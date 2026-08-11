'use strict';
const XLSX = require('xlsx');
const db = require('./db');
const { normKey, trainingKey, canonicalTrainingName, shortCompanyName, companyOrder,
        cargoKey, cleanName, toISODate, parseHours, parseMonths } = require('./normalize');

// A importação roda em duas passagens para não fazer uma consulta por linha:
// 1) descobre todas as empresas, cargos, treinamentos e colaboradores citados e
//    cria de uma vez os que faltam;
// 2) com todos os ids em memória, grava exigências e lançamentos em lote.

async function loadRegistry() {
  const [companies, cargos, trainings, employees, records, requirements] = await Promise.all([
    db.all('SELECT id, name, short_name FROM companies'),
    db.all('SELECT id, name, company_id FROM cargos'),
    db.all('SELECT id, name, norm_key FROM trainings'),
    db.all('SELECT id, name, company_id, cargo_id, admissao FROM employees'),
    db.all('SELECT id, employee_id, training_id, realizacao FROM records'),
    db.all('SELECT employee_id, training_id FROM requirements'),
  ]);
  return {
    companyByKey: new Map(companies.map(c => [normKey(c.name), c])),
    cargoByKey: new Map(cargos.map(c => [c.company_id + '|' + normKey(c.name), c])),
    trainingByKey: new Map(trainings.map(t => [t.norm_key, t])),
    employeeByKey: new Map(employees.map(e => [e.company_id + '|' + normKey(e.name), e])),
    recordByKey: new Map(records.map(r => [r.employee_id + '|' + r.training_id + '|' + (r.realizacao || ''), r])),
    requirementKeys: new Set(requirements.map(r => r.employee_id + '|' + r.training_id)),
    employeesById: new Map(employees.map(e => [e.id, e])),
  };
}

function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  return ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) : null;
}

async function importWorkbook(buffer, options = {}) {
  await db.init();
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const stats = { empresas: 0, cargos: 0, treinamentos: 0, colaboradores: 0, lancamentos: 0, trilhas: 0, avisos: [] };

  if (options.clearRecords) await db.run('DELETE FROM records');

  let reg = await loadRegistry();
  if (options.clearRecords) { reg.recordByKey = new Map(); }

  const base = sheetRows(wb, 'Base de Dados');
  const matriz = sheetRows(wb, 'Matriz de C.H.');
  const trilha = sheetRows(wb, 'Trilha por Cargo');

  // ---------- Passagem 1: catálogo ----------
  const wantCompanies = new Map();   // normKey -> nome original
  const wantTrainings = new Map();   // trainingKey -> nome de exibição
  const wantCargos = new Map();      // "empKey|cargoKey" -> { empresa, cargo }
  const wantEmployees = new Map();   // "empKey|nomeKey" -> { empresa, nome, cargo, admissao }

  const addCompany = (nome) => {
    const c = cleanName(nome);
    if (c) wantCompanies.set(normKey(c), c);
    return c;
  };
  const addTraining = (nome) => {
    const c = cleanName(nome);
    if (!c) return null;
    const key = trainingKey(c);
    const display = canonicalTrainingName(key) || c;
    if (!wantTrainings.has(key) || canonicalTrainingName(key)) wantTrainings.set(key, display);
    return key;
  };

  let baseHeader = null, idx = {};
  if (base) {
    baseHeader = (base[0] || []).map(h => normKey(h));
    const col = (label) => baseHeader.findIndex(h => h === normKey(label));
    idx = { nome: col('Nome'), adm: col('Admissão'), fun: col('FUNÇÃO'), emp: col('EMPRESA'),
            tre: col('TREINAMENTO'), real: col('DATA REALIZAÇÃO'), venc: col('DATA VENCIMENTO') };
    if (idx.nome < 0 || idx.emp < 0 || idx.tre < 0) {
      throw new Error('A aba "Base de Dados" não tem as colunas esperadas (Nome, EMPRESA, TREINAMENTO).');
    }
    for (const r of base.slice(1)) {
      if (!r || !r[idx.nome] || !r[idx.emp]) continue;
      const empresa = addCompany(r[idx.emp]);
      addTraining(r[idx.tre]);
      const cargo = idx.fun >= 0 ? cleanName(r[idx.fun]) : '';
      if (cargo) wantCargos.set(normKey(empresa) + '|' + normKey(cargo), { empresa, cargo });
      const nome = cleanName(r[idx.nome]);
      const chave = normKey(empresa) + '|' + normKey(nome);
      if (!wantEmployees.has(chave)) {
        wantEmployees.set(chave, { empresa, nome, cargo, admissao: idx.adm >= 0 ? toISODate(r[idx.adm]) : null });
      }
    }
  }
  if (matriz) for (const r of matriz.slice(1)) { if (r && r[0]) addTraining(r[0]); }
  if (trilha) {
    for (const r of trilha.slice(1)) {
      if (!r || !r[0] || !r[1] || !r[2]) continue;
      if (/SEM TREINAMENTOS/i.test(String(r[2]))) continue;
      const empresa = addCompany(r[1]);
      const cargo = cleanName(r[0]);
      if (cargo) wantCargos.set(normKey(empresa) + '|' + normKey(cargo), { empresa, cargo });
      for (const linha of String(r[2]).split(/\r?\n/)) addTraining(linha);
    }
  }

  // Cria empresas que faltam
  const novasEmpresas = [...wantCompanies].filter(([k]) => !reg.companyByKey.has(k));
  if (novasEmpresas.length) {
    await db.batch(novasEmpresas.map(([, nome]) =>
      ['INSERT INTO companies (name, short_name, sort_order) VALUES (?, ?, ?)',
        nome, shortCompanyName(nome), companyOrder(nome)]));
    stats.empresas = novasEmpresas.length;
    const companies = await db.all('SELECT id, name, short_name FROM companies');
    reg.companyByKey = new Map(companies.map(c => [normKey(c.name), c]));
  }
  // Preenche nome curto de empresas antigas que ainda não têm
  const semCurto = [...reg.companyByKey.values()].filter(c => !c.short_name);
  if (semCurto.length) {
    await db.batch(semCurto.map(c =>
      ['UPDATE companies SET short_name = ?, sort_order = ? WHERE id = ?',
        shortCompanyName(c.name), companyOrder(c.name), c.id]));
  }

  // Cria treinamentos que faltam e corrige nomes canônicos
  const novosTreinos = [...wantTrainings].filter(([k]) => !reg.trainingByKey.has(k));
  if (novosTreinos.length) {
    await db.batch(novosTreinos.map(([key, nome]) =>
      ['INSERT INTO trainings (name, norm_key) VALUES (?, ?)', nome, key]));
  }
  const renomear = [...wantTrainings]
    .filter(([key, nome]) => reg.trainingByKey.has(key) && canonicalTrainingName(key) && reg.trainingByKey.get(key).name !== nome);
  if (renomear.length) {
    await db.batch(renomear.map(([key, nome]) => ['UPDATE trainings SET name = ? WHERE norm_key = ?', nome, key]));
  }
  if (novosTreinos.length || renomear.length) {
    const trainings = await db.all('SELECT id, name, norm_key FROM trainings');
    reg.trainingByKey = new Map(trainings.map(t => [t.norm_key, t]));
  }
  stats.treinamentos = wantTrainings.size;

  // Cria cargos que faltam
  const novosCargos = [...wantCargos.values()]
    .map(({ empresa, cargo }) => ({ cargo, companyId: reg.companyByKey.get(normKey(empresa)).id }))
    .filter(({ cargo, companyId }) => !reg.cargoByKey.has(companyId + '|' + normKey(cargo)));
  if (novosCargos.length) {
    await db.batch(novosCargos.map(({ cargo, companyId }) =>
      ['INSERT INTO cargos (name, company_id) VALUES (?, ?)', cargo, companyId]));
    const cargos = await db.all('SELECT id, name, company_id FROM cargos');
    reg.cargoByKey = new Map(cargos.map(c => [c.company_id + '|' + normKey(c.name), c]));
  }

  // Cria colaboradores que faltam e atualiza cargo/admissão dos existentes
  const inserirEmp = [], atualizarEmp = [];
  for (const { empresa, nome, cargo, admissao } of wantEmployees.values()) {
    const companyId = reg.companyByKey.get(normKey(empresa)).id;
    const cargoId = cargo ? (reg.cargoByKey.get(companyId + '|' + normKey(cargo)) || {}).id ?? null : null;
    const existente = reg.employeeByKey.get(companyId + '|' + normKey(nome));
    if (!existente) {
      inserirEmp.push(['INSERT INTO employees (name, company_id, cargo_id, admissao) VALUES (?, ?, ?, ?)',
        nome, companyId, cargoId, admissao]);
    } else if ((cargoId && existente.cargo_id !== cargoId) || (admissao && existente.admissao !== admissao)) {
      atualizarEmp.push(['UPDATE employees SET cargo_id = COALESCE(?, cargo_id), admissao = COALESCE(?, admissao) WHERE id = ?',
        cargoId, admissao, existente.id]);
    }
  }
  if (inserirEmp.length) await db.batch(inserirEmp);
  if (atualizarEmp.length) await db.batch(atualizarEmp);
  if (inserirEmp.length) {
    const employees = await db.all('SELECT id, name, company_id, cargo_id, admissao FROM employees');
    reg.employeeByKey = new Map(employees.map(e => [e.company_id + '|' + normKey(e.name), e]));
  }
  stats.colaboradores = wantEmployees.size;

  // ---------- Passagem 2: exigências, lançamentos e trilhas ----------
  const resolveEmp = (empresa, nome) => {
    const c = reg.companyByKey.get(normKey(empresa));
    return c ? reg.employeeByKey.get(c.id + '|' + normKey(nome)) : null;
  };

  if (base) {
    const escritas = [];
    const novasExigencias = new Set();
    const vistos = new Set();
    for (const r of base.slice(1)) {
      if (!r || !r[idx.nome] || !r[idx.emp]) continue;
      const emp = resolveEmp(cleanName(r[idx.emp]), cleanName(r[idx.nome]));
      const tr = reg.trainingByKey.get(trainingKey(cleanName(r[idx.tre])));
      if (!emp || !tr) continue;

      // Toda linha da Base de Dados — inclusive as PENDENTE — significa que aquele
      // treinamento é exigido daquele colaborador.
      const reqKey = emp.id + '|' + tr.id;
      if (!reg.requirementKeys.has(reqKey) && !novasExigencias.has(reqKey)) {
        novasExigencias.add(reqKey);
        escritas.push(['INSERT OR IGNORE INTO requirements (employee_id, training_id) VALUES (?, ?)', emp.id, tr.id]);
      }

      const realizacao = idx.real >= 0 ? toISODate(r[idx.real]) : null;
      const vencimento = idx.venc >= 0 ? toISODate(r[idx.venc]) : null;
      if (!realizacao && !vencimento) continue; // linha PENDENTE: sem lançamento

      const dupKey = emp.id + '|' + tr.id + '|' + (realizacao || '');
      if (vistos.has(dupKey)) continue;
      vistos.add(dupKey);

      const existente = reg.recordByKey.get(dupKey);
      if (existente) {
        escritas.push(['UPDATE records SET vencimento = ? WHERE id = ?', vencimento, existente.id]);
      } else {
        escritas.push(['INSERT INTO records (employee_id, training_id, realizacao, vencimento) VALUES (?, ?, ?, ?)',
          emp.id, tr.id, realizacao, vencimento]);
        stats.lancamentos++;
      }
    }
    // Lotes de 500 para não estourar o limite de uma única requisição.
    for (let i = 0; i < escritas.length; i += 500) await db.batch(escritas.slice(i, i + 500));
  }

  if (matriz) {
    const updates = [];
    for (const r of matriz.slice(1)) {
      if (!r || !r[0]) continue;
      const tr = reg.trainingByKey.get(trainingKey(cleanName(r[0])));
      if (!tr) continue;
      updates.push([`UPDATE trainings SET ch_formacao = COALESCE(?, ch_formacao),
        validade_meses = COALESCE(?, validade_meses), ch_reciclagem = COALESCE(?, ch_reciclagem),
        criterio = COALESCE(?, criterio), fonte = COALESCE(?, fonte) WHERE id = ?`,
        parseHours(r[1]), parseMonths(r[2]), parseHours(r[4]),
        r[5] != null ? String(r[5]) : null, r[6] != null ? String(r[6]) : null, tr.id]);
    }
    if (updates.length) await db.batch(updates);
  }

  if (trilha) {
    // A aba Trilha por Cargo é a definição oficial: para cada cargo que ela
    // descreve, a trilha no sistema passa a ser exatamente aquela lista. Sem
    // isso, um treinamento retirado da planilha continuaria sendo cobrado.
    // Cargos que a planilha não menciona ficam intactos.
    const desejada = new Map();   // cargo_id -> Set(training_id)
    for (const r of trilha.slice(1)) {
      if (!r || !r[0] || !r[1]) continue;
      const comp = reg.companyByKey.get(normKey(cleanName(r[1])));
      if (!comp) continue;
      const cargo = reg.cargoByKey.get(comp.id + '|' + normKey(cleanName(r[0])));
      if (!cargo) continue;
      const nrs = String(r[2] || '');
      const set = desejada.get(cargo.id) || new Set();
      if (!/SEM TREINAMENTOS/i.test(nrs)) {
        for (const linha of nrs.split(/\r?\n/)) {
          const nome = cleanName(linha);
          if (!nome) continue;
          const tr = reg.trainingByKey.get(trainingKey(nome));
          if (tr) set.add(tr.id);
        }
      }
      desejada.set(cargo.id, set);
    }

    const atuais = new Map();
    for (const t of await db.all('SELECT cargo_id, training_id FROM trails')) {
      if (!atuais.has(t.cargo_id)) atuais.set(t.cargo_id, new Set());
      atuais.get(t.cargo_id).add(t.training_id);
    }

    const cmds = [];
    for (const [cargoId, set] of desejada) {
      const antes = atuais.get(cargoId) || new Set();
      const remover = [...antes].filter(id => !set.has(id));
      const incluir = [...set].filter(id => !antes.has(id));
      if (!remover.length && !incluir.length) continue;
      for (const id of remover) {
        cmds.push(['DELETE FROM trails WHERE cargo_id = ? AND training_id = ?', cargoId, id]);
        stats.trilhasRemovidas = (stats.trilhasRemovidas || 0) + 1;
      }
      for (const id of incluir) {
        cmds.push(['INSERT OR IGNORE INTO trails (cargo_id, training_id) VALUES (?, ?)', cargoId, id]);
        stats.trilhasIncluidas = (stats.trilhasIncluidas || 0) + 1;
      }
      stats.cargosAjustados = (stats.cargosAjustados || 0) + 1;
    }
    stats.trilhas = [...desejada.values()].reduce((s, v) => s + v.size, 0);
    for (let i = 0; i < cmds.length; i += 500) await db.batch(cmds.slice(i, i + 500));
  }

  const totals = await db.all('SELECT (SELECT COUNT(*) FROM companies) empresas, (SELECT COUNT(*) FROM cargos) cargos');
  stats.empresas = totals[0].empresas;
  stats.cargos = totals[0].cargos;
  stats.cargosVinculados = await linkCargoTrails();
  return stats;
}

// Liga cargos sem trilha própria ao cargo-base equivalente que tem trilha.
// Ex.: "FIOLISTA III" herda a trilha de "FIOLISTA"; "OP. PONTE ROLANTE A-VII"
// herda de "OP. PONTE ROLANTE". Só preenche vínculos ainda não definidos.
async function linkCargoTrails() {
  const [cargos, comTrilha] = await Promise.all([
    db.all('SELECT id, name, company_id, trail_source_id FROM cargos'),
    db.all('SELECT DISTINCT cargo_id FROM trails'),
  ]);
  const withTrail = new Set(comTrilha.map(r => r.cargo_id));
  const sources = cargos.filter(c => withTrail.has(c.id)).map(c => ({ ...c, key: cargoKey(c.name) }));
  const updates = [];

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
    if (best) updates.push(['UPDATE cargos SET trail_source_id = ? WHERE id = ?', best.id, c.id]);
  }
  if (updates.length) await db.batch(updates);
  return updates.length;
}

module.exports = { importWorkbook, linkCargoTrails };
