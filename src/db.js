'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'painel.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','supervisor','gestor','lider')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cargos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  UNIQUE(name, company_id)
);
CREATE TABLE IF NOT EXISTS trainings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  norm_key TEXT NOT NULL,
  ch_formacao REAL,
  ch_reciclagem REAL,
  validade_meses INTEGER,
  criterio TEXT,
  fonte TEXT,
  custo_formacao REAL NOT NULL DEFAULT 0,
  custo_reciclagem REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  cargo_id INTEGER REFERENCES cargos(id),
  admissao TEXT,
  demissao TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(name, company_id)
);
CREATE TABLE IF NOT EXISTS trails (
  cargo_id INTEGER NOT NULL REFERENCES cargos(id) ON DELETE CASCADE,
  training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  PRIMARY KEY (cargo_id, training_id)
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  realizacao TEXT,
  vencimento TEXT,
  obs TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_records_emp ON records(employee_id, training_id);
-- Exigência individual: treinamento cobrado de um colaborador específico,
-- independentemente da trilha do cargo (vem das linhas da Base de Dados).
CREATE TABLE IF NOT EXISTS requirements (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  PRIMARY KEY (employee_id, training_id)
);
CREATE TABLE IF NOT EXISTS team_members (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, employee_id)
);
`);

// Migrações incrementais (idempotentes)
const cargoCols = db.prepare('PRAGMA table_info(cargos)').all().map(c => c.name);
if (!cargoCols.includes('trail_source_id')) {
  db.exec('ALTER TABLE cargos ADD COLUMN trail_source_id INTEGER REFERENCES cargos(id)');
}
const companyCols = db.prepare('PRAGMA table_info(companies)').all().map(c => c.name);
if (!companyCols.includes('short_name')) {
  db.exec('ALTER TABLE companies ADD COLUMN short_name TEXT');
}
if (!companyCols.includes('sort_order')) {
  db.exec('ALTER TABLE companies ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 100');
}

module.exports = db;
