'use strict';
/* Universidade Corporativa — RH cria cursos, trilhas (módulos) e aulas;
   colaboradores assistem pelo portal próprio em /universidade. */

let UNI_SUBTAB = 'cursos';
let UNI_COURSES = [];
let UNI_COURSE = null; // curso aberto no momento (com módulos/aulas)
let UNI_EMPLOYEES = [];

async function uniApi(url, opts) {
  return api('/api/uni' + url, opts);
}

function uniNav() {
  const items = [['cursos', 'Cursos'], ['colaboradores', 'Acesso dos Colaboradores']];
  return `<div class="tv-subnav" style="display:flex;gap:8px;margin-bottom:16px">
    ${items.map(([key, label]) => `
      <button class="btn-ghost uni-subtab" data-sub="${key}"
        style="${UNI_SUBTAB === key ? 'background:var(--navy);color:#fff' : ''}">${esc(label)}</button>
    `).join('')}
  </div>`;
}

async function renderUniversidade() {
  const el = $('tab-universidade');
  el.innerHTML = uniNav() + '<div id="uniBody">Carregando…</div>';
  el.querySelectorAll('.uni-subtab').forEach((b) => {
    b.onclick = () => { UNI_SUBTAB = b.dataset.sub; UNI_COURSE = null; renderUniversidade(); };
  });
  if (UNI_SUBTAB === 'colaboradores') return renderUniColaboradores();
  if (UNI_COURSE) return renderUniCourseDetail();
  return renderUniCourseList();
}

// ---------- Lista de cursos ----------
const UNI_TIPO_LABEL = { obrigatorio: 'Obrigatório', capacitacao: 'Capacitação' };

async function renderUniCourseList() {
  UNI_COURSES = await uniApi('/courses');
  $('uniBody').innerHTML = `
    <div class="admin-head">
      <h2>🎓 Cursos</h2>
      <span class="hint">Trilhas de treinamento para a liderança e os colaboradores em geral.</span>
      <button class="btn-primary" id="btnNovoCurso">+ Novo curso</button>
    </div>
    <div class="grid cols-3" id="uniCourseGrid"></div>`;

  const grid = $('uniCourseGrid');
  grid.innerHTML = UNI_COURSES.map((c) => `
    <div class="card" style="padding:0;overflow:hidden;cursor:pointer" data-id="${c.id}">
      <div style="background:#eef2f4;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;overflow:hidden">
        ${c.capaUrl ? `<img src="${esc(c.capaUrl)}" style="width:100%;height:100%;object-fit:cover">`
          : `<div style="font-size:38px">🎓</div>`}
      </div>
      <div style="padding:12px 14px">
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <span class="badge ${c.tipo === 'obrigatorio' ? 'vencido' : 'role'}">${UNI_TIPO_LABEL[c.tipo]}</span>
          ${!c.ativo ? '<span class="badge" style="background:#eceff3;color:var(--muted)">Fora do ar</span>' : ''}
        </div>
        <div style="font-weight:700;font-size:14px;margin-bottom:4px">${esc(c.titulo)}</div>
        <div style="font-size:12px;color:var(--muted)">${c.totalModulos} módulo(s) · ${c.totalAulas} aula(s)</div>
      </div>
    </div>`).join('') || '<p class="hint">Nenhum curso criado ainda.</p>';

  grid.querySelectorAll('.card[data-id]').forEach((card) => {
    card.onclick = async () => {
      UNI_COURSE = await uniApi('/courses/' + card.dataset.id);
      renderUniversidade();
    };
  });

  $('btnNovoCurso').onclick = () => openUniCourseModal(null);
}

window.openUniCourseModal = (curso) => {
  openModal(curso ? 'Editar curso' : 'Novo curso', `
    <label>Título</label>
    <input class="inp" id="uTitulo" value="${esc((curso && curso.titulo) || '')}" placeholder="Ex: Liderança na Prática">
    <label>Descrição</label>
    <textarea class="inp" id="uDescricao" rows="3" placeholder="Do que se trata este curso.">${esc((curso && curso.descricao) || '')}</textarea>
    <div class="row2">
      <div><label>Tipo</label>
        <select class="inp" id="uTipo">
          <option value="capacitacao" ${!curso || curso.tipo === 'capacitacao' ? 'selected' : ''}>Capacitação (opcional)</option>
          <option value="obrigatorio" ${curso && curso.tipo === 'obrigatorio' ? 'selected' : ''}>Obrigatório</option>
        </select></div>
      <div><label>Exibição</label>
        <select class="inp" id="uAtivo">
          <option value="1" ${!curso || curso.ativo ? 'selected' : ''}>Visível aos colaboradores</option>
          <option value="0" ${curso && !curso.ativo ? 'selected' : ''}>Fora do ar (rascunho)</option>
        </select></div>
    </div>
    <label>Capa do curso (opcional)</label>
    <input type="file" class="inp" id="uCapaFile" accept="image/jpeg,image/png,image/gif">
    <div id="uCapaPreview" style="margin-top:8px">${curso && curso.capaUrl ? `<img src="${esc(curso.capaUrl)}" style="max-width:180px;border-radius:8px;display:block">` : ''}</div>`,
    [{ label: curso ? 'Salvar' : 'Criar curso', cls: 'btn-primary', onClick: async () => {
      const titulo = $('uTitulo').value.trim();
      if (!titulo) return toast('Dê um título ao curso.', true);
      const body = {
        titulo, descricao: $('uDescricao').value.trim(), tipo: $('uTipo').value,
        ativo: $('uAtivo').value === '1', capaUrl: window.__uniCapaUrl !== undefined ? window.__uniCapaUrl : (curso ? curso.capaUrl : null),
      };
      if (curso) await uniApi('/courses/' + curso.id, { method: 'PUT', body: JSON.stringify(body) });
      else await uniApi('/courses', { method: 'POST', body: JSON.stringify(body) });
      window.__uniCapaUrl = undefined;
      closeModal(); toast('Curso salvo.');
      if (curso) { UNI_COURSE = await uniApi('/courses/' + curso.id); }
      renderUniversidade();
    } }], 'media');

  $('uCapaFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('uCapaPreview').innerHTML = '<p class="hint">Enviando…</p>';
    try {
      const blob = await VercelBlobClient.upload(file.name, file, { access: 'public', handleUploadUrl: '/api/uni/upload-token', contentType: file.type });
      window.__uniCapaUrl = blob.url;
      $('uCapaPreview').innerHTML = `<img src="${esc(blob.url)}" style="max-width:180px;border-radius:8px;display:block">`;
    } catch (err) {
      toast(err.message || 'Falha no upload.', true);
      $('uCapaPreview').innerHTML = '';
    }
  };
};

window.excluirUniCurso = async (id) => {
  if (!(await confirmar('Excluir este curso? Todos os módulos e aulas dele somem junto.', 'Excluir curso'))) return;
  await uniApi('/courses/' + id, { method: 'DELETE' });
  toast('Curso excluído.');
  UNI_COURSE = null;
  renderUniversidade();
};

// ---------- Detalhe do curso: módulos e aulas ----------
async function renderUniCourseDetail() {
  const c = UNI_COURSE;
  $('uniBody').innerHTML = `
    <button class="btn-ghost" id="btnVoltarCursos" style="margin-bottom:12px">← Voltar para Cursos</button>
    <div class="admin-head">
      <h2>${esc(c.titulo)}</h2>
      <span class="hint">${UNI_TIPO_LABEL[c.tipo]}${c.ativo ? '' : ' · Fora do ar'}</span>
      <button class="btn-ghost" id="btnEditarCurso">Editar curso</button>
      <button class="btn-mini danger" id="btnExcluirCurso" style="color:var(--red)">Excluir curso</button>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h3 style="margin:0">Trilha do curso</h3>
        <button class="btn-primary" id="btnNovoModulo">+ Novo módulo</button>
      </div>
      <div id="uniModulesList"></div>
    </div>`;

  $('btnVoltarCursos').onclick = () => { UNI_COURSE = null; renderUniversidade(); };
  $('btnEditarCurso').onclick = () => openUniCourseModal(c);
  $('btnExcluirCurso').onclick = () => window.excluirUniCurso(c.id);
  $('btnNovoModulo').onclick = async () => {
    const titulo = prompt('Nome do módulo (ex: Módulo 1 — Introdução):');
    if (!titulo || !titulo.trim()) return;
    await uniApi('/courses/' + c.id + '/modules', { method: 'POST', body: JSON.stringify({ titulo: titulo.trim() }) });
    UNI_COURSE = await uniApi('/courses/' + c.id);
    renderUniversidade();
  };

  const box = $('uniModulesList');
  box.innerHTML = c.modulos.map((m) => `
    <div class="card" style="margin-bottom:12px;background:#f9fbfc">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0;font-size:13.5px">📂 ${esc(m.titulo)}</h3>
        <div style="display:flex;gap:6px">
          <button class="btn-mini uni-add-aula" data-modulo="${m.id}">+ Aula</button>
          <button class="btn-mini uni-rename-modulo" data-modulo="${m.id}" data-titulo="${esc(m.titulo)}">Renomear</button>
          <button class="btn-mini danger uni-del-modulo" data-modulo="${m.id}" style="color:var(--red)">Remover módulo</button>
        </div>
      </div>
      <div class="tv-lib-list">
        ${m.aulas.map((a) => `
          <div class="tv-lib-item" style="cursor:pointer" data-aula="${a.id}">
            <div class="tv-lib-thumb">${a.videoUrl ? '🎬' : '📄'}</div>
            <div class="tv-lib-info">
              <div class="tv-lib-name">${esc(a.titulo)}</div>
              <div class="tv-lib-type">${a.videoUrl ? 'Com vídeo' : 'Somente texto'}${a.arquivos.length ? ' · ' + a.arquivos.length + ' anexo(s)' : ''}</div>
            </div>
            <button class="btn-mini danger uni-del-aula" data-aula="${a.id}" style="color:var(--red)">Remover</button>
          </div>`).join('') || '<p class="hint">Nenhuma aula neste módulo ainda.</p>'}
      </div>
    </div>`).join('') || '<p class="hint">Nenhum módulo criado ainda — comece adicionando um.</p>';

  box.querySelectorAll('.uni-add-aula').forEach((b) => { b.onclick = () => openUniLessonModal(b.dataset.modulo, null); });
  box.querySelectorAll('.uni-rename-modulo').forEach((b) => {
    b.onclick = async () => {
      const novo = prompt('Novo nome do módulo:', b.dataset.titulo);
      if (!novo || !novo.trim()) return;
      await uniApi('/modules/' + b.dataset.modulo, { method: 'PUT', body: JSON.stringify({ titulo: novo.trim() }) });
      UNI_COURSE = await uniApi('/courses/' + c.id);
      renderUniversidade();
    };
  });
  box.querySelectorAll('.uni-del-modulo').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmar('Remover este módulo e todas as aulas dele?'))) return;
      await uniApi('/modules/' + b.dataset.modulo, { method: 'DELETE' });
      UNI_COURSE = await uniApi('/courses/' + c.id);
      renderUniversidade();
    };
  });
  box.querySelectorAll('.uni-del-aula').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (!(await confirmar('Remover esta aula?'))) return;
      await uniApi('/lessons/' + b.dataset.aula, { method: 'DELETE' });
      UNI_COURSE = await uniApi('/courses/' + c.id);
      renderUniversidade();
    };
  });
  box.querySelectorAll('.tv-lib-item[data-aula]').forEach((row) => {
    row.onclick = () => {
      const moduloId = row.closest('.card').querySelector('.uni-add-aula').dataset.modulo;
      const modulo = c.modulos.find((m) => String(m.id) === String(moduloId));
      const aula = modulo.aulas.find((a) => String(a.id) === row.dataset.aula);
      openUniLessonModal(moduloId, aula);
    };
  });
}

// ---------- Modal de aula: título, texto formatado, vídeo, anexos ----------
function openUniLessonModal(moduloId, aula) {
  const isEdit = !!aula;
  let videoUrl = aula ? aula.videoUrl : null;
  let arquivos = aula ? [...aula.arquivos] : [];

  const toolbar = `
    <div class="rte-toolbar">
      <button type="button" class="rte-btn" data-target="uConteudo" data-cmd="bold"><b>N</b></button>
      <button type="button" class="rte-btn" data-target="uConteudo" data-cmd="italic"><i>I</i></button>
      <button type="button" class="rte-btn" data-target="uConteudo" data-cmd="underline"><u>S</u></button>
      <span class="rte-sep"></span>
      <button type="button" class="rte-btn" data-target="uConteudo" data-cmd="insertUnorderedList">•Lista</button>
      <span class="rte-sep"></span>
      <button type="button" class="rte-btn" data-target="uConteudo" data-cmd="removeFormat">Limpar</button>
    </div>`;

  openModal(isEdit ? 'Editar aula' : 'Nova aula', `
    <label>Título da aula</label>
    <input class="inp" id="uAulaTitulo" value="${esc((aula && aula.titulo) || '')}" placeholder="Ex: O que é liderança situacional">
    <label>Vídeo (opcional)</label>
    <input type="file" class="inp" id="uAulaVideo" accept="video/mp4">
    <div id="uAulaVideoPreview" style="margin-top:8px">${videoUrl ? `<video src="${esc(videoUrl)}" style="max-width:280px;border-radius:8px;display:block" controls></video>` : ''}</div>
    <label style="margin-top:14px">Conteúdo da aula</label>
    ${toolbar}
    <div class="rte-editable" id="uConteudo" contenteditable="true" data-placeholder="Escreva aqui o conteúdo da aula...">${(aula && aula.conteudo) || ''}</div>
    <label style="margin-top:14px">Anexos (PDF)</label>
    <input type="file" class="inp" id="uAulaAnexo" accept="application/pdf">
    <div id="uAulaAnexos" style="margin-top:8px"></div>`,
    [{ label: isEdit ? 'Salvar' : 'Criar aula', cls: 'btn-primary', onClick: async () => {
      const titulo = $('uAulaTitulo').value.trim();
      if (!titulo) return toast('Dê um título à aula.', true);
      const body = { titulo, conteudo: $('uConteudo').innerHTML.trim(), videoUrl };
      let lessonId = aula ? aula.id : null;
      if (isEdit) await uniApi('/lessons/' + aula.id, { method: 'PUT', body: JSON.stringify(body) });
      else {
        const r = await uniApi('/modules/' + moduloId + '/lessons', { method: 'POST', body: JSON.stringify(body) });
        lessonId = r.id;
      }
      // Anexos novos (ainda não gravados) ficam marcados com pending:true.
      for (const arq of arquivos.filter((a) => a.pending)) {
        await uniApi('/lessons/' + lessonId + '/files', { method: 'POST', body: JSON.stringify({ nome: arq.nome, url: arq.url }) });
      }
      closeModal(); toast('Aula salva.');
      UNI_COURSE = await uniApi('/courses/' + UNI_COURSE.id);
      renderUniversidade();
    } }], 'media');

  document.querySelectorAll('.rte-btn').forEach((b) => {
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      $(b.dataset.target).focus();
      document.execCommand(b.dataset.cmd, false, null);
    });
  });

  function renderAnexos() {
    $('uAulaAnexos').innerHTML = arquivos.map((a, i) => `
      <div style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:4px">
        <span>📄</span><span style="flex:1">${esc(a.nome)}</span>
        <button class="btn-mini danger uni-rm-anexo" data-i="${i}" style="color:var(--red)">Remover</button>
      </div>`).join('') || '<p class="hint">Nenhum anexo.</p>';
    $('uAulaAnexos').querySelectorAll('.uni-rm-anexo').forEach((b) => {
      b.onclick = async () => {
        const arq = arquivos[Number(b.dataset.i)];
        if (arq.id) await uniApi('/lesson-files/' + arq.id, { method: 'DELETE' });
        arquivos.splice(Number(b.dataset.i), 1);
        renderAnexos();
      };
    });
  }
  renderAnexos();

  $('uAulaVideo').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('uAulaVideoPreview').innerHTML = '<p class="hint">Enviando vídeo…</p>';
    try {
      const blob = await VercelBlobClient.upload(file.name, file, { access: 'public', handleUploadUrl: '/api/uni/upload-token', contentType: file.type });
      videoUrl = blob.url;
      $('uAulaVideoPreview').innerHTML = `<video src="${esc(videoUrl)}" style="max-width:280px;border-radius:8px;display:block" controls></video>`;
    } catch (err) {
      toast(err.message || 'Falha no upload.', true);
      $('uAulaVideoPreview').innerHTML = '';
    }
  };

  $('uAulaAnexo').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const blob = await VercelBlobClient.upload(file.name, file, { access: 'public', handleUploadUrl: '/api/uni/upload-token', contentType: file.type });
      arquivos.push({ nome: file.name, url: blob.url, pending: true });
      renderAnexos();
      $('uAulaAnexo').value = '';
    } catch (err) {
      toast(err.message || 'Falha no upload.', true);
    }
  };
}

// ---------- Acesso dos colaboradores (CPF + código) ----------
async function renderUniColaboradores() {
  UNI_EMPLOYEES = await uniApi('/employees');
  $('uniBody').innerHTML = `
    <div class="admin-head">
      <h2>🔑 Acesso dos Colaboradores</h2>
      <span class="hint">Cadastre o CPF de cada colaborador e gere um código de acesso — é isso que ele usa pra entrar no portal (em <code>/universidade</code>), sem precisar de senha complexa.</span>
    </div>
    <div class="card">
      <div class="tbl-wrap" style="max-height:560px"><table class="tbl"><thead><tr>
        <th>Nome</th><th>Empresa</th><th>CPF</th><th>Código de acesso</th><th></th></tr></thead><tbody>
        ${UNI_EMPLOYEES.map((e) => `<tr data-id="${e.id}">
          <td>${esc(e.name)}</td>
          <td>${esc(e.empresa)}</td>
          <td><input class="inp uni-cpf" data-id="${e.id}" value="${esc(e.cpf || '')}" placeholder="Só números" style="width:140px"></td>
          <td class="uni-codigo-cell">${e.temCodigo ? '<span class="badge valido">Código gerado</span>' : '<span class="badge" style="background:#eceff3;color:var(--muted)">Sem código</span>'}</td>
          <td style="white-space:nowrap">
            <button class="btn-mini uni-save-cpf" data-id="${e.id}">Salvar CPF</button>
            <button class="btn-mini uni-gerar-codigo" data-id="${e.id}">Gerar código</button>
          </td></tr>`).join('')}
      </tbody></table></div>
      ${UNI_EMPLOYEES.length === 0 ? '<p class="hint">Nenhum colaborador ativo cadastrado.</p>' : ''}
    </div>`;

  $('uniBody').querySelectorAll('.uni-save-cpf').forEach((b) => {
    b.onclick = async () => {
      const cpf = $('uniBody').querySelector('.uni-cpf[data-id="' + b.dataset.id + '"]').value;
      try {
        await uniApi('/employees/' + b.dataset.id + '/cpf', { method: 'PUT', body: JSON.stringify({ cpf }) });
        toast('CPF salvo.');
      } catch (err) { toast(err.message || 'CPF inválido.', true); }
    };
  });
  $('uniBody').querySelectorAll('.uni-gerar-codigo').forEach((b) => {
    b.onclick = async () => {
      const cpfInput = $('uniBody').querySelector('.uni-cpf[data-id="' + b.dataset.id + '"]');
      if (!cpfInput.value.trim()) return toast('Salve o CPF do colaborador antes de gerar o código.', true);
      const r = await uniApi('/employees/' + b.dataset.id + '/codigo', { method: 'POST' });
      openModal('Código de acesso gerado', `
        <p style="font-size:14px;line-height:1.6">Repasse esse código ao colaborador junto com o CPF dele. Ele usa os dois pra entrar em <b>/universidade</b>.</p>
        <div style="text-align:center;margin-top:16px">
          <div style="font-size:32px;font-weight:800;letter-spacing:.1em;color:var(--navy);background:#eef3f8;border-radius:10px;padding:16px">${esc(r.codigo)}</div>
        </div>`, [{ label: 'Fechar', cls: 'btn-primary', onClick: () => { closeModal(); renderUniversidade(); } }]);
    };
  });
}
