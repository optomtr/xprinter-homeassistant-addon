import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import nodemailer from "nodemailer";
import { startApp } from "../app.js";
import { extractCode, repairStoredCodes } from "../mail.js";
import { openDatabase } from "../db.js";
import mailClient from "../../integration/bms-erp-client.cjs";

test("extracts a code near verification wording", () => {
  assert.equal(extractCode("Дата 2026. Ваш код подтверждения: 482913"), "482913");
  const yandexBody = `.mail-address a,\n.mail-address a[href] {\n color: #000000 !important;\n}\nTo confirm this email address, please enter this code on Yandex ID:\n\n 638421`;
  assert.equal(extractCode(`Confirm your email address\n${yandexBody}`), "638421");
  assert.equal(extractCode(".mail-address a { color: #000000 !important; }"), null);
  assert.equal(extractCode("No numeric token here"), null);
});

test("repairs a previously stored CSS color mistaken for a code", () => {
  const folder = mkdtempSync(join(tmpdir(), "mail-code-repair-"));
  const db = openDatabase(join(folder, "inbox.sqlite"));
  try {
    const address = db.prepare("INSERT INTO addresses(local_part, label, created_at) VALUES (?, ?, ?)").run("alice", "", Date.now());
    db.prepare("INSERT INTO messages(address_id, recipient, sender, subject, body, code, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(address.lastInsertRowid, "alice@bmssmart.uz", "noreply@id.yandex.ru", "Confirm your email address",
        ".mail-address a { color: #000000; }\nPlease enter this code on Yandex ID:\n\n 638421", "000000", Date.now());
    repairStoredCodes(db);
    assert.equal(db.prepare("SELECT code FROM messages").get().code, "638421");
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("existing installations start without a relay key", async () => {
  const folder = mkdtempSync(join(tmpdir(), "mail-code-inbox-"));
  const app = await startApp({
    dbPath: join(folder, "inbox.sqlite"),
    mailDomain: "bmssmart.uz",
    adminPassword: "local-test-password-123",
    apiKey: "local-erp-api-key-at-least-24-chars",
    httpPort: 0,
    smtpPort: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.httpAddress.port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/inbound/forward-email`, { method: "POST" })).status, 503);
  } finally {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Home Assistant ingress serves the mailbox UI only to its proxy", async () => {
  const folder = mkdtempSync(join(tmpdir(), "mail-code-ingress-"));
  const options = {
    dbPath: join(folder, "inbox.sqlite"),
    mailDomain: "bmssmart.uz",
    adminPassword: "local-test-password-123",
    apiKey: "local-erp-api-key-at-least-24-chars",
    httpPort: 0,
    ingressPort: 0,
    smtpPort: 0,
  };
  const app = await startApp(options);
  try {
    const ingressUrl = `http://127.0.0.1:${app.ingressAddress.port}`;
    assert.equal((await fetch(`${ingressUrl}/api/session`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${app.httpAddress.port}/api/session`).then((r) => r.json())).authenticated, false);
  } finally {
    await app.close();
  }
  const proxyApp = await startApp({ ...options, ingressProxy: "127.0.0.1" });
  try {
    const base = `http://127.0.0.1:${proxyApp.ingressAddress.port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(await page.text(), /href="style\.css"/u);
    assert.equal((await fetch(`${base}/api/session`).then((r) => r.json())).authenticated, true);
    const created = await fetch(`${base}/api/addresses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: "ha-ingress" }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).address, "ha-ingress@bmssmart.uz");
  } finally {
    await proxyApp.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("creates an address and receives a code through SMTP", async () => {
  const folder = mkdtempSync(join(tmpdir(), "mail-code-inbox-"));
  const app = await startApp({
    dbPath: join(folder, "inbox.sqlite"),
    mailDomain: "bmssmart.uz",
    adminPassword: "local-test-password-123",
    apiKey: "local-erp-api-key-at-least-24-chars",
    relayKey: "local-relay-secret-at-least-32-characters",
    httpPort: 0,
    smtpPort: 0,
  });
  const base = `http://127.0.0.1:${app.httpAddress.port}`;
  const origin = base;
  let cookie = "";
  const api = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json(), response };
  };
  const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: app.smtpAddress.port, secure: false, ignoreTLS: true });
  try {
    assert.equal((await api("/api/addresses")).status, 401);
    assert.equal((await api("/api/erp/addresses")).status, 401);
    const blocked = await fetch(`${base}/api/login`, { method: "POST", headers: { Origin: "http://evil.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ password: "local-test-password-123" }) });
    assert.equal(blocked.status, 403);
    assert.equal((await api("/api/login", { method: "POST", body: { password: "wrong" } })).status, 401);
    const login = await api("/api/login", { method: "POST", body: { password: "local-test-password-123" } });
    assert.equal(login.status, 200);
    cookie = login.response.headers.get("set-cookie").split(";", 1)[0];
    const created = await api("/api/addresses", { method: "POST", body: { localPart: "alice", label: "Алиса" } });
    assert.equal(created.status, 201);
    assert.equal(created.data.address, "alice@bmssmart.uz");
    assert.equal((await api("/api/addresses", { method: "POST", body: { localPart: "alice" } })).status, 409);

    await smtp.sendMail({
      from: "verify@example.net",
      to: "alice+smartlab@bmssmart.uz",
      subject: "Подтверждение регистрации",
      text: "Ваш код подтверждения: 482913",
    });
    const inbox = await api("/api/messages");
    assert.equal(inbox.status, 200);
    assert.equal(inbox.data.messages.length, 1);
    assert.equal(inbox.data.messages[0].code, "482913");
    assert.equal(inbox.data.messages[0].recipient, "alice+smartlab@bmssmart.uz");
    const detail = await api(`/api/messages/${inbox.data.messages[0].id}`);
    assert.match(detail.data.message.body, /482913/u);

    const erpRequest = async (path, { method = "GET", body, key = "local-erp-api-key-at-least-24-chars" } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "X-API-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    };
    const createdByErp = await erpRequest("/api/erp/addresses", { method: "POST", body: { localPart: "smartlab", label: "SmartLab" } });
    assert.equal(createdByErp.status, 201);
    assert.equal(createdByErp.data.address, "smartlab@bmssmart.uz");
    assert.equal((await erpRequest("/api/erp/addresses", { method: "POST", body: { localPart: "smartlab" } })).data.created, false);
    assert.equal((await erpRequest("/api/erp/addresses")).data.addresses.length, 2);
    const code = await erpRequest(`/api/erp/codes/latest?address=alice%40bmssmart.uz&since=${Date.now() - 60_000}`);
    assert.equal(code.data.message.code, "482913");
    const aliasCode = await erpRequest("/api/erp/codes/latest?address=alice%2Bsmartlab%40bmssmart.uz");
    assert.equal(aliasCode.data.message.code, "482913");
    assert.equal((await erpRequest("/api/erp/codes/latest?address=alice%2Bother%40bmssmart.uz")).data.message, null);
    const relayPayload = {
      raw: "From: service@example.net\r\nTo: smartlab@bmssmart.uz\r\nSubject: SmartLab\r\n\r\nYour verification code: 736284",
      recipients: ["smartlab@bmssmart.uz"],
      sender: "service@example.net",
    };
    const relayRequest = (key) => fetch(`${base}/api/inbound/forward-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Relay-Key": key },
      body: JSON.stringify(relayPayload),
    });
    assert.equal((await relayRequest("wrong")).status, 401);
    const relayed = await relayRequest("local-relay-secret-at-least-32-characters");
    assert.equal(relayed.status, 200);
    assert.deepEqual(await relayed.json(), { stored: 1 });
    assert.equal((await erpRequest("/api/erp/codes/latest?address=smartlab%40bmssmart.uz")).data.message.code, "736284");
    assert.equal((await erpRequest("/api/erp/codes/latest?address=alice%40bmssmart.uz", { key: "wrong" })).status, 401);
    const client = mailClient.createMailInboxClient({ baseUrl: base, apiKey: "local-erp-api-key-at-least-24-chars" });
    assert.equal((await client.createAddress("smartlab")).created, false);
    assert.equal((await client.latestCode("alice@bmssmart.uz")).message.code, "482913");

    const disabled = await api(`/api/addresses/${created.data.id}`, { method: "PATCH", body: { enabled: false } });
    assert.equal(disabled.status, 200);
    await assert.rejects(smtp.sendMail({ from: "verify@example.net", to: "alice@bmssmart.uz", text: "Your code is 123456" }), /550/u);
  } finally {
    smtp.close();
    await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
