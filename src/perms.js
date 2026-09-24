'use strict';
// Permissões de acesso. Cada perfil guarda um conjunto destas chaves; o painel e
// a API consultam as mesmas definições, então não há como a tela liberar algo que
// o servidor não permita.

// Painéis de indicadores que um perfil pode enxergar.
const PAINEIS = [
  { chave: 'visao',        nome: 'Visão Geral',            desc: 'Aderência, pendentes, vencidos e ranking de colaboradores' },
  { chave: 'vencimentos',  nome: 'Vencimentos',            desc: 'O que vence em 30/60/90 dias e a agenda detalhada' },
  { chave: 'pendencias',   nome: 'Pendências e Atenção',   desc: 'Lista de tudo que precisa de ação, com exportação em Excel' },
  { chave: 'cargos',       nome: 'Cargos e Empresas',      desc: 'Aderência por cargo e matriz empresa × cargo' },
  { chave: 'custo',        nome: 'Carga Horária e Custo',  desc: 'Horas e custo estimado para regularizar' },
  { chave: 'realizados',   nome: 'Treinamentos Realizados', desc: 'Quem foi treinado em cada mês, com horas e turmas' },
  { chave: 'qualidade',    nome: 'Qualidade dos Dados',    desc: 'Inconsistências e lacunas de cadastro' },
  { chave: 'avisos',       nome: 'Avisos',                 desc: 'Comunicados publicados pela administração' },
];

// Ações administrativas.
const ACOES = [
  { chave: 'lancamentos',   nome: 'Lançar treinamentos',   desc: 'Registrar, editar e excluir lançamentos' },
  { chave: 'colaboradores', nome: 'Cadastrar colaboradores', desc: 'Incluir e editar pessoas, admissão e demissão' },
  { chave: 'config',        nome: 'Configurar o sistema',  desc: 'Empresas, cargos, trilhas e matriz de treinamentos' },
  { chave: 'usuarios',      nome: 'Gerenciar usuários',    desc: 'Criar logins, trocar senhas e bloquear acessos' },
  { chave: 'perfis',        nome: 'Gerenciar perfis',      desc: 'Criar perfis e definir o que cada um enxerga' },
  { chave: 'importar',      nome: 'Importar planilha',     desc: 'Carregar dados a partir do arquivo Excel' },
  { chave: 'exportar',      nome: 'Exportar planilha',     desc: 'Baixar o relatório em Excel' },
  { chave: 'excluir',       nome: 'Excluir definitivamente', desc: 'Apagar colaboradores, empresas, cargos e treinamentos' },
  { chave: 'publicar_avisos', nome: 'Publicar avisos',     desc: 'Criar, editar e retirar os comunicados aos gestores' },
  { chave: 'tv',              nome: 'TV Corporativa',      desc: 'Cadastrar TVs, enviar conteúdos, montar playlists e publicar' },
];

// Perfil usado pelo acesso sem login. É um perfil de verdade, gravado no banco e
// editável pela administradora — o que está aqui é apenas o estado inicial.
const GESTOR_PUBLICO = {
  nome: 'Gestor (sem login)',
  descricao: 'Quem entra pelo botão "Acesso do Gestor", sem senha',
  inicial: ['visao', 'vencimentos', 'realizados', 'cargos', 'custo', 'avisos', 'exportar'],
};

const TODAS = [...PAINEIS, ...ACOES].map(p => p.chave);

// Perfis criados automaticamente na primeira execução. Podem ser editados, mas
// não excluídos, e o de administradora sempre mantém acesso total.
const PADRAO = [
  {
    name: 'Administradora', scope: 'all', is_system: 1,
    description: 'Controle total do sistema, incluindo perfis e exclusões',
    permissions: Object.fromEntries(TODAS.map(k => [k, true])),
  },
  {
    name: 'Supervisor', scope: 'all', is_system: 1,
    description: 'Configura o sistema e gerencia usuários, sem excluir registros nem criar perfis',
    permissions: Object.fromEntries(TODAS.map(k => [k, !['perfis', 'excluir'].includes(k)])),
  },
  {
    name: 'Gestor', scope: 'all', is_system: 1,
    description: 'Visualiza todos os painéis de indicadores e exporta relatórios',
    permissions: Object.fromEntries(TODAS.map(k => [k, PAINEIS.some(p => p.chave === k) || k === 'exportar'])),
  },
  {
    name: 'Líder', scope: 'team', is_system: 1,
    description: 'Enxerga apenas os indicadores da própria equipe',
    permissions: Object.fromEntries(TODAS.map(k => [k, ['visao', 'vencimentos', 'pendencias', 'cargos', 'exportar'].includes(k)])),
  },
];

// Perfil equivalente para usuários criados antes dos perfis existirem.
const POR_PAPEL = { admin: 'Administradora', supervisor: 'Supervisor', gestor: 'Gestor', lider: 'Líder' };

function normalizar(permissoes) {
  const obj = typeof permissoes === 'string' ? JSON.parse(permissoes || '{}') : (permissoes || {});
  return Object.fromEntries(TODAS.map(k => [k, obj[k] === true]));
}

// Estado inicial do perfil do gestor, na primeira vez que o sistema sobe.
function permsGestorPublico() {
  return Object.fromEntries(TODAS.map(k => [k, GESTOR_PUBLICO.inicial.includes(k)]));
}

// Ações que nunca fazem sentido para quem entra sem se identificar, por mais que
// o perfil seja editado: alterar dados, gerenciar contas ou apagar registros.
const NEGADAS_SEM_LOGIN = ['lancamentos', 'colaboradores', 'config', 'usuarios',
                           'perfis', 'importar', 'excluir', 'publicar_avisos', 'tv'];

module.exports = { PAINEIS, ACOES, TODAS, PADRAO, POR_PAPEL, GESTOR_PUBLICO,
                   permsGestorPublico, NEGADAS_SEM_LOGIN, normalizar };
