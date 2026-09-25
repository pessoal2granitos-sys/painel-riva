'use strict';
/* Painel de Treinamentos Normativos — Riva Stones */

let DS = null;   // dataset do servidor
let ME = null;   // usuário logado
let ROWS = [];   // grid enriquecido
let currentTab = 'visao';
let charts = {};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brDate = (iso) => iso ? iso.split('-').reverse().join('/') : '';
const fmtN = (n) => Number(n || 0).toLocaleString('pt-BR');
const fmtH = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const fmtMoney = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (a, b) => b ? (a / b * 100) : 0;
const fmtPct = (v) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';

const ROLE_LABEL = { admin: 'Administradora', supervisor: 'Supervisor', gestor: 'Gestor', lider: 'Líder' };
const STATUS_CLASS = { 'VÁLIDO': 'valido', 'PENDENTE': 'pendente', 'VENCIDO': 'vencido' };

// O agrupamento de cargos por nível ("FIOLISTA III" -> "FIOLISTA") vem calculado
// do servidor em employee.cargo_base, usando a mesma regra do vínculo de trilhas.

function colorByPct(p) { return p < 60 ? 'var(--red)' : p < 80 ? 'var(--amber)' : 'var(--green)'; }

// ---------- carga ----------
async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) { location.href = '/login'; throw new Error('sessão expirada'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Toda falha vira aviso visível: nenhuma ação pode "não fazer nada" em silêncio.
    const err = new Error(data.error || 'Erro na requisição');
    err.jaAvisado = true;
    toast(err.message, true);
    throw err;
  }
  return data;
}

// Confirmação com visual do sistema. A caixa nativa do navegador pode ser
// silenciada em "impedir novas caixas de diálogo" e aí a exclusão parece morta.
function confirmar(msg, titulo = 'Confirmar') {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = titulo;
    $('confirmMsg').textContent = msg;
    $('confirmBack').classList.add('open');
    const fechar = (resposta) => {
      $('confirmBack').classList.remove('open');
      $('confirmSim').onclick = null;
      $('confirmNao').onclick = null;
      resolve(resposta);
    };
    $('confirmSim').onclick = () => fechar(true);
    $('confirmNao').onclick = () => fechar(false);
  });
}

async function loadAll() {
  REALIZADOS = null;   // histórico é recarregado junto, para refletir novos lançamentos
  DS = await api('/api/dataset');
  ME = DS.user;
  const emap = new Map(DS.employees.map(e => [e.id, e]));
  const tmap = new Map(DS.trainings.map(t => [t.id, t]));
  ROWS = DS.grid.map(g => {
    const e = emap.get(g.employee_id), t = tmap.get(g.training_id);
    return { ...g, emp: e, tr: t, empName: e.name, company: e.company_name,
             companyShort: e.company_short || e.company_name, cargo: e.cargo_name || '—',
             cargoBase: e.cargo_base || e.cargo_name || '—', trName: t.name };
  });
  renderHeader();
  fillFilters();
  renderTab();
  contarAvisosNovos();
  // Registra o estado recém-carregado como referência para a próxima verificação.
  try {
    const st = await (await fetch('/api/status')).json();
    assinaturaAtual = st.assinatura;
    $('avisoDesatualizado').style.display = 'none';
  } catch { /* sem problema: a próxima verificação recalibra */ }
}

// Atalho para consultar permissão do usuário logado.
const pode = (chave) => !!(ME && ME.perms && ME.perms[chave]);
// Permissões que dão acesso ao painel de administração.
const ADMIN_PERMS = ['colaboradores', 'config', 'lancamentos', 'usuarios', 'perfis', 'importar'];

// created_at vem em UTC ("2026-08-07 12:34:56"); mostra no horário local.
function dataHoraLocal(utc) {
  if (!utc) return null;
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
         ' às ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function renderHeader() {
  const comps = DS.companies.map(c => c.short_name || c.name).join(' · ');
  const ultimo = dataHoraLocal(DS.ultimoLancamento);
  $('headerSub').innerHTML = esc(comps) +
    ' &nbsp;|&nbsp; Posição em <b>' + brDate(DS.today) + '</b>' +
    (ultimo ? ' &nbsp;|&nbsp; Último lançamento: <b>' + esc(ultimo) + '</b>' : '');
  $('userName').textContent = ME.name;
  $('userRole').textContent = ME.profile || ROLE_LABEL[ME.role] || ME.role;
  $('userAvatar').textContent = ME.convidado ? '👁'
    : ME.name.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  // Visitante não tem conta: nada de trocar senha, e "Sair" vira "Entrar".
  $('btnMyPassword').style.display = ME.convidado ? 'none' : '';
  $('btnLogout').textContent = ME.convidado ? 'Entrar' : 'Sair';

  // Cada aba aparece só se o perfil permitir. O servidor aplica as mesmas regras,
  // então esconder aqui é conveniência, não a proteção em si.
  document.querySelectorAll('#mainTabs button[data-perm]').forEach(b => {
    b.style.display = pode(b.dataset.perm) ? '' : 'none';
  });
  document.querySelectorAll('#mainTabs .tab-admin').forEach(b => {
    b.style.display = ADMIN_PERMS.some(pode) ? '' : 'none';
  });

  // Se a aba atual não é mais permitida, cai na primeira disponível.
  const visiveis = [...document.querySelectorAll('#mainTabs button')].filter(b => b.style.display !== 'none');
  if (!visiveis.some(b => b.dataset.tab === currentTab) && visiveis.length) {
    currentTab = visiveis[0].dataset.tab;
  }
  document.querySelectorAll('#mainTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
}

function fillFilters() {
  const opts = (list) => list.map(v => '<option>' + esc(v) + '</option>').join('');
  const keep = { e: $('fEmpresa').value, c: $('fCargo').value, t: $('fTreinamento').value };
  $('fEmpresa').innerHTML = '<option value="">Todas</option>' + DS.companies
    .map(c => `<option value="${esc(c.name)}">${esc(c.short_name || c.name)}</option>`).join('');
  const cargoNames = [...new Set(DS.employees.map(e => e.cargo_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  $('fCargo').innerHTML = '<option value="">Todos</option>' + opts(cargoNames);
  $('fTreinamento').innerHTML = '<option value="">Todos</option>' + opts(DS.trainings.map(t => t.name));
  $('fEmpresa').value = keep.e; $('fCargo').value = keep.c; $('fTreinamento').value = keep.t;
}

// ---------- escopo dos indicadores ----------
// Por padrão os números contam apenas o que a trilha do cargo exige. Exigências
// individuais e treinamentos avulsos existem no cadastro, mas só entram na conta
// se a pessoa escolher — do contrário inflam os pendentes obrigatórios.
let ESCOPO = localStorage.getItem('painelEscopo') || 'trilha';
const ESCOPO_LABEL = {
  trilha: 'somente a trilha do cargo',
  individual: 'trilha + exigências individuais',
  tudo: 'tudo, inclusive avulsos',
};
function noEscopo(r) {
  if (ESCOPO === 'tudo') return true;
  if (ESCOPO === 'individual') return r.origem !== 'avulso';
  return r.origem === 'trilha';
}
// Base de todos os indicadores, já sem o que está fora do escopo escolhido.
const rowsEscopo = () => ROWS.filter(noEscopo);

// ---------- filtros ----------
function rowMatches(r) {
  if (!noEscopo(r)) return false;
  const fe = $('fEmpresa').value, fc = $('fCargo').value, ft = $('fTreinamento').value,
        fs = $('fSituacao').value, ff = $('fFaixa').value, fb = $('fBusca').value.trim().toLowerCase();
  if (fe && r.company !== fe) return false;
  if (fc && r.cargo !== fc) return false;
  if (ft && r.trName !== ft) return false;
  if (fs && r.status !== fs) return false;
  if (fb && !r.empName.toLowerCase().includes(fb)) return false;
  if (ff) {
    if (ff === 'vencido' && r.status !== 'VENCIDO') return false;
    if (ff === 'pendente' && r.status !== 'PENDENTE') return false;
    if (ff === '30' && !(r.status === 'VÁLIDO' && r.dias <= 30)) return false;
    if (ff === '60' && !(r.status === 'VÁLIDO' && r.dias > 30 && r.dias <= 60)) return false;
    if (ff === '90' && !(r.status === 'VÁLIDO' && r.dias > 60 && r.dias <= 90)) return false;
    if (ff === '90+' && !(r.status === 'VÁLIDO' && r.dias > 90)) return false;
  }
  return true;
}
const fRows = () => ROWS.filter(rowMatches);

function fEmployees() {
  const fe = $('fEmpresa').value, fc = $('fCargo').value, fb = $('fBusca').value.trim().toLowerCase();
  return DS.employees.filter(e => {
    if (e.demissao && e.demissao <= DS.today) return false;
    if (fe && e.company_name !== fe) return false;
    if (fc && (e.cargo_name || '') !== fc) return false;
    if (fb && !e.name.toLowerCase().includes(fb)) return false;
    return true;
  });
}

// ---------- componentes ----------
function kpi(label, value, sub, cls = '') {
  return `<div class="kpi ${cls}"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-sub">${sub}</div></div>`;
}
function hbars(items, colorFn, maxW) {
  const max = maxW || Math.max(1, ...items.map(i => i.value));
  return items.map(i => `
    <div class="hbar-row" title="${esc(i.label)}: ${fmtN(i.value)}">
      <div class="lbl">${esc(i.label)}</div>
      <div class="track"><div class="fill" style="width:${Math.min(100, i.value / max * 100)}%;background:${colorFn ? colorFn(i) : 'var(--navy)'}"></div></div>
      <div class="val">${i.fmt || fmtN(i.value)}</div>
    </div>`).join('') || '<div class="empty">Sem dados para os filtros atuais</div>';
}
function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

// Escreve o valor acima de cada barra, como na planilha de referência.
const barValueLabels = {
  id: 'barValueLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = '600 11px "Segoe UI", sans-serif';
    ctx.fillStyle = '#14395c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const meta of chart.getSortedVisibleDatasetMetas()) {
      meta.data.forEach((bar, i) => {
        const v = chart.data.datasets[meta.index].data[i];
        if (v) ctx.fillText(fmtN(v), bar.x, bar.y - 4);
      });
    }
    ctx.restore();
  }
};

function sortTable(tableId, rows, renderFn, state, col, types) {
  if (state.col === col) state.dir = -state.dir; else { state.col = col; state.dir = 1; }
  rows.sort((a, b) => {
    const va = a[col], vb = b[col];
    if (types && types[col] === 'num') return ((va ?? -Infinity) - (vb ?? -Infinity)) * state.dir;
    return String(va ?? '').localeCompare(String(vb ?? ''), 'pt-BR') * state.dir;
  });
  renderFn();
}

// ---------- abas ----------
// Mostra quantos itens ficaram de fora da conta, para o número nunca surpreender.
function renderAvisoEscopo(visivel) {
  const barra = $('avisoEscopo');
  const esconder = () => { barra.style.display = 'none'; barra.innerHTML = ''; };
  if (!visivel) { esconder(); return; }
  const fora = ROWS.filter(r => !noEscopo(r));
  if (!fora.length) { esconder(); return; }
  const pend = fora.filter(r => r.status === 'PENDENTE').length;
  barra.style.display = 'flex';
  barra.innerHTML =
    'Contando <b>' + ESCOPO_LABEL[ESCOPO] + '</b>. Fora da conta: <b>' + fmtN(fora.length) + '</b> registro(s)' +
    (pend ? ', sendo <b>' + fmtN(pend) + '</b> pendente(s)' : '') + '.' +
    (pode('config') ? ' <button class="btn-mini" onclick="verForaDaTrilha()">Ver quais são</button>' : '');
}

function renderTab() {
  const dash = ['visao', 'vencimentos', 'realizados', 'pendencias', 'cargos', 'custo', 'qualidade'].includes(currentTab);
  $('filterBar').style.display = dash ? '' : 'none';
  renderAvisoEscopo(dash);
  document.querySelectorAll('main > section').forEach(s => s.style.display = 'none');
  const alvo = $('tab-' + currentTab);
  if (!alvo) return;
  alvo.style.display = '';
  // Reaplica a animação de entrada a cada troca de aba (não só na primeira
  // vez) — remover e forçar reflow antes de reativar a classe é o jeito de
  // fazer o navegador rodar a mesma animação CSS de novo.
  alvo.classList.remove('fade-in');
  void alvo.offsetWidth;
  alvo.classList.add('fade-in');
  const render = { avisos: renderAvisos, visao: renderVisao, vencimentos: renderVencimentos,
                   realizados: renderRealizados, pendencias: renderPendencias,
                   cargos: renderCargos, custo: renderCusto,
                   qualidade: renderQualidade, tv: renderTV, pessoas: renderPessoas, admin: renderAdmin }[currentTab];
  if (render) render();
}

// ===== Visão Geral =====
function renderVisao() {
  const rows = fRows();
  const emps = fEmployees();
  const validos = rows.filter(r => r.status === 'VÁLIDO').length;
  const pend = rows.filter(r => r.status === 'PENDENTE').length;
  const venc = rows.filter(r => r.status === 'VENCIDO').length;
  const horas = rows.filter(r => r.status !== 'VÁLIDO').reduce((s, r) => s + (r.horas || 0), 0);
  const ader = pct(validos, rows.length);

  // por empresa
  const byComp = {};
  for (const r of rows) {
    byComp[r.companyShort] = byComp[r.companyShort] || { t: 0, v: 0 };
    byComp[r.companyShort].t++; if (r.status === 'VÁLIDO') byComp[r.companyShort].v++;
  }
  const compItems = Object.entries(byComp).map(([label, d]) => {
    const p = pct(d.v, d.t);
    return { label, value: p, fmt: fmtPct(p) };
  }).sort((a, b) => b.value - a.value);

  // faixas
  const faixas = [
    { label: 'Vencido', value: venc, color: 'var(--red)' },
    { label: 'Pendente', value: pend, color: 'var(--amber)' },
    { label: 'Até 30 dias', value: rows.filter(r => r.status === 'VÁLIDO' && r.dias <= 30).length, color: 'var(--red)' },
    { label: '31 a 60 dias', value: rows.filter(r => r.status === 'VÁLIDO' && r.dias > 30 && r.dias <= 60).length, color: 'var(--amber)' },
    { label: '61 a 90 dias', value: rows.filter(r => r.status === 'VÁLIDO' && r.dias > 60 && r.dias <= 90).length, color: 'var(--green)' },
    { label: 'Acima de 90 dias', value: rows.filter(r => r.status === 'VÁLIDO' && r.dias > 90).length, color: 'var(--green)' },
  ];

  // não conformidades por treinamento
  const byTr = {};
  for (const r of rows) if (r.status !== 'VÁLIDO') byTr[r.trName] = (byTr[r.trName] || 0) + 1;
  const trItems = Object.entries(byTr).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

  // colaboradores com maior pendência
  const byEmp = {};
  for (const r of rows) {
    const k = r.employee_id;
    byEmp[k] = byEmp[k] || { name: r.empName, company: r.companyShort, cargo: r.cargo, p: 0, v: 0, t: 0, ok: 0 };
    byEmp[k].t++;
    if (r.status === 'PENDENTE') byEmp[k].p++;
    else if (r.status === 'VENCIDO') byEmp[k].v++;
    else byEmp[k].ok++;
  }
  const empItems = Object.values(byEmp).filter(e => e.p + e.v > 0).sort((a, b) => (b.p + b.v) - (a.p + a.v));

  $('tab-visao').innerHTML = `
    <div class="kpis">
      ${kpi('Colaboradores', fmtN(emps.length), 'pessoas na base filtrada')}
      ${kpi('Treinamentos exigidos', fmtN(rows.length), 'registros colaborador × NR')}
      ${kpi('Aderência', fmtPct(ader), fmtN(validos) + ' válidos · meta 95%', ader >= 95 ? 'green' : ader >= 75 ? 'amber' : 'red')}
      ${kpi('Pendentes', fmtN(pend), 'nunca realizados', 'amber')}
      ${kpi('Vencidos', fmtN(venc), 'fora da validade', 'red')}
      ${kpi('Horas a treinar', fmtH(horas) + ' h', 'para regularizar tudo', 'orange')}
    </div>
    <div class="grid cols-3">
      <div class="card">
        <h3>Distribuição por situação</h3>
        <div class="chart-box"><canvas id="chartDonut"></canvas></div>
        <div class="legend">
          <div class="li"><span class="dot" style="background:var(--green)"></span>VÁLIDO · <b>${fmtN(validos)}</b> (${fmtPct(pct(validos, rows.length))})</div>
          <div class="li"><span class="dot" style="background:var(--amber)"></span>PENDENTE · <b>${fmtN(pend)}</b> (${fmtPct(pct(pend, rows.length))})</div>
          <div class="li"><span class="dot" style="background:var(--red)"></span>VENCIDO · <b>${fmtN(venc)}</b> (${fmtPct(pct(venc, rows.length))})</div>
        </div>
      </div>
      <div class="card">
        <h3>Aderência por empresa <small>% de treinamentos válidos</small></h3>
        ${hbars(compItems, i => colorByPct(i.value), 100)}
      </div>
      <div class="card">
        <h3>Registros por faixa de vencimento</h3>
        ${faixas.map(f => `
          <div class="hbar-row"><div class="lbl">${f.label}</div>
          <div class="track"><div class="fill" style="width:${Math.min(100, pct(f.value, Math.max(1, ...faixas.map(x => x.value))))}%;background:${f.color}"></div></div>
          <div class="val">${fmtN(f.value)}</div></div>`).join('')}
      </div>
    </div>
    <div class="grid split-31">
      <div class="card">
        <h3>Treinamentos com mais não conformidades <small>pendentes + vencidos</small></h3>
        ${hbars(trItems, () => 'var(--red)')}
      </div>
      <div class="card">
        <h3>Colaboradores com maior pendência <small>${fmtN(empItems.length)} com algo em aberto</small></h3>
        <div class="tbl-wrap"><table class="tbl fixa">
        <colgroup><col style="width:30%"><col style="width:17%"><col style="width:29%"><col style="width:8%"><col style="width:8%"><col style="width:8%"></colgroup>
        <thead><tr>
          <th>Colaborador</th><th>Empresa</th><th>Função</th><th style="text-align:center">Pend.</th><th style="text-align:center">Venc.</th><th style="text-align:center">Ader.</th>
        </tr></thead><tbody>
          ${empItems.slice(0, 60).map(e => `<tr>
            <td>${esc(e.name)}</td><td>${esc(e.company)}</td><td>${esc(e.cargo)}</td>
            <td style="text-align:center;font-weight:700;color:var(--amber)">${e.p}</td>
            <td style="text-align:center;font-weight:700;color:var(--red)">${e.v}</td>
            <td style="text-align:center">${fmtPct(pct(e.ok, e.t))}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhuma pendência 🎉</td></tr>'}
        </tbody></table></div>
      </div>
    </div>`;

  destroyChart('donut');
  charts.donut = new Chart($('chartDonut'), {
    type: 'doughnut',
    data: {
      labels: ['Válido', 'Pendente', 'Vencido'],
      datasets: [{ data: [validos, pend, venc], backgroundColor: ['#2e8b46', '#e9a13b', '#cf3b2f'], borderWidth: 3, borderColor: '#fff' }]
    },
    options: { cutout: '62%', plugins: { legend: { display: false } }, maintainAspectRatio: false }
  });
  // total no centro
  const box = $('chartDonut').parentElement;
  const center = document.createElement('div');
  center.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none';
  center.innerHTML = `<div style="font-size:30px;font-weight:800;color:var(--navy)">${fmtN(rows.length)}</div><div style="font-size:11px;color:var(--muted)">registros</div>`;
  box.appendChild(center);
}

// ===== Vencimentos =====
let agendaState = { col: 'dias', dir: 1 };
function renderVencimentos() {
  const rows = fRows();
  const venc = rows.filter(r => r.status === 'VENCIDO');
  const v30 = rows.filter(r => r.status === 'VÁLIDO' && r.dias <= 30);
  const v60 = rows.filter(r => r.status === 'VÁLIDO' && r.dias <= 60);
  const v90 = rows.filter(r => r.status === 'VÁLIDO' && r.dias <= 90);
  const pessoas90 = new Set(v90.map(r => r.employee_id)).size;
  const horas90 = v90.reduce((s, r) => s + (r.tr.ch_reciclagem || 0), 0);

  // gráfico por mês (18 meses a partir do mês atual)
  const months = [];
  const base = new Date(DS.today + 'T12:00:00'); base.setDate(1);
  for (let i = 0; i < 18; i++) {
    const d = new Date(base); d.setMonth(d.getMonth() + i);
    months.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), label: String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear(), count: 0 });
  }
  for (const r of rows) {
    if (!r.vencimento) continue;
    const key = r.vencimento.slice(0, 7);
    const m = months.find(x => x.key === key);
    if (m) m.count++;
  }

  // turmas a programar (90 dias) por treinamento
  const turmas = {};
  for (const r of v90) turmas[r.trName] = (turmas[r.trName] || 0) + 1;
  const turmasItems = Object.entries(turmas).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

  // Agenda: tudo que precisa de atenção — vencidos, pendentes (nunca realizados,
  // por isso sem data) e os válidos por ordem de vencimento.
  const agenda = rows.map(r => ({
    empName: r.empName, company: r.companyShort, cargo: r.cargo, trName: r.trName,
    realizacao: r.realizacao, vencimento: r.vencimento, dias: r.dias, status: r.status,
    horas: r.horas,
  }));
  // Do mais crítico ao mais distante: vencido (do mais antigo), depois pendente,
  // depois válido (do que vence antes).
  const ordem = { 'VENCIDO': 0, 'PENDENTE': 1, 'VÁLIDO': 2 };
  agenda.sort((a, b) => (ordem[a.status] - ordem[b.status]) ||
                        ((a.dias ?? 0) - (b.dias ?? 0)) ||
                        a.empName.localeCompare(b.empName, 'pt-BR'));

  // Filtro próprio da agenda, além dos filtros gerais do topo.
  const val = (id) => ($(id) ? $(id).value : '');
  const agendaFiltrada = () => {
    const busca = val('agBusca').trim().toLowerCase();
    const prazo = val('agPrazo'), emp = val('agEmpresa'), sit = val('agSituacao'), trn = val('agTreino');
    return agenda.filter(a => {
      if (busca) {
        const alvo = (a.empName + ' ' + a.trName + ' ' + a.cargo + ' ' + a.company).toLowerCase();
        if (!alvo.includes(busca)) return false;
      }
      if (emp && a.company !== emp) return false;
      if (sit && a.status !== sit) return false;
      if (trn && a.trName !== trn) return false;
      // Pendente não tem data, então só entra nos recortes que não dependem de prazo.
      const pendente = a.status === 'PENDENTE';
      if (prazo === 'pendentes' && !pendente) return false;
      if (prazo === 'vencidos' && !(!pendente && a.dias < 0)) return false;
      if (prazo === '30' && !(!pendente && a.dias >= 0 && a.dias <= 30)) return false;
      if (prazo === '60' && !(!pendente && a.dias >= 0 && a.dias <= 60)) return false;
      if (prazo === '90' && !(!pendente && a.dias >= 0 && a.dias <= 90)) return false;
      if (prazo === 'criticos' && !(pendente || a.dias <= 30)) return false;
      return true;
    });
  };

  const renderAgendaBody = () => {
    const lista = agendaFiltrada();
    if ($('agResumo')) {
      $('agResumo').innerHTML = '<b>' + fmtN(lista.length) + '</b> de ' + fmtN(agenda.length) + ' registros' +
        (lista.length > 400 ? ' · a tela mostra os 400 primeiros; o arquivo baixado traz todos' : '');
    }
    $('agendaBody').innerHTML = lista.slice(0, 400).map(a => {
      const pendente = a.status === 'PENDENTE';
      const corDias = a.dias < 0 ? 'var(--red)' : a.dias <= 60 ? 'var(--amber)' : 'var(--navy)';
      return `<tr>
        <td>${esc(a.empName)}</td><td>${esc(a.company)}</td><td>${esc(a.cargo)}</td><td>${esc(a.trName)}</td>
        <td>${pendente ? '<span class="hint">nunca realizado</span>' : brDate(a.realizacao)}</td>
        <td>${pendente ? '—' : brDate(a.vencimento)}</td>
        <td style="text-align:center;font-weight:700;color:${pendente ? 'var(--muted)' : corDias}">${pendente ? '—' : a.dias}</td>
        <td><span class="badge ${STATUS_CLASS[a.status]}">${a.status}</span></td></tr>`;
    }).join('') || '<tr><td colspan="8" class="empty">Nenhum registro com esses filtros</td></tr>';
  };

  // O que vai para o Excel ou PDF: a lista filtrada inteira, sem o corte de tela.
  const relatorioAgenda = () => ({
    titulo: 'Agenda de Vencimentos',
    aba: 'Agenda',
    colunas: [
      { nome: 'Colaborador', largura: 20 }, { nome: 'Empresa', largura: 12 },
      { nome: 'Função', largura: 16 }, { nome: 'Treinamento', largura: 20 },
      { nome: 'Realização', largura: 9 }, { nome: 'Vencimento', largura: 9 },
      { nome: 'Dias', largura: 6 }, { nome: 'Situação', largura: 8 },
    ],
    linhas: agendaFiltrada().map(a => [a.empName, a.company, a.cargo, a.trName,
      a.status === 'PENDENTE' ? 'nunca realizado' : brDate(a.realizacao),
      a.status === 'PENDENTE' ? '' : brDate(a.vencimento),
      a.status === 'PENDENTE' ? '' : a.dias, a.status]),
  });

  $('tab-vencimentos').innerHTML = `
    <div class="kpis">
      ${kpi('Já vencidos', fmtN(venc.length), 'ação imediata', 'red')}
      ${kpi('Vence em 30 dias', fmtN(v30.length), 'programar turma', 'amber')}
      ${kpi('Vence em 60 dias', fmtN(v60.length), 'acumulado', 'orange')}
      ${kpi('Vence em 90 dias', fmtN(v90.length), 'acumulado')}
      ${kpi('Pessoas a reciclar (90d)', fmtN(pessoas90), 'colaboradores distintos')}
      ${kpi('Horas de reciclagem (90d)', fmtH(horas90) + ' h', 'carga a contratar', 'green')}
    </div>
    <div class="grid split-13">
      <div class="card">
        <h3>Treinamentos a vencer por mês <small>próximos 18 meses</small></h3>
        <div class="chart-box"><canvas id="chartMeses"></canvas></div>
      </div>
      <div class="card">
        <h3>Turmas a programar em 90 dias</h3>
        ${hbars(turmasItems, () => '#2a9d8f')}
      </div>
    </div>
    <div class="card">
      <h3>Agenda detalhada <small>vencidos, pendentes e a vencer · do mais crítico ao mais distante · clique no cabeçalho para reordenar</small></h3>
      <div class="filtros-secao" style="box-shadow:none;padding:0 0 14px;background:transparent">
        <div class="f" style="flex:2"><label>Buscar na agenda</label>
          <input type="search" id="agBusca" placeholder="colaborador, treinamento, função ou empresa"></div>
        <div class="f"><label>Empresa</label><select id="agEmpresa"><option value="">Todas</option>
          ${[...new Set(agenda.map(a => a.company))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
            .map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div class="f"><label>Treinamento</label><select id="agTreino"><option value="">Todos</option>
          ${[...new Set(agenda.map(a => a.trName))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
            .map(t => `<option>${esc(t)}</option>`).join('')}</select></div>
        <div class="f"><label>Situação</label><select id="agSituacao">
          <option value="">Todas</option><option>PENDENTE</option><option>VENCIDO</option><option>VÁLIDO</option>
        </select></div>
        <div class="f"><label>Prazo</label><select id="agPrazo">
          <option value="">Todos os prazos</option>
          <option value="criticos">Críticos (pendentes + vencidos + 30 dias)</option>
          <option value="pendentes">Somente pendentes</option>
          <option value="vencidos">Somente vencidos</option>
          <option value="30">Vence em até 30 dias</option>
          <option value="60">Vence em até 60 dias</option>
          <option value="90">Vence em até 90 dias</option>
        </select></div>
        <button class="btn-ghost" id="agLimpar">Limpar</button>
      </div>
      <div class="toolbar" style="margin-bottom:8px">
        <span class="hint" id="agResumo"></span>
        <div style="flex:1"></div>
        ${botoesBaixar('ag')}
      </div>
      <div class="tbl-wrap" style="max-height:520px"><table class="tbl"><thead><tr>
        <th data-c="empName">Colaborador</th><th data-c="company">Empresa</th><th data-c="cargo">Função</th>
        <th data-c="trName">Treinamento</th><th data-c="realizacao">Realização</th><th data-c="vencimento">Vencimento</th>
        <th data-c="dias">Dias</th><th data-c="status">Situação</th>
      </tr></thead><tbody id="agendaBody"></tbody></table></div>
    </div>`;
  renderAgendaBody();
  const camposAgenda = ['agBusca', 'agEmpresa', 'agTreino', 'agSituacao', 'agPrazo'];
  camposAgenda.forEach(id => $(id).addEventListener('input', renderAgendaBody));
  $('agLimpar').addEventListener('click', () => {
    camposAgenda.forEach(id => { $(id).value = ''; });
    renderAgendaBody();
  });
  ligarBotoesBaixar('ag', relatorioAgenda);
  document.querySelectorAll('#tab-vencimentos thead th[data-c]').forEach(th => th.addEventListener('click', () =>
    sortTable('agenda', agenda, renderAgendaBody, agendaState, th.dataset.c,
      { dias: 'num', realizacao: 'num', vencimento: 'num' })));

  destroyChart('meses');
  charts.meses = new Chart($('chartMeses'), {
    type: 'bar',
    data: {
      labels: months.map(m => m.label),
      datasets: [{
        data: months.map(m => m.count),
        backgroundColor: months.map((m, i) => i === 0 ? '#cf3b2f' : i === 1 ? '#e9a13b' : '#1d4b76'),
        borderRadius: 5,
      }]
    },
    options: {
      plugins: { legend: { display: false } }, maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      scales: {
        y: { display: false, beginAtZero: true, grace: '12%' },
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 60, minRotation: 60 } }
      }
    },
    plugins: [barValueLabels]
  });
}

// ===== Avisos =====
// Comunicados que a administração publica para os gestores. Quem tem permissão
// de publicar enxerga também os que estão fora do ar.
let AVISOS = [];
const PRIORIDADES = {
  urgente:    { rotulo: 'Urgente',    cor: 'var(--red)',    fundo: '#fde7e4' },
  importante: { rotulo: 'Importante', cor: '#b17a17',       fundo: '#fcf0da' },
  normal:     { rotulo: 'Informativo', cor: 'var(--navy)',  fundo: '#e8eef5' },
};

function dataAviso(a) {
  const q = dataHoraLocal(a.atualizado_em || a.criado_em);
  return (a.atualizado_em ? 'atualizado em ' : 'publicado em ') + (q || '');
}

const PUBLICO_LABEL = { todos: 'Geral', perfil: 'Liderança/Perfil', empresa: 'Por empresa' };

function midiaHtml(a) {
  if (!a.midia_url) return '';
  if (a.midia_tipo === 'image') return `<div class="aviso-midia"><img src="${esc(a.midia_url)}" loading="lazy"></div>`;
  if (a.midia_tipo === 'video') return `<div class="aviso-midia"><video src="${esc(a.midia_url)}" controls preload="metadata"></video></div>`;
  if (a.midia_tipo === 'pdf') return `<div class="aviso-midia aviso-midia-pdf"><a href="${esc(a.midia_url)}" target="_blank" rel="noopener">📄 Abrir PDF anexado</a></div>`;
  return '';
}

async function renderAvisos() {
  const dados = await api('/api/avisos');
  AVISOS = dados.avisos;
  const publica = dados.podePublicar;
  const ativos = AVISOS.filter(a => a.ativo);

  const cartao = (a) => {
    const p = PRIORIDADES[a.prioridade] || PRIORIDADES.normal;
    return `<div class="aviso ${a.ativo ? '' : 'inativo'}" style="border-left-color:${p.cor}">
      <div class="aviso-topo">
        <span class="aviso-tag" style="background:${p.fundo};color:${p.cor}">${p.rotulo}</span>
        ${a.fixado ? '<span class="aviso-tag" style="background:#e8eef5;color:var(--navy)">📌 Fixado</span>' : ''}
        ${a.publico_tipo !== 'todos' ? `<span class="aviso-tag" style="background:#fff1e0;color:var(--orange)">🎯 ${PUBLICO_LABEL[a.publico_tipo]}</span>` : ''}
        ${a.ativo ? '' : '<span class="aviso-tag" style="background:#eceff3;color:var(--muted)">Fora do ar</span>'}
        <div style="flex:1"></div>
        ${publica ? `<button class="btn-mini" onclick="editarAviso(${a.id})">Editar</button>
                     <button class="btn-mini danger" onclick="excluirAviso(${a.id})">Excluir</button>` : ''}
      </div>
      <h3 class="aviso-titulo">${esc(a.titulo)}</h3>
      <div class="aviso-texto">${esc(a.texto)}</div>
      ${midiaHtml(a)}
      <div class="aviso-rodape">${esc(dataAviso(a))}${a.autor ? ' · por ' + esc(a.autor) : ''}</div>
    </div>`;
  };

  $('tab-avisos').innerHTML = `
    <div class="admin-head">
      <h2>📣 Mural de Comunicação</h2>
      <span class="hint">${publica
        ? 'Publique posts, vídeos ou PDFs para todos ou para um público específico.'
        : 'Comunicados da administração.'}</span>
      ${publica ? '<button class="btn-primary" onclick="editarAviso(null)">+ Novo comunicado</button>' : ''}
    </div>
    ${ativos.length || (publica && AVISOS.length)
      ? `<div class="avisos-lista">${AVISOS.map(cartao).join('')}</div>`
      : `<div class="card"><div class="empty">Nenhum comunicado publicado no momento.</div></div>`}`;

  marcarAvisosLidos(ativos);
}

// Destaca no menu quantos comunicados o usuário ainda não abriu.
function contarAvisosNovos() {
  if (!DS || !pode('avisos')) return;
  fetch('/api/avisos').then(r => r.ok ? r.json() : null).then(d => {
    if (!d) return;
    const vistos = JSON.parse(localStorage.getItem('avisosVistos') || '[]');
    const novos = d.avisos.filter(a => a.ativo && !vistos.includes(a.id)).length;
    const selo = $('badgeAvisos');
    if (!selo) return;
    selo.style.display = novos ? '' : 'none';
    selo.textContent = novos;
  }).catch(() => {});
}
function marcarAvisosLidos(ativos) {
  localStorage.setItem('avisosVistos', JSON.stringify(ativos.map(a => a.id)));
  const selo = $('badgeAvisos');
  if (selo) selo.style.display = 'none';
}

window.editarAviso = async (id) => {
  const a = id ? AVISOS.find(x => x.id === id) : null;
  const { profiles } = await api('/api/profiles');
  let midia = a && a.midia_url ? { url: a.midia_url, tipo: a.midia_tipo, mime: a.midia_mime } : null;
  const publicoValorAtual = a && a.publico_valor ? JSON.parse(a.publico_valor) : [];

  openModal(a ? 'Editar comunicado' : 'Novo comunicado', `
    <label>Título</label>
    <input id="mTitulo" value="${esc(a?.titulo || '')}" placeholder="ex.: Turma de NR-35 em setembro">
    <label>Texto do comunicado</label>
    <textarea id="mTexto" rows="6" placeholder="Escreva aqui a mensagem.">${esc(a?.texto || '')}</textarea>
    <label>Anexo (opcional)</label>
    <input type="file" id="mArquivo" accept="image/jpeg,image/png,image/gif,video/mp4,application/pdf">
    <div id="mMidiaPreview" style="margin-top:8px">${midia ? midiaPreviewHtml(midia) : ''}</div>
    <div class="row2" style="margin-top:10px">
      <div><label>Prioridade</label>
        <select id="mPrioridade">
          <option value="normal" ${!a || a.prioridade === 'normal' ? 'selected' : ''}>Informativo</option>
          <option value="importante" ${a && a.prioridade === 'importante' ? 'selected' : ''}>Importante</option>
          <option value="urgente" ${a && a.prioridade === 'urgente' ? 'selected' : ''}>Urgente</option>
        </select></div>
      <div><label>Exibição</label>
        <select id="mAtivo">
          <option value="1" ${!a || a.ativo ? 'selected' : ''}>Visível</option>
          <option value="0" ${a && !a.ativo ? 'selected' : ''}>Fora do ar (rascunho)</option>
        </select></div>
    </div>
    <label>Público-alvo</label>
    <select id="mPublicoTipo">
      <option value="todos" ${!a || a.publico_tipo === 'todos' ? 'selected' : ''}>Todos</option>
      <option value="perfil" ${a && a.publico_tipo === 'perfil' ? 'selected' : ''}>Por perfil (ex.: Liderança)</option>
      <option value="empresa" ${a && a.publico_tipo === 'empresa' ? 'selected' : ''}>Por empresa</option>
    </select>
    <div id="mPublicoValor" style="margin-top:8px"></div>
    <label style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;margin-top:10px">
      <input type="checkbox" id="mFixado" style="width:auto;accent-color:var(--orange)" ${a && a.fixado ? 'checked' : ''}>
      Fixar no topo da lista
    </label>`,
    [{ label: 'Publicar', cls: 'btn-primary', onClick: async () => {
      const publico_tipo = $('mPublicoTipo').value;
      const publico_valor = publico_tipo === 'todos' ? [] :
        [...document.querySelectorAll('.mPublicoItem:checked')].map(c => Number(c.value));
      const body = {
        titulo: $('mTitulo').value, texto: $('mTexto').value,
        prioridade: $('mPrioridade').value,
        ativo: $('mAtivo').value === '1', fixado: $('mFixado').checked,
        publico_tipo, publico_valor,
        midia_url: midia ? midia.url : null, midia_tipo: midia ? midia.tipo : null, midia_mime: midia ? midia.mime : null,
      };
      if (!body.titulo.trim() || !body.texto.trim()) return toast('Preencha título e texto', true);
      if (publico_tipo !== 'todos' && !publico_valor.length) return toast('Selecione ao menos um item do público-alvo', true);
      if (a) await api('/api/avisos/' + a.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/avisos', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Comunicado salvo'); renderAvisos();
    } }], 'media');

  const desenharPublicoValor = () => {
    const tipo = $('mPublicoTipo').value;
    const box = $('mPublicoValor');
    if (tipo === 'perfil') {
      box.innerHTML = '<div class="hint" style="margin-bottom:6px">Marque os perfis que devem ver este comunicado:</div>' +
        profiles.map(p => `<label style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;margin-bottom:4px">
          <input type="checkbox" class="mPublicoItem" value="${p.id}" style="width:auto;accent-color:var(--orange)" ${publicoValorAtual.includes(p.id) ? 'checked' : ''}>
          ${esc(p.name)}</label>`).join('');
    } else if (tipo === 'empresa') {
      box.innerHTML = '<div class="hint" style="margin-bottom:6px">Marque as empresas que devem ver este comunicado:</div>' +
        DS.companies.map(c => `<label style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;margin-bottom:4px">
          <input type="checkbox" class="mPublicoItem" value="${c.id}" style="width:auto;accent-color:var(--orange)" ${publicoValorAtual.includes(c.id) ? 'checked' : ''}>
          ${esc(c.short_name || c.name)}</label>`).join('');
    } else {
      box.innerHTML = '';
    }
  };
  desenharPublicoValor();
  $('mPublicoTipo').onchange = desenharPublicoValor;

  $('mArquivo').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const tipo = file.type.startsWith('image/') ? 'image' : file.type === 'video/mp4' ? 'video' : file.type === 'application/pdf' ? 'pdf' : null;
    if (!tipo) return toast('Use imagem (JPG/PNG/GIF), vídeo MP4 ou PDF.', true);
    $('mMidiaPreview').innerHTML = '<div class="hint">Enviando…</div>';
    try {
      const blob = await VercelBlobClient.upload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/avisos/upload-token',
        contentType: file.type,
      });
      midia = { url: blob.url, tipo, mime: file.type };
      $('mMidiaPreview').innerHTML = midiaPreviewHtml(midia);
    } catch (err) {
      $('mMidiaPreview').innerHTML = '';
      toast(err.message || 'Falha no upload.', true);
    }
  };

  window.__removerMidiaAviso = () => { midia = null; $('mMidiaPreview').innerHTML = ''; };
};

function midiaPreviewHtml(midia) {
  const remover = `<button type="button" class="btn-mini danger" onclick="window.__removerMidiaAviso()" style="margin-top:6px">Remover anexo</button>`;
  if (midia.tipo === 'image') return `<img src="${esc(midia.url)}" style="max-width:220px;max-height:140px;border-radius:8px;display:block">${remover}`;
  if (midia.tipo === 'video') return `<video src="${esc(midia.url)}" style="max-width:220px;max-height:140px;border-radius:8px;display:block" controls></video>${remover}`;
  return `<div>📄 PDF anexado</div>${remover}`;
}

window.excluirAviso = async (id) => {
  const a = AVISOS.find(x => x.id === id);
  if (!await confirmar('Excluir o comunicado "' + a.titulo + '"?\n\nPara apenas tirá-lo do ar sem apagar, use Editar e mude a exibição para rascunho.', 'Excluir comunicado')) return;
  await api('/api/avisos/' + id, { method: 'DELETE' });
  toast('Comunicado excluído'); renderAvisos();
};

// ===== Treinamentos Realizados =====
// Responde "quem foi treinado no mês". Usa o histórico completo de lançamentos,
// não a situação atual: uma pessoa que reciclou três vezes aparece três vezes,
// cada uma no seu mês.
let REALIZADOS = null;
let periodoRealizados = null;   // 'AAAA-MM' ou 'ano:AAAA' ou 'tudo'

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
               'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const nomeMes = (aaaaMm) => {
  const [a, m] = aaaaMm.split('-');
  return MESES[Number(m) - 1] + ' de ' + a;
};

async function renderRealizados() {
  if (!REALIZADOS) {
    $('tab-realizados').innerHTML = '<div class="card"><div class="empty">Carregando o histórico…</div></div>';
    REALIZADOS = (await api('/api/realizados')).realizados;
  }

  // Meses que têm alguma realização, do mais recente para o mais antigo.
  const meses = [...new Set(REALIZADOS.map(r => r.realizacao.slice(0, 7)))].sort().reverse();
  const anos = [...new Set(meses.map(m => m.slice(0, 4)))].sort().reverse();
  if (!periodoRealizados) periodoRealizados = meses[0] || 'tudo';

  const noPeriodo = (r) => {
    if (periodoRealizados === 'tudo') return true;
    if (periodoRealizados.startsWith('ano:')) return r.realizacao.slice(0, 4) === periodoRealizados.slice(4);
    return r.realizacao.slice(0, 7) === periodoRealizados;
  };
  // Os filtros do topo (empresa, cargo, treinamento, busca) também valem aqui.
  const passaFiltro = (r) => {
    const fe = $('fEmpresa').value, fc = $('fCargo').value, ft = $('fTreinamento').value,
          fb = $('fBusca').value.trim().toLowerCase();
    if (fe && r.empresa_completa !== fe) return false;
    if (fc && (r.cargo || '') !== fc) return false;
    if (ft && r.treinamento !== ft) return false;
    if (fb && !r.colaborador.toLowerCase().includes(fb)) return false;
    return true;
  };

  const base = REALIZADOS.filter(passaFiltro);
  const lista = base.filter(noPeriodo);
  const pessoas = new Set(lista.map(r => r.employee_id));
  const horas = lista.reduce((s, r) => s + (r.ch_formacao || 0), 0);
  const tipos = new Set(lista.map(r => r.training_id));

  // Comparação com o período anterior equivalente, para dar noção de ritmo.
  let comparativo = '';
  if (/^\d{4}-\d{2}$/.test(periodoRealizados)) {
    const d = new Date(periodoRealizados + '-15T12:00:00');
    d.setMonth(d.getMonth() - 1);
    const anterior = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const qtdAnterior = base.filter(r => r.realizacao.slice(0, 7) === anterior).length;
    if (qtdAnterior || lista.length) {
      const dif = lista.length - qtdAnterior;
      comparativo = dif === 0 ? 'igual a ' + nomeMes(anterior)
        : (dif > 0 ? '+' : '') + dif + ' em relação a ' + nomeMes(anterior);
    }
  }

  // Gráfico dos últimos 12 meses com movimento.
  const ultimos = meses.slice(0, 12).reverse();
  const porMes = ultimos.map(m => ({
    label: m.slice(5) + '/' + m.slice(2, 4),
    valor: base.filter(r => r.realizacao.slice(0, 7) === m).length,
    chave: m,
  }));

  // Treinamentos mais aplicados no período.
  const porTreino = {};
  for (const r of lista) {
    porTreino[r.treinamento] = porTreino[r.treinamento] || { qtd: 0, pessoas: new Set(), horas: 0 };
    porTreino[r.treinamento].qtd++;
    porTreino[r.treinamento].pessoas.add(r.employee_id);
    porTreino[r.treinamento].horas += r.ch_formacao || 0;
  }
  const treinoItems = Object.entries(porTreino)
    .map(([label, d]) => ({ label, value: d.qtd, pessoas: d.pessoas.size, horas: d.horas }))
    .sort((a, b) => b.value - a.value);

  const titulo = periodoRealizados === 'tudo' ? 'todo o histórico'
    : periodoRealizados.startsWith('ano:') ? periodoRealizados.slice(4)
    : nomeMes(periodoRealizados);

  $('tab-realizados').innerHTML = `
    <div class="filtros-secao">
      <div class="f" style="max-width:280px"><label>Período</label>
        <select id="rlPeriodo">
          <optgroup label="Mês">
            ${meses.map(m => `<option value="${m}" ${m === periodoRealizados ? 'selected' : ''}>${nomeMes(m)}</option>`).join('')}
          </optgroup>
          <optgroup label="Ano inteiro">
            ${anos.map(a => `<option value="ano:${a}" ${'ano:' + a === periodoRealizados ? 'selected' : ''}>${a}</option>`).join('')}
          </optgroup>
          <option value="tudo" ${periodoRealizados === 'tudo' ? 'selected' : ''}>Todo o histórico</option>
        </select></div>
      <div class="f" style="flex:2"><label>Buscar nesta lista</label>
        <input type="search" id="rlBusca" placeholder="colaborador ou treinamento"></div>
      <div style="align-self:flex-end;display:flex;gap:8px">${botoesBaixar('rl')}</div>
    </div>

    <div class="kpis">
      ${kpi('Pessoas treinadas', fmtN(pessoas.size), 'colaboradores distintos em ' + titulo, 'green')}
      ${kpi('Treinamentos realizados', fmtN(lista.length), comparativo || 'lançamentos no período')}
      ${kpi('Horas de treinamento', fmtH(horas) + ' h', 'somando a carga horária da matriz', 'orange')}
      ${kpi('Tipos de NR aplicados', fmtN(tipos.size), 'treinamentos diferentes')}
    </div>

    <div class="grid split-31">
      <div class="card">
        <h3>Realizados por mês <small>últimos ${porMes.length} meses com movimento</small></h3>
        <div class="chart-box"><canvas id="chartRealizados"></canvas></div>
      </div>
      <div class="card">
        <h3>Treinamentos aplicados em ${esc(titulo)} <small>${fmtN(treinoItems.length)} tipo(s)</small></h3>
        <div class="tbl-wrap" style="max-height:320px"><table class="tbl fixa">
          <colgroup><col style="width:52%"><col style="width:16%"><col style="width:16%"><col style="width:16%"></colgroup>
          <thead><tr><th>Treinamento</th><th style="text-align:center">Turmas</th>
            <th style="text-align:center">Pessoas</th><th style="text-align:center">Horas</th></tr></thead>
          <tbody>${treinoItems.map(t => `<tr>
            <td>${esc(t.label)}</td>
            <td style="text-align:center;font-weight:700">${t.value}</td>
            <td style="text-align:center">${t.pessoas}</td>
            <td style="text-align:center">${fmtH(t.horas)} h</td></tr>`).join('') ||
            '<tr><td colspan="4" class="empty">Nenhum treinamento no período</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>

    <div class="card">
      <h3>Quem foi treinado em ${esc(titulo)} <small id="rlResumo"></small></h3>
      <div class="tbl-wrap" style="max-height:520px"><table class="tbl fixa">
        <colgroup><col style="width:24%"><col style="width:13%"><col style="width:19%"><col style="width:24%"><col style="width:10%"><col style="width:10%"></colgroup>
        <thead><tr><th>Colaborador</th><th>Empresa</th><th>Função</th><th>Treinamento</th>
          <th style="text-align:center">Realizado em</th><th style="text-align:center">Vence em</th></tr></thead>
        <tbody id="rlBody"></tbody></table></div>
    </div>`;

  const filtrada = () => {
    const q = $('rlBusca').value.trim().toLowerCase();
    return lista.filter(r => !q ||
      (r.colaborador + ' ' + r.treinamento + ' ' + (r.cargo || '') + ' ' + r.empresa).toLowerCase().includes(q));
  };
  const pintar = () => {
    const l = filtrada();
    $('rlResumo').textContent = fmtN(l.length) + ' registro(s)' +
      (l.length > 400 ? ' · a tela mostra os 400 primeiros' : '');
    $('rlBody').innerHTML = l.slice(0, 400).map(r => `<tr>
      <td>${esc(r.colaborador)}${r.demissao ? ' <span class="hint">(desligado)</span>' : ''}</td>
      <td>${esc(r.empresa)}</td><td>${esc(r.cargo || '—')}</td><td>${esc(r.treinamento)}</td>
      <td style="text-align:center">${brDate(r.realizacao)}</td>
      <td style="text-align:center">${r.vencimento ? brDate(r.vencimento) : '—'}</td></tr>`).join('') ||
      '<tr><td colspan="6" class="empty">Nenhum treinamento realizado neste período</td></tr>';
  };
  pintar();

  $('rlPeriodo').addEventListener('change', (e) => { periodoRealizados = e.target.value; renderRealizados(); });
  $('rlBusca').addEventListener('input', pintar);
  ligarBotoesBaixar('rl', () => ({
    titulo: 'Treinamentos Realizados - ' + titulo,
    aba: 'Realizados',
    colunas: [
      { nome: 'Colaborador', largura: 22 }, { nome: 'Empresa', largura: 13 },
      { nome: 'Função', largura: 17 }, { nome: 'Treinamento', largura: 22 },
      { nome: 'Realizado em', largura: 10 }, { nome: 'Vence em', largura: 10 },
      { nome: 'Carga horária', largura: 8 },
    ],
    linhas: filtrada().map(r => [r.colaborador, r.empresa, r.cargo || '', r.treinamento,
      brDate(r.realizacao), r.vencimento ? brDate(r.vencimento) : '', r.ch_formacao || '']),
  }));

  destroyChart('realizados');
  charts.realizados = new Chart($('chartRealizados'), {
    type: 'bar',
    data: {
      labels: porMes.map(m => m.label),
      datasets: [{
        data: porMes.map(m => m.valor),
        backgroundColor: porMes.map(m => m.chave === periodoRealizados ? '#F5893B' : '#1d4b76'),
        borderRadius: 5,
      }],
    },
    options: {
      plugins: { legend: { display: false } }, maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      scales: { y: { display: false, beginAtZero: true, grace: '12%' },
                x: { grid: { display: false }, ticks: { font: { size: 10 } } } },
      onClick: (evt, els) => {
        if (!els.length) return;
        periodoRealizados = porMes[els[0].index].chave;
        renderRealizados();
      },
    },
    plugins: [barValueLabels],
  });
}

// ===== Pendências e Pontos de Atenção =====
// Reúne, num só lugar, tudo que precisa de ação: treinamentos em aberto e
// inconsistências de cadastro. Tudo o que aparece aqui sai também no Excel.
let pendAba = 'abertos';

function dadosPendencias() {
  const linhas = fRows();
  const pendentes = linhas.filter(r => r.status === 'PENDENTE');
  const vencidos = linhas.filter(r => r.status === 'VENCIDO');
  const aVencer = linhas.filter(r => r.status === 'VÁLIDO' && r.dias <= 90);
  const inconsistencias = verificacoesQualidade().filter(c => !c.informativo && c.itens.length);
  const foraDaConta = ROWS.filter(r => !noEscopo(r));
  return { linhas, pendentes, vencidos, aVencer, inconsistencias, foraDaConta };
}

function renderPendencias() {
  const d = dadosPendencias();
  const afetados = new Set([...d.pendentes, ...d.vencidos].map(r => r.employee_id)).size;
  const horas = [...d.pendentes, ...d.vencidos].reduce((s, r) => s + (r.horas || 0), 0);
  const totalInconsist = d.inconsistencias.reduce((s, c) => s + c.itens.length, 0);

  const abas = [
    { id: 'abertos', nome: 'Em aberto', qtd: d.pendentes.length + d.vencidos.length },
    { id: 'vencer', nome: 'A vencer em 90 dias', qtd: d.aVencer.length },
    { id: 'cadastro', nome: 'Inconsistências de cadastro', qtd: totalInconsist },
    { id: 'fora', nome: 'Fora da conta dos indicadores', qtd: d.foraDaConta.length },
  ];

  $('tab-pendencias').innerHTML = `
    <div class="kpis">
      ${kpi('Pendentes', fmtN(d.pendentes.length), 'nunca realizados', d.pendentes.length ? 'amber' : 'green')}
      ${kpi('Vencidos', fmtN(d.vencidos.length), 'fora da validade', d.vencidos.length ? 'red' : 'green')}
      ${kpi('A vencer em 90 dias', fmtN(d.aVencer.length), 'programar turma', 'orange')}
      ${kpi('Colaboradores afetados', fmtN(afetados), 'com algo em aberto')}
      ${kpi('Inconsistências', fmtN(totalInconsist), 'no cadastro', totalInconsist ? 'amber' : 'green')}
      ${kpi('Horas para regularizar', fmtH(horas) + ' h', 'formação + reciclagem', 'green')}
    </div>

    <div class="toolbar">
      <div class="subtabs" style="margin:0">
        ${abas.map(a => `<button data-p="${a.id}" class="${a.id === pendAba ? 'active' : ''}">
          ${esc(a.nome)} <span class="pill-count">${fmtN(a.qtd)}</span></button>`).join('')}
      </div>
      <div style="flex:1"></div>
      <button class="btn-primary" id="btnExcelPend">⬇ Baixar Excel completo</button>
    </div>
    <p class="hint" style="margin:-6px 0 14px">
      O Excel traz todas as abas acima em um único arquivo, já com os filtros que você aplicou no topo.
    </p>
    <div id="pendConteudo"></div>`;

  document.querySelectorAll('#tab-pendencias .subtabs button').forEach(b =>
    b.addEventListener('click', () => { pendAba = b.dataset.p; renderPendencias(); }));
  $('btnExcelPend').addEventListener('click', () => baixarExcelPendencias($('btnExcelPend')));

  ({ abertos: pendAbertos, vencer: pendAVencer, cadastro: pendCadastro, fora: pendFora }[pendAba])(d);
}

// Tabela reaproveitada pelas abas de treinamentos.
function tabelaTreinamentos(itens, id, colunas) {
  const render = () => {
    const q = $(id + 'Busca').value.trim().toLowerCase();
    const lista = itens.filter(r => !q ||
      (r.empName + ' ' + r.trName + ' ' + r.cargo + ' ' + r.companyShort).toLowerCase().includes(q));
    $(id + 'Resumo').innerHTML = '<b>' + fmtN(lista.length) + '</b> de ' + fmtN(itens.length) + ' registros' +
      (lista.length > 500 ? ' · mostrando os 500 primeiros' : '');
    $(id + 'Body').innerHTML = lista.slice(0, 500).map(colunas.linha).join('') ||
      '<tr><td colspan="' + colunas.cabecalho.length + '" class="empty">Nada encontrado</td></tr>';
  };
  $('pendConteudo').innerHTML = `
    <div class="card">
      <div class="filtros-secao" style="box-shadow:none;padding:0 0 12px;background:transparent">
        <div class="f" style="flex:2"><label>Buscar</label>
          <input type="search" id="${id}Busca" placeholder="colaborador, treinamento, função ou empresa"></div>
      </div>
      <div class="hint" id="${id}Resumo" style="margin-bottom:8px"></div>
      <div class="tbl-wrap" style="max-height:540px"><table class="tbl fixa">
        <colgroup>${colunas.larguras.map(w => `<col style="width:${w}">`).join('')}</colgroup>
        <thead><tr>${colunas.cabecalho.map(c => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody id="${id}Body"></tbody></table></div>
    </div>`;
  $(id + 'Busca').addEventListener('input', render);
  render();
}

function pendAbertos(d) {
  const itens = [...d.vencidos, ...d.pendentes]
    .sort((a, b) => (a.dias ?? 99999) - (b.dias ?? 99999));
  tabelaTreinamentos(itens, 'pAb', {
    larguras: ['22%', '13%', '18%', '23%', '10%', '7%', '7%'],
    cabecalho: ['Colaborador', 'Empresa', 'Função', 'Treinamento', 'Situação', 'Dias', 'Horas'],
    linha: (r) => `<tr>
      <td>${esc(r.empName)}</td><td>${esc(r.companyShort)}</td><td>${esc(r.cargo)}</td>
      <td>${esc(r.trName)}</td>
      <td><span class="badge ${STATUS_CLASS[r.status]}">${r.status}</span></td>
      <td style="text-align:center;font-weight:700;color:var(--red)">${r.dias != null ? r.dias : '—'}</td>
      <td style="text-align:center">${r.horas ? fmtH(r.horas) + 'h' : '—'}</td></tr>`,
  });
}

function pendAVencer(d) {
  const itens = [...d.aVencer].sort((a, b) => a.dias - b.dias);
  tabelaTreinamentos(itens, 'pVe', {
    larguras: ['23%', '13%', '18%', '24%', '11%', '11%'],
    cabecalho: ['Colaborador', 'Empresa', 'Função', 'Treinamento', 'Vencimento', 'Faltam'],
    linha: (r) => `<tr>
      <td>${esc(r.empName)}</td><td>${esc(r.companyShort)}</td><td>${esc(r.cargo)}</td>
      <td>${esc(r.trName)}</td><td style="text-align:center">${brDate(r.vencimento)}</td>
      <td style="text-align:center;font-weight:700;color:${r.dias <= 30 ? 'var(--red)' : 'var(--amber)'}">${r.dias} dias</td></tr>`,
  });
}

function pendCadastro(d) {
  $('pendConteudo').innerHTML = d.inconsistencias.length ? `
    <div class="grid cols-2">
      ${d.inconsistencias.map(c => `
        <div class="card">
          <h3>${esc(c.nome)} <small>${fmtN(c.itens.length)} item(ns)</small></h3>
          <p class="hint" style="margin:-6px 0 10px">${esc(c.porque)}</p>
          <div class="tbl-wrap" style="max-height:260px"><table class="tbl"><tbody>
            ${c.itens.slice(0, 100).map(i => `<tr><td><b>${esc(i.titulo)}</b>
              <div class="hint">${esc(i.sub)}</div></td></tr>`).join('')}
          </tbody></table></div>
          ${c.itens.length > 100 ? `<p class="hint">… e mais ${fmtN(c.itens.length - 100)}. O Excel traz a lista completa.</p>` : ''}
        </div>`).join('')}
    </div>`
    : '<div class="card"><div class="empty" style="color:var(--green);font-weight:600">✔ Nenhuma inconsistência de cadastro.</div></div>';
}

function pendFora(d) {
  const itens = [...d.foraDaConta].sort((a, b) => a.empName.localeCompare(b.empName, 'pt-BR'));
  $('pendConteudo').innerHTML = `
    <div class="card">
      <p class="hint" style="margin-bottom:12px">Treinamentos cadastrados para as pessoas que <b>não constam na trilha
      do cargo</b> delas. No escopo atual (<b>${esc(ESCOPO_LABEL[ESCOPO])}</b>) eles não entram nos indicadores.
      Para passarem a contar, inclua o treinamento na trilha em <b>Administração → Cargos e Trilhas</b>.</p>
      <div class="tbl-wrap" style="max-height:520px"><table class="tbl fixa">
        <colgroup><col style="width:24%"><col style="width:13%"><col style="width:20%"><col style="width:23%"><col style="width:10%"><col style="width:10%"></colgroup>
        <thead><tr><th>Colaborador</th><th>Empresa</th><th>Função</th><th>Treinamento</th><th>Origem</th><th>Situação</th></tr></thead>
        <tbody>${itens.slice(0, 500).map(r => `<tr>
          <td>${esc(r.empName)}</td><td>${esc(r.companyShort)}</td><td>${esc(r.cargo)}</td><td>${esc(r.trName)}</td>
          <td>${r.origem === 'individual' ? 'individual' : 'avulso'}</td>
          <td><span class="badge ${STATUS_CLASS[r.status]}">${r.status}</span></td></tr>`).join('') ||
          '<tr><td colspan="6" class="empty">Nada fora da conta</td></tr>'}</tbody></table></div>
    </div>`;
}

// ---------- baixar uma tabela em Excel ou PDF ----------
// Usado pelos painéis: recebe o título, o cabeçalho e as linhas já filtradas.
// Só aparece para quem tem a permissão de exportar.
function botoesBaixar(id) {
  if (!pode('exportar')) return '';
  return `<button class="btn-ghost" id="${id}Xlsx">⬇ Excel</button>
          <button class="btn-ghost" id="${id}Pdf">⬇ PDF</button>`;
}

function ligarBotoesBaixar(id, montar) {
  if (!pode('exportar')) return;
  const bx = $(id + 'Xlsx'), bp = $(id + 'Pdf');
  if (bx) bx.addEventListener('click', () => baixarTabelaExcel(montar(), bx));
  if (bp) bp.addEventListener('click', () => baixarTabelaPdf(montar(), bp));
}

// Contexto do relatório: posição, escopo e filtros ativos, para o arquivo se
// explicar sozinho quando for repassado.
function contextoRelatorio() {
  const filtros = [
    $('fEmpresa').value && 'Empresa: ' + $('fEmpresa').value,
    $('fCargo').value && 'Cargo: ' + $('fCargo').value,
    $('fTreinamento').value && 'Treinamento: ' + $('fTreinamento').value,
    $('fSituacao').value && 'Situação: ' + $('fSituacao').value,
    $('fBusca').value && 'Busca: ' + $('fBusca').value,
  ].filter(Boolean).join(' · ');
  return 'Posição em ' + brDate(DS.today) + ' · contando ' + ESCOPO_LABEL[ESCOPO] +
         (filtros ? ' · ' + filtros : '');
}

async function baixarTabelaExcel(rel, botao) {
  const texto = botao.textContent;
  botao.disabled = true; botao.textContent = '⬇ Gerando…';
  try {
    const XLSX = await carregarBibliotecaExcel();
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      [rel.titulo], [contextoRelatorio()], [],
      rel.colunas.map(c => c.nome), ...rel.linhas,
    ]);
    ws['!cols'] = rel.colunas.map(c => ({ wch: c.excel || Math.max(12, c.largura * 1.6) }));
    XLSX.utils.book_append_sheet(wb, ws, (rel.aba || 'Relatório').slice(0, 28));
    XLSX.writeFile(wb, rel.titulo + ' ' + DS.today.split('-').reverse().join('_') + '.xlsx');
    toast(fmtN(rel.linhas.length) + ' linhas exportadas');
  } catch (e) {
    toast(e.message || 'Falha ao gerar o Excel', true);
  } finally { botao.disabled = false; botao.textContent = texto; }
}

async function baixarTabelaPdf(rel, botao) {
  const texto = botao.textContent;
  botao.disabled = true; botao.textContent = '⬇ Gerando…';
  try {
    const res = await fetch('/api/relatorio/pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titulo: rel.titulo, subtitulo: contextoRelatorio(),
                             colunas: rel.colunas, linhas: rel.linhas }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Falha ao gerar o PDF');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = rel.titulo + ' ' + DS.today.split('-').reverse().join('_') + '.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('PDF gerado com ' + fmtN(rel.linhas.length) + ' linhas');
  } catch (e) {
    toast(e.message, true);
  } finally { botao.disabled = false; botao.textContent = texto; }
}

// Carrega a biblioteca de Excel só quando o botão é usado, para não pesar a
// abertura do painel com quase 500 KB.
function carregarBibliotecaExcel() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((ok, falhou) => {
    const s = document.createElement('script');
    s.src = '/js/xlsx.core.min.js';
    s.onload = () => ok(window.XLSX);
    s.onerror = () => falhou(new Error('Não foi possível carregar o gerador de Excel'));
    document.head.appendChild(s);
  });
}

async function baixarExcelPendencias(botao) {
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = '⬇ Gerando…';
  try {
    const XLSX = await carregarBibliotecaExcel();
    const d = dadosPendencias();
    const wb = XLSX.utils.book_new();
    const add = (nome, linhas, larguras) => {
      const ws = XLSX.utils.aoa_to_sheet(linhas);
      ws['!cols'] = larguras.map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, nome);
    };
    const filtroAtivo = [
      $('fEmpresa').value && 'Empresa: ' + $('fEmpresa').value,
      $('fCargo').value && 'Cargo: ' + $('fCargo').value,
      $('fTreinamento').value && 'Treinamento: ' + $('fTreinamento').value,
      $('fBusca').value && 'Busca: ' + $('fBusca').value,
    ].filter(Boolean).join(' · ') || 'nenhum';

    // --- Resumo ---
    const afetados = new Set([...d.pendentes, ...d.vencidos].map(r => r.employee_id)).size;
    const horas = [...d.pendentes, ...d.vencidos].reduce((s, r) => s + (r.horas || 0), 0);
    add('Resumo', [
      ['PENDÊNCIAS E PONTOS DE ATENÇÃO — RIVA STONES'],
      [],
      ['Posição em', brDate(DS.today)],
      ['Gerado em', dataHoraLocal(new Date().toISOString().replace('T', ' ').slice(0, 19)) || ''],
      ['Emitido por', ME.name],
      ['Escopo dos indicadores', ESCOPO_LABEL[ESCOPO]],
      ['Filtros aplicados', filtroAtivo],
      [],
      ['INDICADOR', 'QUANTIDADE'],
      ['Treinamentos pendentes (nunca realizados)', d.pendentes.length],
      ['Treinamentos vencidos', d.vencidos.length],
      ['A vencer em até 90 dias', d.aVencer.length],
      ['Colaboradores com algo em aberto', afetados],
      ['Horas para regularizar', Math.round(horas * 10) / 10],
      ['Inconsistências de cadastro', d.inconsistencias.reduce((s, c) => s + c.itens.length, 0)],
      ['Registros fora da conta dos indicadores', d.foraDaConta.length],
    ], [46, 16]);

    const cabTreino = ['Colaborador', 'Empresa', 'Função', 'Treinamento', 'Situação',
                       'Realização', 'Vencimento', 'Dias', 'Horas', 'Origem'];
    const linhaTreino = (r) => [r.empName, r.companyShort, r.cargo, r.trName, r.status,
      brDate(r.realizacao), brDate(r.vencimento), r.dias, r.horas || '', r.origem];
    const largTreino = [34, 22, 28, 34, 11, 12, 12, 8, 8, 12];

    add('Pendentes', [cabTreino, ...d.pendentes
      .sort((a, b) => a.empName.localeCompare(b.empName, 'pt-BR')).map(linhaTreino)], largTreino);
    add('Vencidos', [cabTreino, ...d.vencidos
      .sort((a, b) => (a.dias ?? 0) - (b.dias ?? 0)).map(linhaTreino)], largTreino);
    add('A vencer 90 dias', [cabTreino, ...d.aVencer
      .sort((a, b) => a.dias - b.dias).map(linhaTreino)], largTreino);

    // --- Inconsistências ---
    const linhasInc = [['Tipo de inconsistência', 'Item', 'Detalhe', 'Gravidade', 'Por que importa']];
    for (const c of d.inconsistencias) {
      for (const i of c.itens) {
        linhasInc.push([c.nome, i.titulo, i.sub, c.grave ? 'Crítica' : 'Atenção', c.porque]);
      }
    }
    add('Inconsistências', linhasInc, [38, 36, 46, 11, 62]);

    add('Fora da trilha', [['Colaborador', 'Empresa', 'Função', 'Treinamento', 'Origem', 'Situação'],
      ...d.foraDaConta.sort((a, b) => a.empName.localeCompare(b.empName, 'pt-BR'))
        .map(r => [r.empName, r.companyShort, r.cargo, r.trName, r.origem, r.status])], [34, 22, 28, 34, 12, 11]);

    const nome = 'Pendencias e Atencao ' + DS.today.split('-').reverse().join('_') + '.xlsx';
    XLSX.writeFile(wb, nome);
    toast('Excel gerado com ' + fmtN(d.pendentes.length + d.vencidos.length) + ' pendências');
  } catch (e) {
    toast(e.message || 'Falha ao gerar o Excel', true);
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

// ===== Cargos e Empresas =====
function renderCargos() {
  const rows = fRows();
  const emps = fEmployees();
  const byEmp = {};
  for (const r of rows) {
    byEmp[r.employee_id] = byEmp[r.employee_id] || { nc: 0, t: 0 };
    byEmp[r.employee_id].t++;
    if (r.status !== 'VÁLIDO') byEmp[r.employee_id].nc++;
  }
  const emDia = emps.filter(e => byEmp[e.id] && byEmp[e.id].nc === 0).length;
  const comPend = emps.filter(e => byEmp[e.id] && byEmp[e.id].nc > 0).length;
  const trailCargos = new Set(DS.cargosWithTrail);
  const lacunas = emps.filter(e => !e.cargo_id || !trailCargos.has(e.cargo_id)).length;
  const validos = rows.filter(r => r.status === 'VÁLIDO').length;

  // por cargo (agrupado pela base do nome)
  const byCargo = {};
  for (const r of rows) {
    const k = r.cargoBase;
    byCargo[k] = byCargo[k] || { t: 0, v: 0, nc: 0 };
    byCargo[k].t++;
    if (r.status === 'VÁLIDO') byCargo[k].v++; else byCargo[k].nc++;
  }
  const aderItems = Object.entries(byCargo).filter(([, d]) => d.t >= 5)
    .map(([label, d]) => ({ label, value: pct(d.v, d.t), fmt: fmtPct(pct(d.v, d.t)) }))
    .sort((a, b) => a.value - b.value);
  const ncItems = Object.entries(byCargo).filter(([, d]) => d.nc > 0)
    .map(([label, d]) => ({ label, value: d.nc })).sort((a, b) => b.value - a.value);

  // matriz empresa × cargo
  const matrix = {};
  for (const r of rows) {
    const k = r.companyShort + '|' + r.cargoBase;
    matrix[k] = matrix[k] || { company: r.companyShort, cargo: r.cargoBase, v: 0, p: 0, x: 0 };
    if (r.status === 'VÁLIDO') matrix[k].v++;
    else if (r.status === 'PENDENTE') matrix[k].p++;
    else matrix[k].x++;
  }
  const matrixRows = Object.values(matrix).map(m => ({ ...m, total: m.v + m.p + m.x, ader: pct(m.v, m.v + m.p + m.x) }))
    .sort((a, b) => a.company.localeCompare(b.company, 'pt-BR') || a.ader - b.ader);

  $('tab-cargos').innerHTML = `
    <div class="kpis">
      ${kpi('Colaboradores', fmtN(emps.length), 'na base filtrada')}
      ${kpi('Totalmente em dia', fmtN(emDia), 'sem nenhuma pendência', 'green')}
      ${kpi('Com pendência', fmtN(comPend), 'ao menos 1 item aberto', 'red')}
      ${kpi('% em dia', fmtPct(pct(emDia, emps.length)), 'colaboradores 100% ok', 'green')}
      ${kpi('Lacunas de trilha', fmtN(lacunas), 'sem trilha definida', 'amber')}
      ${kpi('Aderência geral', fmtPct(pct(validos, rows.length)), fmtN(validos) + ' de ' + fmtN(rows.length))}
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h3>Cargos com menor aderência <small>mínimo 5 registros</small></h3>
        ${hbars(aderItems, i => colorByPct(i.value), 100)}
      </div>
      <div class="card">
        <h3>Não conformidades por cargo</h3>
        ${hbars(ncItems, () => 'var(--amber)')}
      </div>
    </div>
    <div class="card">
      <h3>Matriz empresa × cargo × situação</h3>
      <div class="tbl-wrap" style="max-height:520px"><table class="tbl"><thead><tr>
        <th>Empresa</th><th>Cargo</th><th style="text-align:center">Válidos</th><th style="text-align:center">Pendentes</th>
        <th style="text-align:center">Vencidos</th><th style="text-align:center">Total</th><th style="text-align:center">Aderência</th>
      </tr></thead><tbody>
        ${matrixRows.map(m => `<tr>
          <td>${esc(m.company)}</td><td>${esc(m.cargo)}</td>
          <td style="text-align:center;color:var(--green);font-weight:700">${m.v}</td>
          <td style="text-align:center;color:var(--amber);font-weight:700">${m.p}</td>
          <td style="text-align:center;color:var(--red);font-weight:700">${m.x}</td>
          <td style="text-align:center;font-weight:700">${m.total}</td>
          <td style="text-align:center;font-weight:700;color:${colorByPct(m.ader)}">${fmtPct(m.ader)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
}

// ===== Carga Horária e Custo =====
function renderCusto() {
  const rows = fRows();
  const pend = rows.filter(r => r.status === 'PENDENTE');
  const venc = rows.filter(r => r.status === 'VENCIDO');
  const horasForm = pend.reduce((s, r) => s + (r.tr.ch_formacao || 0), 0);
  const horasRec = venc.reduce((s, r) => s + (r.tr.ch_reciclagem || 0), 0);
  const custoTotal = rows.filter(r => r.status !== 'VÁLIDO').reduce((s, r) => s + (r.custo || 0), 0);
  const temCusto = DS.trainings.some(t => (t.custo_formacao || 0) > 0 || (t.custo_reciclagem || 0) > 0);

  const byTr = {};
  for (const r of rows) {
    byTr[r.trName] = byTr[r.trName] || { tr: r.tr, p: 0, v: 0 };
    if (r.status === 'PENDENTE') byTr[r.trName].p++;
    else if (r.status === 'VENCIDO') byTr[r.trName].v++;
  }
  const items = Object.entries(byTr).map(([name, d]) => {
    const horas = d.p * (d.tr.ch_formacao || 0) + d.v * (d.tr.ch_reciclagem || 0);
    const custo = d.p * (d.tr.custo_formacao || 0) + d.v * (d.tr.custo_reciclagem || 0);
    return { name, ...d, horas, custo };
  }).filter(i => i.p + i.v > 0).sort((a, b) => b.horas - a.horas);

  $('tab-custo').innerHTML = `
    <div class="kpis">
      ${kpi('Horas de formação', fmtH(horasForm) + ' h', fmtN(pend.length) + ' treinamentos pendentes', 'amber')}
      ${kpi('Horas de reciclagem', fmtH(horasRec) + ' h', fmtN(venc.length) + ' treinamentos vencidos', 'red')}
      ${kpi('Total de horas', fmtH(horasForm + horasRec) + ' h', 'para regularizar tudo', 'orange')}
      ${kpi('Custo estimado', temCusto ? fmtMoney(custoTotal) : '—', temCusto ? 'com base nos custos cadastrados' : 'cadastre os custos em Cadastros → Treinamentos', 'green')}
    </div>
    <div class="card">
      <h3>Plano de regularização por treinamento <small>pendentes geram formação; vencidos geram reciclagem</small></h3>
      <div class="tbl-wrap" style="max-height:560px"><table class="tbl"><thead><tr>
        <th>Treinamento</th><th style="text-align:center">Pendentes</th><th style="text-align:center">Vencidos</th>
        <th style="text-align:center">CH formação</th><th style="text-align:center">CH reciclagem</th>
        <th style="text-align:center">Horas totais</th><th style="text-align:center">Custo estimado</th>
      </tr></thead><tbody>
        ${items.map(i => `<tr>
          <td>${esc(i.name)}</td>
          <td style="text-align:center;color:var(--amber);font-weight:700">${i.p}</td>
          <td style="text-align:center;color:var(--red);font-weight:700">${i.v}</td>
          <td style="text-align:center">${i.tr.ch_formacao != null ? fmtH(i.tr.ch_formacao) + ' h' : '—'}</td>
          <td style="text-align:center">${i.tr.ch_reciclagem != null ? fmtH(i.tr.ch_reciclagem) + ' h' : '—'}</td>
          <td style="text-align:center;font-weight:700">${fmtH(i.horas)} h</td>
          <td style="text-align:center">${i.custo > 0 ? fmtMoney(i.custo) : '—'}</td></tr>`).join('') ||
          '<tr><td colspan="7" class="empty">Nada a regularizar 🎉</td></tr>'}
      </tbody></table></div>
      <p class="hint">Valores de carga horária vêm da Matriz de C.H. Os custos por treinamento podem ser cadastrados em <b>Cadastros → Treinamentos</b> (custo por pessoa de formação e de reciclagem).</p>
    </div>`;
}

// ===== Qualidade dos Dados =====
// Cada verificação vira uma lista navegável: o que está errado, em quem, e o
// caminho para corrigir. Respeita os filtros do topo, como os demais painéis.
let qualSelecionada = null;

function verificacoesQualidade() {
  const dentroDoFiltro = (e) => {
    const fe = $('fEmpresa').value, fc = $('fCargo').value, fb = $('fBusca').value.trim().toLowerCase();
    if (fe && e.company_name !== fe) return false;
    if (fc && (e.cargo_name || '') !== fc) return false;
    if (fb && !e.name.toLowerCase().includes(fb)) return false;
    return true;
  };
  const ativos = DS.employees.filter(e => !(e.demissao && e.demissao <= DS.today)).filter(dentroDoFiltro);
  const trailCargos = new Set(DS.cargosWithTrail);
  const linhas = fRows();

  const pessoa = (e) => ({ titulo: e.name, sub: (e.cargo_name || 'sem cargo') + ' · ' + (e.company_short || e.company_name),
                           acao: () => { irParaAdmin('colaboradores', e.name); } });
  const lancamento = (r) => ({ titulo: r.empName, sub: r.trName + ' · ' + r.companyShort,
                               acao: () => { irParaAdmin('lancamentos', r.empName); } });

  return [
    { id: 'semCargo', nome: 'Colaboradores sem cargo definido', grave: true,
      porque: 'Sem cargo não há trilha, então os treinamentos obrigatórios dele não são cobrados.',
      ok: 'Todos os colaboradores têm cargo.',
      itens: ativos.filter(e => !e.cargo_id).map(pessoa) },

    { id: 'semTrilha', nome: 'Cargos sem trilha de treinamentos', grave: true,
      porque: 'A trilha define o que é obrigatório. Sem ela, os pendentes ficam subcontados.',
      ok: 'Todos os cargos em uso têm trilha.',
      itens: ativos.filter(e => e.cargo_id && !trailCargos.has(e.cargo_id)).map(pessoa) },

    { id: 'semLanc', nome: 'Colaboradores sem nenhum lançamento', grave: false,
      porque: 'Pode ser admissão recente ou treinamentos ainda não registrados no sistema.',
      ok: 'Todos têm ao menos um lançamento.',
      itens: ativos.filter(e => !linhas.some(r => r.employee_id === e.id && r.record_id)).map(pessoa) },

    { id: 'semVenc', nome: 'Lançamentos sem data de vencimento', grave: true,
      porque: 'Sem vencimento o sistema não consegue dizer se está válido ou vencido.',
      ok: 'Todos os lançamentos têm vencimento.',
      itens: linhas.filter(r => r.record_id && r.realizacao && !r.vencimento).map(lancamento) },

    { id: 'foraTrilha', nome: 'Exigências fora da trilha do cargo', grave: false,
      porque: 'Cobrado da pessoa mas ausente da trilha do cargo. Não entra nos indicadores no ' +
              'escopo padrão — inclua o treinamento na trilha se ele for mesmo obrigatório.',
      ok: 'Tudo o que é cobrado consta na trilha do cargo.',
      itens: ROWS.filter(r => r.origem !== 'trilha')
        .filter(r => {
          const fe = $('fEmpresa').value, fc = $('fCargo').value, fb = $('fBusca').value.trim().toLowerCase();
          if (fe && r.company !== fe) return false;
          if (fc && r.cargo !== fc) return false;
          if (fb && !r.empName.toLowerCase().includes(fb)) return false;
          return true;
        })
        .map(r => ({ titulo: r.empName,
                     sub: r.trName + ' · ' + r.cargo + ' · ' + (r.origem === 'individual' ? 'exigência individual' : 'lançamento avulso') + ' · ' + r.status,
                     acao: () => irParaAdmin('cargostrilhas', r.cargo) })) },

    { id: 'semAdmissao', nome: 'Colaboradores sem data de admissão', grave: false,
      porque: 'A admissão ajuda a justificar prazos de treinamento admissional.',
      ok: 'Todas as admissões preenchidas.',
      itens: ativos.filter(e => !e.admissao).map(pessoa) },

    { id: 'semMatriz', nome: 'Treinamentos sem carga horária ou validade', grave: true,
      porque: 'Sem validade o vencimento não é calculado; sem carga horária as horas não somam.',
      ok: 'Matriz completa para todos os treinamentos.',
      itens: DS.trainings.filter(t => t.ch_formacao == null || t.validade_meses == null)
        .map(t => ({ titulo: t.name,
                     sub: (t.ch_formacao == null ? 'sem carga horária' : '') +
                          (t.ch_formacao == null && t.validade_meses == null ? ' · ' : '') +
                          (t.validade_meses == null ? 'sem validade' : ''),
                     acao: () => irParaAdmin('treinamentos', t.name) })) },

    { id: 'desligados', nome: 'Colaboradores desligados', grave: false, informativo: true,
      porque: 'Ficam fora dos indicadores, mas o histórico é preservado.',
      ok: 'Nenhum desligamento registrado.',
      itens: DS.employees.filter(e => e.demissao && e.demissao <= DS.today).filter(dentroDoFiltro)
        .map(e => ({ titulo: e.name, sub: 'desligado em ' + brDate(e.demissao),
                     acao: () => irParaAdmin('colaboradores', e.name) })) },
  ];
}

// Leva à seção de administração certa, já com a busca preenchida.
window.irParaAdmin = (secao, busca) => {
  if (!ADMIN_PERMS.some(pode)) return toast('Seu perfil não permite abrir os cadastros', true);
  currentTab = 'admin'; cadTab = secao;
  document.querySelectorAll('#mainTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'admin'));
  renderTab();
  setTimeout(() => {
    const campo = $('colabSearch') || $('lancSearch');
    if (campo && busca) { campo.value = busca; campo.dispatchEvent(new Event('input')); campo.focus(); }
  }, 120);
};

function renderQualidade() {
  const checks = verificacoesQualidade();
  const totalProblemas = checks.filter(c => !c.informativo).reduce((s, c) => s + c.itens.length, 0);
  const graves = checks.filter(c => c.grave).reduce((s, c) => s + c.itens.length, 0);
  const okCount = checks.filter(c => !c.informativo && c.itens.length === 0).length;
  const verificaveis = checks.filter(c => !c.informativo).length;

  if (!qualSelecionada || !checks.some(c => c.id === qualSelecionada)) {
    const primeiro = checks.find(c => c.itens.length > 0);
    qualSelecionada = primeiro ? primeiro.id : checks[0].id;
  }
  const sel = checks.find(c => c.id === qualSelecionada);

  $('tab-qualidade').innerHTML = `
    <div class="kpis">
      ${kpi('Pontos de atenção', fmtN(totalProblemas), 'itens a revisar no cadastro',
            totalProblemas === 0 ? 'green' : graves > 0 ? 'red' : 'amber')}
      ${kpi('Críticos', fmtN(graves), 'afetam o cálculo dos indicadores', graves ? 'red' : 'green')}
      ${kpi('Verificações em ordem', okCount + ' de ' + verificaveis, 'sem nenhuma ocorrência', 'green')}
      ${kpi('Colaboradores ativos', fmtN(DS.employees.filter(e => !(e.demissao && e.demissao <= DS.today)).length), 'na base do sistema')}
    </div>
    <div class="grid split-13">
      <div class="card">
        <h3>Verificações <small>clique para ver os itens</small></h3>
        <div class="qual-lista">
          ${checks.map(c => `
            <button class="qual-item ${c.id === qualSelecionada ? 'sel' : ''} ${c.itens.length === 0 ? 'zerado' : (c.grave ? 'grave' : 'aviso')}"
                    onclick="selecionarQualidade('${c.id}')">
              <span class="qual-nome">${esc(c.nome)}</span>
              <span class="qual-num">${c.itens.length === 0 ? '✔' : fmtN(c.itens.length)}</span>
            </button>`).join('')}
        </div>
      </div>
      <div class="card">
        <h3>${esc(sel.nome)}
          <small>${sel.itens.length ? fmtN(sel.itens.length) + ' item(ns)' : 'nada a corrigir'}</small></h3>
        <p class="hint" style="margin:-6px 0 12px">${esc(sel.porque)}</p>
        ${sel.itens.length ? `
          <input type="search" id="qualBusca" placeholder="filtrar nesta lista…"
                 style="width:100%;padding:8px 11px;border:1.5px solid var(--line);border-radius:9px;margin-bottom:10px">
          <div class="tbl-wrap" style="max-height:420px"><table class="tbl"><tbody id="qualBody"></tbody></table></div>`
        : `<div class="empty" style="color:var(--green);font-weight:600">✔ ${esc(sel.ok)}</div>`}
      </div>
    </div>`;

  if (sel.itens.length) {
    const pintar = () => {
      const q = $('qualBusca').value.trim().toLowerCase();
      const lista = sel.itens.filter(i => !q || (i.titulo + ' ' + i.sub).toLowerCase().includes(q));
      $('qualBody').innerHTML = lista.slice(0, 300).map((i, idx) => `<tr>
        <td><b>${esc(i.titulo)}</b><div class="hint">${esc(i.sub)}</div></td>
        <td style="width:110px;text-align:right">
          <button class="btn-mini" onclick="corrigirQualidade('${sel.id}',${sel.itens.indexOf(i)})">Corrigir</button>
        </td></tr>`).join('') || '<tr><td class="empty">Nada encontrado</td></tr>';
    };
    $('qualBusca').addEventListener('input', pintar);
    pintar();
  }
}

window.selecionarQualidade = (id) => { qualSelecionada = id; renderQualidade(); };
window.corrigirQualidade = (checkId, idx) => {
  const c = verificacoesQualidade().find(x => x.id === checkId);
  if (c && c.itens[idx]) c.itens[idx].acao();
};

// ===== Cadastros =====
// Painel de administração: reúne num só lugar tudo que configura o sistema.
// Cada seção só aparece se o perfil do usuário permitir.
let cadTab = null;
const SECOES_ADMIN = [
  { id: 'resumo',        nome: 'Resumo',              perm: null,            render: () => renderAdminResumo() },
  { id: 'colaboradores', nome: 'Colaboradores',       perm: 'colaboradores', render: () => renderCadColab() },
  { id: 'lancamentos',   nome: 'Lançamentos',         perm: 'lancamentos',   render: () => renderCadLancamentos() },
  { id: 'empresas',      nome: 'Empresas',            perm: 'config',        render: () => renderCadEmpresas() },
  { id: 'cargostrilhas', nome: 'Cargos e Trilhas',    perm: 'config',        render: () => renderCadCargos() },
  { id: 'treinamentos',  nome: 'Treinamentos',        perm: 'config',        render: () => renderCadTreinamentos() },
  { id: 'perfis',        nome: 'Perfis de Acesso',    perm: 'perfis',        render: () => renderPerfis() },
  { id: 'usuarios',      nome: 'Usuários',            perm: 'usuarios',      render: () => renderUsuarios() },
  { id: 'dados',         nome: 'Importar / Exportar', perm: 'importar',      render: () => renderImportar() },
  { id: 'acesso',        nome: 'Acesso dos Gestores', perm: 'config',        render: () => renderConfigAcesso() },
];

// Liga ou desliga a entrada sem login, define o que o gestor pode fazer e
// mostra o endereço a divulgar.
async function renderConfigAcesso() {
  const cfg = await api('/api/config');
  const endereco = location.origin;
  const bloqueada = (k) => cfg.bloqueadas.includes(k);

  const item = (i) => `
    <label class="perm-item ${bloqueada(i.chave) ? 'travada' : ''}" title="${esc(i.desc)}">
      <input type="checkbox" class="cfgPerm" value="${i.chave}"
        ${cfg.permsGestor[i.chave] ? 'checked' : ''} ${bloqueada(i.chave) ? 'disabled' : ''}>
      <span><b>${esc(i.nome)}</b><br><span class="hint">${esc(i.desc)}</span></span>
      ${bloqueada(i.chave) ? '<span class="badge role">indisponível sem login</span>' : ''}
    </label>`;

  $('cadContent').innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h3>Entrada sem login</h3>
        <p class="hint">Ligado, a tela de entrada mostra o botão <b>Acesso do Gestor</b> e quem clicar
        entra direto, sem digitar senha.</p>
        <label style="display:flex;align-items:center;gap:10px;margin:16px 0;font-size:14px">
          <input type="checkbox" id="cfgAcesso" ${cfg.acessoGestor ? 'checked' : ''}
                 style="width:auto;accent-color:var(--orange);transform:scale(1.3)">
          <b>${cfg.acessoGestor ? 'Liberado' : 'Desativado'}</b>
        </label>
        <h3 style="margin-top:22px">Endereço para divulgar</h3>
        <div style="display:flex;gap:8px;margin:10px 0">
          <input id="cfgUrl" readonly value="${esc(endereco)}"
                 style="flex:1;padding:10px 12px;border:1.5px solid var(--line);border-radius:9px;font-size:14px">
          <button class="btn-navy" id="btnCopiar">Copiar</button>
        </div>
        <p class="hint" style="color:var(--amber)"><b>Atenção:</b> com o acesso liberado, qualquer pessoa
        que tenha o endereço vê nomes, cargos e situação de treinamento dos colaboradores, sem senha.
        Divulgue apenas internamente e desative aqui se precisar fechar.</p>
      </div>

      <div class="card">
        <h3>O que o gestor pode <small>vale para todos que entram sem login</small></h3>
        <p class="hint" style="margin-bottom:12px">Marque os painéis que ele enxerga e as ações que pode
        executar. Vale imediatamente, inclusive para quem já estiver com a tela aberta.</p>

        <label style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">Painéis</label>
        <div class="checklist" style="margin:6px 0 16px">${cfg.catalogo.paineis.map(item).join('')}</div>

        <label style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">Ações</label>
        <div class="checklist" style="margin-top:6px">${cfg.catalogo.acoes.map(item).join('')}</div>

        <p class="hint" style="margin-top:12px">As ações marcadas como <b>indisponíveis sem login</b> alteram
        dados ou contas — o servidor as recusa para quem não se identifica, mesmo que fossem marcadas aqui.</p>
        <div class="toolbar" style="margin:14px 0 0">
          <div style="flex:1"></div>
          <button class="btn-primary" id="btnSalvarPerms">Salvar permissões</button>
        </div>
      </div>
    </div>`;

  $('cfgAcesso').addEventListener('change', async (e) => {
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify({ acessoGestor: e.target.checked }) });
    toast(r.acessoGestor ? 'Acesso do gestor liberado' : 'Acesso do gestor desativado');
    renderConfigAcesso();
  });
  $('btnCopiar').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(endereco); toast('Endereço copiado'); }
    catch { $('cfgUrl').select(); toast('Selecione e copie com Ctrl+C', true); }
  });
  $('btnSalvarPerms').addEventListener('click', async () => {
    const permsGestor = {};
    document.querySelectorAll('.cfgPerm').forEach(c => { permsGestor[c.value] = c.checked; });
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ permsGestor }) });
    toast('Permissões do gestor atualizadas');
    renderConfigAcesso();
  });
}

function renderAdmin() {
  const disponiveis = SECOES_ADMIN.filter(s => !s.perm || pode(s.perm));
  if (!disponiveis.some(s => s.id === cadTab)) cadTab = disponiveis.length ? disponiveis[0].id : null;
  $('tab-admin').innerHTML = `
    <div class="admin-head">
      <h2>⚙ Administração</h2>
      <span class="hint">Tudo que configura o sistema em um só lugar.</span>
    </div>
    <div class="subtabs" id="cadSubtabs">
      ${disponiveis.map(s => `<button data-s="${s.id}">${esc(s.nome)}</button>`).join('')}
    </div>
    <div id="cadContent"></div>`;
  document.querySelectorAll('#cadSubtabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.s === cadTab);
    b.addEventListener('click', () => { cadTab = b.dataset.s; renderAdmin(); });
  });
  const secao = disponiveis.find(s => s.id === cadTab);
  if (secao) secao.render();
}

// Visão de abertura do painel: o estado do sistema em números.
function renderAdminResumo() {
  const emps = DS.employees.filter(e => !(e.demissao && e.demissao <= DS.today));
  const trailCargos = new Set(DS.cargosWithTrail);
  const semTrilha = emps.filter(e => !e.cargo_id || !trailCargos.has(e.cargo_id)).length;
  const base = rowsEscopo();
  const validos = base.filter(r => r.status === 'VÁLIDO').length;
  const atalho = (id, texto) => `<button class="btn-mini" onclick="irParaSecao('${id}')">${texto}</button>`;

  $('cadContent').innerHTML = `
    <div class="kpis">
      ${kpi('Colaboradores ativos', fmtN(emps.length), 'na base do sistema')}
      ${kpi('Empresas', fmtN(DS.companies.length), 'cadastradas')}
      ${kpi('Cargos', fmtN(DS.cargos.length), fmtN(trailCargos.size) + ' com trilha definida')}
      ${kpi('Treinamentos', fmtN(DS.trainings.length), 'na matriz')}
      ${kpi('Aderência geral', fmtPct(pct(validos, base.length)), fmtN(validos) + ' de ' + fmtN(base.length),
            pct(validos, base.length) >= 95 ? 'green' : pct(validos, base.length) >= 75 ? 'amber' : 'red')}
      ${kpi('Sem trilha', fmtN(semTrilha), 'colaboradores a revisar', semTrilha ? 'amber' : 'green')}
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h3>Por onde começar</h3>
        <p class="hint" style="margin-bottom:12px">As tarefas mais comuns do dia a dia.</p>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${pode('lancamentos') ? `<div><b>Registrar um treinamento realizado</b><div class="hint">Busque a pessoa e lance a data. O vencimento é calculado sozinho.</div>${atalho('lancamentos', 'Ir para Lançamentos')}</div>` : ''}
          ${pode('importar') ? `<div><b>Atualizar tudo de uma vez</b><div class="hint">Envie a planilha e o sistema atualiza os registros existentes.</div>${atalho('dados', 'Ir para Importar / Exportar')}</div>` : ''}
          ${pode('usuarios') ? `<div><b>Liberar acesso a um gestor</b><div class="hint">Crie um login e escolha o perfil que define o que ele enxerga.</div>${atalho('usuarios', 'Ir para Usuários')}</div>` : ''}
          ${pode('perfis') ? `<div><b>Criar um perfil de acesso</b><div class="hint">Defina quais painéis e ações cada tipo de usuário terá.</div>${atalho('perfis', 'Ir para Perfis de Acesso')}</div>` : ''}
        </div>
      </div>
      <div class="card">
        <h3>Situação do cadastro</h3>
        ${semTrilha ? `<p class="hint" style="color:var(--red)"><b>${fmtN(semTrilha)} colaborador(es)</b> sem trilha de treinamentos definida — os pendentes deles podem estar subcontados. Veja a aba <b>Qualidade dos Dados</b>.</p>` :
          '<p class="hint">Todos os colaboradores têm trilha definida. ✔</p>'}
        <div style="margin-top:14px">
          ${hbars(DS.companies.map(c => {
            const n = emps.filter(e => e.company_id === c.id).length;
            return { label: c.short_name || c.name, value: n };
          }).sort((a, b) => b.value - a.value), () => 'var(--navy)')}
        </div>
      </div>
    </div>`;
}

window.irParaSecao = (id) => { cadTab = id; renderAdmin(); };

// ---- Perfis de acesso ----
let CATALOGO = null;   // painéis e ações disponíveis, vindos do servidor
let PERFIS = [];

async function renderPerfis() {
  const dados = await api('/api/profiles');
  PERFIS = dados.profiles;
  CATALOGO = dados.catalogo;

  const marca = (ok) => ok ? '<span style="color:var(--green);font-weight:700">✔</span>'
                           : '<span style="color:var(--line)">—</span>';
  $('cadContent').innerHTML = `
    <div class="toolbar">
      <button class="btn-primary" onclick="editarPerfil(null)">+ Novo perfil</button>
      <span class="hint">O perfil define quais painéis de indicadores e quais ações cada usuário tem.
      Os quatro perfis do sistema podem ser ajustados, mas não excluídos.</span>
    </div>
    <div class="card">
      <div class="tbl-wrap" style="max-height:560px"><table class="tbl"><thead><tr>
        <th>Perfil</th><th>Alcance</th>
        ${CATALOGO.paineis.map(p => `<th style="text-align:center" title="${esc(p.desc)}">${esc(p.nome.split(' ')[0])}</th>`).join('')}
        <th style="text-align:center">Ações</th><th style="text-align:center">Usuários</th><th></th>
      </tr></thead><tbody>
        ${PERFIS.map(p => {
          const nAcoes = CATALOGO.acoes.filter(a => p.permissions[a.chave]).length;
          return `<tr>
            <td><b>${esc(p.name)}</b>${p.is_system ? ' <span class="badge role">padrão</span>' : ''}
                <div class="hint">${esc(p.description || '')}</div></td>
            <td>${p.scope === 'team' ? '<span class="badge pendente">só a equipe</span>' : '<span class="badge valido">todos</span>'}</td>
            ${CATALOGO.paineis.map(pa => `<td style="text-align:center">${marca(p.permissions[pa.chave])}</td>`).join('')}
            <td style="text-align:center">${nAcoes} de ${CATALOGO.acoes.length}</td>
            <td style="text-align:center">${p.usuarios}</td>
            <td style="white-space:nowrap">
              <button class="btn-mini" onclick="editarPerfil(${p.id})">Editar</button>
              ${p.is_system ? '' : `<button class="btn-mini danger" onclick="excluirPerfil(${p.id})">Excluir</button>`}
            </td></tr>`;
        }).join('')}
      </tbody></table></div>
      <p class="hint" style="margin-top:12px">
        <b>Alcance</b> define de quem o usuário vê os dados: <i>todos</i> os colaboradores ou
        <i>só a equipe</i> que você atribuir a ele na tela de Usuários.
      </p>
    </div>`;
}

window.editarPerfil = (id) => {
  const p = id ? PERFIS.find(x => x.id === id) : null;
  const sistema = p && p.is_system;
  const admin = p && p.name === 'Administradora';
  const grupo = (titulo, itens, ajuda) => `
    <label>${titulo}</label>
    <p class="hint" style="margin:-2px 0 6px">${ajuda}</p>
    <div class="checklist">
      ${itens.map(i => `<label title="${esc(i.desc)}">
        <input type="checkbox" class="permChk" value="${i.chave}"
          ${p && p.permissions[i.chave] ? 'checked' : ''} ${admin ? 'disabled' : ''}>
        <span><b>${esc(i.nome)}</b><br><span class="hint">${esc(i.desc)}</span></span>
      </label>`).join('')}
    </div>`;

  openModal(p ? 'Perfil — ' + p.name : 'Novo perfil de acesso', `
    <label>Nome do perfil</label>
    <input id="mNome" value="${esc(p?.name || '')}" ${sistema ? 'disabled' : ''}
      placeholder="ex.: Gestor de Produção">
    ${sistema ? '<p class="hint">Este é um perfil padrão: o nome não muda, mas as permissões sim.</p>' : ''}
    <label>Descrição</label>
    <input id="mDesc" value="${esc(p?.description || '')}" placeholder="para que serve este perfil">
    <label>Alcance dos dados</label>
    <select id="mScope" ${admin ? 'disabled' : ''}>
      <option value="all" ${p && p.scope === 'all' ? 'selected' : ''}>Todos os colaboradores</option>
      <option value="team" ${p && p.scope === 'team' ? 'selected' : ''}>Somente a equipe atribuída ao usuário</option>
    </select>
    ${admin ? '<p class="hint" style="color:var(--amber)">O perfil da administradora sempre mantém acesso total — é o que garante que o sistema nunca fique sem quem o administre.</p>' : ''}
    ${grupo('Painéis de indicadores que este perfil enxerga', CATALOGO.paineis,
            'Marque quais abas de dashboard ficam visíveis.')}
    ${grupo('Ações que este perfil pode executar', CATALOGO.acoes,
            'Sem nenhuma ação marcada, o usuário apenas visualiza os painéis.')}`,
    [{ label: 'Salvar', cls: 'btn-primary', onClick: async () => {
      const permissions = {};
      document.querySelectorAll('.permChk').forEach(c => { permissions[c.value] = c.checked; });
      const body = { name: $('mNome').value, description: $('mDesc').value,
                     scope: $('mScope').value, permissions };
      if (p) await api('/api/profiles/' + p.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/profiles', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Perfil salvo');
      await loadAll();
      cadTab = 'perfis'; renderAdmin();
    } }], 'media');
};

window.excluirPerfil = async (id) => {
  const p = PERFIS.find(x => x.id === id);
  if (!await confirmar('Excluir o perfil "' + p.name + '"?')) return;
  await api('/api/profiles/' + id, { method: 'DELETE' });
  toast('Perfil excluído'); renderPerfis();
};

function empPendCounts() {
  const m = {};
  for (const r of rowsEscopo()) {
    m[r.employee_id] = m[r.employee_id] || { p: 0, v: 0 };
    if (r.status === 'PENDENTE') m[r.employee_id].p++;
    if (r.status === 'VENCIDO') m[r.employee_id].v++;
  }
  return m;
}

function renderCadColab() {
  const counts = empPendCounts();
  const cargos = [...new Set(DS.employees.map(e => e.cargo_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

  const render = () => {
    const busca = $('colabSearch').value.trim().toLowerCase();
    const emp = $('colabEmpresa').value;
    const cargo = $('colabCargo').value;
    const situacao = $('colabSituacao').value;
    const pendencia = $('colabPendencia').value;

    const list = DS.employees.filter(e => {
      if (busca && !e.name.toLowerCase().includes(busca)) return false;
      if (emp && String(e.company_id) !== emp) return false;
      if (cargo && (e.cargo_name || '') !== cargo) return false;
      const desligado = !!(e.demissao && e.demissao <= DS.today);
      if (situacao === 'ativos' && desligado) return false;
      if (situacao === 'desligados' && !desligado) return false;
      const c = counts[e.id] || { p: 0, v: 0 };
      if (pendencia === 'com' && c.p + c.v === 0) return false;
      if (pendencia === 'sem' && c.p + c.v > 0) return false;
      if (pendencia === 'vencidos' && c.v === 0) return false;
      return true;
    });

    $('colabResumo').innerHTML = '<b>' + fmtN(list.length) + '</b> de ' + fmtN(DS.employees.length) + ' colaboradores';
    $('colabBody').innerHTML = list.map(e => {
      const c = counts[e.id] || { p: 0, v: 0 };
      const desligado = e.demissao && e.demissao <= DS.today;
      return `<tr style="${desligado ? 'opacity:.55' : ''}">
        <td>${esc(e.name)}</td><td>${esc(e.company_short || e.company_name)}</td><td>${esc(e.cargo_name || '—')}</td>
        <td>${brDate(e.admissao)}</td><td>${e.demissao ? brDate(e.demissao) : '—'}</td>
        <td>${desligado ? '<span class="badge vencido">DESLIGADO</span>' : '<span class="badge valido">ATIVO</span>'}</td>
        <td style="text-align:center;${c.p ? 'color:var(--amber);font-weight:700' : ''}">${c.p}</td>
        <td style="text-align:center;${c.v ? 'color:var(--red);font-weight:700' : ''}">${c.v}</td>
        <td style="white-space:nowrap">
          <button class="btn-mini" onclick="editEmployee(${e.id})">Editar</button>
          <button class="btn-mini" onclick="openLancamentos(${e.id})">Lançamentos</button>
          ${pode('excluir') ? `<button class="btn-mini danger" onclick="delEmployee(${e.id})">Excluir</button>` : ''}
        </td></tr>`;
    }).join('') || '<tr><td colspan="9" class="empty">Nenhum colaborador com esses filtros</td></tr>';
  };

  $('cadContent').innerHTML = `
    <div class="filtros-secao">
      <div class="f"><label>Buscar por nome</label><input type="search" id="colabSearch" placeholder="digite parte do nome"></div>
      <div class="f"><label>Empresa</label><select id="colabEmpresa"><option value="">Todas</option>
        ${DS.companies.map(c => `<option value="${c.id}">${esc(c.short_name || c.name)}</option>`).join('')}</select></div>
      <div class="f"><label>Cargo</label><select id="colabCargo"><option value="">Todos</option>
        ${cargos.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
      <div class="f"><label>Situação</label><select id="colabSituacao">
        <option value="ativos">Somente ativos</option>
        <option value="">Todos</option>
        <option value="desligados">Somente desligados</option></select></div>
      <div class="f"><label>Pendências</label><select id="colabPendencia">
        <option value="">Todos</option>
        <option value="com">Com pendência</option>
        <option value="vencidos">Com vencidos</option>
        <option value="sem">Totalmente em dia</option></select></div>
      <button class="btn-ghost" id="colabLimpar">Limpar</button>
    </div>
    <div class="toolbar">
      <span class="hint" id="colabResumo"></span>
      <div style="flex:1"></div>
      <button class="btn-primary" onclick="editEmployee(null)">+ Novo colaborador</button>
    </div>
    <div class="card"><div class="tbl-wrap" style="max-height:600px"><table class="tbl"><thead><tr>
      <th>Nome</th><th>Empresa</th><th>Cargo</th><th>Admissão</th><th>Demissão</th><th>Status</th>
      <th style="text-align:center">Pend.</th><th style="text-align:center">Venc.</th><th>Ações</th>
    </tr></thead><tbody id="colabBody"></tbody></table></div></div>`;

  ['colabSearch', 'colabEmpresa', 'colabCargo', 'colabSituacao', 'colabPendencia']
    .forEach(id => $(id).addEventListener('input', render));
  $('colabLimpar').addEventListener('click', () => {
    $('colabSearch').value = ''; $('colabEmpresa').value = ''; $('colabCargo').value = '';
    $('colabSituacao').value = 'ativos'; $('colabPendencia').value = '';
    render();
  });
  render();
}

window.editEmployee = (id) => {
  const e = id ? DS.employees.find(x => x.id === id) : null;
  const compOpts = DS.companies.map(c => `<option value="${c.id}" ${e && e.company_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  openModal(e ? 'Editar colaborador' : 'Novo colaborador', `
    <label>Nome completo</label><input id="mNome" value="${esc(e?.name || '')}">
    <div class="row2">
      <div><label>Empresa</label><select id="mEmpresa">${compOpts}</select></div>
      <div><label>Cargo</label><select id="mCargo"></select></div>
    </div>
    <div class="row2">
      <div><label>Admissão</label><input type="date" id="mAdmissao" value="${e?.admissao || ''}"></div>
      <div><label>Demissão (deixe vazio se ativo)</label><input type="date" id="mDemissao" value="${e?.demissao || ''}"></div>
    </div>`,
    [{ label: 'Salvar', cls: 'btn-primary', onClick: async () => {
      const body = {
        name: $('mNome').value, company_id: Number($('mEmpresa').value),
        cargo_id: $('mCargo').value ? Number($('mCargo').value) : null,
        admissao: $('mAdmissao').value || null, demissao: $('mDemissao').value || null,
      };
      if (e) await api('/api/employees/' + e.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/employees', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Colaborador salvo'); await loadAll();
    } }]);
  const fillCargos = () => {
    const cid = Number($('mEmpresa').value);
    $('mCargo').innerHTML = '<option value="">— sem cargo —</option>' + DS.cargos.filter(c => c.company_id === cid)
      .map(c => `<option value="${c.id}" ${e && e.cargo_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  };
  fillCargos();
  $('mEmpresa').addEventListener('change', fillCargos);
};

window.delEmployee = async (id) => {
  const e = DS.employees.find(x => x.id === id);
  if (!await confirmar('Excluir DEFINITIVAMENTE ' + e.name + ' e todos os seus lançamentos?\n\nSe o colaborador foi desligado, prefira registrar a data de demissão em Editar.')) return;
  await api('/api/employees/' + id, { method: 'DELETE' });
  toast('Colaborador excluído'); await loadAll();
};

function renderCadEmpresas() {
  $('cadContent').innerHTML = `
    <div class="toolbar"><button class="btn-primary" onclick="editCompany(null)">+ Nova empresa</button>
      <span class="hint">O nome curto é o que aparece nos painéis e relatórios; a ordem define a sequência de exibição.</span></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th>Razão social</th><th>Nome curto</th><th style="text-align:center">Ordem</th>
      <th style="text-align:center">Colab.</th><th style="text-align:center">Cargos</th><th>Ações</th></tr></thead><tbody>
      ${DS.companies.map(c => {
        const nE = DS.employees.filter(e => e.company_id === c.id).length;
        const nC = DS.cargos.filter(g => g.company_id === c.id).length;
        return `<tr><td>${esc(c.name)}</td><td><b>${esc(c.short_name || '—')}</b></td>
          <td style="text-align:center">${c.sort_order}</td>
          <td style="text-align:center">${nE}</td><td style="text-align:center">${nC}</td>
          <td style="white-space:nowrap"><button class="btn-mini" onclick="editCompany(${c.id})">Editar</button>
          ${pode('excluir') ? `<button class="btn-mini danger" onclick="delCompany(${c.id})">Excluir</button>` : ''}</td></tr>`;
      }).join('')}
    </tbody></table></div></div>`;
}
window.editCompany = (id) => {
  const c = id ? DS.companies.find(x => x.id === id) : null;
  openModal(c ? 'Editar empresa' : 'Nova empresa', `
    <label>Razão social</label><input id="mNome" value="${esc(c?.name || '')}">
    <div class="row2">
      <div><label>Nome curto (exibido nos painéis)</label><input id="mCurto" value="${esc(c?.short_name || '')}" placeholder="ex.: Riva Stones"></div>
      <div><label>Ordem de exibição</label><input type="number" id="mOrdem" value="${c?.sort_order ?? 100}"></div>
    </div>`,
    [{ label: 'Salvar', cls: 'btn-primary', onClick: async () => {
      const body = { name: $('mNome').value, short_name: $('mCurto').value || null, sort_order: Number($('mOrdem').value) || 100 };
      if (c) await api('/api/companies/' + c.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/companies', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Empresa salva'); await loadAll();
    } }]);
};
window.delCompany = async (id) => {
  if (!await confirmar('Excluir esta empresa? Só é possível se não houver colaboradores vinculados.')) return;
  await api('/api/companies/' + id, { method: 'DELETE' });
  toast('Empresa excluída'); await loadAll();
};

function renderCadCargos() {
  const trailsByCargo = {};
  for (const t of DS.trails) (trailsByCargo[t.cargo_id] = trailsByCargo[t.cargo_id] || []).push(t.training_id);
  const cargoById = new Map(DS.cargos.map(c => [c.id, c]));
  const render = (filter) => {
    const list = DS.cargos.filter(c => !filter || c.name.toLowerCase().includes(filter));
    $('cargoBody').innerHTML = list.map(c => {
      const comp = DS.companies.find(x => x.id === c.company_id);
      const own = (trailsByCargo[c.id] || []).length;
      const src = c.trail_source_id ? cargoById.get(c.trail_source_id) : null;
      const inherited = !own && src ? (trailsByCargo[src.id] || []).length : 0;
      const nE = DS.employees.filter(e => e.cargo_id === c.id).length;
      let trailCell;
      if (own) trailCell = `<b>${own}</b> treinamentos <span class="hint">(própria)</span>`;
      else if (inherited) trailCell = `<b>${inherited}</b> treinamentos <span class="hint">(herda de ${esc(src.name)})</span>`;
      else trailCell = '<span class="badge vencido">SEM TRILHA</span>';
      return `<tr><td>${esc(c.name)}</td><td>${esc(comp?.name || '')}</td><td>${trailCell}</td><td style="text-align:center">${nE}</td>
        <td style="white-space:nowrap"><button class="btn-mini" onclick="editCargo(${c.id})">Editar trilha</button>
        ${pode('excluir') ? `<button class="btn-mini danger" onclick="delCargo(${c.id})">Excluir</button>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">Nenhum cargo</td></tr>';
  };
  $('cadContent').innerHTML = `
    <div class="toolbar">
      <input type="search" id="cargoSearch" placeholder="Buscar cargo…">
      <button class="btn-primary" onclick="editCargo(null)">+ Novo cargo</button>
      <span class="hint">A trilha define quais treinamentos são obrigatórios para o cargo — é ela que gera os "pendentes".<br>
      Cargos com nível (FIOLISTA III) herdam automaticamente a trilha do cargo-base (FIOLISTA).</span></div>
    <div class="card"><div class="tbl-wrap" style="max-height:600px"><table class="tbl"><thead><tr>
      <th>Cargo</th><th>Empresa</th><th>Trilha</th><th>Colab.</th><th>Ações</th></tr></thead><tbody id="cargoBody"></tbody></table></div></div>`;
  render('');
  $('cargoSearch').addEventListener('input', (e) => render(e.target.value.trim().toLowerCase()));
}
window.editCargo = (id) => {
  const c = id ? DS.cargos.find(x => x.id === id) : null;
  const own = new Set(DS.trails.filter(t => t.cargo_id === id).map(t => t.training_id));
  const src = c && c.trail_source_id ? DS.cargos.find(x => x.id === c.trail_source_id) : null;
  const inherited = src ? new Set(DS.trails.filter(t => t.cargo_id === src.id).map(t => t.training_id)) : new Set();
  const shown = own.size ? own : inherited;
  const compOpts = DS.companies.map(x => `<option value="${x.id}" ${c && c.company_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const srcOpts = DS.cargos.filter(x => x.id !== id && DS.trails.some(t => t.cargo_id === x.id))
    .map(x => `<option value="${x.id}" ${src && src.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  openModal(c ? 'Editar cargo e trilha' : 'Novo cargo', `
    <label>Nome do cargo</label><input id="mNome" value="${esc(c?.name || '')}">
    <label>Empresa</label><select id="mEmpresa" ${c ? 'disabled' : ''}>${compOpts}</select>
    ${c ? `<label>Herdar trilha de outro cargo</label>
      <select id="mSrc"><option value="">— não herdar (usar trilha própria abaixo) —</option>${srcOpts}</select>
      ${!own.size && src ? `<p class="hint">Este cargo herda a trilha de <b>${esc(src.name)}</b>. Marcar/desmarcar treinamentos abaixo cria uma trilha própria e desfaz a herança.</p>` : ''}` : ''}
    <label>Trilha de treinamentos obrigatórios</label>
    <div class="checklist">${DS.trainings.map(t =>
      `<label><input type="checkbox" class="trailChk" value="${t.id}" ${shown.has(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div>`,
    [{ label: 'Salvar', cls: 'btn-primary', onClick: async () => {
      const srcVal = $('mSrc') ? $('mSrc').value : '';
      const body = { name: $('mNome').value };
      if (srcVal) {
        body.trail_source_id = Number(srcVal);
        body.trail_training_ids = [];   // herança manda: limpa a trilha própria
      } else {
        body.trail_source_id = null;
        body.trail_training_ids = [...document.querySelectorAll('.trailChk:checked')].map(x => Number(x.value));
      }
      if (c) {
        await api('/api/cargos/' + c.id, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        const r = await api('/api/cargos', { method: 'POST', body: JSON.stringify({ name: $('mNome').value, company_id: Number($('mEmpresa').value) }) });
        await api('/api/cargos/' + r.id, { method: 'PUT', body: JSON.stringify({ trail_training_ids: body.trail_training_ids }) });
      }
      closeModal(); toast('Cargo salvo'); await loadAll();
    } }], 'media');
};
window.delCargo = async (id) => {
  if (!await confirmar('Excluir este cargo? Só é possível se nenhum colaborador o utilizar.')) return;
  await api('/api/cargos/' + id, { method: 'DELETE' });
  toast('Cargo excluído'); await loadAll();
};

function renderCadTreinamentos() {
  $('cadContent').innerHTML = `
    <div class="toolbar"><button class="btn-primary" onclick="editTraining(null)">+ Novo treinamento</button></div>
    <div class="card"><div class="tbl-wrap" style="max-height:600px"><table class="tbl"><thead><tr>
      <th>Treinamento</th><th>CH formação</th><th>CH reciclagem</th><th>Validade (meses)</th>
      <th>Custo formação</th><th>Custo reciclagem</th><th>Ações</th></tr></thead><tbody>
      ${DS.trainings.map(t => `<tr>
        <td>${esc(t.name)}</td>
        <td style="text-align:center">${t.ch_formacao != null ? fmtH(t.ch_formacao) + ' h' : '—'}</td>
        <td style="text-align:center">${t.ch_reciclagem != null ? fmtH(t.ch_reciclagem) + ' h' : '—'}</td>
        <td style="text-align:center">${t.validade_meses ?? '—'}</td>
        <td style="text-align:center">${t.custo_formacao ? fmtMoney(t.custo_formacao) : '—'}</td>
        <td style="text-align:center">${t.custo_reciclagem ? fmtMoney(t.custo_reciclagem) : '—'}</td>
        <td style="white-space:nowrap"><button class="btn-mini" onclick="editTraining(${t.id})">Editar</button>
        ${pode('excluir') ? `<button class="btn-mini danger" onclick="delTraining(${t.id})">Excluir</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
window.editTraining = (id) => {
  const t = id ? DS.trainings.find(x => x.id === id) : null;
  openModal(t ? 'Editar treinamento' : 'Novo treinamento', `
    <label>Nome (ex.: NR-35 TRABALHO EM ALTURA)</label><input id="mNome" value="${esc(t?.name || '')}">
    <div class="row2">
      <div><label>CH formação (horas)</label><input type="number" step="0.5" id="mChF" value="${t?.ch_formacao ?? ''}"></div>
      <div><label>CH reciclagem (horas)</label><input type="number" step="0.5" id="mChR" value="${t?.ch_reciclagem ?? ''}"></div>
    </div>
    <div class="row2">
      <div><label>Validade (meses)</label><input type="number" id="mVal" value="${t?.validade_meses ?? ''}"></div>
      <div><label>&nbsp;</label><span class="hint">A validade preenche o vencimento automaticamente ao lançar.</span></div>
    </div>
    <div class="row2">
      <div><label>Custo formação por pessoa (R$)</label><input type="number" step="0.01" id="mCF" value="${t?.custo_formacao || ''}"></div>
      <div><label>Custo reciclagem por pessoa (R$)</label><input type="number" step="0.01" id="mCR" value="${t?.custo_reciclagem || ''}"></div>
    </div>
    <label>Critério / observação</label><textarea id="mCrit" rows="3">${esc(t?.criterio || '')}</textarea>
    <label>Base / fonte</label><input id="mFonte" value="${esc(t?.fonte || '')}">`,
    [{ label: 'Salvar', cls: 'btn-primary', onClick: async () => {
      const num = (v) => v === '' ? null : Number(v);
      const body = {
        name: $('mNome').value, ch_formacao: num($('mChF').value), ch_reciclagem: num($('mChR').value),
        validade_meses: num($('mVal').value), custo_formacao: num($('mCF').value) ?? 0,
        custo_reciclagem: num($('mCR').value) ?? 0, criterio: $('mCrit').value || null, fonte: $('mFonte').value || null,
      };
      if (t) await api('/api/trainings/' + t.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/trainings', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); toast('Treinamento salvo'); await loadAll();
    } }], 'media');
};
window.delTraining = async (id) => {
  if (!await confirmar('Excluir este treinamento? Só é possível se não houver lançamentos.')) return;
  await api('/api/trainings/' + id, { method: 'DELETE' });
  toast('Treinamento excluído'); await loadAll();
};

// --- Lançamentos ---
let lancAba = 'registrar';
function renderCadLancamentos() {
  $('cadContent').innerHTML = `
    <div class="subtabs" style="margin-bottom:14px">
      <button id="abaRegistrar" class="${lancAba === 'registrar' ? 'active' : ''}">Registrar</button>
      <button id="abaHistorico" class="${lancAba === 'historico' ? 'active' : ''}">Histórico de alterações</button>
    </div>
    <div id="lancConteudo"></div>`;
  $('abaRegistrar').addEventListener('click', () => { lancAba = 'registrar'; renderCadLancamentos(); });
  $('abaHistorico').addEventListener('click', () => { lancAba = 'historico'; renderCadLancamentos(); });
  if (lancAba === 'historico') renderHistorico(); else renderRegistrar();
}

function renderRegistrar() {
  $('lancConteudo').innerHTML = `
    <div class="toolbar">
      <input type="search" id="lancSearch" placeholder="Digite o nome do colaborador…" style="min-width:300px">
      <button class="btn-primary" onclick="newRecordQuick()">+ Novo lançamento</button>
      <span class="hint">O lançamento registra a realização de um treinamento; o vencimento é calculado pela validade da matriz.</span>
    </div>
    <div id="lancResults"></div>`;
  $('lancSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (q.length < 2) { $('lancResults').innerHTML = '<div class="empty">Digite ao menos 2 letras para buscar</div>'; return; }
    const list = DS.employees.filter(x => x.name.toLowerCase().includes(q)).slice(0, 12);
    $('lancResults').innerHTML = list.map(x =>
      `<div class="card" style="margin-bottom:10px;display:flex;align-items:center;gap:14px">
        <div style="flex:1"><b>${esc(x.name)}</b><div class="hint">${esc(x.cargo_name || '—')} · ${esc(x.company_short || x.company_name)}</div></div>
        <button class="btn-navy" onclick="openLancamentos(${x.id})">Ver lançamentos</button>
      </div>`).join('') || '<div class="empty">Nenhum colaborador encontrado</div>';
  });
  $('lancResults').innerHTML = '<div class="empty">Digite o nome de um colaborador para gerenciar os lançamentos dele</div>';
}

// Histórico de tudo que alterou os números: quem fez, quando e o quê.
let HISTORICO = [];
async function renderHistorico() {
  $('lancConteudo').innerHTML = '<div class="empty">Carregando histórico…</div>';
  const dados = await api('/api/historico?limite=2000');
  HISTORICO = dados.linhas;

  const acoes = [...new Set(HISTORICO.map(l => l.acao))].sort();
  const render = () => {
    const busca = $('hSearch').value.trim().toLowerCase();
    const acao = $('hAcao').value;
    const de = $('hDe').value, ate = $('hAte').value;
    const lista = HISTORICO.filter(l => {
      if (acao && l.acao !== acao) return false;
      const dia = (l.quando || '').slice(0, 10);
      if (de && dia < de) return false;
      if (ate && dia > ate) return false;
      if (busca) {
        const alvo = [l.colaborador, l.treinamento, l.empresa, l.usuario, l.detalhe].join(' ').toLowerCase();
        if (!alvo.includes(busca)) return false;
      }
      return true;
    });
    $('hResumo').innerHTML = '<b>' + fmtN(lista.length) + '</b> de ' + fmtN(dados.total) + ' registros';
    $('hBody').innerHTML = lista.slice(0, 800).map(l => `<tr>
      <td style="white-space:nowrap">${esc(dataHoraLocal(l.quando) || '')}</td>
      <td>${esc(l.acao)}</td>
      <td>${esc(l.colaborador || '—')}</td>
      <td>${esc(l.empresa || '—')}</td>
      <td>${esc(l.treinamento || '—')}</td>
      <td class="hint" style="font-size:12px">${esc(l.detalhe || '')}</td>
      <td>${esc(l.usuario || '—')}</td></tr>`).join('') ||
      '<tr><td colspan="7" class="empty">Nenhum registro com esses filtros</td></tr>';
  };

  $('lancConteudo').innerHTML = `
    <div class="filtros-secao">
      <div class="f"><label>Buscar</label><input type="search" id="hSearch" placeholder="colaborador, treinamento, usuário"></div>
      <div class="f"><label>Ação</label><select id="hAcao"><option value="">Todas</option>
        ${acoes.map(a => `<option>${esc(a)}</option>`).join('')}</select></div>
      <div class="f"><label>De</label><input type="date" id="hDe"></div>
      <div class="f"><label>Até</label><input type="date" id="hAte"></div>
      <button class="btn-ghost" id="hLimpar">Limpar</button>
    </div>
    <div class="toolbar">
      <span class="hint" id="hResumo"></span>
      <div style="flex:1"></div>
      <a class="btn-navy" style="text-decoration:none" href="/api/historico/pdf">⬇ Baixar PDF</a>
      ${pode('excluir') ? '<button class="btn-ghost" id="hLimparAntigos">Limpar anteriores a…</button>' +
                          '<button class="btn-ghost" id="hApagarTudo" style="color:var(--red);border-color:var(--red)">Apagar todo o histórico</button>' : ''}
    </div>
    <div class="card">
      <div class="tbl-wrap" style="max-height:520px"><table class="tbl"><thead><tr>
        <th>Data e hora</th><th>Ação</th><th>Colaborador</th><th>Empresa</th>
        <th>Treinamento</th><th>Detalhe</th><th>Usuário</th>
      </tr></thead><tbody id="hBody"></tbody></table></div>
      <p class="hint" style="margin-top:12px">
        O histórico guarda cada lançamento, alteração, exclusão e importação, com autor e horário.
        Ele cresce com o uso — baixe o PDF antes de limpar, se quiser manter o registro.
        A tela mostra até 800 linhas; o PDF sai completo.
      </p>
    </div>`;

  ['hSearch', 'hAcao', 'hDe', 'hAte'].forEach(id => $(id).addEventListener('input', render));
  $('hLimpar').addEventListener('click', () => {
    $('hSearch').value = ''; $('hAcao').value = ''; $('hDe').value = ''; $('hAte').value = '';
    render();
  });
  if ($('hApagarTudo')) {
    $('hApagarTudo').addEventListener('click', async () => {
      if (!await confirmar('Apagar TODO o histórico de alterações?\n\nOs lançamentos em si não são afetados — some apenas o registro de quem fez o quê. Baixe o PDF antes, se quiser guardar.', 'Apagar histórico')) return;
      const r = await api('/api/historico', { method: 'DELETE' });
      toast(fmtN(r.removidos) + ' registros apagados');
      renderHistorico();
    });
  }
  if ($('hLimparAntigos')) {
    $('hLimparAntigos').addEventListener('click', () => {
      const corte = new Date(); corte.setMonth(corte.getMonth() - 6);
      const iso = corte.toISOString().slice(0, 10);
      openModal('Limpar histórico antigo', `
        <p class="hint">Apaga os registros anteriores à data escolhida. Os lançamentos não são afetados.</p>
        <label>Apagar registros anteriores a</label>
        <input type="date" id="mCorte" value="${iso}">`,
        [{ label: 'Apagar', cls: 'btn-primary', onClick: async () => {
          const d = $('mCorte').value;
          if (!d) return toast('Escolha uma data', true);
          const r = await api('/api/historico?antes_de=' + d, { method: 'DELETE' });
          closeModal(); toast(fmtN(r.removidos) + ' registros apagados');
          renderHistorico();
        } }]);
    });
  }
  render();
}

window.newRecordQuick = () => openRecordModal(null, null);

window.openLancamentos = async (empId) => {
  const e = DS.employees.find(x => x.id === empId);
  const [recs, reqs] = await Promise.all([api('/api/records/' + empId), api('/api/requirements/' + empId)]);
  const reqSet = new Set(reqs.map(r => r.training_id));
  const mine = ROWS.filter(r => r.employee_id === empId)
    .sort((a, b) => a.trName.localeCompare(b.trName, 'pt-BR'));
  const recsByTraining = {};
  for (const r of recs) (recsByTraining[r.training_id] = recsByTraining[r.training_id] || []).push(r);

  const situacao = mine.map(g => {
    const hist = recsByTraining[g.training_id] || [];
    const rotulo = { trilha: 'trilha do cargo', individual: 'exigência individual', avulso: 'lançamento avulso' }[g.origem];
    const conta = noEscopo(g);
    return `<tr${conta ? '' : ' style="opacity:.62"'}>
      <td>${esc(g.trName)}<div class="hint">${rotulo}${conta ? '' : ' · <b>não entra nos indicadores</b>'}${hist.length > 1 ? ' · ' + hist.length + ' registros' : ''}</div></td>
      <td>${brDate(g.realizacao) || '—'}</td><td>${brDate(g.vencimento) || '—'}</td>
      <td><span class="badge ${STATUS_CLASS[g.status]}">${g.status}</span></td>
      <td style="white-space:nowrap">
        ${g.record_id ? `<button class="btn-mini" onclick="editRecord(${g.record_id}, ${empId})">Editar</button>
                         <button class="btn-mini danger" onclick="delRecord(${g.record_id}, ${empId})">Excluir</button>`
                      : `<button class="btn-mini" onclick="openRecordModal(${empId}, null, ${g.training_id})">Lançar</button>`}
        ${reqSet.has(g.training_id) ? `<button class="btn-mini danger" title="Remover a exigência individual deste treinamento" onclick="delRequirement(${empId}, ${g.training_id})">Não exigir</button>` : ''}
      </td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">Nenhum treinamento exigido nem lançado</td></tr>';

  const resumo = { 'VÁLIDO': 0, 'PENDENTE': 0, 'VENCIDO': 0 };
  for (const g of mine.filter(noEscopo)) resumo[g.status]++;
  const foraDaConta = mine.filter(g => !noEscopo(g)).length;

  openModal('Treinamentos — ' + e.name, `
    <div class="hint" style="margin-bottom:12px">
      ${esc(e.cargo_name || '—')} · ${esc(e.company_short || e.company_name)}${e.admissao ? ' · admitido em ' + brDate(e.admissao) : ''}
      &nbsp;|&nbsp; <span class="badge valido">${resumo['VÁLIDO']} válidos</span>
      <span class="badge pendente">${resumo['PENDENTE']} pendentes</span>
      <span class="badge vencido">${resumo['VENCIDO']} vencidos</span>
      ${foraDaConta ? `<span class="badge role">${foraDaConta} fora da conta</span>` : ''}
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <colgroup><col style="width:36%"><col style="width:13%"><col style="width:13%"><col style="width:12%"><col style="width:26%"></colgroup>
      <thead><tr>
        <th>Treinamento</th><th>Realização</th><th>Vencimento</th><th>Situação</th><th>Ações</th></tr></thead><tbody>
      ${situacao}</tbody></table></div>
    <p class="hint" style="margin-top:12px">A exigência vem da <b>trilha</b> do cargo ou é <b>individual</b> (cobrada só desta pessoa).
    "Não exigir" remove apenas a exigência individual; se o treinamento estiver na trilha do cargo, ele continua sendo cobrado.</p>`,
    [{ label: '+ Novo lançamento', cls: 'btn-primary', onClick: () => openRecordModal(empId, null) }],
    'larga');
};

window.delRequirement = async (empId, trainingId) => {
  if (!await confirmar('Remover a exigência individual deste treinamento para este colaborador?')) return;
  await api('/api/requirements/' + empId + '/' + trainingId, { method: 'DELETE' });
  toast('Exigência removida'); await loadAll(); openLancamentos(empId);
};

window.editRecord = async (recId, empId) => {
  const recs = await api('/api/records/' + empId);
  const rec = recs.find(r => r.id === recId);
  openRecordModal(empId, rec);
};
window.delRecord = async (recId, empId) => {
  if (!await confirmar('Excluir este lançamento?')) return;
  await api('/api/records/' + recId, { method: 'DELETE' });
  toast('Lançamento excluído'); await loadAll(); openLancamentos(empId);
};

window.openRecordModal = function openRecordModal(empId, rec, preTrainingId = null) {
  const empOpts = DS.employees.map(e =>
    `<option value="${e.id}" ${empId === e.id ? 'selected' : ''}>${esc(e.name)} — ${esc(e.company_short || e.company_name)}</option>`).join('');
  const selTr = rec ? rec.training_id : preTrainingId;
  const trOpts = DS.trainings.map(t =>
    `<option value="${t.id}" ${selTr === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  openModal(rec ? 'Editar lançamento' : 'Novo lançamento', `
    <label>Colaborador</label><select id="mEmp" ${rec ? 'disabled' : ''}><option value="">— selecione —</option>${empOpts}</select>
    <label>Treinamento</label><select id="mTr" ${rec ? 'disabled' : ''}>${trOpts}</select>
    <div class="row2">
      <div><label>Data de realização</label><input type="date" id="mReal" value="${rec?.realizacao || ''}"></div>
      <div><label>Vencimento (vazio = automático)</label><input type="date" id="mVenc" value="${rec?.vencimento || ''}"></div>
    </div>
    <label>Observação</label><input id="mObs" value="${esc(rec?.obs || '')}">`,
    [{ label: 'Salvar', cls: 'btn-primary', onClick: async () => {
      // Guarda de quem é o lançamento antes de salvar, para voltar à lista dele.
      let doColaborador = empId;
      if (rec) {
        await api('/api/records/' + rec.id, { method: 'PUT', body: JSON.stringify({
          realizacao: $('mReal').value || null, vencimento: $('mVenc').value || null, obs: $('mObs').value || null }) });
      } else {
        if (!$('mEmp').value) return toast('Selecione o colaborador', true);
        doColaborador = Number($('mEmp').value);
        await api('/api/records', { method: 'POST', body: JSON.stringify({
          employee_id: doColaborador, training_id: Number($('mTr').value),
          realizacao: $('mReal').value, vencimento: $('mVenc').value || null, obs: $('mObs').value || null }) });
      }
      toast('Lançamento salvo');
      await loadAll();
      // Volta para a lista do colaborador, já atualizada, em vez de fechar tudo
      // e obrigar a pesquisar a pessoa outra vez.
      if (doColaborador) await openLancamentos(doColaborador);
      else closeModal();
    } }]);
};

// ===== Importar / Exportar =====
function renderImportar() {
  $('cadContent').innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h3>Exportar planilha</h3>
        <p class="hint">Gera um arquivo Excel no mesmo formato da planilha atual, com as abas <b>Base de Dados</b> (incluindo linhas PENDENTE), <b>Matriz de C.H.</b> e <b>Trilha por Cargo</b>, refletindo a posição de hoje.</p>
        <br>${pode('exportar')
          ? '<a class="btn-primary" style="text-decoration:none;display:inline-block" href="/api/export">⬇ Baixar Balanço Normativos (.xlsx)</a>'
          : '<span class="hint">Seu perfil não permite exportar.</span>'}
      </div>
      <div class="card">
        <h3>Importar planilha</h3>
        <p class="hint">Envie um arquivo no formato do "Balanço Normativos" (abas Base de Dados, Matriz de C.H. e Trilha por Cargo). Colaboradores, treinamentos e lançamentos novos são adicionados; os existentes são atualizados. Linhas PENDENTE não criam lançamento.</p>
        <br>
        <input type="file" id="impFile" accept=".xlsx,.xls">
        <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;text-transform:none;letter-spacing:0">
          <input type="checkbox" id="impClear" style="width:auto;accent-color:var(--orange)"> Substituir todos os lançamentos (apaga os atuais antes de importar)
        </label>
        <br><button class="btn-navy" id="btnImport">⬆ Importar arquivo</button>
        <div id="impResult" class="hint" style="margin-top:12px"></div>
      </div>
    </div>`;
  $('btnImport').addEventListener('click', async () => {
    const f = $('impFile').files[0];
    if (!f) return toast('Selecione um arquivo .xlsx', true);
    if ($('impClear').checked && !(await confirmar('Tem certeza? TODOS os lançamentos atuais serão apagados e substituídos pelos da planilha.'))) return;
    const fd = new FormData();
    fd.append('file', f);
    fd.append('clear', $('impClear').checked ? '1' : '0');
    $('impResult').textContent = 'Importando…';
    const res = await fetch('/api/import', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { $('impResult').textContent = data.error || 'Falha na importação'; return; }
    $('impResult').innerHTML = `✔ Importação concluída — ${fmtN(data.stats.lancamentos)} lançamentos novos · ${fmtN(data.stats.empresas)} empresas · ${fmtN(data.stats.cargos)} cargos na base.`;
    toast('Planilha importada com sucesso');
    await loadAll();
  });
}

// ===== Usuários =====
async function renderUsuarios() {
  const [{ users, teams }, dados] = await Promise.all([api('/api/users'), api('/api/profiles')]);
  PERFIS = dados.profiles;
  CATALOGO = dados.catalogo;
  const teamCount = {};
  for (const t of teams) teamCount[t.user_id] = (teamCount[t.user_id] || 0) + 1;

  $('cadContent').innerHTML = `
    <div class="toolbar">
      <button class="btn-primary" onclick="editUser(null)">+ Novo usuário</button>
      <span class="hint">Um login por pessoa. O perfil define o que cada um enxerga —
      ajuste os perfis na aba <b>Perfis de Acesso</b>.</span>
    </div>
    <div class="card">
      <div class="tbl-wrap" style="max-height:560px"><table class="tbl"><thead><tr>
        <th>Nome</th><th>E-mail</th><th>Perfil</th><th>Equipe</th><th>Status</th><th>Ações</th></tr></thead><tbody>
        ${users.map(u => `<tr>
          <td>${esc(u.name)}${u.role === 'admin' ? ' <span class="badge role admin">principal</span>' : ''}</td>
          <td>${esc(u.email)}</td>
          <td><span class="badge role">${esc(u.profile_name || '—')}</span></td>
          <td>${u.profile_scope === 'team' ? (teamCount[u.id] || 0) + ' colaboradores' : 'todos'}</td>
          <td>${u.active ? '<span class="badge valido">ATIVO</span>' : '<span class="badge vencido">INATIVO</span>'}</td>
          <td style="white-space:nowrap">
            <button class="btn-mini" onclick='editUser(${esc(JSON.stringify(u))}, ${esc(JSON.stringify(teams.filter(t => t.user_id === u.id).map(t => t.employee_id)))})'>Editar</button>
            ${u.id !== ME.id && (u.role !== 'admin' || ME.role === 'admin') ? `<button class="btn-mini danger" onclick="delUser(${u.id})">Excluir</button>` : ''}
          </td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
}

window.editUser = (u, teamIds = []) => {
  const isNew = !u;
  const teamSet = new Set(teamIds);
  // Só é possível conceder um perfil cujas permissões você mesma possui — o
  // servidor aplica a mesma regra, isto aqui é para não oferecer o impossível.
  const atribuiveis = PERFIS.filter(p => CATALOGO && [...CATALOGO.paineis, ...CATALOGO.acoes]
    .every(i => !p.permissions[i.chave] || pode(i.chave)));
  const perfilOpts = atribuiveis
    .map(p => `<option value="${p.id}" ${u && u.profile_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const ehPrincipal = u && u.role === 'admin';

  openModal(isNew ? 'Novo usuário' : 'Editar usuário — ' + u.name, `
    <label>Nome</label><input id="mNome" value="${esc(u?.name || '')}">
    <label>E-mail (login)</label><input type="email" id="mEmail" value="${esc(u?.email || '')}">
    <div class="row2">
      <div><label>Perfil de acesso</label>
        <select id="mPerfil" ${ehPrincipal ? 'disabled' : ''}>${perfilOpts}</select></div>
      <div><label>${isNew ? 'Senha' : 'Nova senha (vazio = manter)'}</label>
        <input type="text" id="mSenha" placeholder="mínimo 6 caracteres"></div>
    </div>
    <label>Empresa (usada para direcionar comunicados por empresa)</label>
    <select id="mEmpresaUser">
      <option value="">Nenhuma específica</option>
      ${DS.companies.map(c => `<option value="${c.id}" ${u && u.company_id === c.id ? 'selected' : ''}>${esc(c.short_name || c.name)}</option>`).join('')}
    </select>
    <p class="hint" id="mPerfilDesc"></p>
    ${ehPrincipal ? '<p class="hint" style="color:var(--amber)">Esta é a administradora principal: o perfil dela não pode ser alterado.</p>' : ''}
    ${!isNew ? `<label style="display:flex;align-items:center;gap:8px;text-transform:none"><input type="checkbox" id="mAtivo" style="width:auto;accent-color:var(--orange)" ${u.active ? 'checked' : ''}> Usuário ativo (desmarque para bloquear o acesso)</label>` : ''}
    <div id="teamBox" style="display:none">
      <label>Equipe (colaboradores que este usuário enxerga)</label>
      <input type="search" id="teamSearch" placeholder="filtrar…" style="margin-bottom:6px">
      <div class="checklist" id="teamList"></div>
    </div>`,
    [{ label: 'Salvar', cls: 'btn-primary', onClick: async () => {
      const body = { name: $('mNome').value, email: $('mEmail').value, profile_id: Number($('mPerfil').value),
        company_id: $('mEmpresaUser').value ? Number($('mEmpresaUser').value) : null };
      if ($('mSenha').value) body.password = $('mSenha').value;
      if (!isNew) body.active = $('mAtivo').checked ? 1 : 0;
      const perfil = PERFIS.find(p => p.id === Number($('mPerfil').value));
      if (perfil && perfil.scope === 'team') {
        body.team = [...document.querySelectorAll('.teamChk:checked')].map(x => Number(x.value));
      }
      if (isNew) {
        if (!body.password) return toast('Defina uma senha', true);
        await api('/api/users', { method: 'POST', body: JSON.stringify(body) });
      } else {
        await api('/api/users/' + u.id, { method: 'PUT', body: JSON.stringify(body) });
      }
      closeModal(); toast('Usuário salvo'); renderUsuarios();
    } }], 'media');

  const renderTeam = (q = '') => {
    $('teamList').innerHTML = DS.employees
      .filter(e => !q || e.name.toLowerCase().includes(q))
      .map(e => `<label><input type="checkbox" class="teamChk" value="${e.id}" ${teamSet.has(e.id) ? 'checked' : ''}> ${esc(e.name)} <span style="color:var(--muted)">· ${esc(e.company_short || e.company_name)}</span></label>`).join('');
    document.querySelectorAll('.teamChk').forEach(chk => chk.addEventListener('change', () => {
      if (chk.checked) teamSet.add(Number(chk.value)); else teamSet.delete(Number(chk.value));
    }));
  };
  const syncPerfil = () => {
    const perfil = PERFIS.find(p => p.id === Number($('mPerfil').value));
    $('mPerfilDesc').textContent = perfil ? (perfil.description || '') : '';
    const equipe = perfil && perfil.scope === 'team';
    $('teamBox').style.display = equipe ? '' : 'none';
    if (equipe) renderTeam();
  };
  $('mPerfil').addEventListener('change', syncPerfil);
  $('teamSearch').addEventListener('input', (e) => renderTeam(e.target.value.trim().toLowerCase()));
  syncPerfil();
};
window.delUser = async (id) => {
  if (!await confirmar('Excluir este usuário? Ele perderá o acesso imediatamente.')) return;
  await api('/api/users/' + id, { method: 'DELETE' });
  toast('Usuário excluído'); renderUsuarios();
};

// ---------- modal / toast ----------
function openModal(title, bodyHTML, buttons = [], largura = '') {
  const caixa = document.querySelector('#modalBack .modal');
  caixa.className = 'modal' + (largura ? ' ' + largura : '');
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHTML;
  $('modalBody').scrollTop = 0;
  $('modalFoot').innerHTML = '';
  const cancel = document.createElement('button');
  cancel.className = 'btn-ghost'; cancel.textContent = 'Cancelar';
  cancel.addEventListener('click', closeModal);
  $('modalFoot').appendChild(cancel);
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = b.cls || 'btn-primary'; btn.textContent = b.label;
    btn.addEventListener('click', async () => {
      try { await b.onClick(); } catch (e) { if (!e.jaAvisado) toast(e.message, true); }
    });
    $('modalFoot').appendChild(btn);
  }
  $('modalBack').classList.add('open');
}
function closeModal() { $('modalBack').classList.remove('open'); }
$('modalClose').addEventListener('click', closeModal);
$('modalBack').addEventListener('click', (e) => { if (e.target === $('modalBack')) closeModal(); });

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---------- eventos globais ----------
document.querySelectorAll('#mainTabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#mainTabs button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  currentTab = b.dataset.tab;
  renderTab();
}));
['fEmpresa', 'fCargo', 'fTreinamento', 'fSituacao', 'fFaixa'].forEach(id =>
  $(id).addEventListener('change', renderTab));
$('fBusca').addEventListener('input', () => renderTab());
$('fEscopo').value = ESCOPO;
$('fEscopo').addEventListener('change', (e) => {
  ESCOPO = e.target.value;
  localStorage.setItem('painelEscopo', ESCOPO);   // a escolha vale nos próximos acessos
  renderTab();
});
$('btnLimpar').addEventListener('click', () => {
  ['fEmpresa', 'fCargo', 'fTreinamento', 'fSituacao', 'fFaixa'].forEach(id => $(id).value = '');
  $('fBusca').value = '';
  renderTab();   // o escopo não é limpo: é uma definição, não um filtro pontual
});

// Lista o que está fora da conta e leva ao ajuste da trilha.
window.verForaDaTrilha = () => {
  const fora = ROWS.filter(r => !noEscopo(r))
    .sort((a, b) => a.empName.localeCompare(b.empName, 'pt-BR') || a.trName.localeCompare(b.trName, 'pt-BR'));
  const porCargo = {};
  for (const r of fora) {
    const k = r.cargo + ' — ' + r.companyShort;
    porCargo[k] = porCargo[k] || { total: 0, pend: 0, treinos: new Set() };
    porCargo[k].total++;
    if (r.status === 'PENDENTE') porCargo[k].pend++;
    porCargo[k].treinos.add(r.trName);
  }
  openModal('Registros fora da conta dos indicadores', `
    <p class="hint">Estes treinamentos estão cadastrados para as pessoas, mas não constam na
    trilha do cargo delas — por isso não entram nos números. Para passarem a contar, inclua o
    treinamento na trilha do cargo em <b>Administração → Cargos e Trilhas</b>, ou mude o escopo
    na barra de filtros.</p>
    <div class="tbl-wrap" style="max-height:420px"><table class="tbl fixa">
      <colgroup><col style="width:40%"><col style="width:12%"><col style="width:12%"><col style="width:36%"></colgroup>
      <thead><tr><th>Cargo</th><th style="text-align:center">Registros</th>
        <th style="text-align:center">Pendentes</th><th>Treinamentos</th></tr></thead><tbody>
      ${Object.entries(porCargo).sort((a, b) => b[1].pend - a[1].pend).map(([cargo, d]) => `<tr>
        <td>${esc(cargo)}</td>
        <td style="text-align:center">${d.total}</td>
        <td style="text-align:center;font-weight:700;color:${d.pend ? 'var(--amber)' : 'var(--muted)'}">${d.pend}</td>
        <td class="hint" style="font-size:12px">${esc([...d.treinos].join(', '))}</td></tr>`).join('') ||
        '<tr><td colspan="4" class="empty">Nada fora da conta</td></tr>'}
    </tbody></table></div>`,
    pode('config') ? [{ label: 'Ir para Cargos e Trilhas', cls: 'btn-primary',
      onClick: () => { closeModal(); irParaAdmin('cargostrilhas', ''); } }] : [],
    'media');
};
// ---------- manter os indicadores sempre atuais ----------
// Um lançamento feito aqui já recarrega tudo. Estes mecanismos cobrem o resto:
// outra pessoa lançando ao mesmo tempo, outra aba do navegador, ou a página
// deixada aberta por horas.
async function atualizarAgora(botao) {
  if (botao) { botao.classList.add('girando'); botao.textContent = '⟳ Atualizando…'; }
  try {
    await loadAll();
    $('avisoDesatualizado').style.display = 'none';
    toast('Indicadores atualizados');
  } finally {
    if (botao) { botao.classList.remove('girando'); botao.textContent = '⟳ Atualizar'; }
  }
}
$('btnAtualizar').addEventListener('click', () => atualizarAgora($('btnAtualizar')));
$('btnAtualizarAviso').addEventListener('click', () => atualizarAgora($('btnAtualizar')));

// Assinatura do estado dos dados no momento em que a tela foi carregada.
let assinaturaAtual = null;

// Pergunta ao servidor se algo mudou. A consulta é leve (só contadores), então
// pode rodar de tempos em tempos sem pesar.
async function verificarNovidades({ silencioso = true } = {}) {
  if (!DS) return;
  try {
    const res = await fetch('/api/status', { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return;
    const st = await res.json();
    if (assinaturaAtual === null) { assinaturaAtual = st.assinatura; return; }
    if (st.assinatura === assinaturaAtual) return;

    // Não recarrega por baixo de uma edição em andamento: avisa e espera.
    const editando = $('modalBack').classList.contains('open') || $('confirmBack').classList.contains('open');
    if (editando) { $('avisoDesatualizado').style.display = 'flex'; return; }
    await loadAll();
    $('avisoDesatualizado').style.display = 'none';
    if (!silencioso) toast('Indicadores atualizados');
  } catch { /* rede instável: tenta de novo no próximo ciclo */ }
}

// Ao voltar para a aba do navegador e a cada 2 minutos com a aba visível.
document.addEventListener('visibilitychange', () => { if (!document.hidden) verificarNovidades(); });
window.addEventListener('focus', () => verificarNovidades());
setInterval(() => { if (!document.hidden) verificarNovidades(); }, 120000);

$('btnLogout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });
$('btnMyPassword').addEventListener('click', () => {
  const ehAdmin = ME.role === 'admin';
  openModal('Trocar minha senha', `
    <label>Senha atual</label><input type="password" id="mAtual">
    <label>Nova senha (mínimo 6 caracteres)</label><input type="password" id="mNova">
    ${ehAdmin ? `<div class="hint" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">
      Se você esquecer a senha, não há mais ninguém que possa trocá-la por você — por isso
      existe o código de recuperação. Gere um, anote em lugar seguro (não neste computador)
      e use na tela de login se precisar.
      <div style="margin-top:8px"><button class="btn-ghost" id="btnGerarCodigo" type="button">Gerar código de recuperação</button></div>
    </div>` : ''}`,
    [{ label: 'Alterar', cls: 'btn-primary', onClick: async () => {
      await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: $('mAtual').value, next: $('mNova').value }) });
      closeModal(); toast('Senha alterada com sucesso');
    } }]);
  if (ehAdmin) {
    $('btnGerarCodigo').addEventListener('click', async () => {
      if (!await confirmar('Gerar um novo código de recuperação invalida qualquer código anterior. Continuar?',
        'Gerar código de recuperação')) return;
      const r = await api('/api/me/recovery-code', { method: 'POST' });
      openModal('Seu código de recuperação', `
        <p style="font-size:13.5px;line-height:1.6">Anote este código agora — ele <b>não vai aparecer de novo</b>.
        Guarde em um lugar seguro, fora deste computador (papel, cofre de senhas). Serve para
        redefinir a senha da administradora caso ela seja esquecida.</p>
        <div style="font:700 22px/1.4 monospace;letter-spacing:1px;background:var(--bg);
          border:1px solid var(--line);border-radius:8px;padding:14px;text-align:center;
          margin:14px 0;user-select:all">${esc(r.codigo)}</div>`,
        [{ label: 'Já anotei, fechar', cls: 'btn-primary', onClick: () => closeModal() }]);
    });
  }
});

// Rede de segurança: qualquer falha não tratada vira aviso visível.
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason || {};
  if (!err.jaAvisado) toast(err.message || 'Algo deu errado. Tente novamente.', true);
});

loadAll().catch(e => { console.error(e); });
