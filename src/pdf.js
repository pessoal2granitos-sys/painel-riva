'use strict';
// Gerador de PDF mínimo para relatórios em tabela. Escrito à mão para não
// adicionar dependência: usa as fontes padrão do PDF (Helvetica), que cobrem
// os acentos do português via codificação WinAnsi.

const LARGURA = 842;   // A4 paisagem, em pontos
const ALTURA = 595;

// Helvetica: larguras aproximadas por caractere, para quebrar texto na medida.
function larguraTexto(txt, tamanho) {
  let w = 0;
  for (const ch of String(txt)) {
    const c = ch.charCodeAt(0);
    if (c === 32) w += 278;
    else if ('iljI.,:;|!\''.includes(ch)) w += 240;
    else if ('ftr()[]-'.includes(ch)) w += 340;
    else if ('MW@%'.includes(ch)) w += 880;
    else if (ch >= 'A' && ch <= 'Z') w += 690;
    else if (ch >= '0' && ch <= '9') w += 556;
    else w += 545;
  }
  return w * tamanho / 1000;
}

function cortar(txt, tamanho, max) {
  let s = String(txt == null ? '' : txt).replace(/[\r\n]+/g, ' ');
  if (larguraTexto(s, tamanho) <= max) return s;
  while (s.length > 1 && larguraTexto(s + '...', tamanho) > max) s = s.slice(0, -1);
  return s.trimEnd() + '...';
}

// Pontuação tipográfica que existe no WinAnsi, mas em outro código Unicode.
const WINANSI = {
  0x2013: 0x96, 0x2014: 0x97,   // – —
  0x2018: 0x91, 0x2019: 0x92,   // ' '
  0x201C: 0x93, 0x201D: 0x94,   // " "
  0x2022: 0x95, 0x2026: 0x85,   // • …
  0x20AC: 0x80, 0x2122: 0x99,   // € ™
};

// Escapa e converte para WinAnsi, que é o que a fonte padrão do PDF entende.
function pdfTexto(s) {
  const limpo = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ');
  const bytes = [];
  for (const ch of limpo) {
    const c = ch.charCodeAt(0);
    if (WINANSI[c] !== undefined) { bytes.push(WINANSI[c]); continue; }
    if (c === 0x2192) { bytes.push(0x2D, 0x3E); continue; }   // → vira ->
    bytes.push(c <= 0xFF ? c : 0x3F);
  }
  let out = '';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5C) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out;
}

/**
 * Monta um PDF em tabela.
 * @param {object} opts
 *   titulo, subtitulo — cabeçalho de cada página
 *   colunas — [{ nome, largura, campo }]
 *   linhas  — array de objetos
 */
function gerarTabelaPDF({ titulo, subtitulo, colunas, linhas }) {
  const margem = 28;
  const topo = ALTURA - margem;
  const alturaLinha = 15;
  const larguraUtil = LARGURA - margem * 2;

  // normaliza larguras para caberem exatamente na área útil
  const somaPesos = colunas.reduce((s, c) => s + c.largura, 0);
  const cols = colunas.map(c => ({ ...c, px: c.largura / somaPesos * larguraUtil }));

  const paginas = [];
  let atual = null;
  let y = 0;

  const novaPagina = () => {
    atual = [];
    paginas.push(atual);
    y = topo;
    // título
    atual.push('BT /F2 15 Tf 0.08 0.22 0.36 rg ' + margem + ' ' + (y - 12) + ' Td (' + pdfTexto(titulo) + ') Tj ET');
    y -= 30;
    atual.push('BT /F1 9 Tf 0.42 0.48 0.54 rg ' + margem + ' ' + (y - 2) + ' Td (' + pdfTexto(subtitulo) + ') Tj ET');
    y -= 18;
    // faixa do cabeçalho
    atual.push('0.08 0.22 0.36 rg ' + margem + ' ' + (y - alturaLinha + 3) + ' ' + larguraUtil + ' ' + alturaLinha + ' re f');
    let x = margem;
    for (const c of cols) {
      atual.push('BT /F2 8 Tf 1 1 1 rg ' + (x + 4) + ' ' + (y - alturaLinha + 8) + ' Td (' +
        pdfTexto(cortar(c.nome, 8, c.px - 8)) + ') Tj ET');
      x += c.px;
    }
    y -= alturaLinha + 2;
  };

  novaPagina();

  let zebra = false;
  for (const linha of linhas) {
    if (y < margem + alturaLinha) { novaPagina(); zebra = false; }
    if (zebra) {
      atual.push('0.96 0.97 0.98 rg ' + margem + ' ' + (y - alturaLinha + 3) + ' ' + larguraUtil + ' ' + alturaLinha + ' re f');
    }
    zebra = !zebra;
    let x = margem;
    for (const c of cols) {
      const valor = cortar(linha[c.campo], 8, c.px - 8);
      atual.push('BT /F1 8 Tf 0.11 0.17 0.23 rg ' + (x + 4) + ' ' + (y - alturaLinha + 8) + ' Td (' +
        pdfTexto(valor) + ') Tj ET');
      x += c.px;
    }
    y -= alturaLinha;
  }

  // ---- montagem do arquivo ----
  const objetos = [];
  const add = (corpo) => { objetos.push(corpo); return objetos.length; };

  const idFonte1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const idFonte2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const idsPaginas = [];
  const conteudos = [];
  for (const ops of paginas) {
    const fluxo = ops.join('\n');
    const idConteudo = add({ fluxo });
    conteudos.push(idConteudo);
    idsPaginas.push(null);
  }

  const idPaginasRaiz = objetos.length + paginas.length + 1;
  paginas.forEach((_, i) => {
    idsPaginas[i] = add('<< /Type /Page /Parent ' + idPaginasRaiz + ' 0 R ' +
      '/MediaBox [0 0 ' + LARGURA + ' ' + ALTURA + '] ' +
      '/Resources << /Font << /F1 ' + idFonte1 + ' 0 R /F2 ' + idFonte2 + ' 0 R >> >> ' +
      '/Contents ' + conteudos[i] + ' 0 R >>');
  });
  const idRaizPaginas = add('<< /Type /Pages /Kids [' + idsPaginas.map(i => i + ' 0 R').join(' ') +
    '] /Count ' + idsPaginas.length + ' >>');
  const idCatalogo = add('<< /Type /Catalog /Pages ' + idRaizPaginas + ' 0 R >>');

  const partes = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const posicoes = [];
  let offset = partes[0].length;

  objetos.forEach((obj, i) => {
    let corpo;
    if (typeof obj === 'object' && obj.fluxo !== undefined) {
      const dados = Buffer.from(obj.fluxo, 'latin1');
      corpo = Buffer.concat([
        Buffer.from((i + 1) + ' 0 obj\n<< /Length ' + dados.length + ' >>\nstream\n', 'latin1'),
        dados, Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    } else {
      corpo = Buffer.from((i + 1) + ' 0 obj\n' + obj + '\nendobj\n', 'latin1');
    }
    posicoes.push(offset);
    partes.push(corpo);
    offset += corpo.length;
  });

  const inicioXref = offset;
  let xref = 'xref\n0 ' + (objetos.length + 1) + '\n0000000000 65535 f \n';
  for (const p of posicoes) xref += String(p).padStart(10, '0') + ' 00000 n \n';
  xref += 'trailer\n<< /Size ' + (objetos.length + 1) + ' /Root ' + idCatalogo + ' 0 R >>\n' +
          'startxref\n' + inicioXref + '\n%%EOF\n';
  partes.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(partes);
}

module.exports = { gerarTabelaPDF };
