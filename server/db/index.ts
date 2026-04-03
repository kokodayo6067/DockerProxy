import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { CONFIG } from "../utils/config";
import { hashPassword } from "../services/security";

let database: Database.Database | null = null;

function nowIso() {
  return new Date().toISOString();
}

function ensureDataDir() {
  if (!fs.existsSync(CONFIG.DATA_DIR)) {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  }
}

function createTables(db: Database.Database) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      bootstrap INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_secrets (
      integration_id TEXT PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS environments (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      runtime_driver TEXT NOT NULL DEFAULT 'docker',
      host TEXT,
      port INTEGER,
      username TEXT,
      workdir TEXT NOT NULL,
      auth_type TEXT,
      host_fingerprint TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_verified_at TEXT,
      is_local INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS environment_credentials (
      environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS environment_capabilities (
      environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
      connect_ok INTEGER NOT NULL DEFAULT 0,
      inspect_ok INTEGER NOT NULL DEFAULT 0,
      operate_ok INTEGER NOT NULL DEFAULT 0,
      elevated_ok INTEGER NOT NULL DEFAULT 0,
      docker_version TEXT,
      compose_version TEXT,
      architecture TEXT,
      available_disk_bytes INTEGER,
      sudo_mode TEXT NOT NULL DEFAULT 'none',
      modules_json TEXT NOT NULL DEFAULT '[]',
      permissions_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      details_json TEXT NOT NULL DEFAULT '{}',
      host_fingerprint TEXT,
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      remarks TEXT,
      project_dir TEXT,
      current_revision_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
      compose_yaml TEXT NOT NULL,
      remarks TEXT,
      compose_path TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proxy_routes (
      id TEXT PRIMARY KEY,
      environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
      domain TEXT NOT NULL,
      target TEXT NOT NULL,
      ssl INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dns_zone_bindings (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      zone_name TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateways (
      id TEXT PRIMARY KEY,
      environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'nginx',
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source_environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
      target_environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_events_index (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      level TEXT NOT NULL,
      phase TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts_index (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
      artifact_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      level TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
}

async function ensureBootstrapUser(db: Database.Database) {
  const row = db
    .prepare("SELECT id, username, bootstrap FROM users ORDER BY created_at ASC")
    .all() as Array<{ id: string; username: string; bootstrap: number }>;

  const passwordHash = await hashPassword(CONFIG.ADMIN_PASSWORD);
  const timestamp = nowIso();

  if (row.length === 0) {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, bootstrap, created_at, updated_at)
       VALUES (@id, @username, @passwordHash, 1, @timestamp, @timestamp)`
    ).run({
      id: "bootstrap-admin",
      username: CONFIG.ADMIN_USERNAME,
      passwordHash,
      timestamp,
    });
    return;
  }

  if (row.length === 1 && row[0].bootstrap === 1) {
    db.prepare(
      `UPDATE users
       SET username = @username,
           password_hash = @passwordHash,
           updated_at = @timestamp
       WHERE id = @id`
    ).run({
      id: row[0].id,
      username: CONFIG.ADMIN_USERNAME,
      passwordHash,
      timestamp,
    });
  }
}

export async function initDatabase() {
  if (database) return database;
  ensureDataDir();
  const dbPath = path.join(CONFIG.DATA_DIR, "app.db");
  const db = new Database(dbPath);
  createTables(db);
  await ensureBootstrapUser(db);
  database = db;
  return db;
}

export function getDb() {
  if (!database) {
    throw new Error("数据库尚未初始化");
  }
  return database;
}
