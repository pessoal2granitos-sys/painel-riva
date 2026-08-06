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

## Perfis de acesso

| Perfil | O que pode fazer |
|---|---|
| **Administradora** | Tudo: cadastros, exclusões, usuários, licenças, importar/exportar |
| **Supervisor** | Cadastros, lançamentos e gestão de usuários (não mexe em administradores nem exclui registros) |
| **Gestor** | Somente visualiza os painéis, com todos os filtros |
| **Líder** | Visualiza apenas os indicadores da equipe que a administradora atribuir a ele |

Usuários são criados em **Usuários e Acessos**. Para um líder, marque na lista quais
colaboradores compõem a equipe dele.

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
