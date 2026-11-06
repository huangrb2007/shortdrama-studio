import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
export function openDb(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'studio.db'));
  db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS secrets(key TEXT PRIMARY KEY, iv TEXT, tag TEXT, data TEXT);
  CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, title TEXT, input_type TEXT, input TEXT, aspect TEXT, style TEXT, budget_llm REAL, spent_llm REAL DEFAULT 0, budget_gen REAL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS stages(project_id TEXT, stage TEXT, status TEXT, version INTEGER DEFAULT 0, error TEXT, next_step TEXT, PRIMARY KEY(project_id, stage));
  CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, project_id TEXT, stage TEXT, version INTEGER, content TEXT, hash TEXT, frozen INTEGER DEFAULT 0, skill_lock TEXT, issues TEXT, created_at TEXT, UNIQUE(project_id, stage, version));
  CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, target TEXT, provider TEXT, request TEXT, request_hash TEXT, estimate TEXT, state TEXT, ticket TEXT, provider_ref TEXT, error TEXT, output TEXT, reserved REAL DEFAULT 0, settled REAL DEFAULT 0, repair_reason TEXT, created_at TEXT, updated_at TEXT, submitted_at TEXT);
  CREATE INDEX IF NOT EXISTS ledger_hash ON ledger(project_id, request_hash);
  CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, type TEXT, payload TEXT, inverse TEXT, undone INTEGER DEFAULT 0, at TEXT);
  CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, project_id TEXT, target TEXT, ledger_id TEXT, file TEXT, selected INTEGER DEFAULT 0, review TEXT, created_at TEXT);`);
  return db;
}
export type DB = ReturnType<typeof openDb>;
/** 密钥只进这里，AES-256-GCM 加密。主密钥桌面端由系统钥匙串保护，服务端由环境变量提供。 */
export class Secrets {
  private key: Buffer;
  constructor(private db: DB, masterKey: string) { this.key = crypto.createHash('sha256').update(masterKey).digest(); }
  set(k: string, v: string) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', this.key, iv); const data = Buffer.concat([c.update(v, 'utf8'), c.final()]); this.db.prepare('INSERT OR REPLACE INTO secrets VALUES(?,?,?,?)').run(k, iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')); }
  get(k: string) { const r: any = this.db.prepare('SELECT * FROM secrets WHERE key=?').get(k); if (!r) return undefined; const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(r.iv, 'base64')); d.setAuthTag(Buffer.from(r.tag, 'base64')); return Buffer.concat([d.update(Buffer.from(r.data, 'base64')), d.final()]).toString('utf8'); }
  has(k: string) { return !!this.db.prepare('SELECT 1 FROM secrets WHERE key=?').get(k); }
}
