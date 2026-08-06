'use strict';
const XLSX = require('xlsx');
const db = require('./db');
const { normKey, trainingKey, canonicalTrainingName, shortCompanyName, companyOrder, cargoKey, cleanName, toISODate, parseHours, parseMonths } = require('./normalize');

function getOrCreateCompany(name) {
  const clean = cleanName(name);
  if (!clean) return null;
  const row = db.prepare('SELECT id, name, short_name FROM companies').all()
    .find(c => normKey(c.name) === normKey(clean));
  if (row) {
    if (!row.short_name) {
      db.prepare('UPDATE companies SET short_name = ?, sort_order = ? WHERE id = ?')
        .run(shortCompanyName(row.name), companyOrder(row.name), row.id);
    }
    return row.id;
  }
  return Number(db.prepare('INSERT INTO companies (name, short_name, sort_order) VALUES (?, ?, ?)')
    .run(clean, shortCompanyName(clean), companyOrder(clean)).lastInsertRowid);
}

function getOrCreateCargo(name, companyId) {
  const clean = cleanName(name);
  if (!clean || !companyId) return null;
  const row = db.prepare('SELECT id, name FROM cargos WHERE company_id = ?').all(companyId)
    .find(c => normKey(c.name) === normKey(clean));
  if (row) return row.id;
  return Number(db.prepare('INSERT INTO cargos (name, company_id) VALUES (?, ?)').run(clean, companyId).lastInsertRowid);
}

function getOrCreateTraining(name) {
  const clean = cleanName(name);
  if (!clean) return null;
  const key = trainingKey(clean);
  const display = canonicalTrainingName(key) || clean;
  const row = db.prepare('SELECT id, name FROM trainings WHERE norm_key = ?').get(key);
  if (row) {
    if (display !== row.name && canonicalTrainingName(key)) {
      db.prepare('UPDATE trainings SET name = ? WHERE id = ?').run(display, row.id);
    }
    return row.id;
  }
  return Number(db.prepare('INSERT INTO trainings (name, norm_key) VALUES (?, ?)').run(display, key).lastInsertRowid);
}

function getOrCreateEmployee(name, companyId, cargoId, admissao) {
  const clean = cleanName(name);
  if (!clean || !companyId) return null;
  const rows = db.prepare('SELECT id, name FROM employees WHERE company_id = ?').all(companyId);
  const row = rows.find(e => normKey(e.name) === normKey(clean));
  if (row) {
    if (cargoId || admissao) {
      db.prepare('UPDATE employees SET cargo_id = COALESCE(?, cargo_id), admissao = COALESCE(?, admissao) WHERE id = ?')
        .run(cargoId ?? null, admissao ?? null, row.id);
    }
    return row.id;
  }
  return Number(db.prepare('INSERT INTO employees (name, company_id, cargo_id, admissao) VALUES (?, ?, ?, ?)')
    .run(clean, companyId, cargoId ?? null, admissao ?? null).lastInsertRowid);
}

// Importa um arquivo xlsx (Buffer) no formato da planilha "Balanço Normativos".
// options.clearRecords: apaga lançamentos antes de importar.
function importWorkbook(buffer, options = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const stats = { empresas: 0, cargos: 0, treinamentos: 0, colaboradores: 0, lancamentos: 0, trilhas: 0, avisos: [] };

  db.exec('BEGIN');
  try {
    if (options.clearRecords) db.exec('DELETE FROM records');

    // ----- Matriz de C.H. -----
    const wsMatriz = wb.Sheets['Matriz de C.H.'];
    if (wsMatriz) {
      const rows = XLSX.utils.sheet_to_json(wsMatriz, { header: 1, raw: true, defval: null });
      for (const r of rows.slice(1)) {
        if (!r || !r[0]) continue;
        const tid = getOrCreateTraining(r[0]);
        if (!tid) continue;
        db.prepare(`UPDATE trainings SET ch_formacao = COALESCE(?, ch_formacao),
                    validade_meses = COALESCE(?, validade_meses),
                    ch_reciclagem = COALESCE(?, ch_reciclagem),
                    criterio = COALESCE(?, criterio), fonte = COALESCE(?, fonte) WHERE id = ?`)
          .run(parseHours(r[1]), parseMonths(r[2]), parseHours(r[4]),
               r[5] != null ? String(r[5]) : null, r[6] != null ? String(r[6]) : null, tid);
        stats.treinamentos++;
      }
    }

    // ----- Base de Dados -----
    const wsBase = wb.Sheets['Base de Dados'];
    if (wsBase) {
      const rows = XLSX.utils.sheet_to_json(wsBase, { header: 1, raw: true, defval: null });
      const header = (rows[0] || []).map(h => normKey(h));
      const col = (label) => header.findIndex(h => h === normKey(label));
      const iNome = col('Nome'), iAdm = col('Admissão'), iFun = col('FUNÇÃO'), iEmp = col('EMPRESA'),
            iTre = col('TREINAMENTO'), iReal = col('DATA REALIZAÇÃO'), iVenc = col('DATA VENCIMENTO');
      if (iNome < 0 || iEmp < 0 || iTre < 0) throw new Error('Aba "Base de Dados" sem as colunas esperadas (Nome, EMPRESA, TREINAMENTO).');

      const seen = new Set();
      for (const r of rows.slice(1)) {
        if (!r || !r[iNome] || !r[iEmp]) continue;
        const companyId = getOrCreateCompany(r[iEmp]);
        const cargoId = iFun >= 0 ? getOrCreateCargo(r[iFun], companyId) : null;
        const admissao = iAdm >= 0 ? toISODate(r[iAdm]) : null;
        const empId = getOrCreateEmployee(r[iNome], companyId, cargoId, admissao);
        const tid = getOrCreateTraining(r[iTre]);
        if (!empId || !tid) continue;
        stats.colaboradores++;

        // Toda linha da Base de Dados — inclusive as PENDENTE — significa que aquele
        // treinamento é exigido daquele colaborador. Guardamos isso para não depender
        // apenas da trilha do cargo, que pode não estar cadastrada.
        db.prepare('INSERT OR IGNORE INTO requirements (employee_id, training_id) VALUES (?, ?)').run(empId, tid);

        const realizacao = iReal >= 0 ? toISODate(r[iReal]) : null;
        const vencimento = iVenc >= 0 ? toISODate(r[iVenc]) : null;
        if (!realizacao && !vencimento) continue; // linha PENDENTE: sem lançamento

        const dupKey = empId + '|' + tid + '|' + realizacao;
        if (seen.has(dupKey)) continue;
        seen.add(dupKey);

        const existing = db.prepare('SELECT id, realizacao FROM records WHERE employee_id = ? AND training_id = ?').all(empId, tid);
        const same = existing.find(e => e.realizacao === realizacao);
        if (same) {
          db.prepare('UPDATE records SET vencimento = ? WHERE id = ?').run(vencimento, same.id);
        } else {
          db.prepare('INSERT INTO records (employee_id, training_id, realizacao, vencimento) VALUES (?, ?, ?, ?)')
            .run(empId, tid, realizacao, vencimento);
          stats.lancamentos++;
        }
      }
    }

    // ----- Trilha por Cargo -----
    const wsTrilha = wb.Sheets['Trilha por Cargo'];
    if (wsTrilha) {
      const rows = XLSX.utils.sheet_to_json(wsTrilha, { header: 1, raw: true, defval: null });
      for (const r of rows.slice(1)) {
        if (!r || !r[0] || !r[1] || !r[2]) continue;
        const nrs = String(r[2]);
        if (/SEM TREINAMENTOS/i.test(nrs)) continue;
        const companyId = getOrCreateCompany(r[1]);
        const cargoId = getOrCreateCargo(r[0], companyId);
        if (!cargoId) continue;
        for (const line of nrs.split(/\r?\n/)) {
          const nome = cleanName(line);
          if (!nome) continue;
          const tid = getOrCreateTraining(nome);
          if (!tid) continue;
          db.prepare('INSERT OR IGNORE INTO trails (cargo_id, training_id) VALUES (?, ?)').run(cargoId, tid);
          stats.trilhas++;
        }
      }
    }

    stats.empresas = db.prepare('SELECT COUNT(*) c FROM companies').get().c;
    stats.cargos = db.prepare('SELECT COUNT(*) c FROM cargos').get().c;
    stats.cargosVinculados = linkCargoTrails();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return stats;
}

// Liga cargos sem trilha própria ao cargo-base equivalente que tem trilha.
// Ex.: "FIOLISTA III" herda a trilha de "FIOLISTA"; "OP. PONTE ROLANTE A-VII"
// herda de "OP. PONTE ROLANTE". Só preenche vínculos ainda não definidos.
function linkCargoTrails() {
  const cargos = db.prepare('SELECT id, name, company_id, trail_source_id FROM cargos').all();
  const withTrail = new Set(db.prepare('SELECT DISTINCT cargo_id FROM trails').all().map(r => r.cargo_id));
  const sources = cargos.filter(c => withTrail.has(c.id)).map(c => ({ ...c, key: cargoKey(c.name) }));
  let linked = 0;

  for (const c of cargos) {
    if (withTrail.has(c.id) || c.trail_source_id) continue;
    const key = cargoKey(c.name);
    let best = null, bestScore = Infinity;
    for (const s of sources) {
      if (s.id === c.id) continue;
      const sameCompany = s.company_id === c.company_id;
      let score = null;
      if (s.key === key) score = sameCompany ? 0 : 10;
      else if (key.startsWith(s.key + ' ')) score = (sameCompany ? 20 : 30) - s.key.length / 1000;
      else if (s.key.startsWith(key + ' ')) score = (sameCompany ? 40 : 50) + s.key.length / 1000;
      if (score !== null && score < bestScore) { bestScore = score; best = s; }
    }
    if (best) {
      db.prepare('UPDATE cargos SET trail_source_id = ? WHERE id = ?').run(best.id, c.id);
      linked++;
    }
  }
  return linked;
}

module.exports = { importWorkbook, linkCargoTrails, getOrCreateCompany, getOrCreateCargo, getOrCreateTraining, getOrCreateEmployee };
