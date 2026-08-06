# Publicar o painel na internet — sem custo

Os gestores acessam de qualquer lugar, por um endereço com HTTPS, cada um com seu
login. Tudo em planos gratuitos permanentes, sem cartão de crédito.

| Serviço | Papel | Plano |
|---|---|---|
| **Turso** | Banco de dados (SQLite gerenciado) | Gratuito — 9 GB, não expira |
| **Vercel** | Hospeda o site | Gratuito (Hobby) |
| **GitHub** | Guarda o código | Gratuito |

> **Por que o banco mudou de lugar:** nenhuma hospedagem gratuita mantém arquivos
> gravados em disco — tudo que o site escreve é apagado quando ele reinicia. Por isso
> o banco saiu do arquivo local e foi para o Turso, que continua sendo SQLite, só que
> hospedado. A aplicação foi adaptada e **revalidada contra a sua planilha**: mesmos
> 151 colaboradores, 1.017 registros e, em Mineração Vista Linda, os mesmos 261
> válidos, 100 pendentes e 42 vencidos.

---

## Etapa 1 — Criar o banco no Turso

1. Acesse <https://turso.tech> e crie a conta (dá para entrar com o GitHub).
2. Crie um banco (**Create Database**), nome `painel-riva`, região mais próxima
   do Brasil (`São Paulo` ou `Virginia`).
3. Na página do banco, copie os dois valores:
   - **Database URL** — começa com `libsql://`
   - **Token** — em *Generate Token*, copie o texto longo

Guarde os dois: são o `TURSO_DATABASE_URL` e o `TURSO_AUTH_TOKEN` da Etapa 3.

---

## Etapa 2 — Subir o código para o GitHub

1. Crie a conta em <https://github.com> se não tiver.
2. **New repository** → nome `painel-riva` → marque **Private** →
   não marque nenhuma opção extra.
3. Copie o endereço que aparece e rode no PowerShell, trocando `SEU-USUARIO`:

```
cd "D:\Users\ana.claudia\Desktop\Arquitetura - Painel de treinamentos\painel-riva"
git remote add origin https://github.com/SEU-USUARIO/painel-riva.git
git push -u origin main
```

> **O que sobe:** só o código. A pasta `data/` e os arquivos `.xlsx` estão bloqueados
> pelo `.gitignore`. Verifiquei: nenhum nome de colaborador e nenhuma senha estão nos
> arquivos versionados.

---

## Etapa 3 — Publicar na Vercel

1. Acesse <https://vercel.com>, entre com o GitHub.
2. **Add New → Project** → escolha `painel-riva` → **Import**.
3. Antes de clicar em Deploy, abra **Environment Variables** e cadastre:

| Nome | Valor |
|---|---|
| `TURSO_DATABASE_URL` | o endereço `libsql://...` da Etapa 1 |
| `TURSO_AUTH_TOKEN` | o token da Etapa 1 |
| `SESSION_SECRET` | uma frase longa e aleatória, inventada por você |
| `ADMIN_EMAIL` | `departamentopessoalriva@gmail.com` |
| `ADMIN_PASSWORD` | **uma senha nova**, que você ainda não usou |

4. **Deploy.** Em um ou dois minutos sai o endereço, algo como
   `https://painel-riva.vercel.app`.

> Se esquecer alguma variável, o site sobe mas não conecta no banco. Basta cadastrar
> em *Settings → Environment Variables* e usar *Redeploy*.

---

## Etapa 4 — Carregar os dados e liberar os acessos

1. Acesse o endereço e entre com o `ADMIN_EMAIL` e a senha nova.
   O banco começa vazio — é o esperado.
2. **Importar / Exportar → Importar planilha** → envie o
   `Balanço Normativos Att 05_08_26.xlsx`. Leva menos de um segundo.
3. **Usuários e Acessos** → crie um login por gestor:
   - **Gestor** — vê todos os painéis, não altera nada
   - **Líder** — vê apenas a equipe que você marcar
   - **Supervisor** — configura o sistema junto com você
4. Envie a cada um o endereço e a senha, pedindo que troquem no botão **Senha**.

---

## Depois de publicado

**Uma senha por pessoa.** Nunca um login compartilhado — sem isso não dá para tirar
o acesso de quem sai da empresa sem trocar a senha de todo mundo.

**Backup.** Uma vez por semana, entre em *Importar / Exportar* e baixe o `.xlsx`.
É o backup completo e abre no Excel normalmente.

**Limites do plano gratuito.** O Turso gratuito oferece 9 GB e 1 bilhão de leituras
por mês; este painel usa uma fração mínima disso. A Vercel Hobby é gratuita para uso
interno como este. Nenhum dos dois expira nem pede cartão.

**LGPD.** O painel tem nome, cargo, empresa e admissão de 151 pessoas, e passa a
ficar atrás de uma tela de login acessível pela internet. Vale registrar internamente
quem tem acesso e revisar essa lista de tempos em tempos.

---

## Proteções implementadas

| Proteção | O que faz |
|---|---|
| HTTPS obrigatório | Cookie de sessão só trafega cifrado (`Secure` + HSTS) |
| Bloqueio de força bruta | 8 senhas erradas travam aquele login por 15 minutos |
| Sessão assinada | Guardada em cookie assinado; não dá para forjar sem o `SESSION_SECRET` |
| Isolamento do líder | Líder só lê e exporta a própria equipe, inclusive pela API |
| Cabeçalhos de segurança | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` |
| Senhas | Guardadas com bcrypt, nunca em texto puro |
| Dependências | Zero vulnerabilidades conhecidas (`npm audit`) |

---

## Rodar na sua máquina

Continua funcionando com o `Iniciar Painel.bat`. Sem as variáveis do Turso, o sistema
usa o arquivo local `data/painel.db` — útil para testar sem mexer no ambiente publicado.

## Variáveis de ambiente

| Variável | Para que serve |
|---|---|
| `TURSO_DATABASE_URL` | Banco hospedado. Sem ela, usa o arquivo local |
| `TURSO_AUTH_TOKEN` | Token de acesso ao Turso |
| `SESSION_SECRET` | Assina o cookie de sessão |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Usados só na primeira execução, para criar a administradora |
| `BEHIND_PROXY` | `1` quando há proxy HTTPS; a Vercel ativa isso sozinha |
| `PORT` / `HOST` | Só para execução local |

## Também roda em

O `Dockerfile` e o `render.yaml` continuam na pasta. Com o Turso configurado, o mesmo
código roda no plano gratuito da Render, Koyeb ou Fly.io sem alteração — a diferença é
que a Vercel não hiberna, enquanto o plano gratuito da Render demora a acordar depois
de um tempo parado.
