import { SMTPServer } from "smtp-server";
import PostalMime from "postal-mime";

const MAX_RAW_BYTES = 5 * 1024 * 1024;

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

export function createMailServer({ db, mailDomain, tls }) {
  const findAddress = db.prepare("SELECT id FROM addresses WHERE local_part = ? AND enabled = 1");
  const insertMessage = db.prepare(`
    INSERT INTO messages(address_id, recipient, sender, subject, body, code, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const server = new SMTPServer({
    name: `mx.${mailDomain}`,
    banner: "Mail inbox ready",
    size: MAX_RAW_BYTES,
    maxClients: 30,
    authOptional: true,
    disabledCommands: ["AUTH", ...(tls ? [] : ["STARTTLS"])],
    ...(tls ? { key: tls.key, cert: tls.cert } : {}),
    onRcptTo(address, session, callback) {
      const recipient = address.address.toLowerCase();
      const at = recipient.lastIndexOf("@");
      const domain = recipient.slice(at + 1);
      const local = recipient.slice(0, at).split("+", 1)[0];
      if (domain !== mailDomain || !findAddress.get(local)) {
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
          const email = await PostalMime.parse(Buffer.concat(chunks));
          const body = String(email.text || htmlToText(email.html || "")).slice(0, 200_000);
          const code = extractCode(`${email.subject || ""}\n${body}`);
          const sender = email.from?.address || session.envelope.mailFrom.address || "unknown";
          const receivedAt = Date.now();
          const save = db.transaction(() => {
            for (const recipient of session.envelope.rcptTo) {
              const value = recipient.address.toLowerCase();
              const local = value.slice(0, value.lastIndexOf("@")).split("+", 1)[0];
              const address = findAddress.get(local);
              // An address could be disabled after RCPT TO but before DATA completes.
              if (address) insertMessage.run(address.id, value, sender, email.subject || "Без темы", body, code, receivedAt);
            }
          });
          save();
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
