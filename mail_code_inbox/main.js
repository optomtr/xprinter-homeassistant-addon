import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "./app.js";

const haOptions = existsSync("/data/options.json") ? JSON.parse(readFileSync("/data/options.json", "utf8")) : null;
const mailDomain = String(haOptions?.mail_domain ?? process.env.MAIL_DOMAIN ?? "").trim().toLowerCase();
const adminPassword = haOptions?.admin_password ?? process.env.ADMIN_PASSWORD;
const apiKey = haOptions?.api_key ?? process.env.API_KEY;
const appOrigin = process.env.APP_ORIGIN;
if (!mailDomain || !adminPassword || !apiKey) {
  console.error("Configure mail_domain, admin_password and api_key in Home Assistant app options");
  process.exit(1);
}
if (adminPassword === "replace-with-a-long-unique-password") {
  console.error("Replace the example ADMIN_PASSWORD before starting");
  process.exit(1);
}

const tlsKeyPath = haOptions?.smtp_tls_key ?? process.env.SMTP_TLS_KEY;
const tlsCertPath = haOptions?.smtp_tls_cert ?? process.env.SMTP_TLS_CERT;
if (Boolean(tlsKeyPath) !== Boolean(tlsCertPath)) throw new Error("Set both SMTP TLS key and certificate paths");
if (haOptions && (tlsKeyPath || tlsCertPath) && (![tlsKeyPath, tlsCertPath].every((path) => typeof path === "string" && path.startsWith("/ssl/")))) {
  throw new Error("SMTP TLS files must be inside /ssl");
}
const tls = tlsKeyPath && tlsCertPath
  ? { key: readFileSync(tlsKeyPath), cert: readFileSync(tlsCertPath) }
  : undefined;

const app = await startApp({
  dbPath: join(process.env.DATA_DIR || "./data", "inbox.sqlite"),
  mailDomain,
  adminPassword,
  apiKey,
  appOrigin,
  httpHost: process.env.HTTP_HOST || "0.0.0.0",
  httpPort: Number(process.env.HTTP_PORT || 3000),
  smtpHost: process.env.SMTP_HOST || "0.0.0.0",
  smtpPort: Number(process.env.SMTP_PORT || 2525),
  retentionDays: Number(haOptions?.retention_days ?? process.env.RETENTION_DAYS ?? 30),
  tls,
});

console.log(`Web UI on ${app.httpAddress.address}:${app.httpAddress.port}`);
console.log(`SMTP for ${mailDomain} on ${app.smtpAddress.address}:${app.smtpAddress.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0)).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
}
