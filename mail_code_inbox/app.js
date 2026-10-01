import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.js";
import { createMailServer, createMailStore, MAX_RAW_BYTES, repairStoredCodes } from "./mail.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const staticFiles = new Map([
  ["/", { type: "text/html; charset=utf-8", data: readFileSync(join(here, "public/index.html")) }],
  ["/app.js", { type: "text/javascript; charset=utf-8", data: readFileSync(join(here, "public/app.js")) }],
  ["/style.css", { type: "text/css; charset=utf-8", data: readFileSync(join(here, "public/style.css")) }],
]);

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function readJson(req, maxBytes = 16_384) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(Object.assign(new Error("Request too large"), { status: 413 }));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function tokenFromCookie(cookie) {
  const value = /(?:^|;\s*)mail_code_session=([^;]+)/u.exec(cookie || "")?.[1];
  return value && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeLocalPart(value) {
  if (typeof value !== "string") return null;
  const local = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/u.test(local) || local.endsWith(".") || local.includes("..")) return null;
  return local;
}

export async function startApp(options) {
  const {
    dbPath, mailDomain, adminPassword, apiKey, relayKey, appOrigin,
    httpHost = "127.0.0.1", httpPort = 3000,
    ingressHost = "127.0.0.1", ingressPort = null, ingressProxy = "172.30.32.2",
    smtpHost = "127.0.0.1", smtpPort = 2525,
    retentionDays = 30, tls,
  } = options;
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/u.test(mailDomain)) throw new Error("MAIL_DOMAIN must be a domain name");
  if (typeof adminPassword !== "string" || adminPassword.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  if (typeof apiKey !== "string" || apiKey.length < 24) throw new Error("API_KEY must be at least 24 characters");
  if (relayKey && (typeof relayKey !== "string" || relayKey.length < 32)) throw new Error("RELAY_KEY must be at least 32 characters");
  const origin = appOrigin ? new URL(appOrigin).origin : null;
  const expectedApiKey = createHash("sha256").update(apiKey).digest();
  const expectedRelayKey = relayKey ? createHash("sha256").update(relayKey).digest() : null;
  const db = openDatabase(dbPath);
  repairStoredCodes(db);
  const mailStore = createMailStore({ db, mailDomain });
  // A restart revokes all cookies, including when the admin changes the password.
  db.prepare("DELETE FROM sessions").run();
  const passwordSalt = randomBytes(16);
  const expectedPassword = scryptSync(adminPassword, passwordSalt, 64);
  const failedLogins = new Map();
  const getSession = db.prepare("SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?");
  const insertSession = db.prepare("INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)");
  const deleteSession = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const listAddresses = db.prepare("SELECT id, local_part AS localPart, label, enabled, created_at AS createdAt FROM addresses ORDER BY created_at DESC, id DESC");
  const createAddress = db.prepare("INSERT INTO addresses(local_part, label, created_at) VALUES (?, ?, ?)");
  const updateAddress = db.prepare("UPDATE addresses SET enabled = ? WHERE id = ?");
  const findAddress = db.prepare("SELECT id FROM addresses WHERE id = ?");
  const allMessages = db.prepare(`SELECT m.id, m.recipient, m.sender, m.subject, m.code, m.received_at AS receivedAt,
    a.local_part AS localPart FROM messages m JOIN addresses a ON a.id = m.address_id
    ORDER BY m.received_at DESC, m.id DESC LIMIT 100`);
  const addressMessages = db.prepare(`SELECT m.id, m.recipient, m.sender, m.subject, m.code, m.received_at AS receivedAt,
    a.local_part AS localPart FROM messages m JOIN addresses a ON a.id = m.address_id
    WHERE m.address_id = ? ORDER BY m.received_at DESC, m.id DESC LIMIT 100`);
  const getMessage = db.prepare("SELECT id, recipient, sender, subject, body, code, received_at AS receivedAt FROM messages WHERE id = ?");
  const deleteMessage = db.prepare("DELETE FROM messages WHERE id = ?");
  const findAddressByLocal = db.prepare("SELECT id, enabled FROM addresses WHERE local_part = ?");
  const latestCode = db.prepare(`SELECT id, recipient, sender, subject, code, received_at AS receivedAt
    FROM messages WHERE address_id = ? AND code IS NOT NULL AND received_at >= ?
    AND (? IS NULL OR recipient = ?) ORDER BY received_at DESC, id DESC LIMIT 1`);

  function authenticated(req, viaIngress) {
    if (viaIngress) return true;
    const token = tokenFromCookie(req.headers.cookie);
    return token && !!getSession.get(tokenHash(token), Date.now());
  }

  function apiAuthenticated(req) {
    const provided = req.headers["x-api-key"];
    return typeof provided === "string" && timingSafeEqual(createHash("sha256").update(provided).digest(), expectedApiKey);
  }

  function parseAddress(value) {
    if (typeof value !== "string") return null;
    const address = value.trim().toLowerCase();
    const at = address.lastIndexOf("@");
    if (at < 1 || address.slice(at + 1) !== mailDomain) return null;
    const local = address.slice(0, at);
    const base = local.split("+", 1)[0];
    if (!normalizeLocalPart(base) || (local.includes("+") && !/^[a-z0-9._-]+\+[a-z0-9._-]+$/u.test(local))) return null;
    return { base, exact: local.includes("+") ? address : null };
  }

  const handleRequest = async (req, res, viaIngress = false) => {
    if (viaIngress && req.socket.remoteAddress !== ingressProxy) {
      return json(res, 403, { error: "Ingress proxy required" });
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", viaIngress ? "SAMEORIGIN" : "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'");
    try {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname;
      const erpRoute = path.startsWith("/api/erp/");
      const relayRoute = path === "/api/inbound/forward-email";
      if (!viaIngress && method !== "GET" && method !== "HEAD" && !erpRoute && !relayRoute) {
        const requestOrigin = req.headers.origin;
        let validOrigin = false;
        try {
          const parsed = new URL(requestOrigin);
          validOrigin = (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            (origin ? parsed.origin === origin : parsed.host === req.headers.host);
        } catch { /* Missing or invalid Origin. */ }
        if (!validOrigin) return json(res, 403, { error: "Invalid origin" });
      }
      if (method === "GET" && path === "/api/health") return json(res, 200, { ok: true });
      if (relayRoute) {
        if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
        if (!expectedRelayKey) return json(res, 503, { error: "Relay not configured" });
        const provided = req.headers["x-relay-key"];
        if (typeof provided !== "string" || !timingSafeEqual(createHash("sha256").update(provided).digest(), expectedRelayKey)) {
          return json(res, 401, { error: "Invalid relay key" });
        }
        if (!req.headers["content-type"]?.startsWith("application/json")) return json(res, 415, { error: "Expected JSON" });
        const body = await readJson(req, MAX_RAW_BYTES * 2);
        if (!body || typeof body.raw !== "string" || !Array.isArray(body.recipients) ||
          body.recipients.length === 0 || body.recipients.length > 10 ||
          !body.recipients.every((recipient) => typeof recipient === "string" && recipient.length <= 320) ||
          (body.sender !== undefined && typeof body.sender !== "string")) {
          return json(res, 400, { error: "Invalid email payload" });
        }
        if (Buffer.byteLength(body.raw, "utf8") > MAX_RAW_BYTES) return json(res, 413, { error: "Message too large" });
        const stored = await mailStore.store(body.raw, body.recipients, body.sender);
        return json(res, 200, { stored });
      }
      if (erpRoute) {
        if (!apiAuthenticated(req)) return json(res, 401, { error: "Invalid API key" });
        if (method === "GET" && path === "/api/erp/addresses") {
          return json(res, 200, { addresses: listAddresses.all(), domain: mailDomain });
        }
      if (method === "POST" && path === "/api/erp/addresses") {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "Invalid JSON body" });
        const local = normalizeLocalPart(body.localPart);
          const label = typeof body.label === "string" ? body.label.trim().slice(0, 100) : "";
          if (!local) return json(res, 400, { error: "Invalid localPart" });
          const existing = findAddressByLocal.get(local);
          if (existing) return json(res, 200, { id: existing.id, address: `${local}@${mailDomain}`, created: false, enabled: !!existing.enabled });
          const result = createAddress.run(local, label, Date.now());
          return json(res, 201, { id: Number(result.lastInsertRowid), address: `${local}@${mailDomain}`, created: true, enabled: true });
        }
        if (method === "GET" && path === "/api/erp/codes/latest") {
          const parsed = parseAddress(url.searchParams.get("address"));
          if (!parsed) return json(res, 400, { error: "Invalid address" });
          const sinceText = url.searchParams.get("since");
          const since = sinceText === null ? Date.now() - 10 * 60_000 : Number(sinceText);
          if (!Number.isSafeInteger(since) || since < 0) return json(res, 400, { error: "Invalid since timestamp" });
          const address = findAddressByLocal.get(parsed.base);
          const message = address ? latestCode.get(address.id, since, parsed.exact, parsed.exact) : undefined;
          return json(res, 200, { message: message || null });
        }
        return json(res, 404, { error: "Not found" });
      }
      if (method === "POST" && path === "/api/login") {
        const ip = req.socket.remoteAddress || "unknown";
        const record = failedLogins.get(ip);
        if (record && record.until > Date.now() && record.count >= 5) return json(res, 429, { error: "Too many attempts. Try again later." });
        const body = await readJson(req);
        const candidate = typeof body.password === "string" ? body.password : "";
        const valid = timingSafeEqual(scryptSync(candidate.slice(0, 256), passwordSalt, 64), expectedPassword);
        if (!valid) {
          failedLogins.set(ip, { count: (record?.until > Date.now() ? record.count : 0) + 1, until: Date.now() + 15 * 60_000 });
          return json(res, 401, { error: "Incorrect password" });
        }
        failedLogins.delete(ip);
        const token = randomBytes(32).toString("base64url");
        insertSession.run(tokenHash(token), Date.now() + 7 * 86_400_000);
        res.setHeader("Set-Cookie", `mail_code_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${req.headers.origin?.startsWith("https://") ? "; Secure" : ""}`);
        return json(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/session") return json(res, 200, { authenticated: !!authenticated(req, viaIngress), domain: mailDomain, ingress: viaIngress });
      if (!path.startsWith("/api/")) {
        const file = method === "GET" ? staticFiles.get(path) : null;
        if (!file) return json(res, 404, { error: "Not found" });
        res.writeHead(200, { "Content-Type": file.type, "Cache-Control": "no-store" });
        return res.end(file.data);
      }
      if (!authenticated(req, viaIngress)) return json(res, 401, { error: "Sign in required" });
      if (method === "POST" && path === "/api/logout") {
        if (viaIngress) return json(res, 200, { ok: true });
        const token = tokenFromCookie(req.headers.cookie);
        if (token) deleteSession.run(tokenHash(token));
        res.setHeader("Set-Cookie", `mail_code_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${req.headers.origin?.startsWith("https://") ? "; Secure" : ""}`);
        return json(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/addresses") return json(res, 200, { addresses: listAddresses.all(), domain: mailDomain });
      if (method === "POST" && path === "/api/addresses") {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "Invalid JSON body" });
        const local = normalizeLocalPart(body.localPart);
        const label = typeof body.label === "string" ? body.label.trim().slice(0, 100) : "";
        if (!local) return json(res, 400, { error: "Use 1–64 Latin letters, digits, dots, hyphens or underscores" });
        try {
          const result = createAddress.run(local, label, Date.now());
          return json(res, 201, { id: Number(result.lastInsertRowid), address: `${local}@${mailDomain}` });
        } catch (error) {
          if (error.code?.startsWith("SQLITE_CONSTRAINT")) return json(res, 409, { error: "Address already exists" });
          throw error;
        }
      }
      const addressMatch = /^\/api\/addresses\/(\d+)$/u.exec(path);
      if (method === "PATCH" && addressMatch) {
        const id = parseId(addressMatch[1]);
        const body = await readJson(req);
        if (!id || typeof body.enabled !== "boolean") return json(res, 400, { error: "Invalid address update" });
        if (!findAddress.get(id)) return json(res, 404, { error: "Address not found" });
        updateAddress.run(body.enabled ? 1 : 0, id);
        return json(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/messages") {
        const idText = url.searchParams.get("addressId");
        const id = idText ? parseId(idText) : null;
        if (idText && !id) return json(res, 400, { error: "Invalid address" });
        return json(res, 200, { messages: id ? addressMessages.all(id) : allMessages.all() });
      }
      const messageMatch = /^\/api\/messages\/(\d+)$/u.exec(path);
      if (messageMatch) {
        const id = parseId(messageMatch[1]);
        if (!id) return json(res, 400, { error: "Invalid message" });
        if (method === "GET") {
          const message = getMessage.get(id);
          return message ? json(res, 200, { message }) : json(res, 404, { error: "Message not found" });
        }
        if (method === "DELETE") {
          deleteMessage.run(id);
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      if (error.status) return json(res, error.status, { error: error.message });
      console.error("HTTP request failed", error);
      return json(res, 500, { error: "Internal error" });
    }
  };
  const http = createServer((req, res) => handleRequest(req, res));
  const ingress = ingressPort === null ? null : createServer((req, res) => handleRequest(req, res, true));

  const smtp = createMailServer({ db, mailDomain, tls, mailStore });
  const listen = (server, port, host) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(typeof server.address === "function" ? server.address() : server.server.address());
    });
  });
  let httpAddress;
  let ingressAddress;
  let smtpAddress;
  try {
    httpAddress = await listen(http, httpPort, httpHost);
    if (ingress) ingressAddress = await listen(ingress, ingressPort, ingressHost);
    smtpAddress = await listen(smtp, smtpPort, smtpHost);
  } catch (error) {
    http.close();
    ingress?.close();
    smtp.close();
    db.close();
    throw error;
  }
  const cleanup = setInterval(() => {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    if (retentionDays > 0) db.prepare("DELETE FROM messages WHERE received_at < ?").run(Date.now() - retentionDays * 86_400_000);
  }, 60 * 60_000);
  cleanup.unref();
  return {
    httpAddress,
    ingressAddress,
    smtpAddress,
    close: async () => {
      clearInterval(cleanup);
      await Promise.all([
        new Promise((resolve) => http.close(resolve)),
        ...(ingress ? [new Promise((resolve) => ingress.close(resolve))] : []),
        new Promise((resolve) => smtp.close(resolve)),
      ]);
      db.close();
    },
  };
}
