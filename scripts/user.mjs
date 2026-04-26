#!/usr/bin/env node
// CLI for managing users without the web UI.
// Useful for the very first bootstrap or rescuing locked-out admins.
//
// Usage (from project root):
//   node scripts/user.mjs list
//   node scripts/user.mjs create <email> <name> <role> [password]
//   node scripts/user.mjs reset  <email> [password]
//   node scripts/user.mjs delete <email>
//
// If <password> is omitted, a random one is generated and printed.

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(here, "..", "data", "amaso.db");

function openDb() {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','team','client')),
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function randomPassword() {
  return randomBytes(9).toString("base64url");
}

function usage(code = 0) {
  console.log(`Usage:
  node scripts/user.mjs list
  node scripts/user.mjs create <email> <name> <role> [password]
  node scripts/user.mjs reset  <email> [password]
  node scripts/user.mjs delete <email>

  role = admin | team | client
`);
  process.exit(code);
}

const [, , cmd, ...rest] = process.argv;
if (!cmd) usage(1);

const db = openDb();

if (cmd === "list") {
  const rows = db
    .prepare(
      "SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC",
    )
    .all();
  if (rows.length === 0) {
    console.log("(no users yet)");
  } else {
    for (const r of rows) {
      console.log(
        `#${r.id.toString().padStart(3)}  ${r.role.padEnd(6)}  ${r.email.padEnd(30)}  ${r.name}`,
      );
    }
  }
} else if (cmd === "create") {
  const [email, name, role, passwordArg] = rest;
  if (!email || !name || !role) usage(1);
  if (!["admin", "team", "client"].includes(role)) {
    console.error("Role must be admin, team, or client.");
    process.exit(1);
  }
  const password = passwordArg ?? randomPassword();
  const hash = bcrypt.hashSync(password, 12);
  try {
    db.prepare(
      "INSERT INTO users (email, password, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(email.toLowerCase().trim(), hash, name.trim(), role, Date.now());
    console.log(`Created ${role} ${email}`);
    if (!passwordArg) console.log(`Password: ${password}`);
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      console.error(`User ${email} already exists.`);
      process.exit(1);
    }
    throw err;
  }
} else if (cmd === "reset") {
  const [email, passwordArg] = rest;
  if (!email) usage(1);
  const password = passwordArg ?? randomPassword();
  const hash = bcrypt.hashSync(password, 12);
  const r = db
    .prepare("UPDATE users SET password = ? WHERE email = ?")
    .run(hash, email.toLowerCase().trim());
  if (r.changes === 0) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  // Invalidate sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id INTEGER, created_at INTEGER, expires_at INTEGER
    );
  `);
  db.prepare(
    "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)",
  ).run(email.toLowerCase().trim());
  console.log(`Reset password for ${email}`);
  if (!passwordArg) console.log(`New password: ${password}`);
} else if (cmd === "delete") {
  const [email] = rest;
  if (!email) usage(1);
  const r = db
    .prepare("DELETE FROM users WHERE email = ?")
    .run(email.toLowerCase().trim());
  console.log(r.changes > 0 ? `Deleted ${email}` : `No user with email ${email}`);
} else {
  usage(1);
}

db.close();
