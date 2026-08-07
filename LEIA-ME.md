# Painel de Treinamentos Normativos — Riva Stones

Plataforma web que substitui o controle em planilha (`Balanço Normativos.xlsx`),
com cadastro de colaboradores, lançamento de treinamentos, painéis de indicadores
por perfil de acesso e importação/exportação da planilha no formato original.

## Como iniciar

Dê um duplo clique em **`Iniciar Painel.bat`**. O navegador abre automaticamente em
`http://localhost:3000`. Mantenha a janela preta aberta enquanto usar o sistema —
ela é o servidor. Para encerrar, feche a janela.

## Acesso inicial

| Campo | Valor |
|---|---|
| E-mail | departamentopessoalriva@gmail.com |
| Perfil | Administradora |

A senha é a que foi definida na primeira execução. Troque quando quiser pelo botão
**Senha** no canto superior direito.

> Se o arquivo `data/painel.db` for apagado, o sistema recria o banco do zero e
> cria a administradora com a senha padrão `trocar123` — troque-a imediatamente.
> Para definir outra senha inicial, inicie com as variáveis `ADMIN_EMAIL` e
> `ADMIN_PASSWORD`.

## Painel de Administração

A aba **⚙ Administração** reúne tudo que configura o sistema, em nove seções:

| Seção | Para quê |
|---|---|
| **Resumo** | Números do cadastro e atalhos para as tarefas do dia a dia |
| **Colaboradores** | Incluir, editar, registrar demissão |
| **Lançamentos** | Registrar treinamentos realizados |
| **Empresas** | Razão social, nome curto e ordem de exibição |
| **Cargos e Trilhas** | Quais NRs são obrigatórias em cada cargo |
| **Treinamentos** | Matriz de carga horária, validade e custo |
| **Perfis de Acesso** | Criar perfis e definir o que cada um enxerga |
| **Usuários** | Criar logins e vincular ao perfil |
| **Importar / Exportar** | Carregar e baixar a planilha |

## Perfis de acesso

O perfil define **quais painéis de indicadores** o usuário vê e **quais ações** pode
executar. Quatro perfis vêm prontos e podem ser ajustados; você cria quantos quiser.

| Perfil | Alcance | O que faz |
|---|---|---|
| **Administradora** | Todos | Controle total, incluindo perfis e exclusões |
| **Supervisor** | Todos | Configura o sistema e gerencia usuários; não exclui nem cria perfis |
| **Gestor** | Todos | Visualiza os painéis e exporta relatórios |
| **Líder** | Só a equipe | Vê apenas os indicadores da equipe atribuída a ele |

Ao criar um perfil você marca, item a item, os cinco painéis e as oito ações
(lançar, cadastrar, configurar, gerenciar usuários, gerenciar perfis, importar,
exportar, excluir). O **alcance** decide se a pessoa vê todos os colaboradores ou
somente a equipe que você marcar para ela na tela de Usuários.

Duas travas protegem o sistema:

- Ninguém concede um perfil com mais permissões do que ele próprio tem — um
  supervisor não consegue criar um usuário com perfil de administradora.
- O perfil da administradora sempre mantém acesso total, para o sistema nunca
  ficar sem quem o administre.

## As abas do painel

- **Visão Geral** — aderência, pendentes, vencidos, horas a treinar, distribuição por
  situação, aderência por empresa, faixas de vencimento, treinamentos mais críticos e
  ranking de colaboradores com pendência.
- **Vencimentos** — o que já venceu e o que vence em 30/60/90 dias, curva de
  vencimentos por mês (18 meses), turmas a programar e agenda detalhada ordenável.
- **Cargos e Empresas** — quem está 100% em dia, cargos com menor aderência,
  não conformidades por cargo e matriz empresa × cargo × situação.
- **Carga Horária e Custo** — horas de formação e reciclagem necessárias e custo
  estimado (preencha os custos em Cadastros → Treinamentos).
- **Qualidade dos Dados** — inconsistências que precisam de atenção: colaboradores
  sem cargo, cargos sem trilha, lançamentos sem vencimento, etc.

## Conceitos importantes

**Trilha por cargo** — é a lista de NRs obrigatórias de cada cargo. É ela que gera os
"pendentes": todo treinamento da trilha sem lançamento aparece como PENDENTE.
Cargos com nível (`FIOLISTA III`) herdam automaticamente a trilha do cargo-base
(`FIOLISTA`); a tela de Cargos mostra de quem cada um herda e permite alterar.

**Vencimento automático** — ao lançar um treinamento, se você deixar o vencimento em
branco, o sistema calcula pela validade em meses da Matriz de C.H.

**Situação** — `VÁLIDO` (vencimento no futuro), `VENCIDO` (vencimento passou),
`PENDENTE` (exigido pela trilha, nunca realizado).

**Desligamento** — registre a data de demissão em Cadastros → Colaboradores → Editar.
O colaborador sai dos indicadores mas o histórico é preservado. Evite excluir.

## Importar e exportar

- **Exportar** gera um `.xlsx` no mesmo formato da sua planilha, com as abas
  `Base de Dados`, `Matriz de C.H.` e `Trilha por Cargo`, na posição de hoje.
- **Importar** aceita um arquivo nesse mesmo formato. Registros novos são criados e
  os existentes atualizados. A opção *Substituir todos os lançamentos* apaga os
  lançamentos atuais antes de importar — use com cuidado.

## Publicar na internet

Para os gestores acessarem de qualquer lugar, veja **[DEPLOY.md](DEPLOY.md)** —
o passo a passo usa Turso, Vercel e GitHub, todos em plano gratuito permanente.

## Backup

Rodando na sua máquina, os dados ficam em **`data/painel.db`** — copie o arquivo com
o servidor fechado. Publicado, os dados ficam no Turso; o backup é baixar o `.xlsx`
pela aba *Importar / Exportar*, que abre no Excel normalmente.

## Estrutura técnica

```
painel-riva/
├── server.js            API e autenticação (Express + cookie de sessão assinado)
├── src/
│   ├── db.js            acesso ao banco: arquivo local ou Turso
│   ├── normalize.js     normalização de nomes, datas e cargos
│   ├── importer.js      leitura da planilha e vínculo de trilhas
│   ├── dataset.js       cálculo de situação, dias e horas
│   └── exporter.js      geração da planilha
├── public/              interface (HTML, CSS, JS, Chart.js)
├── api/index.js         ponto de entrada na Vercel
├── vercel.json          configuração da Vercel
├── Dockerfile           para hospedagens que usam contêiner
└── data/painel.db       banco local (não usado quando há Turso)
```

O banco é SQLite nos dois cenários — local em arquivo, publicado no Turso — então o
comportamento é idêntico.
