import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = path.join(process.cwd(), "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "safecare.db");

/**
 * 表结构对应 docs/PLAN.md §4；险种差异字段（coverage/exclusion/term 的细节）
 * 以 JSON 存在 data 列，具体形状见 docs/FIELDS.md。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS member (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  relation TEXT,
  birth_date TEXT,
  sex TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER REFERENCES member(id) ON DELETE SET NULL,
  sha256 TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  char_count INTEGER NOT NULL DEFAULT 0,
  has_text_layer INTEGER NOT NULL DEFAULT 0,
  clause_count INTEGER NOT NULL DEFAULT 0,
  clause_coverage REAL NOT NULL DEFAULT 0,
  toc_expected INTEGER NOT NULL DEFAULT 0,
  toc_matched INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'parsed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS page (
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL,
  width REAL,
  height REAL,
  char_count INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (document_id, page_no)
);

CREATE TABLE IF NOT EXISTS clause_set (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  insurer TEXT,
  product_name TEXT,
  version TEXT,
  effective_from TEXT,
  UNIQUE (insurer, product_name, version)
);

CREATE TABLE IF NOT EXISTS clause (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  clause_set_id INTEGER REFERENCES clause_set(id) ON DELETE SET NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  page_from INTEGER NOT NULL,
  page_to INTEGER NOT NULL,
  clause_no TEXT,
  heading_path TEXT,
  category TEXT,
  text TEXT NOT NULL,
  char_start INTEGER,
  char_end INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clause_document ON clause(document_id, seq);

CREATE TABLE IF NOT EXISTS policy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES member(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  insurer TEXT,
  product_name TEXT,
  policy_no TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coverage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL REFERENCES policy(id) ON DELETE CASCADE,
  code TEXT,
  name TEXT,
  benefit_type TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  citation_clause_id INTEGER REFERENCES clause(id) ON DELETE SET NULL,
  confidence REAL,
  review_status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exclusion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL REFERENCES policy(id) ON DELETE CASCADE,
  category TEXT,
  severity TEXT,
  text TEXT,
  citation_clause_id INTEGER REFERENCES clause(id) ON DELETE SET NULL,
  confidence REAL,
  review_status TEXT NOT NULL DEFAULT 'ok'
);

CREATE TABLE IF NOT EXISTS term (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL REFERENCES policy(id) ON DELETE CASCADE,
  kind TEXT,
  value TEXT,
  citation_clause_id INTEGER REFERENCES clause(id) ON DELETE SET NULL,
  confidence REAL,
  review_status TEXT NOT NULL DEFAULT 'ok'
);

-- AI 增补结果：本地切分出的条款结构为准，这里只存模型补的类别/摘要/要点
CREATE TABLE IF NOT EXISTS clause_ai (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clause_id INTEGER NOT NULL REFERENCES clause(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  kind TEXT,
  summary TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  confidence REAL,
  review_status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (clause_id, model)
);

CREATE TABLE IF NOT EXISTS extraction_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER REFERENCES document(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  engine TEXT,
  model TEXT,
  prompt_version TEXT,
  tokens INTEGER,
  cost REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- 脱敏映射只存本机，不随请求发送（docs/PLAN.md §8.1）
CREATE TABLE IF NOT EXISTS redaction_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  placeholder TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_value TEXT NOT NULL,
  UNIQUE (document_id, placeholder)
);

CREATE TABLE IF NOT EXISTS qa_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const holder = globalThis as unknown as { __safecareDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  let db = holder.__safecareDb;

  if (!db) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    db = new DatabaseSync(DB_FILE);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(DDL);
    holder.__safecareDb = db;
  }

  // 每次取连接都跑一遍：dev 下模块会热更新，但连接挂在 globalThis 上，
  // 只在建连时迁移的话，改了 schema 之后老连接会一直缺列。
  ensureColumn(db, "document", "clause_count", "clause_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "document", "clause_coverage", "clause_coverage REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "document", "toc_expected", "toc_expected INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "document", "toc_matched", "toc_matched INTEGER NOT NULL DEFAULT 0");
  // 责任/免责行来自哪一层：ai 的行每次重跑整体替换，rules 的行保留
  ensureColumn(db, "exclusion", "source", "source TEXT NOT NULL DEFAULT 'rules'");
  ensureColumn(db, "term", "source", "source TEXT NOT NULL DEFAULT 'rules'");

  // 老库里没有 clause_ai，建表语句是幂等的，每次取连接补一下
  db.exec(`CREATE TABLE IF NOT EXISTS clause_ai (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clause_id INTEGER NOT NULL REFERENCES clause(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  kind TEXT,
  summary TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  confidence REAL,
  review_status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (clause_id, model)
);`);

  return db;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function uploadPathFor(documentId: number): string {
  return path.join(UPLOAD_DIR, `${documentId}.pdf`);
}
