'use strict';
// Banco de dados. Local: arquivo SQLite em data/painel.db.
// Hospedagem: Turso (SQLite gerenciado) via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
// O dialeto SQL é o mesmo nos dois casos.
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

// Em hospedagem serverless o disco é somente leitura: sem o Turso configurado
// não há onde guardar dados. A criação do cliente é adiada para o primeiro uso,
// para o erro aparecer como mensagem clara e não como falha misteriosa no boot.
const NA_NUVEM = process.env.VERCEL === '1' || process.env.AWS_LAMBDA_FUNCTION_NAME;

function localUrl() {
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return 'file:' + path.join(dir, 'painel.db');
}

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!process.env.TURSO_DATABASE_URL && NA_NUVEM) {
    throw new Error('Banco de dados não configurado: defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN nas variáveis de ambiente do projeto.');
  }
  _client = createClient({
    url: process.env.TURSO_DATABASE_URL || localUrl(),
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return _client;
}
const client = { execute: (...a) => getClient().execute(...a),
                 executeMultiple: (...a) => getClient().executeMultiple(...a),
                 batch: (...a) => getClient().batch(...a) };

// libSQL rejeita undefined e devolve inteiros como BigInt.
const toArgs = (args) => args.map(a => (a === undefined ? null : a));
const fromCell = (v) => (typeof v === 'bigint' ? Number(v) : v);

async function all(sql, ...args) {
  const r = await client.execute({ sql, args: toArgs(args) });
  return r.rows.map(row => {
    const obj = {};
    r.columns.forEach((col, i) => { obj[col] = fromCell(row[i]); });
    return obj;
  });
}

async function get(sql, ...args) {
  return (await all(sql, ...args))[0];
}

async function run(sql, ...args) {
  const r = await client.execute({ sql, args: toArgs(args) });
  return {
    lastInsertRowid: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid),
    rowsAffected: Number(r.rowsAffected || 0),
  };
}

// Executa várias escritas numa única viagem à rede — essencial para a importação,
// que sem isso faria milhares de idas e voltas até o Turso.
async function batch(statements) {
  if (!statements.length) return [];
  const prepared = statements.map(s => (Array.isArray(s) ? { sql: s[0], args: toArgs(s.slice(1)) } : s));
  return client.batch(prepared, 'write');
}

const SCHEMA = `
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
  short_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cargos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  trail_source_id INTEGER REFERENCES cargos(id),
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
-- Histórico de alterações. Cresce com o uso, por isso pode ser exportado em PDF
-- e limpo pela tela de Lançamentos.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quando TEXT NOT NULL DEFAULT (datetime('now')),
  usuario TEXT,
  acao TEXT NOT NULL,
  colaborador TEXT,
  empresa TEXT,
  treinamento TEXT,
  detalhe TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_quando ON activity_log(quando DESC);
-- Configurações gerais do sistema, em pares chave/valor.
CREATE TABLE IF NOT EXISTS settings (
  chave TEXT PRIMARY KEY,
  valor TEXT
);
-- Comunicados que a administração publica para os gestores.
CREATE TABLE IF NOT EXISTS avisos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  texto TEXT NOT NULL,
  prioridade TEXT NOT NULL DEFAULT 'normal' CHECK (prioridade IN ('normal','importante','urgente')),
  ativo INTEGER NOT NULL DEFAULT 1,
  fixado INTEGER NOT NULL DEFAULT 0,
  autor TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_avisos_ordem ON avisos(ativo, fixado DESC, criado_em DESC);
-- Tentativas de login que falharam. Fica no banco, e não na memória, porque em
-- hospedagem serverless cada requisição pode cair numa instância diferente: um
-- contador em memória se perde e o bloqueio por força bruta deixa de valer.
CREATE TABLE IF NOT EXISTS login_fails (
  chave TEXT PRIMARY KEY,
  tentativas INTEGER NOT NULL DEFAULT 0,
  primeira TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Perfis de acesso: definem quais painéis e ações cada usuário enxerga.
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','team')),
  permissions TEXT NOT NULL DEFAULT '{}',
  is_system INTEGER NOT NULL DEFAULT 0
);
`;

let ready = null;
// Cria o schema uma única vez por processo. Em ambiente serverless cada instância
// nova roda isso no primeiro acesso; as instruções são todas IF NOT EXISTS.
function init() {
  if (!ready) {
    ready = (async () => {
      await client.executeMultiple(SCHEMA);
      // Migração de bancos criados antes destas colunas existirem.
      const cols = (await all('PRAGMA table_info(companies)')).map(c => c.name);
      if (!cols.includes('short_name')) await run('ALTER TABLE companies ADD COLUMN short_name TEXT');
      if (!cols.includes('sort_order')) await run('ALTER TABLE companies ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 100');
      const cargoCols = (await all('PRAGMA table_info(cargos)')).map(c => c.name);
      if (!cargoCols.includes('trail_source_id')) await run('ALTER TABLE cargos ADD COLUMN trail_source_id INTEGER REFERENCES cargos(id)');
      const userCols = (await all('PRAGMA table_info(users)')).map(c => c.name);
      if (!userCols.includes('profile_id')) await run('ALTER TABLE users ADD COLUMN profile_id INTEGER REFERENCES profiles(id)');

      // Cria os perfis padrão e liga os usuários antigos ao perfil equivalente.
      const { PADRAO, POR_PAPEL, GESTOR_PUBLICO, permsGestorPublico } = require('./perms');
      const existentes = await all('SELECT id, name FROM profiles');
      const porNome = new Map(existentes.map(p => [p.name, p.id]));
      for (const p of PADRAO) {
        if (!porNome.has(p.name)) {
          const r = await run('INSERT INTO profiles (name, description, scope, permissions, is_system) VALUES (?, ?, ?, ?, 1)',
            p.name, p.description, p.scope, JSON.stringify(p.permissions));
          porNome.set(p.name, r.lastInsertRowid);
        }
      }
      // O acesso sem login usa um perfil de verdade, para a administradora poder
      // configurar o que o gestor enxerga e faz.
      if (!porNome.has(GESTOR_PUBLICO.nome)) {
        await run('INSERT INTO profiles (name, description, scope, permissions, is_system) VALUES (?, ?, ?, ?, 1)',
          GESTOR_PUBLICO.nome, GESTOR_PUBLICO.descricao, 'all', JSON.stringify(permsGestorPublico()));
      }

      const semPerfil = await all('SELECT id, role FROM users WHERE profile_id IS NULL');
      for (const u of semPerfil) {
        const id = porNome.get(POR_PAPEL[u.role]);
        if (id) await run('UPDATE users SET profile_id = ? WHERE id = ?', id, u.id);
      }

      // Permissões criadas depois que perfis já existiam recebem um padrão
      // sensato, para nenhum perfil ficar com acesso indefinido.
      for (const p of await all('SELECT id, name, permissions FROM profiles')) {
        let perm;
        try { perm = JSON.parse(p.permissions || '{}'); } catch { perm = {}; }
        const admin = p.name === 'Administradora';
        let mudou = false;
        if (perm.pendencias === undefined) {
          perm.pendencias = admin ? true : !!perm.vencimentos;
          mudou = true;
        }
        if (perm.avisos === undefined) {          // ler comunicados: todos
          perm.avisos = true;
          mudou = true;
        }
        if (perm.realizados === undefined) {      // quem já vê indicadores
          perm.realizados = admin ? true : !!perm.visao;
          mudou = true;
        }
        if (perm.publicar_avisos === undefined) { // publicar: quem já configura
          perm.publicar_avisos = admin ? true : !!perm.config;
          mudou = true;
        }
        if (mudou) await run('UPDATE profiles SET permissions = ? WHERE id = ?', JSON.stringify(perm), p.id);
      }
    })();
  }
  return ready;
}

module.exports = { client, all, get, run, batch, init };
