'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const db = require('./src/db');
const { importWorkbook, linkCargoTrails } = require('./src/importer');
const { exportWorkbook } = require('./src/exporter');
const { buildDataset, todayISO } = require('./src/dataset');
const { cleanName, toISODate, shortCompanyName, trainingKey } = require('./src/normalize');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// Em hospedagem o tráfego chega por um proxy HTTPS. BEHIND_PROXY faz o Express
// confiar no X-Forwarded-Proto e marcar o cookie como Secure, para a sessão nunca
// trafegar fora de uma conexão criptografada.
const BEHIND_PROXY = process.env.BEHIND_PROXY === '1' || process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

const app = express();
app.disable('x-powered-by');
if (BEHIND_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (BEHIND_PROXY) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ---- Sessão ----
// Guardada no próprio cookie, assinada — sem estado no servidor, que é o que
// permite rodar em ambiente serverless, onde cada requisição pode cair numa
// instância diferente. O cookie carrega apenas o id do usuário.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretPath = path.join(__dirname, 'data', 'secret.txt');
  try {
    if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, crypto.randomBytes(32).toString('hex'));
    return fs.readFileSync(secretPath, 'utf8');
  } catch (e) {
    console.warn('Não foi possível gravar data/secret.txt (' + e.code + '). ' +
      'Defina SESSION_SECRET para manter as sessões entre reinícios.');
    return crypto.randomBytes(32).toString('hex');
  }
}

app.use(cookieSession({
  name: 'painel_riva',
  keys: [sessionSecret()],
  httpOnly: true,
  sameSite: 'lax',
  secure: BEHIND_PROXY,
  maxAge: 12 * 60 * 60 * 1000,
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Envolve handlers assíncronos para que uma falha vire resposta de erro em vez de
// deixar a requisição pendurada.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Preparação (schema + administradora), uma vez por instância ----
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.init();
      const { c } = await db.get('SELECT COUNT(*) c FROM users');
      if (c === 0) {
        const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'trocar123', 10);
        await db.run("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
          process.env.ADMIN_NAME || 'Administradora',
          process.env.ADMIN_EMAIL || 'departamentopessoalriva@gmail.com', hash);
        console.log('Usuário administrador criado.');
      }
    })().catch(err => { readyPromise = null; throw err; });
  }
  return readyPromise;
}
app.use(h(async (req, res, next) => { await ensureReady(); next(); }));

// ---- Autenticação ----
async function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return db.get('SELECT * FROM users WHERE id = ? AND active = 1', req.session.userId);
}
const requireAuth = h(async (req, res, next) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  req.user = user;
  next();
});
function requireRole(...roles) {
  return h(async (req, res, next) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });
    if (!roles.includes(user.role)) return res.status(403).json({ error: 'Sem permissão' });
    req.user = user;
    next();
  });
}

// Bloqueia tentativas repetidas de adivinhar senha: 8 falhas em 15 minutos,
// contadas por IP + e-mail, travam novas tentativas por 15 minutos.
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map();

const loginKey = (req, email) => (req.ip || 'sem-ip') + '|' + String(email || '').trim().toLowerCase();
function isLocked(key) {
  const entry = loginFails.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) { loginFails.delete(key); return false; }
  return entry.count >= LOGIN_MAX_FAILS;
}
function registerFail(key) {
  const entry = loginFails.get(key);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) loginFails.set(key, { count: 1, first: Date.now() });
  else entry.count++;
  if (loginFails.size > 5000) {
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    for (const [k, v] of loginFails) if (v.first < cutoff) loginFails.delete(k);
  }
}

app.post('/api/login', h(async (req, res) => {
  const { email, password } = req.body || {};
  const key = loginKey(req, email);
  if (isLocked(key)) {
    return res.status(429).json({ error: 'Muitas tentativas de acesso. Aguarde 15 minutos e tente novamente.' });
  }
  const user = await db.get('SELECT * FROM users WHERE email = ? AND active = 1', String(email || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    registerFail(key);
    return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  }
  loginFails.delete(key);
  req.session = { userId: user.id };
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
});

app.post('/api/me/password', requireAuth, h(async (req, res) => {
  const { current, next } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) {
    return res.status(400).json({ error: 'Senha atual incorreta' });
  }
  if (!next || String(next).length < 6) return res.status(400).json({ error: 'A nova senha deve ter ao menos 6 caracteres' });
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(String(next), 10), req.user.id);
  res.json({ ok: true });
}));

// ---- Alcance de visibilidade ----
// Líder enxerga apenas a equipe atribuída a ele; os demais perfis veem tudo.
async function scopeFor(user) {
  if (!user || user.role !== 'lider') return null;
  const rows = await db.all('SELECT employee_id FROM team_members WHERE user_id = ?', user.id);
  return rows.map(r => r.employee_id);
}
// Barra o acesso a um colaborador fora do alcance do usuário logado.
async function employeeInScope(user, employeeId) {
  const scope = await scopeFor(user);
  return !scope || scope.includes(Number(employeeId));
}

// ---- Painel (dataset) ----
app.get('/api/dataset', requireAuth, h(async (req, res) => {
  const ds = await buildDataset(await scopeFor(req.user));
  ds.user = { id: req.user.id, name: req.user.name, role: req.user.role };
  res.json(ds);
}));

// ---- CRUD (admin e supervisor) ----
const canEdit = requireRole('admin', 'supervisor');

app.post('/api/companies', canEdit, h(async (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const r = await db.run('INSERT INTO companies (name, short_name, sort_order) VALUES (?, ?, ?)',
      name, cleanName(req.body.short_name) || shortCompanyName(name), Number(req.body.sort_order) || 100);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch { res.status(400).json({ error: 'Empresa já existe' }); }
}));
app.put('/api/companies/:id', canEdit, h(async (req, res) => {
  await db.run(`UPDATE companies SET name = COALESCE(?, name), short_name = COALESCE(?, short_name),
    sort_order = COALESCE(?, sort_order), active = COALESCE(?, active) WHERE id = ?`,
    req.body.name ? cleanName(req.body.name) : null,
    req.body.short_name ? cleanName(req.body.short_name) : null,
    req.body.sort_order ?? null, req.body.active ?? null, Number(req.params.id));
  res.json({ ok: true });
}));
app.delete('/api/companies/:id', requireRole('admin'), h(async (req, res) => {
  const id = Number(req.params.id);
  const { c } = await db.get('SELECT COUNT(*) c FROM employees WHERE company_id = ?', id);
  if (c > 0) return res.status(400).json({ error: 'Há colaboradores vinculados a esta empresa. Exclua ou transfira antes.' });
  await db.batch([['DELETE FROM cargos WHERE company_id = ?', id], ['DELETE FROM companies WHERE id = ?', id]]);
  res.json({ ok: true });
}));

app.post('/api/cargos', canEdit, h(async (req, res) => {
  const name = cleanName(req.body.name);
  const companyId = Number(req.body.company_id);
  if (!name || !companyId) return res.status(400).json({ error: 'Nome e empresa obrigatórios' });
  try {
    const r = await db.run('INSERT INTO cargos (name, company_id) VALUES (?, ?)', name, companyId);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch { res.status(400).json({ error: 'Cargo já existe nesta empresa' }); }
}));
app.put('/api/cargos/:id', canEdit, h(async (req, res) => {
  const id = Number(req.params.id);
  await db.run('UPDATE cargos SET name = COALESCE(?, name) WHERE id = ?',
    req.body.name ? cleanName(req.body.name) : null, id);
  if ('trail_source_id' in req.body) {
    const src = req.body.trail_source_id ? Number(req.body.trail_source_id) : null;
    if (src === id) return res.status(400).json({ error: 'Um cargo não pode herdar a trilha de si mesmo' });
    await db.run('UPDATE cargos SET trail_source_id = ? WHERE id = ?', src, id);
  }
  if (Array.isArray(req.body.trail_training_ids)) {
    const stmts = [['DELETE FROM trails WHERE cargo_id = ?', id]];
    for (const tid of req.body.trail_training_ids) {
      stmts.push(['INSERT OR IGNORE INTO trails (cargo_id, training_id) VALUES (?, ?)', id, Number(tid)]);
    }
    await db.batch(stmts);
  }
  res.json({ ok: true });
}));
app.delete('/api/cargos/:id', requireRole('admin'), h(async (req, res) => {
  const id = Number(req.params.id);
  const { c } = await db.get('SELECT COUNT(*) c FROM employees WHERE cargo_id = ?', id);
  if (c > 0) return res.status(400).json({ error: 'Há colaboradores com este cargo. Altere-os antes.' });
  await db.run('DELETE FROM cargos WHERE id = ?', id);
  res.json({ ok: true });
}));

app.post('/api/trainings', canEdit, h(async (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const r = await db.run(`INSERT INTO trainings (name, norm_key, ch_formacao, ch_reciclagem, validade_meses, criterio, fonte, custo_formacao, custo_reciclagem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      name, trainingKey(name),
      req.body.ch_formacao ?? null, req.body.ch_reciclagem ?? null, req.body.validade_meses ?? null,
      req.body.criterio ?? null, req.body.fonte ?? null,
      req.body.custo_formacao ?? 0, req.body.custo_reciclagem ?? 0);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch { res.status(400).json({ error: 'Treinamento já existe' }); }
}));
app.put('/api/trainings/:id', canEdit, h(async (req, res) => {
  const b = req.body;
  await db.run(`UPDATE trainings SET name = COALESCE(?, name), ch_formacao = COALESCE(?, ch_formacao),
    ch_reciclagem = COALESCE(?, ch_reciclagem), validade_meses = COALESCE(?, validade_meses),
    criterio = COALESCE(?, criterio), fonte = COALESCE(?, fonte),
    custo_formacao = COALESCE(?, custo_formacao), custo_reciclagem = COALESCE(?, custo_reciclagem),
    active = COALESCE(?, active) WHERE id = ?`,
    b.name ? cleanName(b.name) : null, b.ch_formacao ?? null, b.ch_reciclagem ?? null,
    b.validade_meses ?? null, b.criterio ?? null, b.fonte ?? null,
    b.custo_formacao ?? null, b.custo_reciclagem ?? null, b.active ?? null, Number(req.params.id));
  res.json({ ok: true });
}));
app.delete('/api/trainings/:id', requireRole('admin'), h(async (req, res) => {
  const id = Number(req.params.id);
  const { c } = await db.get('SELECT COUNT(*) c FROM records WHERE training_id = ?', id);
  if (c > 0) return res.status(400).json({ error: 'Há lançamentos para este treinamento. Exclua-os antes ou desative o treinamento.' });
  await db.batch([['DELETE FROM trails WHERE training_id = ?', id], ['DELETE FROM trainings WHERE id = ?', id]]);
  res.json({ ok: true });
}));

app.post('/api/employees', canEdit, h(async (req, res) => {
  const name = cleanName(req.body.name);
  const companyId = Number(req.body.company_id);
  if (!name || !companyId) return res.status(400).json({ error: 'Nome e empresa obrigatórios' });
  try {
    const r = await db.run('INSERT INTO employees (name, company_id, cargo_id, admissao, demissao) VALUES (?, ?, ?, ?, ?)',
      name, companyId, req.body.cargo_id ? Number(req.body.cargo_id) : null,
      toISODate(req.body.admissao), toISODate(req.body.demissao));
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch { res.status(400).json({ error: 'Colaborador já existe nesta empresa' }); }
}));
app.put('/api/employees/:id', canEdit, h(async (req, res) => {
  const b = req.body;
  await db.run(`UPDATE employees SET name = COALESCE(?, name), company_id = COALESCE(?, company_id),
    cargo_id = ?, admissao = ?, demissao = ?, active = COALESCE(?, active) WHERE id = ?`,
    b.name ? cleanName(b.name) : null, b.company_id ? Number(b.company_id) : null,
    b.cargo_id ? Number(b.cargo_id) : null, toISODate(b.admissao), toISODate(b.demissao),
    b.active ?? null, Number(req.params.id));
  res.json({ ok: true });
}));
app.delete('/api/employees/:id', requireRole('admin'), h(async (req, res) => {
  await db.run('DELETE FROM employees WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

// ---- Lançamentos de treinamento ----
app.get('/api/records/:employeeId', requireAuth, h(async (req, res) => {
  if (!await employeeInScope(req.user, req.params.employeeId)) {
    return res.status(403).json({ error: 'Este colaborador não faz parte da sua equipe' });
  }
  const rows = await db.all(`SELECT r.*, t.name AS training_name FROM records r
    JOIN trainings t ON t.id = r.training_id WHERE r.employee_id = ? ORDER BY r.realizacao DESC`,
    Number(req.params.employeeId));
  res.json(rows);
}));
app.post('/api/records', canEdit, h(async (req, res) => {
  const employeeId = Number(req.body.employee_id);
  const trainingId = Number(req.body.training_id);
  const realizacao = toISODate(req.body.realizacao);
  let vencimento = toISODate(req.body.vencimento);
  if (!employeeId || !trainingId || !realizacao) {
    return res.status(400).json({ error: 'Colaborador, treinamento e data de realização são obrigatórios' });
  }
  if (!vencimento) {
    const t = await db.get('SELECT validade_meses FROM trainings WHERE id = ?', trainingId);
    if (t && t.validade_meses) {
      const d = new Date(realizacao + 'T12:00:00');
      d.setMonth(d.getMonth() + t.validade_meses);
      vencimento = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
  }
  const r = await db.run('INSERT INTO records (employee_id, training_id, realizacao, vencimento, obs) VALUES (?, ?, ?, ?, ?)',
    employeeId, trainingId, realizacao, vencimento, req.body.obs || null);
  res.json({ ok: true, id: r.lastInsertRowid, vencimento });
}));
app.put('/api/records/:id', canEdit, h(async (req, res) => {
  await db.run('UPDATE records SET realizacao = COALESCE(?, realizacao), vencimento = COALESCE(?, vencimento), obs = COALESCE(?, obs) WHERE id = ?',
    toISODate(req.body.realizacao), toISODate(req.body.vencimento), req.body.obs ?? null, Number(req.params.id));
  res.json({ ok: true });
}));
app.delete('/api/records/:id', canEdit, h(async (req, res) => {
  await db.run('DELETE FROM records WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

// ---- Exigências individuais ----
app.get('/api/requirements/:employeeId', requireAuth, h(async (req, res) => {
  if (!await employeeInScope(req.user, req.params.employeeId)) {
    return res.status(403).json({ error: 'Este colaborador não faz parte da sua equipe' });
  }
  const rows = await db.all(`SELECT r.training_id, t.name AS training_name FROM requirements r
    JOIN trainings t ON t.id = r.training_id WHERE r.employee_id = ? ORDER BY t.name`,
    Number(req.params.employeeId));
  res.json(rows);
}));
app.post('/api/requirements', canEdit, h(async (req, res) => {
  const employeeId = Number(req.body.employee_id), trainingId = Number(req.body.training_id);
  if (!employeeId || !trainingId) return res.status(400).json({ error: 'Colaborador e treinamento obrigatórios' });
  await db.run('INSERT OR IGNORE INTO requirements (employee_id, training_id) VALUES (?, ?)', employeeId, trainingId);
  res.json({ ok: true });
}));
app.delete('/api/requirements/:employeeId/:trainingId', canEdit, h(async (req, res) => {
  await db.run('DELETE FROM requirements WHERE employee_id = ? AND training_id = ?',
    Number(req.params.employeeId), Number(req.params.trainingId));
  res.json({ ok: true });
}));

// ---- Usuários e acessos ----
const canManageUsers = requireRole('admin', 'supervisor');
app.get('/api/users', canManageUsers, h(async (req, res) => {
  const [users, teams] = await Promise.all([
    db.all('SELECT id, name, email, role, active, created_at FROM users ORDER BY name'),
    db.all('SELECT user_id, employee_id FROM team_members'),
  ]);
  res.json({ users, teams });
}));
app.post('/api/users', canManageUsers, h(async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'Preencha nome, e-mail, senha e perfil' });
  if (!['admin', 'supervisor', 'gestor', 'lider'].includes(role)) return res.status(400).json({ error: 'Perfil inválido' });
  if (role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas a administradora pode criar outros administradores' });
  if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres' });
  try {
    const r = await db.run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      cleanName(name), String(email).trim(), bcrypt.hashSync(String(password), 10), role);
    const id = r.lastInsertRowid;
    if (role === 'lider' && Array.isArray(req.body.team) && req.body.team.length) {
      await db.batch(req.body.team.map(eid =>
        ['INSERT OR IGNORE INTO team_members (user_id, employee_id) VALUES (?, ?)', id, Number(eid)]));
    }
    res.json({ ok: true, id });
  } catch { res.status(400).json({ error: 'Já existe um usuário com este e-mail' }); }
}));
app.put('/api/users/:id', canManageUsers, h(async (req, res) => {
  const id = Number(req.params.id);
  const target = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (target.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Sem permissão para alterar administradores' });
  const b = req.body;
  if (b.role && !['admin', 'supervisor', 'gestor', 'lider'].includes(b.role)) return res.status(400).json({ error: 'Perfil inválido' });
  if (b.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas a administradora pode promover a administrador' });
  await db.run('UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?',
    b.name ? cleanName(b.name) : null, b.email ? String(b.email).trim() : null, b.role ?? null, b.active ?? null, id);
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres' });
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(String(b.password), 10), id);
  }
  if (Array.isArray(b.team)) {
    const stmts = [['DELETE FROM team_members WHERE user_id = ?', id]];
    for (const eid of b.team) stmts.push(['INSERT OR IGNORE INTO team_members (user_id, employee_id) VALUES (?, ?)', id, Number(eid)]);
    await db.batch(stmts);
  }
  res.json({ ok: true });
}));
app.delete('/api/users/:id', requireRole('admin'), h(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Você não pode excluir o próprio usuário' });
  await db.run('DELETE FROM users WHERE id = ?', id);
  res.json({ ok: true });
}));

// ---- Importação e exportação ----
app.post('/api/import', canEdit, upload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envie um arquivo .xlsx' });
  try {
    const stats = await importWorkbook(req.file.buffer, { clearRecords: req.body.clear === '1' });
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(400).json({ error: 'Falha na importação: ' + e.message });
  }
}));
app.get('/api/export', requireAuth, h(async (req, res) => {
  const buf = await exportWorkbook(await scopeFor(req.user));
  const name = 'Balanço Normativos ' + todayISO().split('-').reverse().join('_') + '.xlsx';
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(name) + '"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}));

// ---- Páginas ----
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
  console.error('Erro não tratado:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Erro interno no servidor' });
});

// ---- Inicialização ----
// Só sobe um servidor quando executado direto (`node server.js`). Em hospedagem
// serverless o arquivo é apenas importado e o `app` é usado como handler.
async function startLocal() {
  await ensureReady();
  const { c } = await db.get('SELECT COUNT(*) c FROM employees');
  if (c === 0) {
    const seedFile = process.env.SEED_XLSX || path.join(__dirname, '..', 'Balanço Normativos Att 05_08_26.xlsx');
    if (fs.existsSync(seedFile)) {
      console.log('Importando dados iniciais de: ' + seedFile);
      console.log('Carga inicial:', JSON.stringify(await importWorkbook(fs.readFileSync(seedFile))));
    }
  }
  const vinculados = await linkCargoTrails();
  if (vinculados) console.log(vinculados + ' cargos vinculados automaticamente à trilha do cargo-base.');

  app.listen(PORT, HOST, () => {
    console.log('Painel Riva rodando na porta ' + PORT + (BEHIND_PROXY ? ' (atrás de proxy HTTPS)' : ''));
    console.log('Acesso local: http://localhost:' + PORT);
    if (!BEHIND_PROXY) {
      for (const [nome, addrs] of Object.entries(require('os').networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal) console.log('Acesso na rede (' + nome + '): http://' + a.address + ':' + PORT);
        }
      }
    }
  });
}

if (require.main === module) {
  startLocal().catch(err => { console.error('Falha ao iniciar:', err); process.exit(1); });
}

module.exports = app;
