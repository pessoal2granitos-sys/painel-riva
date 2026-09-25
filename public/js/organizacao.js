'use strict';
/* Organização Pessoal da administradora: Kanban (que também é a agenda),
   calendário com feriados nacionais/estaduais(ES)/municipais(Colatina),
   calculadora de horas e ferramentas de PDF — tudo local, nada sai do
   navegador nas ferramentas de PDF (pdf-lib roda 100% client-side). */

let ORG_SUBTAB = 'kanban';
let ORG_CARDS = [];
let ORG_CAL_MES = new Date().getMonth();
let ORG_CAL_ANO = new Date().getFullYear();
let ORG_DRAG_ID = null;

async function orgApi(url, opts) { return api('/api/organizacao' + url, opts); }

function orgNav() {
  const items = [['kanban', '📋 Kanban'], ['calendario', '📅 Calendário'], ['horas', '⏱ Calculadora de Horas'], ['pdf', '📎 Ferramentas de PDF']];
  return `<div class="tv-subnav" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
    ${items.map(([key, label]) => `
      <button class="btn-ghost org-subtab" data-sub="${key}"
        style="${ORG_SUBTAB === key ? 'background:var(--navy);color:#fff' : ''}">${esc(label)}</button>
    `).join('')}
  </div>`;
}

async function renderOrganizacao() {
  const el = $('tab-organizacao');
  el.innerHTML = orgNav() + '<div id="orgBody">Carregando…</div>';
  el.querySelectorAll('.org-subtab').forEach((b) => { b.onclick = () => { ORG_SUBTAB = b.dataset.sub; renderOrganizacao(); }; });
  if (ORG_SUBTAB === 'calendario') return renderOrgCalendario();
  if (ORG_SUBTAB === 'horas') return renderOrgHoras();
  if (ORG_SUBTAB === 'pdf') return renderOrgPdf();
  return renderOrgKanban();
}

/* ===================== FERIADOS ===================== */
// Páscoa pelo algoritmo de Meeus/Jones/Butcher — a partir dela, todo o resto
// (Carnaval, Sexta-feira Santa, Corpus Christi, Nossa Senhora da Penha e
// Sagrado Coração de Jesus) é só deslocamento de dias, confirmado contra as
// datas oficiais publicadas para 2026.
function orgPascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}
function orgAddDias(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function orgYmd(d) { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }

function orgFeriadosDoAno(ano) {
  const pas = orgPascoa(ano);
  const lista = [];
  const add = (date, nome, tipo) => lista.push({ data: orgYmd(date), nome, tipo });
  add(new Date(ano, 0, 1), 'Confraternização Universal', 'nacional');
  add(new Date(ano, 3, 21), 'Tiradentes', 'nacional');
  add(new Date(ano, 4, 1), 'Dia do Trabalho', 'nacional');
  add(new Date(ano, 8, 7), 'Independência do Brasil', 'nacional');
  add(new Date(ano, 9, 12), 'Nossa Senhora Aparecida', 'nacional');
  add(new Date(ano, 10, 2), 'Finados', 'nacional');
  add(new Date(ano, 10, 15), 'Proclamação da República', 'nacional');
  add(new Date(ano, 10, 20), 'Consciência Negra', 'nacional');
  add(new Date(ano, 11, 25), 'Natal', 'nacional');
  add(orgAddDias(pas, -48), 'Carnaval (segunda-feira)', 'nacional');
  add(orgAddDias(pas, -47), 'Carnaval (terça-feira)', 'nacional');
  add(orgAddDias(pas, -2), 'Sexta-feira Santa', 'nacional');
  add(pas, 'Páscoa', 'nacional');
  add(orgAddDias(pas, 60), 'Corpus Christi', 'nacional');
  add(orgAddDias(pas, 8), 'Nossa Senhora da Penha — Padroeira do ES', 'estadual');
  add(new Date(ano, 7, 22), 'Aniversário de Colatina', 'municipal');
  add(orgAddDias(pas, 68), 'Sagrado Coração de Jesus (Colatina)', 'municipal');
  return lista;
}
const ORG_TIPO_COR = { nacional: 'var(--navy)', estadual: 'var(--orange)', municipal: 'var(--green)' };
const ORG_TIPO_LABEL = { nacional: 'Nacional', estadual: 'Estadual (ES)', municipal: 'Municipal (Colatina)' };

/* ===================== KANBAN ===================== */
const ORG_COLUNAS = [['a_fazer', '📥 A Fazer'], ['fazendo', '🔧 Fazendo'], ['concluido', '✅ Concluído']];
const ORG_PRIORIDADE_COR = { baixa: 'var(--muted)', normal: 'var(--navy)', alta: 'var(--red)' };
const ORG_PRIORIDADE_LABEL = { baixa: 'Baixa', normal: 'Normal', alta: 'Alta' };

async function renderOrgKanban() {
  ORG_CARDS = await orgApi('/cards');
  const box = $('orgBody');
  box.innerHTML = `
    <div class="admin-head">
      <h2>📋 Quadro de Tarefas</h2>
      <span class="hint">Arraste os cartões entre as colunas. Cartões com prazo também aparecem no Calendário.</span>
      <button class="btn-primary" id="btnNovoCard">+ Nova tarefa</button>
    </div>
    <div class="grid cols-3" id="orgKanbanCols"></div>`;
  $('btnNovoCard').onclick = () => openOrgCardModal(null, 'a_fazer');

  const cols = $('orgKanbanCols');
  cols.innerHTML = ORG_COLUNAS.map(([key, label]) => `
    <div class="card org-col" data-coluna="${key}" style="min-height:300px">
      <h3>${label} <span class="hint" style="margin:0">(${ORG_CARDS.filter((c) => c.coluna === key).length})</span></h3>
      <div class="org-col-body" data-coluna="${key}"></div>
    </div>`).join('');

  ORG_COLUNAS.forEach(([key]) => {
    const body = cols.querySelector('.org-col-body[data-coluna="' + key + '"]');
    const cards = ORG_CARDS.filter((c) => c.coluna === key);
    body.innerHTML = cards.map((c) => `
      <div class="org-card" draggable="true" data-id="${c.id}" style="border-left:3px solid ${ORG_PRIORIDADE_COR[c.prioridade]}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
          <b style="font-size:13px">${esc(c.titulo)}</b>
          <button class="btn-mini danger org-del-card" data-id="${c.id}" style="color:var(--red);flex:0 0 auto">×</button>
        </div>
        ${c.descricao ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${esc(c.descricao)}</div>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
          <span class="badge" style="background:#eef3f8;color:${ORG_PRIORIDADE_COR[c.prioridade]}">${ORG_PRIORIDADE_LABEL[c.prioridade]}</span>
          ${c.prazo ? `<span style="font-size:11px;color:var(--muted)">📅 ${brDate(c.prazo)}</span>` : ''}
        </div>
      </div>`).join('') || '<p class="hint">Nenhuma tarefa aqui.</p>';

    body.querySelectorAll('.org-card').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('org-del-card')) return;
        const c = ORG_CARDS.find((x) => x.id == el.dataset.id);
        openOrgCardModal(c, c.coluna);
      });
      el.addEventListener('dragstart', () => { ORG_DRAG_ID = el.dataset.id; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
    });
    body.querySelectorAll('.org-del-card').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (!(await confirmar('Excluir esta tarefa?'))) return;
        await orgApi('/cards/' + b.dataset.id, { method: 'DELETE' });
        renderOrgKanban();
      };
    });
    body.addEventListener('dragover', (e) => e.preventDefault());
    body.addEventListener('drop', async () => {
      if (!ORG_DRAG_ID) return;
      await orgApi('/cards/' + ORG_DRAG_ID, { method: 'PUT', body: JSON.stringify({ coluna: key }) });
      ORG_DRAG_ID = null;
      renderOrgKanban();
    });
  });
}

window.openOrgCardModal = (card, colunaPadrao, prazoPadrao) => {
  openModal(card ? 'Editar tarefa' : 'Nova tarefa', `
    <label>Título</label>
    <input class="inp" id="oTitulo" value="${esc((card && card.titulo) || '')}" placeholder="Ex: Fechar folha de ponto">
    <label>Descrição (opcional)</label>
    <textarea class="inp" id="oDescricao" rows="3">${esc((card && card.descricao) || '')}</textarea>
    <div class="row2">
      <div><label>Prazo (opcional)</label><input type="date" class="inp" id="oPrazo" value="${(card && card.prazo) || prazoPadrao || ''}"></div>
      <div><label>Prioridade</label>
        <select class="inp" id="oPrioridade">
          <option value="baixa" ${card && card.prioridade === 'baixa' ? 'selected' : ''}>Baixa</option>
          <option value="normal" ${!card || card.prioridade === 'normal' ? 'selected' : ''}>Normal</option>
          <option value="alta" ${card && card.prioridade === 'alta' ? 'selected' : ''}>Alta</option>
        </select></div>
    </div>`,
    [{ label: card ? 'Salvar' : 'Criar tarefa', cls: 'btn-primary', onClick: async () => {
      const titulo = $('oTitulo').value.trim();
      if (!titulo) return toast('Dê um título à tarefa.', true);
      const body = {
        titulo, descricao: $('oDescricao').value.trim() || null,
        prazo: $('oPrazo').value || null, prioridade: $('oPrioridade').value,
      };
      if (card) await orgApi('/cards/' + card.id, { method: 'PUT', body: JSON.stringify(body) });
      else await orgApi('/cards', { method: 'POST', body: JSON.stringify(Object.assign({ coluna: colunaPadrao || 'a_fazer' }, body)) });
      closeModal(); toast('Tarefa salva.'); renderOrganizacao();
    } }], 'media');
};

/* ===================== CALENDÁRIO ===================== */
const ORG_MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const ORG_DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

async function renderOrgCalendario() {
  ORG_CARDS = await orgApi('/cards');
  const feriados = orgFeriadosDoAno(ORG_CAL_ANO);
  const feriadosMap = new Map(feriados.map((f) => [f.data, f]));
  const cardsPorData = new Map();
  ORG_CARDS.filter((c) => c.prazo).forEach((c) => {
    if (!cardsPorData.has(c.prazo)) cardsPorData.set(c.prazo, []);
    cardsPorData.get(c.prazo).push(c);
  });

  const primeiroDia = new Date(ORG_CAL_ANO, ORG_CAL_MES, 1);
  const diasNoMes = new Date(ORG_CAL_ANO, ORG_CAL_MES + 1, 0).getDate();
  const offset = primeiroDia.getDay();

  let celulas = '';
  let uteisSemSabado = 0, uteisComSabado = 0;
  for (let i = 0; i < offset; i++) celulas += '<div class="org-cal-cell vazia"></div>';
  for (let dia = 1; dia <= diasNoMes; dia++) {
    const dataObj = new Date(ORG_CAL_ANO, ORG_CAL_MES, dia);
    const data = orgYmd(dataObj);
    const diaSemana = dataObj.getDay(); // 0=dom, 6=sáb
    const feriado = feriadosMap.get(data);
    const tarefas = cardsPorData.get(data) || [];
    const hoje = orgYmd(new Date()) === data;
    if (!feriado && diaSemana !== 0) {
      uteisComSabado++;
      if (diaSemana !== 6) uteisSemSabado++;
    }
    celulas += `
      <div class="org-cal-cell ${hoje ? 'hoje' : ''}" data-data="${data}">
        <div class="org-cal-dia">${dia}</div>
        ${feriado ? `<div class="org-cal-feriado" style="background:${ORG_TIPO_COR[feriado.tipo]}" title="${esc(feriado.nome)} — ${ORG_TIPO_LABEL[feriado.tipo]}">${esc(feriado.nome)}</div>` : ''}
        ${tarefas.map((t) => `<div class="org-cal-tarefa" data-id="${t.id}" title="${esc(t.titulo)}">${esc(t.titulo)}</div>`).join('')}
      </div>`;
  }

  $('orgBody').innerHTML = `
    <div class="admin-head">
      <h2>📅 Calendário</h2>
      <span class="hint">Feriados nacionais, do Espírito Santo e de Colatina — mais suas tarefas com prazo.</span>
    </div>
    <div class="kpis">
      ${kpi('Dias úteis (seg–sex)', fmtN(uteisSemSabado), 'sem contar sábados, domingos e feriados')}
      ${kpi('Dias úteis (seg–sáb)', fmtN(uteisComSabado), 'contando sábados, sem domingos e feriados', 'orange')}
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <button class="btn-ghost" id="btnMesAnterior">← Mês anterior</button>
        <h3 style="margin:0">${ORG_MESES[ORG_CAL_MES]} de ${ORG_CAL_ANO}</h3>
        <button class="btn-ghost" id="btnMesProximo">Próximo mês →</button>
      </div>
      <div class="org-cal-grid">
        ${ORG_DIAS_SEMANA.map((d) => `<div class="org-cal-cell cabecalho">${d}</div>`).join('')}
        ${celulas}
      </div>
      <div style="display:flex;gap:16px;margin-top:14px;flex-wrap:wrap">
        ${Object.keys(ORG_TIPO_LABEL).map((t) => `<span style="font-size:12px;display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:3px;background:${ORG_TIPO_COR[t]};display:inline-block"></span>${ORG_TIPO_LABEL[t]}</span>`).join('')}
      </div>
    </div>`;

  $('btnMesAnterior').onclick = () => { ORG_CAL_MES--; if (ORG_CAL_MES < 0) { ORG_CAL_MES = 11; ORG_CAL_ANO--; } renderOrgCalendario(); };
  $('btnMesProximo').onclick = () => { ORG_CAL_MES++; if (ORG_CAL_MES > 11) { ORG_CAL_MES = 0; ORG_CAL_ANO++; } renderOrgCalendario(); };
  $('orgBody').querySelectorAll('.org-cal-cell[data-data]').forEach((cel) => {
    cel.addEventListener('dblclick', () => openOrgCardModal(null, 'a_fazer', cel.dataset.data));
  });
  $('orgBody').querySelectorAll('.org-cal-tarefa').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = ORG_CARDS.find((x) => x.id == el.dataset.id);
      if (c) openOrgCardModal(c, c.coluna);
    });
  });
}

/* ===================== CALCULADORA DE HORAS ===================== */
let ORG_HORAS_LINHAS = [{ entrada: '', saidaAlmoco: '', voltaAlmoco: '', saida: '' }];

function orgParseHora(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function orgFmtMin(min) {
  const neg = min < 0; min = Math.abs(Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return (neg ? '-' : '') + h + 'h' + String(m).padStart(2, '0') + 'min';
}

function renderOrgHoras() {
  $('orgBody').innerHTML = `
    <div class="admin-head">
      <h2>⏱ Calculadora de Horas</h2>
      <span class="hint">Some a jornada de vários dias — entrada, saída pro almoço, volta e saída. Compara com a jornada esperada e mostra o saldo (banco de horas).</span>
    </div>
    <div class="card">
      <div class="row2" style="margin-bottom:10px">
        <div><label>Jornada esperada por dia</label><input type="text" class="inp" id="oJornadaEsperada" value="8:48" placeholder="Ex: 8:48"></div>
        <div></div>
      </div>
      <div id="orgHorasLinhas"></div>
      <button class="btn-ghost" id="btnAddLinhaHoras" style="margin-top:10px">+ Adicionar dia</button>
      <div class="card" style="margin-top:16px;background:#f7fafc">
        <div class="kpis" id="orgHorasResumo"></div>
      </div>
    </div>`;

  $('btnAddLinhaHoras').onclick = () => { ORG_HORAS_LINHAS.push({ entrada: '', saidaAlmoco: '', voltaAlmoco: '', saida: '' }); renderOrgHorasLinhas(); };
  $('oJornadaEsperada').oninput = calcularOrgHoras;
  renderOrgHorasLinhas();
}

function renderOrgHorasLinhas() {
  const box = $('orgHorasLinhas');
  box.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:8px;font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">
      <div>Entrada</div><div>Saída almoço</div><div>Volta almoço</div><div>Saída</div><div></div>
    </div>
    ${ORG_HORAS_LINHAS.map((l, i) => `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:8px;margin-bottom:6px">
        <input type="time" class="inp org-hora" data-i="${i}" data-campo="entrada" value="${l.entrada}">
        <input type="time" class="inp org-hora" data-i="${i}" data-campo="saidaAlmoco" value="${l.saidaAlmoco}">
        <input type="time" class="inp org-hora" data-i="${i}" data-campo="voltaAlmoco" value="${l.voltaAlmoco}">
        <input type="time" class="inp org-hora" data-i="${i}" data-campo="saida" value="${l.saida}">
        <button class="btn-mini danger org-rm-linha" data-i="${i}" style="color:var(--red)">×</button>
      </div>`).join('')}`;
  box.querySelectorAll('.org-hora').forEach((inp) => {
    inp.oninput = () => { ORG_HORAS_LINHAS[Number(inp.dataset.i)][inp.dataset.campo] = inp.value; calcularOrgHoras(); };
  });
  box.querySelectorAll('.org-rm-linha').forEach((b) => {
    b.onclick = () => { ORG_HORAS_LINHAS.splice(Number(b.dataset.i), 1); if (!ORG_HORAS_LINHAS.length) ORG_HORAS_LINHAS.push({ entrada: '', saidaAlmoco: '', voltaAlmoco: '', saida: '' }); renderOrgHorasLinhas(); calcularOrgHoras(); };
  });
  calcularOrgHoras();
}

function calcularOrgHoras() {
  const esperadaMin = orgParseHora($('oJornadaEsperada').value) || 0;
  let totalMin = 0, diasValidos = 0;
  for (const l of ORG_HORAS_LINHAS) {
    const e = orgParseHora(l.entrada), sa = orgParseHora(l.saidaAlmoco), va = orgParseHora(l.voltaAlmoco), s = orgParseHora(l.saida);
    if (e === null || s === null) continue;
    let trabalhado = s - e;
    if (trabalhado < 0) trabalhado += 24 * 60;
    if (sa !== null && va !== null) {
      let almoco = va - sa;
      if (almoco < 0) almoco += 24 * 60;
      trabalhado -= almoco;
    }
    totalMin += trabalhado;
    diasValidos++;
  }
  const saldo = totalMin - esperadaMin * diasValidos;
  $('orgHorasResumo').innerHTML = `
    ${kpi('Dias preenchidos', fmtN(diasValidos), 'com entrada e saída')}
    ${kpi('Total trabalhado', orgFmtMin(totalMin), diasValidos + ' dia(s)')}
    ${kpi('Jornada esperada', orgFmtMin(esperadaMin * diasValidos), esperadaMin ? orgFmtMin(esperadaMin) + '/dia' : '—')}
    ${kpi('Saldo (banco de horas)', orgFmtMin(saldo), saldo >= 0 ? 'positivo' : 'negativo', saldo >= 0 ? 'green' : 'red')}`;
}

/* ===================== FERRAMENTAS DE PDF ===================== */
function renderOrgPdf() {
  $('orgBody').innerHTML = `
    <div class="admin-head">
      <h2>📎 Ferramentas de PDF</h2>
      <span class="hint">Tudo roda aqui no seu navegador — os arquivos não são enviados a nenhum servidor.</span>
    </div>
    <div class="grid cols-3">
      <div class="card">
        <h3>🔗 Juntar PDFs</h3>
        <p class="hint">Escolha vários arquivos, na ordem que quer juntar.</p>
        <input type="file" class="inp" id="oPdfJuntarFiles" accept="application/pdf" multiple style="margin-top:10px">
        <button class="btn-primary" id="btnPdfJuntar" style="margin-top:10px;width:100%">Juntar e baixar</button>
        <div id="oPdfJuntarStatus" class="hint"></div>
      </div>
      <div class="card">
        <h3>✂️ Extrair páginas</h3>
        <p class="hint">Escolha um PDF e as páginas que quer (ex: 1-3,5,8).</p>
        <input type="file" class="inp" id="oPdfExtrairFile" accept="application/pdf" style="margin-top:10px">
        <label style="margin-top:8px">Páginas</label>
        <input type="text" class="inp" id="oPdfExtrairPaginas" placeholder="Ex: 1-3,5,8">
        <button class="btn-primary" id="btnPdfExtrair" style="margin-top:10px;width:100%">Extrair e baixar</button>
        <div id="oPdfExtrairStatus" class="hint"></div>
      </div>
      <div class="card">
        <h3>🖼 Imagens em PDF</h3>
        <p class="hint">Transforma fotos (JPG/PNG) em um único PDF, uma por página.</p>
        <input type="file" class="inp" id="oPdfImgFiles" accept="image/jpeg,image/png" multiple style="margin-top:10px">
        <button class="btn-primary" id="btnPdfImg" style="margin-top:10px;width:100%">Transformar e baixar</button>
        <div id="oPdfImgStatus" class="hint"></div>
      </div>
    </div>`;

  function baixarBytes(bytes, nome) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  $('btnPdfJuntar').onclick = async () => {
    const files = [...$('oPdfJuntarFiles').files];
    if (files.length < 2) return toast('Escolha pelo menos 2 arquivos PDF.', true);
    $('oPdfJuntarStatus').textContent = 'Juntando…';
    try {
      const out = await PDFLib.PDFDocument.create();
      for (const file of files) {
        const bytes = await file.arrayBuffer();
        const src = await PDFLib.PDFDocument.load(bytes);
        const paginas = await out.copyPages(src, src.getPageIndices());
        paginas.forEach((p) => out.addPage(p));
      }
      baixarBytes(await out.save(), 'documento-unido.pdf');
      $('oPdfJuntarStatus').textContent = 'Pronto! ' + files.length + ' arquivo(s) unidos.';
    } catch (err) {
      $('oPdfJuntarStatus').textContent = '';
      toast('Não consegui juntar esses arquivos — confirme que são PDFs válidos.', true);
    }
  };

  function parseIntervalos(texto, totalPaginas) {
    const indices = [];
    for (const parte of String(texto).split(',')) {
      const p = parte.trim();
      if (!p) continue;
      const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        for (let n = Number(m[1]); n <= Number(m[2]); n++) if (n >= 1 && n <= totalPaginas) indices.push(n - 1);
      } else if (/^\d+$/.test(p)) {
        const n = Number(p);
        if (n >= 1 && n <= totalPaginas) indices.push(n - 1);
      }
    }
    return indices;
  }

  $('btnPdfExtrair').onclick = async () => {
    const file = $('oPdfExtrairFile').files[0];
    const paginasTexto = $('oPdfExtrairPaginas').value.trim();
    if (!file) return toast('Escolha um arquivo PDF.', true);
    if (!paginasTexto) return toast('Informe quais páginas extrair.', true);
    $('oPdfExtrairStatus').textContent = 'Extraindo…';
    try {
      const bytes = await file.arrayBuffer();
      const src = await PDFLib.PDFDocument.load(bytes);
      const indices = parseIntervalos(paginasTexto, src.getPageCount());
      if (!indices.length) { $('oPdfExtrairStatus').textContent = ''; return toast('Nenhuma página válida nesse intervalo.', true); }
      const out = await PDFLib.PDFDocument.create();
      const paginas = await out.copyPages(src, indices);
      paginas.forEach((p) => out.addPage(p));
      baixarBytes(await out.save(), 'paginas-extraidas.pdf');
      $('oPdfExtrairStatus').textContent = 'Pronto! ' + indices.length + ' página(s) extraída(s).';
    } catch (err) {
      $('oPdfExtrairStatus').textContent = '';
      toast('Não consegui ler esse arquivo — confirme que é um PDF válido.', true);
    }
  };

  $('btnPdfImg').onclick = async () => {
    const files = [...$('oPdfImgFiles').files];
    if (!files.length) return toast('Escolha ao menos uma imagem.', true);
    $('oPdfImgStatus').textContent = 'Transformando…';
    try {
      const out = await PDFLib.PDFDocument.create();
      for (const file of files) {
        const bytes = await file.arrayBuffer();
        const img = file.type === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        const page = out.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      baixarBytes(await out.save(), 'imagens.pdf');
      $('oPdfImgStatus').textContent = 'Pronto! ' + files.length + ' imagem(ns) no PDF.';
    } catch (err) {
      $('oPdfImgStatus').textContent = '';
      toast('Não consegui usar essas imagens — use JPG ou PNG.', true);
    }
  };
}
