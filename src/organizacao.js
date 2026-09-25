'use strict';
// Painel de Organização Pessoal da administradora: quadro Kanban que também
// alimenta o calendário/agenda (um cartão com prazo É um item da agenda —
// não existem duas listas de pendência). Calculadora de horas e ferramentas
// de PDF são só client-side, sem rota própria; feriados também são
// calculados no navegador (são só matemática de data, não precisam de banco).
const db = require('./db');
const { cleanName } = require('./normalize');

function serializeCard(row) {
  return {
    id: row.id, coluna: row.coluna, titulo: row.titulo, descricao: row.descricao,
    prazo: row.prazo, prioridade: row.prioridade, ordem: row.ordem,
    criadoEm: row.criado_em, concluidoEm: row.concluido_em,
  };
}

function registerOrganizacaoRoutes(app, { h, requirePerm }) {
  const guard = requirePerm('organizacao');

  app.get('/api/organizacao/cards', guard, h(async (req, res) => {
    const rows = await db.all('SELECT * FROM kanban_cards WHERE owner_user_id = ? ORDER BY coluna, ordem, id', req.user.id);
    res.json(rows.map(serializeCard));
  }));

  app.post('/api/organizacao/cards', guard, h(async (req, res) => {
    const titulo = cleanName(req.body.titulo || '');
    if (!titulo) return res.status(400).json({ error: 'Dê um título ao cartão.' });
    const coluna = ['a_fazer', 'fazendo', 'concluido'].includes(req.body.coluna) ? req.body.coluna : 'a_fazer';
    const prioridade = ['baixa', 'normal', 'alta'].includes(req.body.prioridade) ? req.body.prioridade : 'normal';
    const ordem = await db.get('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM kanban_cards WHERE owner_user_id = ? AND coluna = ?', req.user.id, coluna);
    const r = await db.run(
      'INSERT INTO kanban_cards (owner_user_id, coluna, titulo, descricao, prazo, prioridade, ordem) VALUES (?, ?, ?, ?, ?, ?, ?)',
      req.user.id, coluna, titulo, req.body.descricao || null, req.body.prazo || null, prioridade, ordem.n);
    res.status(201).json({ id: r.lastInsertRowid });
  }));

  app.put('/api/organizacao/cards/:id', guard, h(async (req, res) => {
    const existing = await db.get('SELECT * FROM kanban_cards WHERE id = ? AND owner_user_id = ?', req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Cartão não encontrado.' });
    const b = req.body;
    const coluna = ['a_fazer', 'fazendo', 'concluido'].includes(b.coluna) ? b.coluna : existing.coluna;
    const concluidoEm = coluna === 'concluido' && existing.coluna !== 'concluido' ? new Date().toISOString()
      : coluna !== 'concluido' ? null : existing.concluido_em;
    await db.run(`UPDATE kanban_cards SET titulo = COALESCE(?, titulo), descricao = ?, prazo = ?, prioridade = COALESCE(?, prioridade),
      coluna = ?, ordem = COALESCE(?, ordem), concluido_em = ? WHERE id = ?`,
      b.titulo ? cleanName(b.titulo) : null,
      b.descricao !== undefined ? b.descricao : existing.descricao,
      b.prazo !== undefined ? b.prazo : existing.prazo,
      ['baixa', 'normal', 'alta'].includes(b.prioridade) ? b.prioridade : null,
      coluna, b.ordem !== undefined ? Number(b.ordem) : null, concluidoEm, req.params.id);
    res.json({ ok: true });
  }));

  app.delete('/api/organizacao/cards/:id', guard, h(async (req, res) => {
    await db.run('DELETE FROM kanban_cards WHERE id = ? AND owner_user_id = ?', req.params.id, req.user.id);
    res.json({ ok: true });
  }));
}

module.exports = { registerOrganizacaoRoutes };
