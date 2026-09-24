'use strict';
// TV Corporativa: telas (imagem/vídeo/clima/notícias/relógio), TVs cadastradas,
// playlists e publicação. Segue o mesmo padrão do resto do painel: rotas
// protegidas por requirePerm('tv'), e duas rotas públicas (sem login) para o
// player que roda no TV Box consultar sua programação.
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const db = require('./db');

const WIDGET_TYPES = ['weather', 'news', 'clock'];
const MEDIA_TYPES = ['image', 'video'];
const CACHE_MS = 15 * 60 * 1000;

// Em produção (Vercel) os arquivos vão para o Vercel Blob, porque o disco da
// função serverless não é persistente. Em desenvolvimento local, sem o token
// configurado, caem numa pasta local servida como estático — mesmo
// comportamento dual que src/db.js já usa para o banco.
const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;
const LOCAL_UPLOADS_DIR = path.join(__dirname, '..', 'public', 'tv-uploads');

function saveFile(file) {
  if (USE_BLOB) {
    const { put } = require('@vercel/blob');
    const ext = path.extname(file.originalname).toLowerCase();
    const key = 'tv/' + Date.now() + '_' + Math.round(Math.random() * 1e6) + ext;
    return put(key, file.buffer, { access: 'public', contentType: file.mimetype })
      .then((blob) => blob.url);
  }
  if (!fs.existsSync(LOCAL_UPLOADS_DIR)) fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
  const ext = path.extname(file.originalname).toLowerCase();
  const filename = Date.now() + '_' + Math.round(Math.random() * 1e6) + ext;
  fs.writeFileSync(path.join(LOCAL_UPLOADS_DIR, filename), file.buffer);
  return Promise.resolve('/tv-uploads/' + filename);
}

function weatherDescription(code) {
  if (code === 0) return 'Céu limpo';
  if ([1, 2, 3].includes(code)) return 'Parcialmente nublado';
  if ([45, 48].includes(code)) return 'Neblina';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return 'Chuva';
  if ([71, 73, 75, 85, 86].includes(code)) return 'Neve';
  if ([95, 96, 99].includes(code)) return 'Tempestade';
  return '';
}

async function refreshWeather(screen) {
  const config = JSON.parse(screen.config || '{}');
  if (!config.city) return { error: 'Cidade não configurada.' };
  const geoRes = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=pt&name=' + encodeURIComponent(config.city));
  const geo = await geoRes.json();
  const place = geo.results && geo.results[0];
  if (!place) return { error: 'Cidade não encontrada.' };
  const forecastRes = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + place.latitude + '&longitude=' + place.longitude + '&current_weather=true');
  const forecast = await forecastRes.json();
  const cw = forecast.current_weather || {};
  return {
    city: place.name,
    temperatureC: cw.temperature,
    windKmh: cw.windspeed,
    weatherCode: cw.weathercode,
    description: weatherDescription(cw.weathercode),
  };
}

async function refreshNews(screen) {
  const Parser = require('rss-parser');
  const parser = new Parser({ timeout: 8000 });
  const config = JSON.parse(screen.config || '{}');
  const sources = config.sources || [];
  const allItems = [];
  for (const source of sources) {
    try {
      const feed = await parser.parseURL(source.url);
      (feed.items || []).slice(0, 5).forEach((item) => {
        allItems.push({ source: source.name, title: item.title, pubDate: item.pubDate || null });
      });
    } catch (e) {
      // Fonte indisponível: ignora e segue com as demais.
    }
  }
  allItems.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return { items: allItems.slice(0, 15) };
}

async function getLiveData(screen) {
  const cached = await db.get('SELECT * FROM tv_screen_cache WHERE screen_id = ?', screen.id);
  const fresh = cached && (Date.now() - new Date(cached.updated_at + 'Z').getTime()) < CACHE_MS;
  if (fresh) return JSON.parse(cached.data);

  let data;
  try {
    data = screen.type === 'weather' ? await refreshWeather(screen) : await refreshNews(screen);
  } catch (e) {
    data = cached ? JSON.parse(cached.data) : { error: 'Não foi possível atualizar agora.' };
  }
  await db.run(
    `INSERT INTO tv_screen_cache (screen_id, data, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(screen_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    screen.id, JSON.stringify(data)
  );
  return data;
}

function serializeScreen(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.blob_url || null,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    config: row.config ? JSON.parse(row.config) : null,
    createdAt: row.created_at,
  };
}

async function getPlaylistDetail(id) {
  const playlist = await db.get('SELECT * FROM tv_playlists WHERE id = ?', id);
  if (!playlist) return null;
  const items = await db.all(
    `SELECT tv_playlist_items.id, tv_playlist_items.order_index, tv_playlist_items.duration_seconds,
            tv_screens.id AS screen_id, tv_screens.name, tv_screens.type, tv_screens.blob_url, tv_screens.size_bytes
     FROM tv_playlist_items
     JOIN tv_screens ON tv_screens.id = tv_playlist_items.screen_id
     WHERE tv_playlist_items.playlist_id = ?
     ORDER BY tv_playlist_items.order_index ASC`, id
  );
  return {
    id: playlist.id,
    name: playlist.name,
    version: playlist.version,
    items: items.map((it) => ({
      id: it.id,
      screenId: it.screen_id,
      name: it.name,
      type: it.type,
      url: it.blob_url || null,
      sizeBytes: it.size_bytes,
      durationSeconds: it.duration_seconds,
    })),
  };
}

const ONLINE_MS = 2 * 60 * 1000;

function registerTvRoutes(app, { h, requirePerm }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });
  const guard = requirePerm('tv');

  if (!USE_BLOB) app.use('/tv-uploads', require('express').static(LOCAL_UPLOADS_DIR));

  // ---- Biblioteca de telas ----
  app.get('/api/tv/screens', guard, h(async (req, res) => {
    const rows = await db.all('SELECT * FROM tv_screens ORDER BY created_at DESC');
    res.json(rows.map(serializeScreen));
  }));

  app.post('/api/tv/screens', guard, upload.single('file'), h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const type = ['.jpg', '.jpeg', '.png'].includes(ext) ? 'image'
      : ext === '.mp4' ? 'video' : null;
    if (!type) return res.status(400).json({ error: 'Use JPG, PNG ou MP4.' });

    const url = await saveFile(req.file);
    const r = await db.run(
      'INSERT INTO tv_screens (name, type, blob_url, mime, size_bytes) VALUES (?, ?, ?, ?, ?)',
      req.file.originalname, type, url, req.file.mimetype, req.file.size
    );
    const row = await db.get('SELECT * FROM tv_screens WHERE id = ?', r.lastInsertRowid);
    res.status(201).json(serializeScreen(row));
  }));

  app.post('/api/tv/screens/widget', guard, h(async (req, res) => {
    const { type, name, config } = req.body;
    if (!WIDGET_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de tela inválido.' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Dê um nome para a tela.' });
    const r = await db.run('INSERT INTO tv_screens (name, type, config) VALUES (?, ?, ?)',
      name.trim(), type, JSON.stringify(config || {}));
    const row = await db.get('SELECT * FROM tv_screens WHERE id = ?', r.lastInsertRowid);
    res.status(201).json(serializeScreen(row));
  }));

  app.put('/api/tv/screens/widget/:id', guard, h(async (req, res) => {
    const existing = await db.get('SELECT * FROM tv_screens WHERE id = ?', req.params.id);
    if (!existing || !WIDGET_TYPES.includes(existing.type)) return res.status(404).json({ error: 'Tela não encontrada.' });
    const { name, config } = req.body;
    await db.run('UPDATE tv_screens SET name = ?, config = ? WHERE id = ?',
      (name && name.trim()) || existing.name, JSON.stringify(config || {}), req.params.id);
    await db.run('DELETE FROM tv_screen_cache WHERE screen_id = ?', req.params.id);
    const row = await db.get('SELECT * FROM tv_screens WHERE id = ?', req.params.id);
    res.json(serializeScreen(row));
  }));

  app.delete('/api/tv/screens/:id', guard, h(async (req, res) => {
    const existing = await db.get('SELECT * FROM tv_screens WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Tela não encontrada.' });
    const { c } = await db.get('SELECT COUNT(*) c FROM tv_playlist_items WHERE screen_id = ?', req.params.id);
    if (c > 0) return res.status(409).json({ error: 'Essa tela está em uso em uma ou mais playlists.' });
    await db.run('DELETE FROM tv_screens WHERE id = ?', req.params.id);
    res.json({ ok: true });
  }));

  // ---- TVs ----
  app.get('/api/tv/devices', guard, h(async (req, res) => {
    const rows = await db.all(
      `SELECT tv_devices.*, tv_playlists.name AS playlist_name
       FROM tv_devices LEFT JOIN tv_playlists ON tv_playlists.id = tv_devices.current_playlist_id
       ORDER BY tv_devices.created_at DESC`);
    res.json(rows.map((row) => {
      const lastSeenMs = row.last_seen_at ? new Date(row.last_seen_at + 'Z').getTime() : null;
      return {
        id: row.id, name: row.name, code: row.code, location: row.location, description: row.description,
        lastSeenAt: row.last_seen_at,
        online: lastSeenMs !== null && Date.now() - lastSeenMs <= ONLINE_MS,
        currentPlaylist: row.playlist_name ? { id: row.current_playlist_id, name: row.playlist_name } : null,
      };
    }));
  }));

  app.post('/api/tv/devices', guard, h(async (req, res) => {
    const { name, code, location, description } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'Nome e código são obrigatórios.' });
    try {
      const r = await db.run('INSERT INTO tv_devices (name, code, location, description) VALUES (?, ?, ?, ?)',
        name.trim(), code.trim().toUpperCase(), location || null, description || null);
      res.status(201).json({ id: r.lastInsertRowid });
    } catch (e) {
      res.status(409).json({ error: 'Já existe uma TV com esse código.' });
    }
  }));

  app.put('/api/tv/devices/:id', guard, h(async (req, res) => {
    const existing = await db.get('SELECT * FROM tv_devices WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'TV não encontrada.' });
    const { name, code, location, description } = req.body;
    try {
      await db.run('UPDATE tv_devices SET name = ?, code = ?, location = ?, description = ? WHERE id = ?',
        (name && name.trim()) || existing.name, code ? code.trim().toUpperCase() : existing.code,
        location != null ? location : existing.location, description != null ? description : existing.description,
        req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(409).json({ error: 'Já existe uma TV com esse código.' });
    }
  }));

  app.delete('/api/tv/devices/:id', guard, h(async (req, res) => {
    await db.run('DELETE FROM tv_devices WHERE id = ?', req.params.id);
    res.json({ ok: true });
  }));

  // ---- Playlists ----
  app.get('/api/tv/playlists', guard, h(async (req, res) => {
    const rows = await db.all(
      `SELECT tv_playlists.*, COUNT(tv_playlist_items.id) AS item_count
       FROM tv_playlists LEFT JOIN tv_playlist_items ON tv_playlist_items.playlist_id = tv_playlists.id
       GROUP BY tv_playlists.id ORDER BY tv_playlists.updated_at DESC`);
    res.json(rows.map((r) => ({ id: r.id, name: r.name, version: r.version, itemCount: r.item_count, updatedAt: r.updated_at })));
  }));

  app.post('/api/tv/playlists', guard, h(async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome da playlist é obrigatório.' });
    const r = await db.run('INSERT INTO tv_playlists (name) VALUES (?)', name.trim());
    res.status(201).json(await getPlaylistDetail(r.lastInsertRowid));
  }));

  app.get('/api/tv/playlists/:id', guard, h(async (req, res) => {
    const detail = await getPlaylistDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Playlist não encontrada.' });
    res.json(detail);
  }));

  app.put('/api/tv/playlists/:id', guard, h(async (req, res) => {
    const existing = await db.get('SELECT * FROM tv_playlists WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Playlist não encontrada.' });
    await db.run("UPDATE tv_playlists SET name = ?, updated_at = datetime('now') WHERE id = ?",
      (req.body.name && req.body.name.trim()) || existing.name, req.params.id);
    res.json(await getPlaylistDetail(req.params.id));
  }));

  app.put('/api/tv/playlists/:id/items', guard, h(async (req, res) => {
    const { items } = req.body;
    const existing = await db.get('SELECT * FROM tv_playlists WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Playlist não encontrada.' });
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Lista de itens inválida.' });

    const statements = [['DELETE FROM tv_playlist_items WHERE playlist_id = ?', req.params.id]];
    items.forEach((item, index) => {
      statements.push([
        'INSERT INTO tv_playlist_items (playlist_id, screen_id, order_index, duration_seconds) VALUES (?, ?, ?, ?)',
        req.params.id, item.screenId, index, item.durationSeconds || 10,
      ]);
    });
    statements.push(["UPDATE tv_playlists SET version = version + 1, updated_at = datetime('now') WHERE id = ?", req.params.id]);
    await db.batch(statements);
    res.json(await getPlaylistDetail(req.params.id));
  }));

  app.post('/api/tv/playlists/:id/duplicate', guard, h(async (req, res) => {
    const original = await getPlaylistDetail(req.params.id);
    if (!original) return res.status(404).json({ error: 'Playlist não encontrada.' });
    const r = await db.run('INSERT INTO tv_playlists (name) VALUES (?)', original.name + ' (cópia)');
    const statements = original.items.map((item, index) => [
      'INSERT INTO tv_playlist_items (playlist_id, screen_id, order_index, duration_seconds) VALUES (?, ?, ?, ?)',
      r.lastInsertRowid, item.screenId, index, item.durationSeconds,
    ]);
    if (statements.length) await db.batch(statements);
    res.status(201).json(await getPlaylistDetail(r.lastInsertRowid));
  }));

  app.delete('/api/tv/playlists/:id', guard, h(async (req, res) => {
    await db.run('DELETE FROM tv_playlists WHERE id = ?', req.params.id);
    res.json({ ok: true });
  }));

  app.get('/api/tv/playlists/:id/preview', guard, h(async (req, res) => {
    const detail = await getPlaylistDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Playlist não encontrada.' });
    res.json({
      version: detail.version,
      items: detail.items.map((it) => ({
        contentId: it.screenId, url: it.url, type: it.type, durationSeconds: it.durationSeconds,
      })),
    });
  }));

  app.post('/api/tv/playlists/:id/publish', guard, h(async (req, res) => {
    const { deviceIds } = req.body;
    const playlist = await db.get('SELECT * FROM tv_playlists WHERE id = ?', req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist não encontrada.' });
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return res.status(400).json({ error: 'Selecione ao menos uma TV.' });

    const statements = [];
    deviceIds.forEach((id) => {
      statements.push(['UPDATE tv_devices SET current_playlist_id = ? WHERE id = ?', playlist.id, id]);
      statements.push(['INSERT INTO tv_publications (device_id, playlist_id) VALUES (?, ?)', id, playlist.id]);
    });
    await db.batch(statements);
    res.json({ ok: true });
  }));

  // ---- Dashboard ----
  app.get('/api/tv/dashboard', guard, h(async (req, res) => {
    const devices = await db.all('SELECT * FROM tv_devices');
    const now = Date.now();
    const online = devices.filter((d) => d.last_seen_at && now - new Date(d.last_seen_at + 'Z').getTime() <= ONLINE_MS);
    const lastSync = devices.reduce((max, d) => (d.last_seen_at && (!max || d.last_seen_at > max) ? d.last_seen_at : max), null);
    const currentPlaylists = await db.all(
      `SELECT DISTINCT tv_playlists.id, tv_playlists.name
       FROM tv_devices JOIN tv_playlists ON tv_playlists.id = tv_devices.current_playlist_id`);
    res.json({
      totalDevices: devices.length,
      onlineDevices: online.length,
      offlineDevices: devices.length - online.length,
      lastSync,
      currentPlaylists,
    });
  }));

  // ---- Player (público, sem login — igual /login) ----
  app.get('/api/tv/device/:code/playlist', h(async (req, res) => {
    const tv = await db.get('SELECT * FROM tv_devices WHERE code = ?', String(req.params.code).toUpperCase());
    if (!tv) return res.status(404).json({ error: 'TV não cadastrada.' });
    await db.run("UPDATE tv_devices SET last_seen_at = datetime('now') WHERE id = ?", tv.id);
    if (!tv.current_playlist_id) return res.json({ playlist: null });

    const playlist = await db.get('SELECT * FROM tv_playlists WHERE id = ?', tv.current_playlist_id);
    const items = await db.all(
      `SELECT tv_screens.id AS screen_id, tv_screens.blob_url, tv_screens.type, tv_playlist_items.duration_seconds
       FROM tv_playlist_items JOIN tv_screens ON tv_screens.id = tv_playlist_items.screen_id
       WHERE tv_playlist_items.playlist_id = ? ORDER BY tv_playlist_items.order_index ASC`, playlist.id);

    res.json({
      playlist: {
        id: playlist.id, version: playlist.version,
        items: items.map((it) => ({ contentId: it.screen_id, url: it.blob_url || null, type: it.type, durationSeconds: it.duration_seconds })),
      },
    });
  }));

  app.get('/api/tv/device/widget-data/:screenId', h(async (req, res) => {
    const screen = await db.get('SELECT * FROM tv_screens WHERE id = ?', req.params.screenId);
    if (!screen) return res.status(404).json({ error: 'Tela não encontrada.' });
    const data = await getLiveData(screen);
    res.json({ type: screen.type, data });
  }));
}

module.exports = { registerTvRoutes };
