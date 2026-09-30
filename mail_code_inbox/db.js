import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY,
      local_part TEXT NOT NULL UNIQUE COLLATE NOCASE,
      label TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      address_id INTEGER NOT NULL REFERENCES addresses(id),
      recipient TEXT NOT NULL,
      sender TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      code TEXT,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_address_time ON messages(address_id, received_at DESC);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}
