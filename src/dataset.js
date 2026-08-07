'use strict';
const db = require('./db');
const { cargoKey } = require('./normalize');

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function daysBetween(fromISO, toISO) {
  return Math.round((new Date(toISO + 'T12:00:00') - new Date(fromISO + 'T12:00:00')) / 86400000);
}

// Monta o conjunto completo de dados para o painel.
// scopeEmployeeIds: se informado (líder), restringe aos colaboradores da equipe.
async function buildDataset(scopeEmployeeIds = null) {
  const today = todayISO();

  const [companies, cargos, trainings, allEmployees, trails, reqRows, allRecords, ultimo] = await Promise.all([
    db.all('SELECT * FROM companies WHERE active = 1 ORDER BY sort_order, name'),
    db.all('SELECT * FROM cargos ORDER BY name'),
    db.all('SELECT * FROM trainings WHERE active = 1 ORDER BY name'),
    db.all(`SELECT e.*, c.name AS company_name,
        COALESCE(c.short_name, c.name) AS company_short, g.name AS cargo_name
      FROM employees e JOIN companies c ON c.id = e.company_id
      LEFT JOIN cargos g ON g.id = e.cargo_id
      WHERE e.active = 1 ORDER BY e.name`),
    db.all('SELECT cargo_id, training_id FROM trails'),
    db.all('SELECT employee_id, training_id FROM requirements'),
    db.all('SELECT * FROM records ORDER BY realizacao'),
    // Quando o último lançamento foi registrado (created_at vem em UTC).
    db.get('SELECT MAX(created_at) AS quando FROM records'),
  ]);

  let employees = allEmployees;
  if (scopeEmployeeIds) {
    const set = new Set(scopeEmployeeIds);
    employees = employees.filter(e => set.has(e.id));
  }

  // Agrupa cargos que são o mesmo papel em níveis diferentes ("FIOLISTA I/III" -> "FIOLISTA").
  // O nome do grupo é o do cargo que tem trilha própria; na falta dele, o nome mais curto.
  const ownTrail = new Set(trails.map(t => t.cargo_id));
  const byBase = new Map();
  for (const c of cargos) {
    const k = cargoKey(c.name);
    if (!byBase.has(k)) byBase.set(k, []);
    byBase.get(k).push(c);
  }
  const cargoBaseById = new Map();
  for (const [, group] of byBase) {
    const canonical = group.find(c => ownTrail.has(c.id))
      || group.slice().sort((a, b) => a.name.length - b.name.length)[0];
    for (const c of group) { c.base_name = canonical.name; cargoBaseById.set(c.id, canonical.name); }
  }
  for (const e of employees) e.cargo_base = e.cargo_id ? (cargoBaseById.get(e.cargo_id) || e.cargo_name) : null;

  const trailMap = new Map(); // cargo_id -> Set(training_id)
  for (const t of trails) {
    if (!trailMap.has(t.cargo_id)) trailMap.set(t.cargo_id, new Set());
    trailMap.get(t.cargo_id).add(t.training_id);
  }
  // Cargos com nível ("FIOLISTA III") herdam a trilha do cargo-base ("FIOLISTA")
  for (const c of cargos) {
    if (!trailMap.has(c.id) && c.trail_source_id && trailMap.has(c.trail_source_id)) {
      trailMap.set(c.id, trailMap.get(c.trail_source_id));
    }
  }

  const reqMap = new Map(); // employee_id -> Set(training_id)
  for (const r of reqRows) {
    if (!reqMap.has(r.employee_id)) reqMap.set(r.employee_id, new Set());
    reqMap.get(r.employee_id).add(r.training_id);
  }

  const latest = new Map(); // "emp|tid" -> record (maior realizacao)
  const recCount = new Map();
  for (const r of allRecords) {
    const k = r.employee_id + '|' + r.training_id;
    recCount.set(k, (recCount.get(k) || 0) + 1);
    const cur = latest.get(k);
    if (!cur || (r.realizacao || '') >= (cur.realizacao || '')) latest.set(k, r);
  }

  const tmap = new Map(trainings.map(t => [t.id, t]));
  const grid = [];
  for (const e of employees) {
    const dismissed = e.demissao && e.demissao <= today;
    if (dismissed) continue;
    // Exigido = trilha do cargo + exigências individuais vindas da planilha
    const required = new Set(e.cargo_id ? (trailMap.get(e.cargo_id) || []) : []);
    for (const tid of (reqMap.get(e.id) || [])) required.add(tid);
    const pairs = new Set(required);
    for (const key of latest.keys()) {
      const [empId, tid] = key.split('|').map(Number);
      if (empId === e.id) pairs.add(tid);
    }
    for (const tid of pairs) {
      const t = tmap.get(tid);
      if (!t) continue;
      const rec = latest.get(e.id + '|' + tid) || null;
      let status, dias = null, horas = 0, custo = 0;
      if (!rec || !rec.vencimento) {
        status = 'PENDENTE';
        horas = t.ch_formacao || 0;
        custo = t.custo_formacao || 0;
      } else if (rec.vencimento < today) {
        status = 'VENCIDO';
        dias = daysBetween(today, rec.vencimento);
        horas = t.ch_reciclagem || 0;
        custo = t.custo_reciclagem || 0;
      } else {
        status = 'VÁLIDO';
        dias = daysBetween(today, rec.vencimento);
      }
      grid.push({
        employee_id: e.id, training_id: tid,
        record_id: rec ? rec.id : null,
        realizacao: rec ? rec.realizacao : null,
        vencimento: rec ? rec.vencimento : null,
        status, dias, horas, custo,
        required: required.has(tid),
        history: recCount.get(e.id + '|' + tid) || 0,
      });
    }
  }

  const cargosWithTrail = cargos.filter(c => (trailMap.get(c.id) || new Set()).size > 0).map(c => c.id);
  return {
    today, companies, cargos, trainings, employees, grid, trails, cargosWithTrail,
    ultimoLancamento: (ultimo && ultimo.quando) || null,  // UTC, formatado na tela
    geradoEm: new Date().toISOString(),
  };
}

module.exports = { buildDataset, todayISO };
