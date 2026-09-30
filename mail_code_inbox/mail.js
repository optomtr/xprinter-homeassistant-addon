import { SMTPServer } from "smtp-server";
import PostalMime from "postal-mime";

export const MAX_RAW_BYTES = 5 * 1024 * 1024;

function smtpError(message, responseCode) {
  return Object.assign(new Error(message), { responseCode });
}

export function extractCode(text) {
  const contextual = /(?:код|code|otp|verification|verify|подтверждени[ея]|пароль)[^\d\n]{0,50}(\d{4,8})/iu.exec(text);
  if (contextual) return contextual[1];
  const longer = /(?:^|\D)(\d{5,8})(?!\d)/u.exec(text);
  if (longer) return longer[1];
  const short = /(?:^|\D)(\d{4})(?!\d)/u.exec(text);
  return short?.[1] ?? null;
}

function htmlToText(html) {
  return html
    .replace(/<\s*(?:br|\/p|\/div|\/tr|\/li)\b[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#(\d+);/gu, (match, number) => {
      const point = Number(number);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/[ \t]+/gu, " ");
}

export function createMailStore({ db, mailDomain }) {
  const findAddress = db.prepare("SELECT id FROM addresses WHERE local_part = ? AND enabled = 1");
  const insertMessage = db.prepare(`
    INSERT INTO messages(address_id, recipient, sender, subject, body, code, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  function findRecipient(value) {
    if (typeof value !== "string") return null;
    const recipient = value.toLowerCase();
    const at = recipient.lastIndexOf("@");
    if (at < 1 || recipient.slice(at + 1) !== mailDomain) return null;
    const local = recipient.slice(0, at).split("+", 1)[0];
    const address = findAddress.get(local);
    return address ? { id: address.id, recipient } : null;
  }

  async function store(raw, recipients, fallbackSender = "") {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
    if (bytes.length > MAX_RAW_BYTES) throw new Error("Message too large");
    const email = await PostalMime.parse(bytes);
    const body = String(email.text || htmlToText(email.html || "")).slice(0, 200_000);
    const code = extractCode(`${email.subject || ""}\n${body}`);
    const sender = email.from?.address || fallbackSender || "unknown";
    const receivedAt = Date.now();
    return db.transaction(() => {
      let stored = 0;
      for (const value of recipients) {
        const address = findRecipient(value);
        // An address may be disabled after SMTP RCPT TO or webhook delivery.
        if (!address) continue;
        insertMessage.run(address.id, address.recipient, sender, email.subject || "Без темы", body, code, receivedAt);
        stored += 1;
      }
      return stored;
    })();
  }

  return { findRecipient, store };
}

export function createMailServer({ db, mailDomain, tls, mailStore = createMailStore({ db, mailDomain }) }) {

  const server = new SMTPServer({
    name: `mx.${mailDomain}`,
    banner: "Mail inbox ready",
    size: MAX_RAW_BYTES,
    maxClients: 30,
    authOptional: true,
    disabledCommands: ["AUTH", ...(tls ? [] : ["STARTTLS"])],
    ...(tls ? { key: tls.key, cert: tls.cert } : {}),
    onRcptTo(address, session, callback) {
      if (!mailStore.findRecipient(address.address)) {
        callback(smtpError("Unknown recipient", 550));
        return;
      }
      if (session.envelope.rcptTo.length >= 10) {
        callback(smtpError("Too many recipients", 452));
        return;
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RAW_BYTES) tooLarge = true;
        else chunks.push(chunk);
      });
      stream.on("error", (error) => callback(error));
      stream.on("end", async () => {
        if (tooLarge) return callback(smtpError("Message too large", 552));
        try {
          await mailStore.store(
            Buffer.concat(chunks),
            session.envelope.rcptTo.map((recipient) => recipient.address),
            session.envelope.mailFrom.address,
          );
          callback();
        } catch (error) {
          console.error("Could not store incoming email", error);
          callback(smtpError("Temporary storage error", 451));
        }
      });
    },
  });
  server.on("error", (error) => console.error("SMTP server error", error));
  return server;
}
