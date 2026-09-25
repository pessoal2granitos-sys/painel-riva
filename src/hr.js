'use strict';
// Gestão de Pessoas (RH): importação da folha de pagamento e indicadores
// derivados dela (hora extra por departamento, custo da folha, absenteísmo)
// mais o turnover, que já pode ser calculado com o que o sistema já tem
// (admissão/demissão dos colaboradores), sem depender de nenhuma planilha.
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const { normKey, cleanName } = require('./normalize');

// Jornada padrão usada como referência pro cálculo de absenteísmo — é o valor
// que já aparece nos próprios contracheques da empresa (o "220:00" da base
// de cálculo de benefícios). Ajustável no futuro se a empresa usar outra.
const HORAS_JORNADA_MES = 220;

function registerHrRoutes(app, { h, requirePerm, currentUser }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
  const guard = requirePerm('pessoas');

  // Lê a planilha de folha (uma linha por colaborador, uma coluna por rubrica)
  // e devolve o que entendeu, SEM gravar nada — a tela mostra uma prévia e só
  // grava quando a administradora confirmar.
  app.post('/api/hr/payroll/parse', guard, upload.single('file'), h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Envie um arquivo .xlsx ou .xls.' });
    let linhas;
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      linhas = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } catch {
      return res.status(400).json({ error: 'Não consegui ler esse arquivo. Envie uma planilha .xlsx válida.' });
    }

    const employees = await db.all('SELECT id, name FROM employees');
    const byName = new Map(employees.map((e) => [normKey(e.name), e]));

    const pega = (row, ...chaves) => {
      for (const k of Object.keys(row)) {
        if (chaves.includes(normKey(k))) return row[k];
      }
      return undefined;
    };
    const numero = (v) => {
      if (v === undefined || v === '' || v === null) return null;
      const n = typeof v === 'number' ? v : Number(String(v).replace(/\./g, '').replace(',', '.'));
      return isNaN(n) ? null : n;
    };

    const out = [];
    for (const row of linhas) {
      const nome = cleanName(pega(row, 'NOME', 'COLABORADOR', 'FUNCIONARIO') || '');
      if (!nome) continue;
      const emp = byName.get(normKey(nome));
      const salarioBase = numero(pega(row, 'SALARIO BASE', 'SAL BASE', 'SALARIO CONTRATUAL'));
      const salarioLiquido = numero(pega(row, 'SALARIO LIQUIDO', 'LIQUIDO'));
      const he50 = numero(pega(row, 'HORAS EXTRAS 50', 'HORA EXTRA 50', 'HE 50'));
      const he100 = numero(pega(row, 'HORAS EXTRAS 100', 'HORA EXTRA 100', 'HE 100', 'HORAS EXTRAS 110', 'HORA EXTRA 110'));
      const adicionais = numero(pega(row, 'ADICIONAIS', 'INSALUBRIDADE', 'ADICIONAIS INSALUBRIDADE'));
      const descontos = numero(pega(row, 'DESCONTOS'));
      const faltasHoras = numero(pega(row, 'FALTAS HORAS', 'FALTAS (HORAS)', 'FALTAS'));
      const atestadosHoras = numero(pega(row, 'ATESTADOS HORAS', 'ATESTADOS (HORAS)', 'ATESTADOS'));
      const inss = numero(pega(row, 'INSS'));
      const fgts = numero(pega(row, 'FGTS'));
      const custoInformado = numero(pega(row, 'CUSTO TOTAL', 'CUSTO', 'CUSTO TOTAL DO COLABORADOR'));
      const departamento = cleanName(pega(row, 'DEPARTAMENTO', 'SETOR') || '') || null;

      if (salarioBase == null && salarioLiquido == null && custoInformado == null) continue;

      const custoTotal = custoInformado != null ? custoInformado :
        [salarioBase, adicionais, he50, he100, inss, fgts].reduce((a, v) => a + (v || 0), 0) || null;

      out.push({
        nomePlanilha: nome,
        employeeId: emp ? emp.id : null,
        encontrado: !!emp,
        departamento,
        salarioBase, salarioLiquido, he50, he100, adicionais, descontos,
        faltasHoras, atestadosHoras, inss, fgts, custoTotal,
      });
    }

    if (!out.length) {
      return res.status(400).json({
        error: 'Não encontrei linhas válidas. A planilha precisa de pelo menos as colunas "Nome" e "Salário Base" ou "Salário Líquido".',
      });
    }
    res.json({
      linhas: out,
      encontrados: out.filter((l) => l.encontrado).length,
      naoEncontrados: out.filter((l) => !l.encontrado).length,
    });
  }));

  // Grava de fato a folha do mês informado. Substitui qualquer importação
  // anterior do mesmo mês (reimportar corrige em vez de duplicar).
  app.post('/api/hr/payroll/import', guard, h(async (req, res) => {
    const { mesRef, linhas } = req.body;
    if (!/^\d{4}-\d{2}$/.test(mesRef || '')) return res.status(400).json({ error: 'Informe o mês de referência (AAAA-MM).' });
    if (!Array.isArray(linhas) || !linhas.length) return res.status(400).json({ error: 'Nenhuma linha para importar.' });

    await db.run('DELETE FROM hr_payroll WHERE mes_ref = ?', mesRef);
    await db.batch(linhas.map((l) => ([
      `INSERT INTO hr_payroll (employee_id, nome_planilha, departamento, mes_ref, salario_base, salario_liquido,
        horas_extra_50, horas_extra_100, adicionais, descontos, faltas_horas, atestados_horas, inss, fgts, custo_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      l.employeeId || null, cleanName(l.nomePlanilha || ''), l.departamento || null, mesRef,
      l.salarioBase ?? null, l.salarioLiquido ?? null, l.he50 ?? null, l.he100 ?? null,
      l.adicionais ?? null, l.descontos ?? null, l.faltasHoras ?? null, l.atestadosHoras ?? null,
      l.inss ?? null, l.fgts ?? null, l.custoTotal ?? null,
    ])));

    // Departamento informado na folha atualiza o cadastro do colaborador,
    // pra próximas telas (e futuras permissões por departamento) já usarem.
    for (const l of linhas) {
      if (l.employeeId && l.departamento) {
        await db.run('UPDATE employees SET departamento = COALESCE(departamento, ?) WHERE id = ?', l.departamento, l.employeeId);
      }
    }

    res.json({ ok: true, mesRef, total: linhas.length });
  }));

  app.get('/api/hr/payroll/meses', guard, h(async (req, res) => {
    const rows = await db.all('SELECT DISTINCT mes_ref FROM hr_payroll ORDER BY mes_ref DESC');
    res.json({ meses: rows.map((r) => r.mes_ref) });
  }));

  // Turnover mensal: desligamentos no mês / headcount médio do mês. Usa o que
  // já existe no cadastro de colaboradores (admissão/demissão) — não depende
  // de nenhuma planilha de folha ser importada.
  app.get('/api/hr/turnover', guard, h(async (req, res) => {
    const meses = Number(req.query.meses) || 12;
    const employees = await db.all('SELECT admissao, demissao FROM employees');
    const hoje = new Date();
    const serie = [];
    for (let i = meses - 1; i >= 0; i--) {
      const ref = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      const inicioMes = ref.toISOString().slice(0, 10);
      const fimMes = new Date(ref.getFullYear(), ref.getMonth() + 1, 0).toISOString().slice(0, 10);
      const ativosInicio = employees.filter((e) =>
        e.admissao && e.admissao <= inicioMes && (!e.demissao || e.demissao >= inicioMes)).length;
      const ativosFim = employees.filter((e) =>
        e.admissao && e.admissao <= fimMes && (!e.demissao || e.demissao > fimMes)).length;
      const desligados = employees.filter((e) => e.demissao && e.demissao >= inicioMes && e.demissao <= fimMes).length;
      const headcountMedio = (ativosInicio + ativosFim) / 2;
      serie.push({
        mes: inicioMes.slice(0, 7),
        desligados, headcountMedio,
        turnoverPct: headcountMedio > 0 ? Number((desligados / headcountMedio * 100).toFixed(2)) : 0,
      });
    }
    res.json({ serie });
  }));

  // Indicadores da folha importada (hora extra por departamento, custo total
  // e absenteísmo) para um mês específico.
  app.get('/api/hr/payroll/:mesRef', guard, h(async (req, res) => {
    const mesRef = req.params.mesRef;
    const linhas = await db.all('SELECT * FROM hr_payroll WHERE mes_ref = ?', mesRef);
    if (!linhas.length) return res.json({ mesRef, existe: false });

    const porDepto = new Map();
    let custoTotalFolha = 0, faltasHorasTotal = 0, atestadosHorasTotal = 0;
    for (const l of linhas) {
      const depto = l.departamento || 'Sem departamento';
      if (!porDepto.has(depto)) porDepto.set(depto, { departamento: depto, colaboradores: 0, horaExtra: 0, custo: 0 });
      const d = porDepto.get(depto);
      d.colaboradores += 1;
      d.horaExtra += (l.horas_extra_50 || 0) + (l.horas_extra_100 || 0);
      d.custo += l.custo_total || 0;
      custoTotalFolha += l.custo_total || 0;
      faltasHorasTotal += l.faltas_horas || 0;
      atestadosHorasTotal += l.atestados_horas || 0;
    }
    const horasEsperadas = linhas.length * HORAS_JORNADA_MES;
    const absenteismoPct = horasEsperadas > 0
      ? Number(((faltasHorasTotal + atestadosHorasTotal) / horasEsperadas * 100).toFixed(2)) : 0;

    res.json({
      mesRef, existe: true,
      totalColaboradores: linhas.length,
      custoTotalFolha: Number(custoTotalFolha.toFixed(2)),
      absenteismoPct,
      faltasHorasTotal, atestadosHorasTotal,
      porDepartamento: [...porDepto.values()].map((d) => ({ ...d, horaExtra: Number(d.horaExtra.toFixed(2)), custo: Number(d.custo.toFixed(2)) }))
        .sort((a, b) => b.horaExtra - a.horaExtra),
    });
  }));
}

module.exports = { registerHrRoutes };
