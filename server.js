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
const perms = require('./src/perms');
const { gerarTabelaPDF } = require('./src/pdf');

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
  // Indicadores nunca podem vir de cache: um lançamento tem que aparecer na
  // consulta seguinte, mesmo com CDN na frente.
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  }
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
        // trim() também remove o BOM (U+FEFF) que ferramentas de linha de comando
        // no Windows costumam anexar ao gravar variáveis de ambiente.
        const limpo = (v, padrao) => (v || padrao).trim();
        const hash = bcrypt.hashSync(limpo(process.env.ADMIN_PASSWORD, 'trocar123'), 10);
        await db.run("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
          limpo(process.env.ADMIN_NAME, 'Administradora'),
          limpo(process.env.ADMIN_EMAIL, 'departamentopessoalriva@gmail.com'), hash);
        console.log('Usuário administrador criado.');
      }
    })().catch(err => { readyPromise = null; throw err; });
  }
  return readyPromise;
}
app.use(h(async (req, res, next) => { await ensureReady(); next(); }));

// ---- Autenticação e permissões ----
// O usuário carrega o perfil junto. As permissões vêm do perfil, exceto para a
// administradora original, que mantém acesso total mesmo que o perfil seja alterado
// — assim não há como o sistema ficar sem ninguém capaz de administrá-lo.
// ---- Acesso do gestor, sem login ----
// Um clique na tela de entrada abre uma sessão somente-leitura, limitada aos
// painéis de indicadores e aos avisos. Pode ser desligado pela administradora.
async function acessoGestorLiberado() {
  const r = await db.get("SELECT valor FROM settings WHERE chave = 'acesso_gestor'");
  return !r || r.valor !== 'off';   // liberado por padrão
}
// As permissões do gestor vêm do perfil "Gestor (sem login)", que a
// administradora edita. Por segurança, nada que altere dados é aceito aqui,
// por mais que o perfil seja marcado — quem não se identifica não escreve.
async function usuarioGestorPublico() {
  const perfil = await db.get('SELECT * FROM profiles WHERE name = ?', perms.GESTOR_PUBLICO.nome);
  const config = perfil ? perms.normalizar(perfil.permissions) : perms.permsGestorPublico();
  for (const k of perms.NEGADAS_SEM_LOGIN) config[k] = false;
  return {
    id: null, name: 'Gestor', email: null, role: 'gestor_publico',
    profile_name: 'Gestor (visualização)', convidado: true,
    perms: config, scope: 'all',
  };
}

async function currentUser(req) {
  if (req.session && req.session.convidado) {
    return (await acessoGestorLiberado()) ? await usuarioGestorPublico() : null;
  }
  if (!req.session || !req.session.userId) return null;
  const user = await db.get(`SELECT u.*, p.name AS profile_name, p.scope AS profile_scope,
      p.permissions AS profile_permissions
    FROM users u LEFT JOIN profiles p ON p.id = u.profile_id
    WHERE u.id = ? AND u.active = 1`, req.session.userId);
  if (!user) return null;
  user.perms = user.role === 'admin'
    ? Object.fromEntries(perms.TODAS.map(k => [k, true]))
    : perms.normalizar(user.profile_permissions);
  user.scope = user.role === 'admin' ? 'all' : (user.profile_scope || 'all');
  return user;
}
const requireAuth = h(async (req, res, next) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  req.user = user;
  next();
});
// Rotas que o acesso sem login não deve alcançar, mesmo sendo de leitura:
// detalhe individual de colaborador e qualquer coisa ligada à conta.
const semConvidado = h(async (req, res, next) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  if (user.convidado) return res.status(403).json({ error: 'Disponível apenas para usuários com login' });
  req.user = user;
  next();
});

// Exige uma permissão. Aceita várias chaves: basta ter uma delas.
function requirePerm(...chaves) {
  return h(async (req, res, next) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });
    if (!chaves.some(k => user.perms[k])) {
      return res.status(403).json({ error: 'Seu perfil de acesso não permite esta ação' });
    }
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

// Entrada do gestor: um clique, sem credenciais.
app.get('/api/acesso-gestor', h(async (req, res) => {
  res.json({ liberado: await acessoGestorLiberado() });
}));
app.post('/api/acesso-gestor', h(async (req, res) => {
  if (!await acessoGestorLiberado()) {
    return res.status(403).json({ error: 'O acesso de visualização está desativado. Use seu login.' });
  }
  req.session = { convidado: true };
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
});

app.post('/api/me/password', semConvidado, h(async (req, res) => {
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
  if (!user || user.scope !== 'team') return null;
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
  ds.user = {
    id: req.user.id, name: req.user.name, role: req.user.role,
    profile: req.user.profile_name || null,
    perms: req.user.perms, scope: req.user.scope,
    convidado: !!req.user.convidado,
  };
  res.json(ds);
}));

// Marcador leve de "mudou alguma coisa?", para a tela conferir de tempos em tempos
// sem precisar baixar o painel inteiro.
app.get('/api/status', requireAuth, h(async (req, res) => {
  const r = await db.get(`SELECT
      (SELECT MAX(created_at) FROM records) AS ultimo,
      (SELECT COUNT(*) FROM records) AS lancamentos,
      (SELECT COUNT(*) FROM employees WHERE active = 1) AS colaboradores,
      (SELECT COUNT(*) FROM requirements) AS exigencias`);
  res.json({
    ultimoLancamento: r.ultimo || null,
    assinatura: [r.ultimo || '', r.lancamentos, r.colaboradores, r.exigencias].join('|'),
  });
}));

// ---- Avisos aos gestores ----
const podePublicar = requirePerm('publicar_avisos');

app.get('/api/avisos', requirePerm('avisos'), h(async (req, res) => {
  // Quem publica enxerga também os comunicados retirados do ar.
  const todos = req.user.perms.publicar_avisos;
  const linhas = await db.all(
    'SELECT * FROM avisos' + (todos ? '' : ' WHERE ativo = 1') +
    ' ORDER BY fixado DESC, criado_em DESC');
  res.json({ avisos: linhas, podePublicar: !!todos });
}));

app.post('/api/avisos', podePublicar, h(async (req, res) => {
  const titulo = cleanName(req.body.titulo);
  const texto = String(req.body.texto || '').trim();
  if (!titulo || !texto) return res.status(400).json({ error: 'Preencha o título e o texto do comunicado' });
  const prioridade = ['normal', 'importante', 'urgente'].includes(req.body.prioridade) ? req.body.prioridade : 'normal';
  const r = await db.run(`INSERT INTO avisos (titulo, texto, prioridade, ativo, fixado, autor)
    VALUES (?, ?, ?, ?, ?, ?)`,
    titulo, texto, prioridade, req.body.ativo === false ? 0 : 1, req.body.fixado ? 1 : 0, req.user.name);
  await registrar(req, 'Aviso publicado', { detalhe: titulo });
  res.json({ ok: true, id: r.lastInsertRowid });
}));

app.put('/api/avisos/:id', podePublicar, h(async (req, res) => {
  const id = Number(req.params.id);
  const antes = await db.get('SELECT * FROM avisos WHERE id = ?', id);
  if (!antes) return res.status(404).json({ error: 'Aviso não encontrado' });
  const prioridade = ['normal', 'importante', 'urgente'].includes(req.body.prioridade) ? req.body.prioridade : null;
  await db.run(`UPDATE avisos SET titulo = COALESCE(?, titulo), texto = COALESCE(?, texto),
    prioridade = COALESCE(?, prioridade), ativo = COALESCE(?, ativo), fixado = COALESCE(?, fixado),
    atualizado_em = datetime('now') WHERE id = ?`,
    req.body.titulo ? cleanName(req.body.titulo) : null,
    req.body.texto !== undefined ? String(req.body.texto).trim() : null,
    prioridade,
    req.body.ativo === undefined ? null : (req.body.ativo ? 1 : 0),
    req.body.fixado === undefined ? null : (req.body.fixado ? 1 : 0), id);
  await registrar(req, 'Aviso alterado', { detalhe: antes.titulo });
  res.json({ ok: true });
}));

app.delete('/api/avisos/:id', podePublicar, h(async (req, res) => {
  const antes = await db.get('SELECT titulo FROM avisos WHERE id = ?', Number(req.params.id));
  await db.run('DELETE FROM avisos WHERE id = ?', Number(req.params.id));
  if (antes) await registrar(req, 'Aviso excluído', { detalhe: antes.titulo });
  res.json({ ok: true });
}));

// ---- Configurações ----
async function estadoConfig() {
  const gestor = await usuarioGestorPublico();
  return {
    acessoGestor: await acessoGestorLiberado(),
    permsGestor: gestor.perms,
    // O que não pode ser concedido a quem entra sem se identificar.
    bloqueadas: perms.NEGADAS_SEM_LOGIN,
    catalogo: { paineis: perms.PAINEIS, acoes: perms.ACOES },
  };
}

app.get('/api/config', requirePerm('config'), h(async (req, res) => {
  res.json(await estadoConfig());
}));

app.put('/api/config', requirePerm('config'), h(async (req, res) => {
  if (req.body.acessoGestor !== undefined) {
    const valor = req.body.acessoGestor ? 'on' : 'off';
    await db.run(`INSERT INTO settings (chave, valor) VALUES ('acesso_gestor', ?)
      ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`, valor);
    await registrar(req, 'Configuração alterada', {
      detalhe: 'acesso do gestor sem login: ' + (valor === 'on' ? 'liberado' : 'desativado') });
  }

  if (req.body.permsGestor) {
    const novas = perms.normalizar(req.body.permsGestor);
    for (const k of perms.NEGADAS_SEM_LOGIN) novas[k] = false;
    const antes = (await usuarioGestorPublico()).perms;
    await db.run('UPDATE profiles SET permissions = ? WHERE name = ?',
      JSON.stringify(novas), perms.GESTOR_PUBLICO.nome);
    const mudou = perms.TODAS.filter(k => !!antes[k] !== !!novas[k])
      .map(k => (novas[k] ? '+' : '-') + k);
    if (mudou.length) {
      await registrar(req, 'Permissões do gestor alteradas', { detalhe: mudou.join(' ') });
    }
  }
  res.json({ ok: true, ...(await estadoConfig()) });
}));

// ---- Perfis de acesso ----
const podePerfis = requirePerm('perfis');

app.get('/api/profiles', requirePerm('perfis', 'usuarios'), h(async (req, res) => {
  const rows = await db.all('SELECT * FROM profiles ORDER BY is_system DESC, name');
  const usos = await db.all('SELECT profile_id, COUNT(*) c FROM users GROUP BY profile_id');
  const porPerfil = new Map(usos.map(u => [u.profile_id, u.c]));
  res.json({
    profiles: rows.map(p => ({ ...p, permissions: perms.normalizar(p.permissions), usuarios: porPerfil.get(p.id) || 0 })),
    catalogo: { paineis: perms.PAINEIS, acoes: perms.ACOES },
  });
}));

app.post('/api/profiles', podePerfis, h(async (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Dê um nome ao perfil' });
  const scope = req.body.scope === 'team' ? 'team' : 'all';
  try {
    const r = await db.run('INSERT INTO profiles (name, description, scope, permissions, is_system) VALUES (?, ?, ?, ?, 0)',
      name, cleanName(req.body.description) || null, scope, JSON.stringify(perms.normalizar(req.body.permissions)));
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch { res.status(400).json({ error: 'Já existe um perfil com este nome' }); }
}));

app.put('/api/profiles/:id', podePerfis, h(async (req, res) => {
  const id = Number(req.params.id);
  const alvo = await db.get('SELECT * FROM profiles WHERE id = ?', id);
  if (!alvo) return res.status(404).json({ error: 'Perfil não encontrado' });

  // O perfil da administradora não pode perder permissões, senão o sistema fica
  // sem ninguém capaz de administrá-lo.
  const permissoes = alvo.name === 'Administradora'
    ? Object.fromEntries(perms.TODAS.map(k => [k, true]))
    : perms.normalizar(req.body.permissions);
  const scope = alvo.name === 'Administradora' ? 'all' : (req.body.scope === 'team' ? 'team' : 'all');
  const nome = alvo.is_system ? alvo.name : (cleanName(req.body.name) || alvo.name);

  await db.run('UPDATE profiles SET name = ?, description = ?, scope = ?, permissions = ? WHERE id = ?',
    nome, req.body.description !== undefined ? cleanName(req.body.description) : alvo.description,
    scope, JSON.stringify(permissoes), id);
  res.json({ ok: true });
}));

app.delete('/api/profiles/:id', podePerfis, h(async (req, res) => {
  const id = Number(req.params.id);
  const alvo = await db.get('SELECT * FROM profiles WHERE id = ?', id);
  if (!alvo) return res.status(404).json({ error: 'Perfil não encontrado' });
  if (alvo.is_system) return res.status(400).json({ error: 'Os perfis padrão do sistema não podem ser excluídos' });
  const { c } = await db.get('SELECT COUNT(*) c FROM users WHERE profile_id = ?', id);
  if (c > 0) return res.status(400).json({ error: 'Há ' + c + ' usuário(s) com este perfil. Mude-os de perfil antes.' });
  await db.run('DELETE FROM profiles WHERE id = ?', id);
  res.json({ ok: true });
}));

// ---- CRUD, cada rota exigindo a permissão correspondente ----
const podeConfig = requirePerm('config');
const podeColaboradores = requirePerm('colaboradores');
const podeLancar = requirePerm('lancamentos');
const podeExcluir = requirePerm('excluir');

app.post('/api/companies', podeConfig, h(async (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const r = await db.run('INSERT INTO companies (name, short_name, sort_order) VALUES (?, ?, ?)',
      name, cleanName(req.body.short_name) || shortCompanyName(name), Number(req.body.sort_order) || 100);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch { res.status(400).json({ error: 'Empresa já existe' }); }
}));
app.put('/api/companies/:id', podeConfig, h(async (req, res) => {
  await db.run(`UPDATE companies SET name = COALESCE(?, name), short_name = COALESCE(?, short_name),
    sort_order = COALESCE(?, sort_order), active = COALESCE(?, active) WHERE id = ?`,
    req.body.name ? cleanName(req.body.name) : null,
    req.body.short_name ? cleanName(req.body.short_name) : null,
    req.body.sort_order ?? null, req.body.active ?? null, Number(req.params.id));
  res.json({ ok: true });
}));
app.delete('/api/companies/:id', podeExcluir, h(async (req, res) => {
  const id = Number(req.params.id);
  const { c } = await db.get('SELECT COUNT(*) c FROM employees WHERE company_id = ?', id);
  if (c > 0) return res.status(400).json({ error: 'Há colaboradores vinculados a esta empresa. Exclua ou transfira antes.' });
  await db.batch([['DELETE FROM cargos WHERE company_id = ?', id], ['DELETE FROM companies WHERE id = ?', id]]);
  res.json({ ok: true });
}));

app.post('/api/cargos', podeConfig, h(async (req, res) => {
  const name = cleanName(req.body.name);
  const companyId = Number(req.body.company_id);
  if (!name || !companyId) return res.status(400).json({ error: 'Nome e empresa obrigatórios' });
  try {
    const r = await db.run('INSERT INTO cargos (name, company_id) VALUES (?, ?)', name, companyId);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch { res.status(400).json({ error: 'Cargo já existe nesta empresa' }); }
}));
app.put('/api/cargos/:id', podeConfig, h(async (req, res) => {
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
app.delete('/api/cargos/:id', podeExcluir, h(async (req, res) => {
  const id = Number(req.params.id);
  const { c } = await db.get('SELECT COUNT(*) c FROM employees WHERE cargo_id = ?', id);
  if (c > 0) return res.status(400).json({ error: 'Há colaboradores com este cargo. Altere-os antes.' });
  await db.run('DELETE FROM cargos WHERE id = ?', id);
  res.json({ ok: true });
}));

app.post('/api/trainings', podeConfig, h(async (req, res) => {
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
app.put('/api/trainings/:id', podeConfig, h(async (req, res) => {
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
app.delete('/api/trainings/:id', podeExcluir, h(async (req, res) => {
  const id = Number(req.params.id);
  const { c } = await db.get('SELECT COUNT(*) c FROM records WHERE training_id = ?', id);
  if (c > 0) return res.status(400).json({ error: 'Há lançamentos para este treinamento. Exclua-os antes ou desative o treinamento.' });
  await db.batch([['DELETE FROM trails WHERE training_id = ?', id], ['DELETE FROM trainings WHERE id = ?', id]]);
  res.json({ ok: true });
}));

app.post('/api/employees', podeColaboradores, h(async (req, res) => {
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
app.put('/api/employees/:id', podeColaboradores, h(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const antes = await db.get(`SELECT e.*, c.name AS empresa, g.name AS cargo
    FROM employees e JOIN companies c ON c.id = e.company_id
    LEFT JOIN cargos g ON g.id = e.cargo_id WHERE e.id = ?`, id);
  await db.run(`UPDATE employees SET name = COALESCE(?, name), company_id = COALESCE(?, company_id),
    cargo_id = ?, admissao = ?, demissao = ?, active = COALESCE(?, active) WHERE id = ?`,
    b.name ? cleanName(b.name) : null, b.company_id ? Number(b.company_id) : null,
    b.cargo_id ? Number(b.cargo_id) : null, toISODate(b.admissao), toISODate(b.demissao),
    b.active ?? null, id);
  if (antes) {
    const depois = await db.get(`SELECT e.*, c.name AS empresa, g.name AS cargo
      FROM employees e JOIN companies c ON c.id = e.company_id
      LEFT JOIN cargos g ON g.id = e.cargo_id WHERE e.id = ?`, id);
    const mudou = [];
    if (antes.empresa !== depois.empresa) mudou.push('empresa: ' + antes.empresa + ' > ' + depois.empresa);
    if (antes.cargo !== depois.cargo) mudou.push('cargo: ' + (antes.cargo || '-') + ' > ' + (depois.cargo || '-'));
    if (antes.demissao !== depois.demissao) mudou.push('demissão: ' + (antes.demissao || '-') + ' > ' + (depois.demissao || '-'));
    if (mudou.length) await registrar(req, 'Colaborador alterado', { employeeId: id, detalhe: mudou.join(' · ') });
  }
  res.json({ ok: true });
}));
app.delete('/api/employees/:id', podeExcluir, h(async (req, res) => {
  await registrar(req, 'Colaborador excluído', { employeeId: Number(req.params.id) });
  await db.run('DELETE FROM employees WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

// ---- Histórico de alterações ----
// Registra quem fez o quê. Falha aqui nunca derruba a operação principal.
async function registrar(req, acao, { employeeId = null, trainingId = null, detalhe = null } = {}) {
  try {
    let colaborador = null, empresa = null, treinamento = null;
    if (employeeId) {
      const e = await db.get(`SELECT e.name, COALESCE(c.short_name, c.name) AS empresa
        FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.id = ?`, Number(employeeId));
      if (e) { colaborador = e.name; empresa = e.empresa; }
    }
    if (trainingId) {
      const t = await db.get('SELECT name FROM trainings WHERE id = ?', Number(trainingId));
      if (t) treinamento = t.name;
    }
    await db.run(`INSERT INTO activity_log (usuario, acao, colaborador, empresa, treinamento, detalhe)
      VALUES (?, ?, ?, ?, ?, ?)`,
      req.user ? req.user.name : null, acao, colaborador, empresa, treinamento, detalhe);
  } catch (e) {
    console.warn('Falha ao registrar no histórico: ' + e.message);
  }
}

app.get('/api/historico', requirePerm('lancamentos', 'usuarios'), h(async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 500, 2000);
  const linhas = await db.all(
    'SELECT * FROM activity_log ORDER BY quando DESC, id DESC LIMIT ?', limite);
  const { total } = await db.get('SELECT COUNT(*) total FROM activity_log');
  res.json({ linhas, total });
}));

app.get('/api/historico/pdf', requirePerm('lancamentos', 'usuarios'), h(async (req, res) => {
  const linhas = await db.all('SELECT * FROM activity_log ORDER BY quando DESC, id DESC LIMIT 5000');
  const fmt = (utc) => {
    if (!utc) return '';
    const d = new Date(utc.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return utc;
    const p = (n) => String(n).padStart(2, '0');
    // Horário de Brasília (UTC-3)
    const b = new Date(d.getTime() - 3 * 3600 * 1000);
    return p(b.getUTCDate()) + '/' + p(b.getUTCMonth() + 1) + '/' + b.getUTCFullYear() +
           ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes());
  };
  const buf = gerarTabelaPDF({
    titulo: 'Histórico de Lançamentos — Riva Stones',
    subtitulo: 'Gerado em ' + fmt(new Date().toISOString().replace('T', ' ').slice(0, 19)) +
      ' · ' + linhas.length + ' registro(s) · emitido por ' + (req.user ? req.user.name : ''),
    colunas: [
      { nome: 'Data/hora', largura: 11, campo: 'quando_br' },
      { nome: 'Ação', largura: 16, campo: 'acao' },
      { nome: 'Colaborador', largura: 21, campo: 'colaborador' },
      { nome: 'Empresa', largura: 15, campo: 'empresa' },
      { nome: 'Treinamento', largura: 20, campo: 'treinamento' },
      { nome: 'Detalhe', largura: 20, campo: 'detalhe' },
      { nome: 'Usuário', largura: 13, campo: 'usuario' },
    ],
    linhas: linhas.map(l => ({ ...l, quando_br: fmt(l.quando) })),
  });
  const nome = 'Historico de Lancamentos ' + todayISO().split('-').reverse().join('_') + '.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + nome + '"');
  res.send(buf);
}));

app.delete('/api/historico', requirePerm('excluir'), h(async (req, res) => {
  const antesDe = req.query.antes_de;   // 'AAAA-MM-DD' opcional
  if (antesDe && /^\d{4}-\d{2}-\d{2}$/.test(antesDe)) {
    const r = await db.run('DELETE FROM activity_log WHERE quando < ?', antesDe + ' 00:00:00');
    return res.json({ ok: true, removidos: r.rowsAffected });
  }
  const { total } = await db.get('SELECT COUNT(*) total FROM activity_log');
  await db.run('DELETE FROM activity_log');
  res.json({ ok: true, removidos: total });
}));

// ---- Lançamentos de treinamento ----
app.get('/api/records/:employeeId', semConvidado, h(async (req, res) => {
  if (!await employeeInScope(req.user, req.params.employeeId)) {
    return res.status(403).json({ error: 'Este colaborador não faz parte da sua equipe' });
  }
  const rows = await db.all(`SELECT r.*, t.name AS training_name FROM records r
    JOIN trainings t ON t.id = r.training_id WHERE r.employee_id = ? ORDER BY r.realizacao DESC`,
    Number(req.params.employeeId));
  res.json(rows);
}));
app.post('/api/records', podeLancar, h(async (req, res) => {
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
  await registrar(req, 'Lançamento registrado', { employeeId, trainingId,
    detalhe: 'realização ' + realizacao + (vencimento ? ' · vence em ' + vencimento : '') });
  res.json({ ok: true, id: r.lastInsertRowid, vencimento });
}));
app.put('/api/records/:id', podeLancar, h(async (req, res) => {
  const antes = await db.get('SELECT * FROM records WHERE id = ?', Number(req.params.id));
  await db.run('UPDATE records SET realizacao = COALESCE(?, realizacao), vencimento = COALESCE(?, vencimento), obs = COALESCE(?, obs) WHERE id = ?',
    toISODate(req.body.realizacao), toISODate(req.body.vencimento), req.body.obs ?? null, Number(req.params.id));
  if (antes) {
    const depois = await db.get('SELECT * FROM records WHERE id = ?', Number(req.params.id));
    const mudou = [];
    if (antes.realizacao !== depois.realizacao) mudou.push('realização ' + antes.realizacao + ' → ' + depois.realizacao);
    if (antes.vencimento !== depois.vencimento) mudou.push('vencimento ' + antes.vencimento + ' → ' + depois.vencimento);
    await registrar(req, 'Lançamento alterado', { employeeId: antes.employee_id, trainingId: antes.training_id,
      detalhe: mudou.join(' · ') || 'observação atualizada' });
  }
  res.json({ ok: true });
}));
app.delete('/api/records/:id', podeLancar, h(async (req, res) => {
  const antes = await db.get('SELECT * FROM records WHERE id = ?', Number(req.params.id));
  await db.run('DELETE FROM records WHERE id = ?', Number(req.params.id));
  if (antes) {
    await registrar(req, 'Lançamento excluído', { employeeId: antes.employee_id, trainingId: antes.training_id,
      detalhe: 'realização ' + antes.realizacao });
  }
  res.json({ ok: true });
}));

// ---- Exigências individuais ----
app.get('/api/requirements/:employeeId', semConvidado, h(async (req, res) => {
  if (!await employeeInScope(req.user, req.params.employeeId)) {
    return res.status(403).json({ error: 'Este colaborador não faz parte da sua equipe' });
  }
  const rows = await db.all(`SELECT r.training_id, t.name AS training_name FROM requirements r
    JOIN trainings t ON t.id = r.training_id WHERE r.employee_id = ? ORDER BY t.name`,
    Number(req.params.employeeId));
  res.json(rows);
}));
app.post('/api/requirements', podeLancar, h(async (req, res) => {
  const employeeId = Number(req.body.employee_id), trainingId = Number(req.body.training_id);
  if (!employeeId || !trainingId) return res.status(400).json({ error: 'Colaborador e treinamento obrigatórios' });
  await db.run('INSERT OR IGNORE INTO requirements (employee_id, training_id) VALUES (?, ?)', employeeId, trainingId);
  res.json({ ok: true });
}));
app.delete('/api/requirements/:employeeId/:trainingId', podeLancar, h(async (req, res) => {
  await db.run('DELETE FROM requirements WHERE employee_id = ? AND training_id = ?',
    Number(req.params.employeeId), Number(req.params.trainingId));
  res.json({ ok: true });
}));

// ---- Usuários e acessos ----
const podeUsuarios = requirePerm('usuarios');
app.get('/api/users', podeUsuarios, h(async (req, res) => {
  const [users, teams] = await Promise.all([
    db.all(`SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, u.profile_id,
        p.name AS profile_name, p.scope AS profile_scope
      FROM users u LEFT JOIN profiles p ON p.id = u.profile_id ORDER BY u.name`),
    db.all('SELECT user_id, employee_id FROM team_members'),
  ]);
  res.json({ users, teams });
}));

// Impede escalada de privilégio: ninguém pode conceder um perfil com permissões
// que ele próprio não tem. Sem isso um supervisor criaria um usuário com o perfil
// de administradora e ganharia acesso total por tabela.
async function perfilAtribuivel(user, profileId) {
  const perfil = await db.get('SELECT * FROM profiles WHERE id = ?', Number(profileId));
  if (!perfil) return { ok: false, erro: 'Perfil não encontrado' };
  const alvo = perms.normalizar(perfil.permissions);
  const excedentes = perms.TODAS.filter(k => alvo[k] && !user.perms[k]);
  if (excedentes.length) {
    return { ok: false, erro: 'Você não pode conceder um perfil com mais permissões que o seu.' };
  }
  if (perfil.scope === 'all' && user.scope === 'team') {
    return { ok: false, erro: 'Você só pode criar usuários restritos à sua equipe.' };
  }
  return { ok: true, perfil };
}

app.post('/api/users', podeUsuarios, h(async (req, res) => {
  const { name, email, password, profile_id } = req.body || {};
  if (!name || !email || !password || !profile_id) {
    return res.status(400).json({ error: 'Preencha nome, e-mail, senha e perfil de acesso' });
  }
  if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres' });
  const check = await perfilAtribuivel(req.user, profile_id);
  if (!check.ok) return res.status(403).json({ error: check.erro });
  try {
    // role fica como campo herdado; quem manda é o perfil. Nunca gravamos 'admin'
    // por aqui — a administradora original é criada só na primeira execução.
    const r = await db.run('INSERT INTO users (name, email, password_hash, role, profile_id) VALUES (?, ?, ?, ?, ?)',
      cleanName(name), String(email).trim(), bcrypt.hashSync(String(password), 10), 'gestor', Number(profile_id));
    const id = r.lastInsertRowid;
    if (check.perfil.scope === 'team' && Array.isArray(req.body.team) && req.body.team.length) {
      await db.batch(req.body.team.map(eid =>
        ['INSERT OR IGNORE INTO team_members (user_id, employee_id) VALUES (?, ?)', id, Number(eid)]));
    }
    res.json({ ok: true, id });
  } catch { res.status(400).json({ error: 'Já existe um usuário com este e-mail' }); }
}));

app.put('/api/users/:id', podeUsuarios, h(async (req, res) => {
  const id = Number(req.params.id);
  const target = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (target.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Sem permissão para alterar a administradora' });
  }
  const b = req.body;
  if (b.profile_id) {
    const check = await perfilAtribuivel(req.user, b.profile_id);
    if (!check.ok) return res.status(403).json({ error: check.erro });
    // A administradora original não pode ser rebaixada, para o sistema nunca
    // ficar sem quem o administre.
    if (target.role !== 'admin') await db.run('UPDATE users SET profile_id = ? WHERE id = ?', Number(b.profile_id), id);
  }
  if (b.password && String(b.password).length < 6) {
    return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres' });
  }
  await db.run('UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), active = COALESCE(?, active) WHERE id = ?',
    b.name ? cleanName(b.name) : null, b.email ? String(b.email).trim() : null, b.active ?? null, id);
  if (b.password) {
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(String(b.password), 10), id);
  }
  if (Array.isArray(b.team)) {
    const stmts = [['DELETE FROM team_members WHERE user_id = ?', id]];
    for (const eid of b.team) stmts.push(['INSERT OR IGNORE INTO team_members (user_id, employee_id) VALUES (?, ?)', id, Number(eid)]);
    await db.batch(stmts);
  }
  res.json({ ok: true });
}));
app.delete('/api/users/:id', podeUsuarios, h(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Você não pode excluir o próprio usuário' });
  const alvo = await db.get('SELECT role FROM users WHERE id = ?', id);
  if (alvo && alvo.role === 'admin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Sem permissão para excluir a administradora' });
  }
  await db.run('DELETE FROM users WHERE id = ?', id);
  res.json({ ok: true });
}));

// ---- Importação e exportação ----
app.post('/api/import', requirePerm('importar'), upload.single('file'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envie um arquivo .xlsx' });
  try {
    const stats = await importWorkbook(req.file.buffer, { clearRecords: req.body.clear === '1' });
    await registrar(req, 'Planilha importada', { detalhe: stats.lancamentos + ' lançamentos novos · ' +
      stats.colaboradores + ' colaboradores na planilha' + (req.body.clear === '1' ? ' · substituiu os lançamentos anteriores' : '') });
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(400).json({ error: 'Falha na importação: ' + e.message });
  }
}));
// Gera um PDF a partir da tabela que está na tela. O conteúdo vem do próprio
// painel de quem pede — já filtrado e já dentro do alcance dele.
app.post('/api/relatorio/pdf', requirePerm('exportar'), h(async (req, res) => {
  const { titulo, subtitulo, colunas, linhas } = req.body || {};
  if (!Array.isArray(colunas) || !colunas.length || !Array.isArray(linhas)) {
    return res.status(400).json({ error: 'Relatório sem colunas ou sem linhas' });
  }
  if (linhas.length > 5000) return res.status(400).json({ error: 'Relatório grande demais; filtre antes de baixar' });

  const cols = colunas.slice(0, 12).map((c, i) => ({
    nome: String(c.nome || '').slice(0, 40),
    largura: Number(c.largura) || 10,
    campo: 'c' + i,
  }));
  const dados = linhas.map(l => Object.fromEntries(
    cols.map((c, i) => [c.campo, l[i] == null ? '' : String(l[i]).slice(0, 300)])));

  const buf = gerarTabelaPDF({
    titulo: String(titulo || 'Relatório').slice(0, 120) + ' — Riva Stones',
    subtitulo: String(subtitulo || '').slice(0, 200) +
      ' · ' + dados.length + ' registro(s) · emitido por ' + (req.user ? req.user.name : ''),
    colunas: cols,
    linhas: dados,
  });
  const nome = String(titulo || 'Relatorio').replace(/[^\w áéíóúâêôãõçÁÉÍÓÚÂÊÔÃÕÇ-]/g, '').slice(0, 60) +
    ' ' + todayISO().split('-').reverse().join('_') + '.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(nome) + '"');
  res.send(buf);
}));

app.get('/api/export', requirePerm('exportar'), h(async (req, res) => {
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
  // Vale tanto para quem entrou com login quanto para o acesso do gestor.
  const temSessao = req.session && (req.session.userId || req.session.convidado);
  if (!temSessao) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
  console.error('Erro não tratado:', err);
  if (res.headersSent) return;
  if (err && /Banco de dados não configurado/.test(err.message || '')) {
    return res.status(503).json({ error: err.message });
  }
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
