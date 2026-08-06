'use strict';
const XLSX = require('xlsx');
const db = require('./db');
const { buildDataset } = require('./dataset');
const { brDate } = require('./normalize');

// Gera um xlsx no mesmo formato da planilha original.
// scopeEmployeeIds restringe a exportação aos colaboradores visíveis ao usuário
// (um líder exporta apenas a própria equipe).
function exportWorkbook(scopeEmployeeIds = null) {
  const ds = buildDataset(scopeEmployeeIds);
  const emap = new Map(ds.employees.map(e => [e.id, e]));
  const tmap = new Map(ds.trainings.map(t => [t.id, t]));

  // ----- Base de Dados -----
  const baseRows = [['Nome', 'Admissão', 'FUNÇÃO', 'EMPRESA', 'TREINAMENTO', 'DATA REALIZAÇÃO', 'DATA VENCIMENTO', 'STATUS']];
  const sorted = [...ds.grid].sort((a, b) => {
    const ea = emap.get(a.employee_id), eb = emap.get(b.employee_id);
    const c = ea.name.localeCompare(eb.name, 'pt-BR');
    if (c !== 0) return c;
    return tmap.get(a.training_id).name.localeCompare(tmap.get(b.training_id).name, 'pt-BR');
  });
  for (const g of sorted) {
    const e = emap.get(g.employee_id), t = tmap.get(g.training_id);
    baseRows.push([
      e.name, brDate(e.admissao), e.cargo_name || '', e.company_name, t.name,
      g.realizacao ? brDate(g.realizacao) : 'PENDENTE',
      g.vencimento ? brDate(g.vencimento) : 'PENDENTE',
      g.status,
    ]);
  }

  // ----- Matriz de C.H. -----
  const matrizRows = [['TREINAMENTO', 'CARGA HORÁRIA FORMAÇÃO', 'VALIDADE (MESES)', 'VALIDADE (ANOS)', 'CARGA HORÁRIA RECICLAGEM', 'CRITÉRIO/OBSERVAÇÃO', 'BASE/FONTE']];
  for (const t of ds.trainings) {
    matrizRows.push([
      t.name,
      t.ch_formacao != null ? t.ch_formacao + ' h' : '',
      t.validade_meses != null ? t.validade_meses : '',
      t.validade_meses != null ? Math.round(t.validade_meses / 12 * 10) / 10 : '',
      t.ch_reciclagem != null ? t.ch_reciclagem + ' h' : '',
      t.criterio || '', t.fonte || '',
    ]);
  }

  // ----- Trilha por Cargo -----
  const trilhaRows = [['CARGO', 'EMPRESA', "NR'S NECESSÁRIAS"]];
  const cmap = new Map(ds.companies.map(c => [c.id, c]));
  const trailByCargo = new Map();
  for (const t of ds.trails) {
    if (!trailByCargo.has(t.cargo_id)) trailByCargo.set(t.cargo_id, []);
    const tr = tmap.get(t.training_id);
    if (tr) trailByCargo.get(t.cargo_id).push(tr.name);
  }
  for (const cargo of ds.cargos) {
    const list = trailByCargo.get(cargo.id);
    if (!list || !list.length) continue;
    const comp = cmap.get(cargo.company_id);
    trilhaRows.push([cargo.name, comp ? comp.name : '', list.sort((a, b) => a.localeCompare(b, 'pt-BR')).join('\n')]);
  }

  const wb = XLSX.utils.book_new();
  const wsBase = XLSX.utils.aoa_to_sheet(baseRows);
  wsBase['!cols'] = [{ wch: 38 }, { wch: 12 }, { wch: 30 }, { wch: 32 }, { wch: 40 }, { wch: 16 }, { wch: 16 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsBase, 'Base de Dados');
  const wsMatriz = XLSX.utils.aoa_to_sheet(matrizRows);
  wsMatriz['!cols'] = [{ wch: 40 }, { wch: 24 }, { wch: 16 }, { wch: 14 }, { wch: 24 }, { wch: 60 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsMatriz, 'Matriz de C.H.');
  const wsTrilha = XLSX.utils.aoa_to_sheet(trilhaRows);
  wsTrilha['!cols'] = [{ wch: 34 }, { wch: 40 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, wsTrilha, 'Trilha por Cargo');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { exportWorkbook };
