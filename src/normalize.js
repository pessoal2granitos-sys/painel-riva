'use strict';

// Normaliza texto para comparação: maiúsculas, sem acentos, sem pontos,
// hífens viram espaço, espaços colapsados.
function normKey(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\./g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Apelidos conhecidos de treinamentos (variações de escrita na planilha)
const TRAINING_ALIASES = {
  'NR 20 ABASTECIMENTO': 'NR 20 COMBUSTIVEIS',
  'NR 11 PONTE ROLANTE': 'NR 11 PONTE ROLANTE E SIMILARES',
  'NR 12 MAQ E EQUIP ROTATIVAS': 'NR 12 MAQ E EQUIP ROTATIVAS',
  'NR 12 MAQUINAS PESADAS E CAMINHAO FE': 'NR 12 MAQUINAS PESADAS E CAMINHAO FE',
};

function trainingKey(name) {
  const k = normKey(name);
  return TRAINING_ALIASES[k] || k;
}

// Nome de exibição preferido quando várias grafias caem na mesma chave.
const CANONICAL_NAMES = {
  'NR 11 PONTE ROLANTE E SIMILARES': 'NR-11 PONTE ROLANTE E SIMILARES',
  'NR 20 COMBUSTIVEIS': 'NR-20 COMBUSTÍVEIS',
};
function canonicalTrainingName(key) { return CANONICAL_NAMES[key] || null; }

// Nomes curtos já acentuados para as empresas do grupo; as demais recebem um
// nome curto gerado automaticamente, editável na tela de Empresas.
const COMPANY_SHORT = {
  'RIVA STONES LTDA': 'Riva Stones',
  'MINERACAO VISTA LINDA LTDA': 'Mineração Vista Linda',
  'GRANRIVA GRANITOS LTDA': 'Granriva Granitos',
  'AGAPE DISTRIBUICAO, IMPORTACAO E EXPORTACAO DE MAR': 'Ágape Distribuição',
};
// Ordem de exibição preferida das empresas do grupo (menor aparece primeiro).
const COMPANY_ORDER = {
  'RIVA STONES LTDA': 1,
  'MINERACAO VISTA LINDA LTDA': 2,
  'GRANRIVA GRANITOS LTDA': 3,
  'AGAPE DISTRIBUICAO, IMPORTACAO E EXPORTACAO DE MAR': 4,
};
function companyOrder(fullName) { return COMPANY_ORDER[normKey(fullName)] || 100; }

function shortCompanyName(fullName) {
  const known = COMPANY_SHORT[normKey(fullName)] || COMPANY_SHORT[String(fullName).trim().toUpperCase()];
  if (known) return known;
  let s = String(fullName || '').split(',')[0];
  s = s.replace(/\b(LTDA|S\/A|S\.A\.?|SA|EIRELI|ME|EPP)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
  s = s.split(' ').slice(0, 3).join(' ');
  return s.toLowerCase().replace(/(^|\s|')\S/g, c => c.toUpperCase());
}

// Limpa nome para exibição (colapsa espaços, tira espaços nas pontas)
function cleanName(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

// Converte valor de célula em data ISO (yyyy-mm-dd) ou null
function toISODate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    // corrige fuso: xlsx entrega datas em UTC ou local dependendo da origem
    const d = new Date(v.getTime());
    if (d.getHours() >= 12) d.setDate(d.getDate() + 1); // arredonda meia-noite deslocada
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const s = String(v).trim();
  if (!s || /PENDENTE/i.test(s)) return null;
  // dd/mm/yyyy ou dd/mm/yy
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    y = Number(y); if (y < 100) y += 2000;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return null;
}

// Formata ISO -> dd/mm/yyyy
function brDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return d + '/' + m + '/' + y;
}

// Extrai o primeiro número de uma string tipo "40 h (superfície) / 48 h"
function parseHours(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return s;
  const str = String(s);
  if (/N[ÃA]O SE APLICA/i.test(str.normalize('NFD').replace(/[̀-ͯ]/g, ''))) return 0;
  const m = str.match(/(\d+(?:[.,]\d+)?)/);
  return m ? Number(m[1].replace(',', '.')) : null;
}

function parseMonths(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return Math.round(s);
  const m = String(s).match(/^\s*(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

// Chave de comparação de cargos: remove o nível/senioridade do fim
// ("FIOLISTA III", "OPERADOR DE POLITRIZ A-IV", "RESINADOR SENIOR IV" -> nome base)
// e expande abreviações usadas na planilha ("OP." -> "OPERADOR DE").
const ROMAN = '(?:I{1,3}|IV|VI{0,3}|IX|X)';
function cargoKey(name) {
  let k = normKey(name);
  k = k.replace(/^OP\s+/, 'OPERADOR DE ');
  k = k.replace(/^AUX\s+/, 'AUXILIAR ');
  // remove sufixos de nível, possivelmente repetidos: " III", " A V", " B I", " SENIOR IV"
  let prev;
  do {
    prev = k;
    k = k.replace(new RegExp('\\s+(?:SENIOR\\s+)?[A-Z]?\\s*' + ROMAN + '$'), '');
    k = k.replace(/\s+SENIOR$/, '');
  } while (k !== prev);
  return k.replace(/\s+/g, ' ').trim();
}

module.exports = { normKey, trainingKey, canonicalTrainingName, shortCompanyName, companyOrder, cargoKey, cleanName, toISODate, brDate, parseHours, parseMonths };
