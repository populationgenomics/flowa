/**
 * Idempotent SQLite migration. The schema uses `CREATE TABLE IF NOT EXISTS`,
 * so calling this any number of times against the same file is safe.
 *
 * The triage DB lives at `${DEMO_DATA_DIR}/triage.sqlite` by default;
 * tests pass an explicit path to keep each test isolated.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "schema.sql",
);

export function migrate(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  return db;
}
