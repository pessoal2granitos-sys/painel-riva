'use strict';
/* Gestão de Pessoas — indicadores de RH: turnover, hora extra por
   departamento, custo da folha e absenteísmo. */

let HR_MESES = [];
let HR_MES_ATUAL = null;
let HR_PREVIA = null; // linhas lidas da planilha, aguardando confirmação

async function hrApi(url, opts) {
  return api('/api/hr' + url, opts);
}

function mesLabel(mesRef) {
  if (!mesRef) return '—';
  const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const [ano, mes] = mesRef.split('-');
  return MESES[Number(mes) - 1] + '/' + ano;
}

async function renderPessoas() {
  const el = $('tab-pessoas');
  el.innerHTML = '<p class="hint">Carregando…</p>';

  const [{ meses }, { serie }] = await Promise.all([hrApi('/payroll/meses'), hrApi('/turnover?meses=6')]);
  HR_MESES = meses;
  if (!HR_MES_ATUAL || !meses.includes(HR_MES_ATUAL)) HR_MES_ATUAL = meses[0] || null;

  const turnoverAtual = serie[serie.length - 1];

  el.innerHTML = `
    <div class="admin-head">
      <h2>👥 Indicadores de Gestão de Pessoas</h2>
      <span class="hint">Turnover calculado a partir do cadastro de colaboradores. Hora extra, custo e absenteísmo vêm da planilha de folha importada mês a mês.</span>
    </div>

    <div class="kpis">
      ${kpi('Turnover do mês', (turnoverAtual ? turnoverAtual.turnoverPct : 0) + '%', turnoverAtual ? mesLabel(turnoverAtual.mes) + ' · ' + turnoverAtual.desligados + ' desligamento(s)' : 'sem dados')}
      <div id="hrKpiCusto"></div>
      <div id="hrKpiAbsenteismo"></div>
      <div id="hrKpiColaboradores"></div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <h3>Turnover — últimos 6 meses</h3>
        <div id="hrTurnoverList">${hbars(serie.map(s => ({ label: mesLabel(s.mes), value: s.turnoverPct, fmt: s.turnoverPct + '%' })), () => 'var(--navy)')}</div>
      </div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h3 style="margin:0">Hora extra por departamento</h3>
          <select class="inp" id="hrMesSelect" style="width:auto">
            ${HR_MESES.length ? HR_MESES.map(m => `<option value="${m}" ${m === HR_MES_ATUAL ? 'selected' : ''}>${mesLabel(m)}</option>`).join('')
              : '<option value="">Nenhuma folha importada</option>'}
          </select>
        </div>
        <div id="hrOvertimeList"></div>
      </div>
    </div>

    <div class="card" style="margin-top:20px">
      <h3>📥 Importar folha de pagamento</h3>
      <p class="hint">Planilha (.xlsx) com uma linha por colaborador e uma coluna por rubrica: Nome, Departamento, Salário Base, Horas Extras 50%, Horas Extras 100%, Adicionais, Descontos, Faltas (horas), Atestados (horas), INSS, FGTS. O nome é casado com o cadastro de colaboradores já existente.</p>
      <div class="row2" style="margin-top:10px">
        <div><label>Mês de referência</label><input type="month" class="inp" id="hrMesRef"></div>
        <div><label>Planilha</label><input type="file" class="inp" id="hrFile" accept=".xlsx,.xls"></div>
      </div>
      <div id="hrPreview" style="margin-top:14px"></div>
    </div>`;

  renderHrCusto();
  $('hrMesSelect').onchange = () => { HR_MES_ATUAL = $('hrMesSelect').value; renderHrCusto(); };
  $('hrFile').onchange = hrOnFileSelected;

  async function renderHrCusto() {
    if (!HR_MES_ATUAL) {
      $('hrKpiCusto').innerHTML = kpi('Custo total da folha', '—', 'nenhuma folha importada ainda');
      $('hrKpiAbsenteismo').innerHTML = kpi('Absenteísmo', '—', 'nenhuma folha importada ainda');
      $('hrKpiColaboradores').innerHTML = kpi('Colaboradores na folha', '—', '—');
      $('hrOvertimeList').innerHTML = '<p class="hint">Importe uma planilha de folha para ver este indicador.</p>';
      return;
    }
    const d = await hrApi('/payroll/' + HR_MES_ATUAL);
    $('hrKpiCusto').innerHTML = kpi('Custo total da folha', 'R$ ' + fmtN(Math.round(d.custoTotalFolha)), mesLabel(d.mesRef));
    $('hrKpiAbsenteismo').innerHTML = kpi('Absenteísmo', d.absenteismoPct + '%', 'faltas + atestados / jornada esperada', d.absenteismoPct > 5 ? 'red' : 'green');
    $('hrKpiColaboradores').innerHTML = kpi('Colaboradores na folha', fmtN(d.totalColaboradores), mesLabel(d.mesRef));
    $('hrOvertimeList').innerHTML = d.porDepartamento.length
      ? hbars(d.porDepartamento.map(p => ({ label: p.departamento, value: p.horaExtra, fmt: fmtN(p.horaExtra) + 'h' })), () => 'var(--orange)')
      : '<p class="hint">Sem dados de departamento nessa folha.</p>';
  }

  async function hrOnFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    $('hrPreview').innerHTML = '<p class="hint">Lendo planilha…</p>';
    try {
      const res = await fetch('/api/hr/payroll/parse', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'Falha ao ler a planilha.', true); $('hrPreview').innerHTML = ''; return; }
      HR_PREVIA = data.linhas;
      $('hrPreview').innerHTML = `
        <div class="stale-bar" style="background:#eef3f8;border-color:var(--navy)">
          <span><b>${data.linhas.length}</b> linha(s) lida(s) — <b style="color:var(--green)">${data.encontrados}</b> casadas com colaboradores já cadastrados${data.naoEncontrados ? `, <b style="color:var(--amber)">${data.naoEncontrados}</b> não encontradas (serão gravadas mesmo assim, só sem vínculo com o cadastro)` : ''}.</span>
          <button class="btn-primary" id="hrConfirmarImport">Confirmar importação</button>
        </div>`;
      $('hrConfirmarImport').onclick = hrConfirmarImport;
    } catch {
      toast('Falha ao enviar a planilha.', true);
      $('hrPreview').innerHTML = '';
    }
  }

  async function hrConfirmarImport() {
    const mesRef = $('hrMesRef').value;
    if (!mesRef) return toast('Selecione o mês de referência.', true);
    if (!HR_PREVIA || !HR_PREVIA.length) return toast('Nenhuma planilha lida ainda.', true);
    await hrApi('/payroll/import', { method: 'POST', body: JSON.stringify({ mesRef, linhas: HR_PREVIA }) });
    toast('Folha importada.');
    HR_MES_ATUAL = mesRef;
    HR_PREVIA = null;
    renderPessoas();
  }
}
