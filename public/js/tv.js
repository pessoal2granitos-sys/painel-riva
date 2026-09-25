'use strict';
/* TV Corporativa — telas, TVs, playlists e publicação. */

let TV_SUBTAB = 'dashboard';
let TV_SCREENS = [];
let TV_DEVICES = [];
let TV_PLAYLISTS = [];

const WIDGET_ICON = { weather: '☀️', news: '📰', clock: '🕒', announcement: '📢' };
const WIDGET_LABEL = { weather: 'Clima', news: 'Notícias', clock: 'Relógio', announcement: 'Comunicado' };
const WIDGET_TYPES = ['weather', 'news', 'clock', 'announcement'];
const isWidget = (t) => WIDGET_TYPES.includes(t);

async function tvApi(url, opts) {
  return api('/api/tv' + url, opts);
}

function tvNav() {
  const items = [
    ['dashboard', 'Dashboard'],
    ['devices', 'TVs'],
    ['screens', 'Conteúdos'],
    ['playlists', 'Playlists'],
  ];
  return `<div class="tv-subnav" style="display:flex;gap:8px;margin-bottom:16px">
    ${items.map(([key, label]) => `
      <button class="btn-ghost tv-subtab" data-sub="${key}"
        style="${TV_SUBTAB === key ? 'background:var(--navy);color:#fff' : ''}">${esc(label)}</button>
    `).join('')}
  </div>`;
}

async function renderTV() {
  const el = $('tab-tv');
  el.innerHTML = tvNav() + '<div id="tvBody">Carregando…</div>';
  el.querySelectorAll('.tv-subtab').forEach((b) => {
    b.onclick = () => { TV_SUBTAB = b.dataset.sub; renderTV(); };
  });

  if (TV_SUBTAB === 'dashboard') return renderTvDashboard();
  if (TV_SUBTAB === 'devices') return renderTvDevices();
  if (TV_SUBTAB === 'screens') return renderTvScreens();
  if (TV_SUBTAB === 'playlists') return renderTvPlaylists();
}

// ---------- Dashboard ----------
async function renderTvDashboard() {
  const d = await tvApi('/dashboard');
  const lastSync = d.lastSync ? dataHoraLocal(d.lastSync) : '—';
  $('tvBody').innerHTML = `
    <div class="kpis">
      ${kpi('TVs cadastradas', fmtN(d.totalDevices), 'dispositivos no total')}
      ${kpi('TVs online', fmtN(d.onlineDevices), 'sincronizaram há menos de 2 min', 'green')}
      ${kpi('TVs offline', fmtN(d.offlineDevices), 'sem contato recente', d.offlineDevices ? 'red' : 'green')}
      ${kpi('Última sincronização', lastSync, 'de qualquer TV')}
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h3>Playlists publicadas atualmente</h3>
        ${d.currentPlaylists.length ? '<ul>' + d.currentPlaylists.map((p) => `<li>${esc(p.name)}</li>`).join('') + '</ul>'
          : '<p style="color:var(--muted)">Nenhuma playlist publicada ainda.</p>'}
      </div>
    </div>`;
}

// ---------- TVs ----------
async function renderTvDevices() {
  TV_DEVICES = await tvApi('/devices');
  $('tvBody').innerHTML = `
    <div class="grid cols-3">
      <div class="card">
        <h3>Cadastrar nova TV</h3>
        <label>Nome</label><input class="inp" id="tvName" placeholder="TV Refeitório">
        <label>Código único</label><input class="inp" id="tvCode" placeholder="TV-REFEITORIO">
        <label>Localização</label><input class="inp" id="tvLocation" placeholder="Refeitório">
        <label>Descrição (opcional)</label><input class="inp" id="tvDesc">
        <button class="btn-primary" id="btnAddDevice" style="margin-top:10px;width:100%">Cadastrar</button>
      </div>
      <div class="card" style="grid-column: span 2">
        <h3>TVs cadastradas</h3>
        <table class="tbl">
          <thead><tr><th>Nome</th><th>Código</th><th>Status</th><th>Playlist atual</th><th></th></tr></thead>
          <tbody>
            ${TV_DEVICES.map((tv) => `
              <tr>
                <td>${esc(tv.name)}<div style="font-size:11px;color:var(--muted)">${esc(tv.location || '')}</div></td>
                <td><code>${esc(tv.code)}</code></td>
                <td><span class="dot" style="background:${tv.online ? 'var(--green)' : 'var(--red)'}"></span> ${tv.online ? 'Online' : 'Offline'}</td>
                <td>${tv.currentPlaylist ? esc(tv.currentPlaylist.name) : '—'}</td>
                <td style="text-align:right">
                  <a href="/player/${esc(tv.code)}" target="_blank" style="margin-right:10px">Ver ao vivo</a>
                  <button class="btn-mini tv-del-device" data-id="${tv.id}">Remover</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${TV_DEVICES.length === 0 ? '<p style="color:var(--muted)">Nenhuma TV cadastrada ainda.</p>' : ''}
      </div>
    </div>`;

  $('btnAddDevice').onclick = async () => {
    const name = $('tvName').value.trim();
    const code = $('tvCode').value.trim();
    if (!name || !code) return toast('Preencha nome e código.', true);
    await tvApi('/devices', { method: 'POST', body: JSON.stringify({
      name, code, location: $('tvLocation').value.trim(), description: $('tvDesc').value.trim(),
    }) });
    toast('TV cadastrada.');
    renderTvDevices();
  };
  document.querySelectorAll('.tv-del-device').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmar('Remover esta TV?'))) return;
      await tvApi('/devices/' + b.dataset.id, { method: 'DELETE' });
      renderTvDevices();
    };
  });
}

// ---------- Conteúdos ----------
async function renderTvScreens() {
  TV_SCREENS = await tvApi('/screens');
  $('tvBody').innerHTML = `
    <div class="card" style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <h3 style="margin:0">Biblioteca de conteúdos</h3>
        <p style="color:var(--muted);margin:4px 0 0">Imagens, vídeos e telas de clima/notícias/relógio.</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn-ghost" id="btnCreateWidget">+ Criar tela (clima/notícias/relógio)</button>
        <label class="btn-primary" style="cursor:pointer">
          Enviar imagem/vídeo <input type="file" id="tvFileInput" accept=".jpg,.jpeg,.png,.mp4" style="display:none">
        </label>
      </div>
    </div>
    <div class="grid cols-4" id="tvScreensGrid"></div>`;

  const grid = $('tvScreensGrid');
  grid.innerHTML = TV_SCREENS.map((s) => `
    <div class="card" style="padding:0;overflow:hidden">
      <div style="background:#eef2f4;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center">
        ${isWidget(s.type)
          ? `<div style="text-align:center"><div style="font-size:32px">${WIDGET_ICON[s.type]}</div><div style="font-size:12px;color:var(--muted)">${WIDGET_LABEL[s.type]}</div></div>`
          : s.type === 'image' ? `<img src="${esc(s.url)}" style="width:100%;height:100%;object-fit:cover">`
          : `<video src="${esc(s.url)}" style="width:100%;height:100%;object-fit:cover" muted></video>`}
      </div>
      <div style="padding:10px">
        <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</div>
        <div style="display:flex;gap:10px;margin-top:6px">
          ${isWidget(s.type) ? `<button class="btn-mini tv-edit-widget" data-id="${s.id}">Editar</button>` : ''}
          <button class="btn-mini tv-del-screen" data-id="${s.id}" style="color:var(--red)">Remover</button>
        </div>
      </div>
    </div>`).join('') || '<p style="color:var(--muted)">Nenhum conteúdo criado ainda.</p>';

  $('tvFileInput').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    const type = ['.jpg', '.jpeg', '.png'].includes(ext) ? 'image' : ext === '.mp4' ? 'video' : null;
    if (!type) return toast('Use JPG, PNG ou MP4.', true);

    try {
      // Envia direto pro Vercel Blob a partir do navegador — não passa pelo nosso
      // servidor, porque toda função da Vercel tem limite de 4,5 MB por requisição
      // e vídeos costumam ser bem maiores que isso.
      const blob = await VercelBlobClient.upload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/tv/screens/upload-token',
        contentType: file.type,
      });
      await tvApi('/screens/confirm', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, type, url: blob.url, mime: file.type, sizeBytes: file.size }),
      });
      toast('Conteúdo enviado.');
      renderTvScreens();
    } catch (err) {
      toast(err.message || 'Falha no upload.', true);
    }
  };

  $('btnCreateWidget').onclick = () => openWidgetModal(null);
  document.querySelectorAll('.tv-edit-widget').forEach((b) => {
    b.onclick = () => openWidgetModal(TV_SCREENS.find((s) => s.id == b.dataset.id));
  });
  document.querySelectorAll('.tv-del-screen').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmar('Remover este conteúdo?'))) return;
      await tvApi('/screens/' + b.dataset.id, { method: 'DELETE' });
      renderTvScreens();
    };
  });
}

function openWidgetModal(existing) {
  const isEdit = !!existing;
  let type = existing ? existing.type : 'weather';
  let sources = (existing && existing.config && existing.config.sources) || [];

  function body() {
    return `
      ${!isEdit ? `
        <div style="display:flex;gap:8px;margin-bottom:14px">
          ${WIDGET_TYPES.map((t) => `
            <button class="btn-ghost tv-type-btn" data-type="${t}"
              style="flex:1;${type === t ? 'border-color:var(--navy);color:var(--navy)' : ''}">
              <div style="font-size:20px">${WIDGET_ICON[t]}</div>${WIDGET_LABEL[t]}
            </button>`).join('')}
        </div>` : ''}
      <label>Nome da tela</label>
      <input class="inp" id="wName" value="${esc((existing && existing.name) || '')}"
        placeholder="${type === 'weather' ? 'Previsão do Tempo' : type === 'news' ? 'Notícias do dia' : type === 'announcement' ? 'Comunicado RH — Setembro' : 'Relógio'}">
      <div id="wConfigArea"></div>
    `;
  }

  function configArea() {
    if (type === 'weather') {
      const city = (existing && existing.config && existing.config.city) || '';
      return `<label>Cidade</label><input class="inp" id="wCity" value="${esc(city)}" placeholder="Ex: Colatina, Espírito Santo">`;
    }
    if (type === 'news') {
      return `<label>Fontes RSS</label>
        <div id="wSourcesList" style="margin-bottom:8px"></div>
        <div style="display:flex;gap:6px">
          <input class="inp" id="wSourceName" placeholder="Nome (ex: G1)">
          <input class="inp" id="wSourceUrl" placeholder="URL do feed RSS">
          <button class="btn-ghost" id="wAddSource">Adicionar</button>
        </div>`;
    }
    if (type === 'announcement') {
      const title = (existing && existing.config && existing.config.title) || '';
      const subtitle = (existing && existing.config && existing.config.subtitle) || '';
      const toolbar = (prefix) => `
        <div class="rte-toolbar">
          <button type="button" class="rte-btn" data-target="${prefix}" data-cmd="bold"><b>N</b></button>
          <button type="button" class="rte-btn" data-target="${prefix}" data-cmd="italic"><i>I</i></button>
          <button type="button" class="rte-btn" data-target="${prefix}" data-cmd="underline"><u>S</u></button>
          <span class="rte-sep"></span>
          <button type="button" class="rte-btn rte-swatch" data-target="${prefix}" data-cmd="foreColor" data-color="#F58634" style="color:#F58634">A</button>
          <button type="button" class="rte-btn rte-swatch" data-target="${prefix}" data-cmd="foreColor" data-color="#14395c" style="color:#14395c">A</button>
          <button type="button" class="rte-btn rte-swatch" data-target="${prefix}" data-cmd="foreColor" data-color="#ffffff" style="color:#fff;text-shadow:0 0 1px #888">A</button>
          <button type="button" class="rte-btn" data-target="${prefix}" data-cmd="hiliteColor" data-color="#fff3cd">🖍</button>
          <span class="rte-sep"></span>
          <button type="button" class="rte-btn" data-target="${prefix}" data-cmd="removeFormat">Limpar</button>
        </div>`;
      return `
        <label>Título (grande, em destaque)</label>
        ${toolbar('wTitle')}
        <div class="rte-editable" id="wTitle" contenteditable="true" data-placeholder="Ex: Reunião geral sexta-feira">${title}</div>
        <label style="margin-top:14px">Texto complementar (opcional)</label>
        ${toolbar('wSubtitle')}
        <div class="rte-editable" id="wSubtitle" contenteditable="true" data-placeholder="Ex: Às 10h no auditório">${subtitle}</div>
        <p style="color:var(--muted);margin-top:10px;font-size:12.5px">Aparece em tela cheia com a identidade visual da Riva — mesmo estilo das telas de clima e relógio.</p>`;
    }
    return `<p style="color:var(--muted);margin-top:10px">Sem configuração adicional — mostra data e hora atualizadas automaticamente.</p>`;
  }

  function renderSourcesList() {
    const box = $('wSourcesList');
    if (!box) return;
    box.innerHTML = sources.map((s, i) => `
      <div style="display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:4px">
        <b>${esc(s.name)}</b><span style="color:var(--muted);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.url)}</span>
        <button class="btn-mini tv-rm-source" data-i="${i}" style="color:var(--red)">Remover</button>
      </div>`).join('') || '<p style="color:var(--muted);font-size:13px">Nenhuma fonte configurada.</p>';
    box.querySelectorAll('.tv-rm-source').forEach((b) => {
      b.onclick = () => { sources.splice(Number(b.dataset.i), 1); renderSourcesList(); };
    });
  }

  function wireConfigArea() {
    $('wConfigArea').innerHTML = configArea();
    if (type === 'news') {
      renderSourcesList();
      $('wAddSource').onclick = () => {
        const name = $('wSourceName').value.trim();
        const url = $('wSourceUrl').value.trim();
        if (!name || !url) return;
        sources.push({ name, url });
        $('wSourceName').value = ''; $('wSourceUrl').value = '';
        renderSourcesList();
      };
    }
    if (type === 'announcement') {
      document.querySelectorAll('.rte-btn').forEach((b) => {
        // mousedown (não click) evita perder a seleção de texto antes do comando rodar.
        b.addEventListener('mousedown', (e) => {
          e.preventDefault();
          $(b.dataset.target).focus();
          document.execCommand(b.dataset.cmd, false, b.dataset.color || null);
        });
      });
    }
  }

  $('modalTitle').textContent = isEdit ? 'Editar tela' : 'Criar tela';
  $('modalBody').innerHTML = body();
  wireConfigArea();
  document.querySelectorAll('.tv-type-btn').forEach((b) => {
    b.onclick = () => { type = b.dataset.type; $('modalBody').innerHTML = body(); wireConfigArea();
      document.querySelectorAll('.tv-type-btn').forEach((x) => x.onclick = b.onclick); };
  });

  $('modalFoot').innerHTML = `<button class="btn-ghost" id="wCancel">Cancelar</button><button class="btn-primary" id="wSave">Salvar</button>`;
  $('wCancel').onclick = () => $('modalBack').classList.remove('open');
  $('wSave').onclick = async () => {
    const name = $('wName').value.trim();
    if (!name) return toast('Dê um nome para a tela.', true);
    const config = type === 'weather' ? { city: $('wCity').value.trim() }
      : type === 'news' ? { sources }
      : type === 'announcement' ? { title: $('wTitle').innerHTML.trim(), subtitle: $('wSubtitle').innerHTML.trim() }
      : {};
    if (type === 'weather' && !config.city) return toast('Informe a cidade.', true);
    if (type === 'news' && sources.length === 0) return toast('Adicione ao menos uma fonte RSS.', true);
    if (type === 'announcement' && !$('wTitle').textContent.trim()) return toast('Informe o título do comunicado.', true);

    if (isEdit) {
      await tvApi('/screens/widget/' + existing.id, { method: 'PUT', body: JSON.stringify({ name, config }) });
    } else {
      await tvApi('/screens/widget', { method: 'POST', body: JSON.stringify({ type, name, config }) });
    }
    $('modalBack').classList.remove('open');
    toast('Tela salva.');
    renderTvScreens();
  };
  $('modalBack').classList.add('open');
}

// ---------- Playlists ----------
async function renderTvPlaylists() {
  TV_PLAYLISTS = await tvApi('/playlists');
  $('tvBody').innerHTML = `
    <div class="card" style="margin-bottom:16px;display:flex;gap:10px">
      <input class="inp" id="tvPlaylistName" placeholder="Nome da nova playlist (ex: COMUNICADOS — SETEMBRO)">
      <button class="btn-primary" id="btnCreatePlaylist" style="white-space:nowrap">Criar playlist</button>
    </div>
    <div class="grid cols-3" id="tvPlaylistsGrid"></div>`;

  $('tvPlaylistsGrid').innerHTML = TV_PLAYLISTS.map((p) => `
    <div class="card">
      <h3 style="margin:0">${esc(p.name)}</h3>
      <p style="color:var(--muted);margin:4px 0 12px">${p.itemCount} item(ns)</p>
      <div style="display:flex;gap:8px">
        <button class="btn-primary tv-edit-playlist" data-id="${p.id}" style="flex:1">Editar</button>
        <button class="btn-ghost tv-dup-playlist" data-id="${p.id}">Duplicar</button>
        <button class="btn-mini tv-del-playlist" data-id="${p.id}" style="color:var(--red)">Remover</button>
      </div>
    </div>`).join('') || '<p style="color:var(--muted)">Nenhuma playlist criada ainda.</p>';

  $('btnCreatePlaylist').onclick = async () => {
    const name = $('tvPlaylistName').value.trim();
    if (!name) return;
    const p = await tvApi('/playlists', { method: 'POST', body: JSON.stringify({ name }) });
    openPlaylistEditor(p.id);
  };
  document.querySelectorAll('.tv-edit-playlist').forEach((b) => { b.onclick = () => openPlaylistEditor(b.dataset.id); });
  document.querySelectorAll('.tv-dup-playlist').forEach((b) => {
    b.onclick = async () => { await tvApi('/playlists/' + b.dataset.id + '/duplicate', { method: 'POST' }); renderTvPlaylists(); };
  });
  document.querySelectorAll('.tv-del-playlist').forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmar('Remover esta playlist?'))) return;
      await tvApi('/playlists/' + b.dataset.id, { method: 'DELETE' });
      renderTvPlaylists();
    };
  });
}

async function openPlaylistEditor(id) {
  const [playlist, screens] = await Promise.all([tvApi('/playlists/' + id), tvApi('/screens')]);
  let items = playlist.items.slice();
  let dragIndex = null;

  function itemThumb(it) {
    if (isWidget(it.type)) return `<span style="font-size:18px">${WIDGET_ICON[it.type]}</span>`;
    if (it.type === 'image') return `<img src="${esc(it.url)}" style="width:100%;height:100%;object-fit:cover">`;
    return `<video src="${esc(it.url)}" style="width:100%;height:100%;object-fit:cover" muted></video>`;
  }

  function render() {
    $('tvBody').innerHTML = `
      <button class="btn-ghost" id="btnBackPlaylists" style="margin-bottom:12px">← Voltar para Playlists</button>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="margin:0">${esc(playlist.name)}</h2>
        <div style="display:flex;gap:8px">
          <button class="btn-ghost" id="btnSavePlaylist">Salvar</button>
          <button class="btn-primary" id="btnPublishPlaylist">Publicar na TV</button>
        </div>
      </div>
      <div class="grid cols-3">
        <div class="card">
          <h3>Biblioteca de conteúdos</h3>
          <div style="max-height:420px;overflow:auto">
            ${screens.map((s) => `
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;border-bottom:1px solid #eee;padding:6px 0">
                <span>${isWidget(s.type) ? WIDGET_ICON[s.type] + ' ' : ''}${esc(s.name)}</span>
                <button class="btn-mini tv-add-item" data-id="${s.id}">+ Adicionar</button>
              </div>`).join('')}
          </div>
        </div>
        <div class="card" style="grid-column:span 2">
          <h3>Itens da playlist <span style="font-weight:400;color:var(--muted)">(arraste para reordenar)</span></h3>
          <div id="tvItemsList"></div>
        </div>
      </div>
      <div style="margin-top:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <h3 style="margin:0">Pré-visualização <span style="font-weight:400;color:var(--muted)">— como vai aparecer na TV</span></h3>
          <div style="display:flex;gap:10px;align-items:center">
            <a href="/player?playlistId=${id}" target="_blank">Abrir em tela cheia ↗</a>
            <button class="btn-ghost" id="btnRefreshPreview">Atualizar pré-visualização</button>
          </div>
        </div>
        <div style="background:#000;border-radius:16px;padding:10px;display:inline-block">
          <div style="width:560px;max-width:80vw;aspect-ratio:16/9;border-radius:8px;overflow:hidden">
            <iframe id="tvPreviewFrame" src="/player?playlistId=${id}" style="width:100%;height:100%;border:0"></iframe>
          </div>
        </div>
      </div>`;

    renderItemsList();
    $('btnBackPlaylists').onclick = () => { TV_SUBTAB = 'playlists'; renderTV(); };
    $('btnSavePlaylist').onclick = saveItems;
    $('btnRefreshPreview').onclick = () => { $('tvPreviewFrame').src = '/player?playlistId=' + id; };
    $('btnPublishPlaylist').onclick = openPublishModal;
    document.querySelectorAll('.tv-add-item').forEach((b) => {
      b.onclick = () => {
        const s = screens.find((x) => x.id == b.dataset.id);
        items.push({ screenId: s.id, name: s.name, type: s.type, url: s.url, durationSeconds: 10 });
        renderItemsList();
      };
    });
  }

  function renderItemsList() {
    const box = $('tvItemsList');
    if (items.length === 0) { box.innerHTML = '<p style="color:var(--muted)">Adicione conteúdos da biblioteca ao lado.</p>'; return; }
    box.innerHTML = items.map((it, i) => `
      <div class="tv-item-row" draggable="true" data-i="${i}"
        style="display:flex;align-items:center;gap:10px;border:1px solid #eee;border-radius:8px;padding:8px;margin-bottom:6px;cursor:move;background:#fff">
        <span style="color:var(--muted);width:18px">${i + 1}</span>
        <div style="width:64px;height:40px;background:#eef2f4;border-radius:4px;overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center">${itemThumb(it)}</div>
        <span style="flex:1;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${isWidget(it.type) ? '[' + WIDGET_LABEL[it.type] + '] ' : ''}${esc(it.name)}</span>
        ${it.type !== 'video' ? `<input type="number" min="1" class="inp tv-item-duration" data-i="${i}" value="${it.durationSeconds}" style="width:60px;text-align:center">s`
          : '<span style="font-size:12px;color:var(--muted)">até o fim do vídeo</span>'}
        <button class="btn-mini tv-rm-item" data-i="${i}" style="color:var(--red)">Remover</button>
      </div>`).join('');

    box.querySelectorAll('.tv-item-duration').forEach((inp) => {
      inp.onchange = () => { items[Number(inp.dataset.i)].durationSeconds = Number(inp.value) || 1; };
    });
    box.querySelectorAll('.tv-rm-item').forEach((b) => {
      b.onclick = () => { items.splice(Number(b.dataset.i), 1); renderItemsList(); };
    });
    box.querySelectorAll('.tv-item-row').forEach((row) => {
      row.ondragstart = () => { dragIndex = Number(row.dataset.i); };
      row.ondragover = (e) => e.preventDefault();
      row.ondrop = () => {
        const targetIndex = Number(row.dataset.i);
        if (dragIndex === null || dragIndex === targetIndex) return;
        const [moved] = items.splice(dragIndex, 1);
        items.splice(targetIndex, 0, moved);
        dragIndex = null;
        renderItemsList();
      };
    });
  }

  async function saveItems() {
    await tvApi('/playlists/' + id + '/items', {
      method: 'PUT',
      body: JSON.stringify({ items: items.map((it) => ({ screenId: it.screenId, durationSeconds: it.durationSeconds })) }),
    });
    toast('Playlist salva.');
    $('tvPreviewFrame').src = '/player?playlistId=' + id;
  }

  async function openPublishModal() {
    await saveItems();
    const devices = await tvApi('/devices');
    const selected = new Set();
    $('modalTitle').textContent = 'Publicar "' + playlist.name + '" em:';
    $('modalBody').innerHTML = devices.length
      ? devices.map((d) => `
          <label style="display:flex;gap:8px;align-items:center;font-size:14px;margin-bottom:6px">
            <input type="checkbox" class="tv-pub-check" value="${d.id}"> ${esc(d.name)} <span style="color:var(--muted)">(${esc(d.code)})</span>
          </label>`).join('')
      : '<p style="color:var(--muted)">Nenhuma TV cadastrada ainda.</p>';
    $('modalFoot').innerHTML = `<button class="btn-ghost" id="pubCancel">Cancelar</button><button class="btn-primary" id="pubConfirm">Confirmar publicação</button>`;
    $('modalBack').classList.add('open');
    $('pubCancel').onclick = () => $('modalBack').classList.remove('open');
    document.querySelectorAll('.tv-pub-check').forEach((c) => {
      c.onchange = () => { c.checked ? selected.add(c.value) : selected.delete(c.value); };
    });
    $('pubConfirm').onclick = async () => {
      if (selected.size === 0) return toast('Selecione ao menos uma TV.', true);
      await tvApi('/playlists/' + id + '/publish', { method: 'POST', body: JSON.stringify({ deviceIds: [...selected] }) });
      $('modalBack').classList.remove('open');
      toast('Publicado com sucesso!');
    };
  }

  render();
}
