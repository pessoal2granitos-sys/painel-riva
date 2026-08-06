// Faz login no painel publicado e envia a planilha, para os dados já estarem lá
// no primeiro acesso. Chamado pelo PUBLICAR.ps1.
const fs = require('fs');
const https = require('https');
const { URL } = require('url');

const BASE = process.env.PAINEL_URL;
const EMAIL = process.env.PAINEL_EMAIL;
const SENHA = process.env.PAINEL_SENHA;
const XLSX = process.env.PAINEL_XLSX;

function request(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  const u = new URL(pathname, BASE);
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: u.hostname, path: u.pathname + u.search, method, headers, timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('timeout', () => r.destroy(new Error('tempo esgotado')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function multipart(fields, file) {
  const b = '----painelriva' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="planilha.xlsx"\r\n` +
    'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'));
  parts.push(file);
  parts.push(Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` };
}

(async () => {
  const login = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: SENHA }),
  });
  if (login.status !== 200) {
    console.log('  [!]  Nao consegui entrar no painel (' + login.status + '). Importe pela aba Importar / Exportar.');
    process.exit(1);
  }
  const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  const { body, contentType } = multipart({ clear: '0' }, fs.readFileSync(XLSX));
  const up = await request('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'Content-Length': body.length, Cookie: cookie },
    body,
  });
  if (up.status !== 200) {
    console.log('  [!]  Falha ao importar (' + up.status + '): ' + up.body.toString().slice(0, 200));
    process.exit(1);
  }
  const stats = JSON.parse(up.body.toString()).stats;

  const ds = await request('/api/dataset', { headers: { Cookie: cookie } });
  const j = JSON.parse(ds.body.toString());
  console.log('  [ok] Planilha carregada: ' + j.employees.length + ' colaboradores, ' +
    j.grid.length + ' registros, ' + stats.cargos + ' cargos.');
})().catch(e => {
  console.log('  [!]  ' + e.message);
  process.exit(1);
});
