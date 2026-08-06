'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const db = require('./src/db');
const { importWorkbook, linkCargoTrails } = require('./src/importer');
const { exportWorkbook } = require('./src/exporter');
const { buildDataset, todayISO } = require('./src/dataset');
const { cleanName, toISODate, shortCompanyName } = require('./src/normalize');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// Em hospedagem (Render, Railway, etc.) o tráfego chega por um proxy HTTPS.
// BEHIND_PROXY faz o Express confiar no X-Forwarded-Proto e marcar o cookie como
// Secure, para a sessão nunca trafegar fora de uma conexão criptografada.
const BEHIND_PROXY = process.env.BEHIND_PROXY === '1' || process.env.NODE_ENV === 'production';

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
// Na hospedagem o segredo vem de SESSION_SECRET; localmente é gerado uma vez e
// guardado em data/secret.txt para as sessões sobreviverem a reinícios.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretPath = path.join(__dirname, 'data', 'secret.txt');
  try {
    if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, crypto.randomBytes(32).toString('hex'));
    return fs.readFileSync(secretPath, 'utf8');
  } catch (e) {
    console.warn('Não foi possível gravar data/secret.txt (' + e.code + '). ' +
      'Usando segredo temporário — defina SESSION_SECRET para manter as sessões entre reinícios.');
    return crypto.randomBytes(32).toString('hex');
  }
}

app.use(session({
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: BEHIND_PROXY, maxAge: 12 * 60 * 60 * 1000 },
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ---- Seed do administrador inicial ----
function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count === 0) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'trocar123', 10);
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run('Ana Cláudia', process.env.ADMIN_EMAIL || 'departamentopessoalriva@gmail.com', hash);
    console.log('Usuário administrador criado.');
  }
}

// ---- Carga inicial da planilha, se o banco estiver vazio ----
function seedData() {
  const count = db.prepare('SELECT COUNT(*) c FROM employees').get().c;
  if (count > 0) return;
  const seedFile = process.env.SEED_XLSX || path.join(__dirname, '..', 'Balanço Normativos Att 05_08_26.xlsx');
  if (fs.existsSync(seedFile)) {
    console.log('Importando dados iniciais de: ' + seedFile);
    const stats = importWorkbook(fs.readFileSync(seedFile));
    console.log('Carga inicial concluída:', JSON.stringify(stats));
  }
}

// ---- Autenticação ----
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Não autenticado' });
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Não autenticado' });
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.userId);
    if (!user || !roles.includes(user.role)) return res.status(403).json({ error: 'Sem permissão' });
    req.user = user;
    next();
  };
}

// Bloqueia tentativas repetidas de adivinhar senha: 8 falhas em 15 minutos,
// contadas por IP + e-mail, travam novas tentativas por 15 minutos.
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map();

function loginKey(req, email) {
  return (req.ip || 'sem-ip') + '|' + String(email || '').trim().toLowerCase();
}
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
}
setInterval(() => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [k, v] of loginFails) if (v.first < cutoff) loginFails.delete(k);
}, LOGIN_WINDOW_MS).unref();

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const key = loginKey(req, email);
  if (isLocked(key)) {
    return res.status(429).json({ error: 'Muitas tentativas de acesso. Aguarde 15 minutos e tente novamente.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    registerFail(key);
    return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  }
  loginFails.delete(key);
  // Renova o id da sessão no login para impedir fixação de sessão.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Falha ao iniciar a sessão' });
    req.session.userId = user.id;
    res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.session.userId);
  if (!u) return res.status(401).json({ error: 'Não autenticado' });
  res.json(u);
});

app.post('/api/me/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) return res.status(400).json({ error: 'Senha atual incorreta' });
  if (!next || String(next).length < 6) return res.status(400).json({ error: 'A nova senha deve ter ao menos 6 caracteres' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(next), 10), u.id);
  res.json({ ok: true });
});

// ---- Alcance de visibilidade ----
// Líder enxerga apenas a equipe atribuída a ele; os demais perfis veem tudo.
// Retorna null quando não há restrição.
function scopeFor(user) {
  if (!user || user.role !== 'lider') return null;
  return db.prepare('SELECT employee_id FROM team_members WHERE user_id = ?').all(user.id).map(r => r.employee_id);
}
function currentUser(req) {
  return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.userId);
}
// Barra o acesso a um colaborador fora do alcance do usuário logado.
function requireEmployeeInScope(req, res, employeeId) {
  const user = currentUser(req);
  if (!user) { res.status(401).json({ error: 'Não autenticado' }); return false; }
  const scope = scopeFor(user);
  if (scope && !scope.includes(Number(employeeId))) {
    res.status(403).json({ error: 'Este colaborador não faz parte da sua equipe' });
    return false;
  }
  return true;
}

// ---- Painel (dataset) ----
app.get('/api/dataset', requireAuth, (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const ds = buildDataset(scopeFor(user));
  ds.user = { id: user.id, name: user.name, role: user.role };
  res.json(ds);
});

// ---- CRUD (admin e supervisor) ----
const canEdit = requireRole('admin', 'supervisor');

app.post('/api/companies', canEdit, (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const id = Number(db.prepare('INSERT INTO companies (name, short_name, sort_order) VALUES (?, ?, ?)')
      .run(name, cleanName(req.body.short_name) || shortCompanyName(name), Number(req.body.sort_order) || 100).lastInsertRowid);
    res.json({ ok: true, id });
  } catch { res.status(400).json({ error: 'Empresa já existe' }); }
});
app.put('/api/companies/:id', canEdit, (req, res) => {
  db.prepare(`UPDATE companies SET name = COALESCE(?, name), short_name = COALESCE(?, short_name),
    sort_order = COALESCE(?, sort_order), active = COALESCE(?, active) WHERE id = ?`)
    .run(req.body.name ? cleanName(req.body.name) : null,
         req.body.short_name ? cleanName(req.body.short_name) : null,
         req.body.sort_order ?? null, req.body.active ?? null, Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/companies/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) c FROM employees WHERE company_id = ?').get(id).c;
  if (used > 0) return res.status(400).json({ error: 'Há colaboradores vinculados a esta empresa. Exclua ou transfira antes.' });
  db.prepare('DELETE FROM cargos WHERE company_id = ?').run(id);
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/cargos', canEdit, (req, res) => {
  const name = cleanName(req.body.name);
  const companyId = Number(req.body.company_id);
  if (!name || !companyId) return res.status(400).json({ error: 'Nome e empresa obrigatórios' });
  try {
    const id = Number(db.prepare('INSERT INTO cargos (name, company_id) VALUES (?, ?)').run(name, companyId).lastInsertRowid);
    res.json({ ok: true, id });
  } catch { res.status(400).json({ error: 'Cargo já existe nesta empresa' }); }
});
app.put('/api/cargos/:id', canEdit, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE cargos SET name = COALESCE(?, name) WHERE id = ?')
    .run(req.body.name ? cleanName(req.body.name) : null, id);
  if ('trail_source_id' in req.body) {
    const src = req.body.trail_source_id ? Number(req.body.trail_source_id) : null;
    if (src === id) return res.status(400).json({ error: 'Um cargo não pode herdar a trilha de si mesmo' });
    db.prepare('UPDATE cargos SET trail_source_id = ? WHERE id = ?').run(src, id);
  }
  if (Array.isArray(req.body.trail_training_ids)) {
    db.prepare('DELETE FROM trails WHERE cargo_id = ?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO trails (cargo_id, training_id) VALUES (?, ?)');
    for (const tid of req.body.trail_training_ids) ins.run(id, Number(tid));
  }
  res.json({ ok: true });
});
app.delete('/api/cargos/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) c FROM employees WHERE cargo_id = ?').get(id).c;
  if (used > 0) return res.status(400).json({ error: 'Há colaboradores com este cargo. Altere-os antes.' });
  db.prepare('DELETE FROM cargos WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/trainings', canEdit, (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const { trainingKey } = require('./src/normalize');
  try {
    const id = Number(db.prepare(`INSERT INTO trainings (name, norm_key, ch_formacao, ch_reciclagem, validade_meses, criterio, fonte, custo_formacao, custo_reciclagem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      name, trainingKey(name),
      req.body.ch_formacao ?? null, req.body.ch_reciclagem ?? null, req.body.validade_meses ?? null,
      req.body.criterio ?? null, req.body.fonte ?? null,
      req.body.custo_formacao ?? 0, req.body.custo_reciclagem ?? 0).lastInsertRowid);
    res.json({ ok: true, id });
  } catch { res.status(400).json({ error: 'Treinamento já existe' }); }
});
app.put('/api/trainings/:id', canEdit, (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE trainings SET name = COALESCE(?, name), ch_formacao = COALESCE(?, ch_formacao),
    ch_reciclagem = COALESCE(?, ch_reciclagem), validade_meses = COALESCE(?, validade_meses),
    criterio = COALESCE(?, criterio), fonte = COALESCE(?, fonte),
    custo_formacao = COALESCE(?, custo_formacao), custo_reciclagem = COALESCE(?, custo_reciclagem),
    active = COALESCE(?, active) WHERE id = ?`)
    .run(b.name ? cleanName(b.name) : null, b.ch_formacao ?? null, b.ch_reciclagem ?? null,
         b.validade_meses ?? null, b.criterio ?? null, b.fonte ?? null,
         b.custo_formacao ?? null, b.custo_reciclagem ?? null, b.active ?? null, Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/trainings/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) c FROM records WHERE training_id = ?').get(id).c;
  if (used > 0) return res.status(400).json({ error: 'Há lançamentos para este treinamento. Exclua-os antes ou desative o treinamento.' });
  db.prepare('DELETE FROM trails WHERE training_id = ?').run(id);
  db.prepare('DELETE FROM trainings WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/employees', canEdit, (req, res) => {
  const name = cleanName(req.body.name);
  const companyId = Number(req.body.company_id);
  if (!name || !companyId) return res.status(400).json({ error: 'Nome e empresa obrigatórios' });
  try {
    const id = Number(db.prepare('INSERT INTO employees (name, company_id, cargo_id, admissao, demissao) VALUES (?, ?, ?, ?, ?)')
      .run(name, companyId, req.body.cargo_id ? Number(req.body.cargo_id) : null,
           toISODate(req.body.admissao), toISODate(req.body.demissao)).lastInsertRowid);
    res.json({ ok: true, id });
  } catch { res.status(400).json({ error: 'Colaborador já existe nesta empresa' }); }
});
app.put('/api/employees/:id', canEdit, (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE employees SET name = COALESCE(?, name), company_id = COALESCE(?, company_id),
    cargo_id = ?, admissao = ?, demissao = ?, active = COALESCE(?, active) WHERE id = ?`)
    .run(b.name ? cleanName(b.name) : null, b.company_id ? Number(b.company_id) : null,
         b.cargo_id ? Number(b.cargo_id) : null, toISODate(b.admissao), toISODate(b.demissao),
         b.active ?? null, Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/employees/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM employees WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Lançamentos de treinamento ----
app.get('/api/records/:employeeId', requireAuth, (req, res) => {
  if (!requireEmployeeInScope(req, res, req.params.employeeId)) return;
  const rows = db.prepare(`SELECT r.*, t.name AS training_name FROM records r
    JOIN trainings t ON t.id = r.training_id WHERE r.employee_id = ? ORDER BY r.realizacao DESC`).all(Number(req.params.employeeId));
  res.json(rows);
});
app.post('/api/records', canEdit, (req, res) => {
  const employeeId = Number(req.body.employee_id);
  const trainingId = Number(req.body.training_id);
  const realizacao = toISODate(req.body.realizacao);
  let vencimento = toISODate(req.body.vencimento);
  if (!employeeId || !trainingId || !realizacao) return res.status(400).json({ error: 'Colaborador, treinamento e data de realização são obrigatórios' });
  if (!vencimento) {
    const t = db.prepare('SELECT validade_meses FROM trainings WHERE id = ?').get(trainingId);
    if (t && t.validade_meses) {
      const d = new Date(realizacao + 'T12:00:00');
      d.setMonth(d.getMonth() + t.validade_meses);
      vencimento = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
  }
  const id = Number(db.prepare('INSERT INTO records (employee_id, training_id, realizacao, vencimento, obs) VALUES (?, ?, ?, ?, ?)')
    .run(employeeId, trainingId, realizacao, vencimento, req.body.obs || null).lastInsertRowid);
  res.json({ ok: true, id, vencimento });
});
app.put('/api/records/:id', canEdit, (req, res) => {
  db.prepare('UPDATE records SET realizacao = COALESCE(?, realizacao), vencimento = COALESCE(?, vencimento), obs = COALESCE(?, obs) WHERE id = ?')
    .run(toISODate(req.body.realizacao), toISODate(req.body.vencimento), req.body.obs ?? null, Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/records/:id', canEdit, (req, res) => {
  db.prepare('DELETE FROM records WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Exigências individuais (treinamento cobrado de uma pessoa específica) ----
app.get('/api/requirements/:employeeId', requireAuth, (req, res) => {
  if (!requireEmployeeInScope(req, res, req.params.employeeId)) return;
  const rows = db.prepare(`SELECT r.training_id, t.name AS training_name FROM requirements r
    JOIN trainings t ON t.id = r.training_id WHERE r.employee_id = ? ORDER BY t.name`).all(Number(req.params.employeeId));
  res.json(rows);
});
app.post('/api/requirements', canEdit, (req, res) => {
  const employeeId = Number(req.body.employee_id), trainingId = Number(req.body.training_id);
  if (!employeeId || !trainingId) return res.status(400).json({ error: 'Colaborador e treinamento obrigatórios' });
  db.prepare('INSERT OR IGNORE INTO requirements (employee_id, training_id) VALUES (?, ?)').run(employeeId, trainingId);
  res.json({ ok: true });
});
app.delete('/api/requirements/:employeeId/:trainingId', canEdit, (req, res) => {
  db.prepare('DELETE FROM requirements WHERE employee_id = ? AND training_id = ?')
    .run(Number(req.params.employeeId), Number(req.params.trainingId));
  res.json({ ok: true });
});

// ---- Usuários e acessos ----
const canManageUsers = requireRole('admin', 'supervisor');
app.get('/api/users', canManageUsers, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY name').all();
  const teams = db.prepare('SELECT user_id, employee_id FROM team_members').all();
  res.json({ users, teams });
});
app.post('/api/users', canManageUsers, (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'Preencha nome, e-mail, senha e perfil' });
  if (!['admin', 'supervisor', 'gestor', 'lider'].includes(role)) return res.status(400).json({ error: 'Perfil inválido' });
  if (role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas a administradora pode criar outros administradores' });
  try {
    const id = Number(db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(cleanName(name), String(email).trim(), bcrypt.hashSync(String(password), 10), role).lastInsertRowid);
    if (role === 'lider' && Array.isArray(req.body.team)) {
      const ins = db.prepare('INSERT OR IGNORE INTO team_members (user_id, employee_id) VALUES (?, ?)');
      for (const eid of req.body.team) ins.run(id, Number(eid));
    }
    res.json({ ok: true, id });
  } catch { res.status(400).json({ error: 'Já existe um usuário com este e-mail' }); }
});
app.put('/api/users/:id', canManageUsers, (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (target.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Sem permissão para alterar administradores' });
  const b = req.body;
  if (b.role && !['admin', 'supervisor', 'gestor', 'lider'].includes(b.role)) return res.status(400).json({ error: 'Perfil inválido' });
  if (b.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas a administradora pode promover a administrador' });
  db.prepare('UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?')
    .run(b.name ? cleanName(b.name) : null, b.email ? String(b.email).trim() : null, b.role ?? null, b.active ?? null, id);
  if (b.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(b.password), 10), id);
  if (Array.isArray(b.team)) {
    db.prepare('DELETE FROM team_members WHERE user_id = ?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO team_members (user_id, employee_id) VALUES (?, ?)');
    for (const eid of b.team) ins.run(id, Number(eid));
  }
  res.json({ ok: true });
});
app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Você não pode excluir o próprio usuário' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- Importação e exportação ----
app.post('/api/import', canEdit, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envie um arquivo .xlsx' });
  try {
    const stats = importWorkbook(req.file.buffer, { clearRecords: req.body.clear === '1' });
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(400).json({ error: 'Falha na importação: ' + e.message });
  }
});
app.get('/api/export', requireAuth, (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const buf = exportWorkbook(scopeFor(user));
  const name = 'Balanço Normativos ' + todayISO().split('-').reverse().join('_') + '.xlsx';
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(name) + '"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ---- Páginas ----
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

seedAdmin();
seedData();
const vinculados = linkCargoTrails();
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
