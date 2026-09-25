'use strict';
// Universidade Corporativa: RH cria Cursos > Módulos (trilhas) > Aulas
// (vídeo + texto + anexos em PDF), e o colaborador assiste por um login
// próprio (CPF + código de acesso) — bem mais simples que o login
// administrativo, e sem alcance a mais nada do sistema.
const { handleUpload } = require('@vercel/blob/client');
const db = require('./db');
const { cleanName } = require('./normalize');

function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }

function serializeCourse(row, stats) {
  return {
    id: row.id, titulo: row.titulo, descricao: row.descricao, capaUrl: row.capa_url,
    tipo: row.tipo, ativo: !!row.ativo, ordem: row.ordem,
    totalModulos: stats ? stats.modulos : undefined,
    totalAulas: stats ? stats.aulas : undefined,
  };
}

function registerUniversidadeRoutes(app, { h, requirePerm, currentUser }) {
  const guard = requirePerm('universidade');

  // ---- Gestão (RH / administração) ----
  app.get('/api/uni/courses', guard, h(async (req, res) => {
    const courses = await db.all('SELECT * FROM uni_courses ORDER BY ordem, id');
    const modulos = await db.all('SELECT id, course_id FROM uni_modules');
    const aulas = await db.all('SELECT uni_lessons.id, uni_modules.course_id FROM uni_lessons JOIN uni_modules ON uni_modules.id = uni_lessons.module_id');
    res.json(courses.map((c) => serializeCourse(c, {
      modulos: modulos.filter((m) => m.course_id === c.id).length,
      aulas: aulas.filter((a) => a.course_id === c.id).length,
    })));
  }));

  app.post('/api/uni/courses', guard, h(async (req, res) => {
    const titulo = cleanName(req.body.titulo || '');
    if (!titulo) return res.status(400).json({ error: 'Dê um título para o curso.' });
    const tipo = req.body.tipo === 'obrigatorio' ? 'obrigatorio' : 'capacitacao';
    const r = await db.run('INSERT INTO uni_courses (titulo, descricao, capa_url, tipo) VALUES (?, ?, ?, ?)',
      titulo, req.body.descricao || null, req.body.capaUrl || null, tipo);
    res.status(201).json({ id: r.lastInsertRowid });
  }));

  app.put('/api/uni/courses/:id', guard, h(async (req, res) => {
    const existing = await db.get('SELECT * FROM uni_courses WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Curso não encontrado.' });
    const b = req.body;
    await db.run(`UPDATE uni_courses SET titulo = COALESCE(?, titulo), descricao = ?, capa_url = ?,
      tipo = COALESCE(?, tipo), ativo = COALESCE(?, ativo) WHERE id = ?`,
      b.titulo ? cleanName(b.titulo) : null,
      b.descricao !== undefined ? b.descricao : existing.descricao,
      b.capaUrl !== undefined ? b.capaUrl : existing.capa_url,
      b.tipo === 'obrigatorio' || b.tipo === 'capacitacao' ? b.tipo : null,
      b.ativo === undefined ? null : (b.ativo ? 1 : 0),
      req.params.id);
    res.json({ ok: true });
  }));

  app.delete('/api/uni/courses/:id', guard, h(async (req, res) => {
    await db.run('DELETE FROM uni_courses WHERE id = ?', req.params.id);
    res.json({ ok: true });
  }));

  app.get('/api/uni/courses/:id', guard, h(async (req, res) => {
    const course = await db.get('SELECT * FROM uni_courses WHERE id = ?', req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso não encontrado.' });
    const modules = await db.all('SELECT * FROM uni_modules WHERE course_id = ? ORDER BY ordem, id', req.params.id);
    const lessons = await db.all(
      `SELECT uni_lessons.* FROM uni_lessons JOIN uni_modules ON uni_modules.id = uni_lessons.module_id
       WHERE uni_modules.course_id = ? ORDER BY uni_lessons.ordem, uni_lessons.id`, req.params.id);
    const files = await db.all(
      `SELECT uni_lesson_files.* FROM uni_lesson_files JOIN uni_lessons ON uni_lessons.id = uni_lesson_files.lesson_id
       JOIN uni_modules ON uni_modules.id = uni_lessons.module_id WHERE uni_modules.course_id = ?`, req.params.id);
    res.json({
      ...serializeCourse(course),
      modulos: modules.map((m) => ({
        id: m.id, titulo: m.titulo, ordem: m.ordem,
        aulas: lessons.filter((l) => l.module_id === m.id).map((l) => ({
          id: l.id, titulo: l.titulo, conteudo: l.conteudo, videoUrl: l.video_url, ordem: l.ordem,
          arquivos: files.filter((f) => f.lesson_id === l.id).map((f) => ({ id: f.id, nome: f.nome, url: f.url })),
        })),
      })),
    });
  }));

  app.post('/api/uni/courses/:id/modules', guard, h(async (req, res) => {
    const titulo = cleanName(req.body.titulo || '');
    if (!titulo) return res.status(400).json({ error: 'Dê um nome para o módulo.' });
    const ordem = await db.get('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM uni_modules WHERE course_id = ?', req.params.id);
    const r = await db.run('INSERT INTO uni_modules (course_id, titulo, ordem) VALUES (?, ?, ?)', req.params.id, titulo, ordem.n);
    res.status(201).json({ id: r.lastInsertRowid });
  }));

  app.put('/api/uni/modules/:id', guard, h(async (req, res) => {
    const titulo = cleanName(req.body.titulo || '');
    if (!titulo) return res.status(400).json({ error: 'Dê um nome para o módulo.' });
    await db.run('UPDATE uni_modules SET titulo = ? WHERE id = ?', titulo, req.params.id);
    res.json({ ok: true });
  }));

  app.delete('/api/uni/modules/:id', guard, h(async (req, res) => {
    await db.run('DELETE FROM uni_modules WHERE id = ?', req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/uni/modules/:id/lessons', guard, h(async (req, res) => {
    const titulo = cleanName(req.body.titulo || '');
    if (!titulo) return res.status(400).json({ error: 'Dê um título para a aula.' });
    const ordem = await db.get('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM uni_lessons WHERE module_id = ?', req.params.id);
    const r = await db.run('INSERT INTO uni_lessons (module_id, titulo, conteudo, video_url, ordem) VALUES (?, ?, ?, ?, ?)',
      req.params.id, titulo, req.body.conteudo || null, req.body.videoUrl || null, ordem.n);
    res.status(201).json({ id: r.lastInsertRowid });
  }));

  app.put('/api/uni/lessons/:id', guard, h(async (req, res) => {
    const existing = await db.get('SELECT * FROM uni_lessons WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Aula não encontrada.' });
    const b = req.body;
    await db.run('UPDATE uni_lessons SET titulo = COALESCE(?, titulo), conteudo = ?, video_url = ? WHERE id = ?',
      b.titulo ? cleanName(b.titulo) : null,
      b.conteudo !== undefined ? b.conteudo : existing.conteudo,
      b.videoUrl !== undefined ? b.videoUrl : existing.video_url,
      req.params.id);
    res.json({ ok: true });
  }));

  app.delete('/api/uni/lessons/:id', guard, h(async (req, res) => {
    await db.run('DELETE FROM uni_lessons WHERE id = ?', req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/uni/lessons/:id/files', guard, h(async (req, res) => {
    const nome = cleanName(req.body.nome || 'Anexo');
    if (!req.body.url) return res.status(400).json({ error: 'Falta a URL do arquivo.' });
    const r = await db.run('INSERT INTO uni_lesson_files (lesson_id, nome, url) VALUES (?, ?, ?)', req.params.id, nome, req.body.url);
    res.status(201).json({ id: r.lastInsertRowid });
  }));

  app.delete('/api/uni/lesson-files/:id', guard, h(async (req, res) => {
    await db.run('DELETE FROM uni_lesson_files WHERE id = ?', req.params.id);
    res.json({ ok: true });
  }));

  // Upload direto pro Blob (vídeo/PDF/capa) — mesmo motivo do resto do painel:
  // funções da Vercel têm limite de 4,5 MB por requisição.
  app.post('/api/uni/upload-token', h(async (req, res) => {
    try {
      const jsonResponse = await handleUpload({
        body: req.body,
        request: req,
        onBeforeGenerateToken: async () => {
          const user = await currentUser(req);
          if (!user || !user.perms.universidade) throw new Error('Não autorizado.');
          return {
            allowedContentTypes: ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'application/pdf'],
            addRandomSuffix: true,
          };
        },
        onUploadCompleted: async () => {},
      });
      res.json(jsonResponse);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  // Gera (ou troca) o código de acesso de um colaborador à Universidade.
  app.post('/api/uni/employees/:id/codigo', guard, h(async (req, res) => {
    const emp = await db.get('SELECT id FROM employees WHERE id = ?', req.params.id);
    if (!emp) return res.status(404).json({ error: 'Colaborador não encontrado.' });
    const codigo = Math.random().toString(36).slice(2, 8).toUpperCase();
    await db.run('UPDATE employees SET codigo_acesso = ? WHERE id = ?', codigo, req.params.id);
    res.json({ ok: true, codigo });
  }));

  app.get('/api/uni/employees', guard, h(async (req, res) => {
    const rows = await db.all(`SELECT employees.id, employees.name, employees.cpf, employees.codigo_acesso,
        companies.short_name AS company_short, companies.name AS company_name
      FROM employees JOIN companies ON companies.id = employees.company_id
      WHERE employees.active = 1 ORDER BY employees.name`);
    res.json(rows.map((r) => ({
      id: r.id, name: r.name, cpf: r.cpf, temCodigo: !!r.codigo_acesso,
      empresa: r.company_short || r.company_name,
    })));
  }));

  app.put('/api/uni/employees/:id/cpf', guard, h(async (req, res) => {
    const cpf = onlyDigits(req.body.cpf);
    if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido — informe os 11 números.' });
    await db.run('UPDATE employees SET cpf = ? WHERE id = ?', cpf, req.params.id);
    res.json({ ok: true });
  }));

  // ---- Portal do colaborador (login próprio, sem alcance ao resto do sistema) ----
  async function currentEmployee(req) {
    if (!req.session || !req.session.employeeId) return null;
    return db.get('SELECT * FROM employees WHERE id = ? AND active = 1', req.session.employeeId);
  }
  const requireEmployee = h(async (req, res, next) => {
    const emp = await currentEmployee(req);
    if (!emp) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
    req.employee = emp;
    next();
  });

  app.post('/api/uni/login', h(async (req, res) => {
    const cpf = onlyDigits(req.body.cpf);
    const codigo = String(req.body.codigo || '').trim().toUpperCase();
    if (!cpf || !codigo) return res.status(400).json({ error: 'Informe CPF e código de acesso.' });
    const emp = await db.get('SELECT * FROM employees WHERE cpf = ? AND active = 1', cpf);
    if (!emp || !emp.codigo_acesso || emp.codigo_acesso !== codigo) {
      return res.status(401).json({ error: 'CPF ou código de acesso inválidos.' });
    }
    req.session.employeeId = emp.id;
    res.json({ ok: true, nome: emp.name });
  }));

  app.post('/api/uni/logout', (req, res) => {
    if (req.session) req.session.employeeId = null;
    res.json({ ok: true });
  });

  app.get('/api/uni/me', requireEmployee, h(async (req, res) => {
    res.json({ id: req.employee.id, nome: req.employee.name });
  }));

  app.get('/api/uni/meus-cursos', requireEmployee, h(async (req, res) => {
    const courses = await db.all('SELECT * FROM uni_courses WHERE ativo = 1 ORDER BY ordem, id');
    const totalAulas = await db.all(
      `SELECT uni_modules.course_id, COUNT(*) AS n FROM uni_lessons
       JOIN uni_modules ON uni_modules.id = uni_lessons.module_id GROUP BY uni_modules.course_id`);
    const feitas = await db.all(
      `SELECT uni_modules.course_id, COUNT(*) AS n FROM uni_progress
       JOIN uni_lessons ON uni_lessons.id = uni_progress.lesson_id
       JOIN uni_modules ON uni_modules.id = uni_lessons.module_id
       WHERE uni_progress.employee_id = ? GROUP BY uni_modules.course_id`, req.employee.id);
    const totalMap = new Map(totalAulas.map((r) => [r.course_id, r.n]));
    const feitasMap = new Map(feitas.map((r) => [r.course_id, r.n]));
    res.json(courses.map((c) => ({
      ...serializeCourse(c),
      totalAulas: totalMap.get(c.id) || 0,
      aulasFeitas: feitasMap.get(c.id) || 0,
    })));
  }));

  app.get('/api/uni/aluno/courses/:id', requireEmployee, h(async (req, res) => {
    const course = await db.get('SELECT * FROM uni_courses WHERE id = ? AND ativo = 1', req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso não encontrado.' });
    const modules = await db.all('SELECT * FROM uni_modules WHERE course_id = ? ORDER BY ordem, id', req.params.id);
    const lessons = await db.all(
      `SELECT uni_lessons.* FROM uni_lessons JOIN uni_modules ON uni_modules.id = uni_lessons.module_id
       WHERE uni_modules.course_id = ? ORDER BY uni_lessons.ordem, uni_lessons.id`, req.params.id);
    const files = await db.all(
      `SELECT uni_lesson_files.* FROM uni_lesson_files JOIN uni_lessons ON uni_lessons.id = uni_lesson_files.lesson_id
       JOIN uni_modules ON uni_modules.id = uni_lessons.module_id WHERE uni_modules.course_id = ?`, req.params.id);
    const feitas = await db.all(
      `SELECT uni_progress.lesson_id FROM uni_progress
       JOIN uni_lessons ON uni_lessons.id = uni_progress.lesson_id
       JOIN uni_modules ON uni_modules.id = uni_lessons.module_id
       WHERE uni_progress.employee_id = ? AND uni_modules.course_id = ?`, req.employee.id, req.params.id);
    const feitasSet = new Set(feitas.map((r) => r.lesson_id));
    res.json({
      ...serializeCourse(course),
      modulos: modules.map((m) => ({
        id: m.id, titulo: m.titulo,
        aulas: lessons.filter((l) => l.module_id === m.id).map((l) => ({
          id: l.id, titulo: l.titulo, conteudo: l.conteudo, videoUrl: l.video_url,
          concluida: feitasSet.has(l.id),
          arquivos: files.filter((f) => f.lesson_id === l.id).map((f) => ({ id: f.id, nome: f.nome, url: f.url })),
        })),
      })),
    });
  }));

  app.post('/api/uni/aluno/lessons/:id/concluir', requireEmployee, h(async (req, res) => {
    await db.run('INSERT OR IGNORE INTO uni_progress (employee_id, lesson_id) VALUES (?, ?)', req.employee.id, req.params.id);
    res.json({ ok: true });
  }));
}

module.exports = { registerUniversidadeRoutes };
