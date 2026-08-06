# Publicar o painel na internet

Objetivo: os gestores acessam de qualquer lugar, por um endereço próprio com HTTPS,
cada um com seu login.

O código já está pronto e commitado neste repositório Git. Faltam **três etapas que
só você pode fazer**, porque envolvem criar contas e informar meio de pagamento.

---

## Etapa 1 — Subir o código para o GitHub (repositório privado)

1. Crie a conta em <https://github.com> (gratuita), se ainda não tiver.
2. Clique em **New repository**. Nome: `painel-riva`.
   **Marque `Private`.** Não marque nenhuma opção de "Add README" ou ".gitignore".
3. O GitHub mostra o endereço do repositório. Copie-o.
4. Abra o PowerShell nesta pasta e rode, trocando `SEU-USUARIO`:

```
cd "D:\Users\ana.claudia\Desktop\Arquitetura - Painel de treinamentos\painel-riva"
git remote add origin https://github.com/SEU-USUARIO/painel-riva.git
git push -u origin main
```

O Git vai pedir seu login do GitHub na primeira vez.

> **O que vai para o GitHub:** apenas o código do sistema. A pasta `data/` (o banco
> com os dados dos 151 colaboradores) e os arquivos `.xlsx` estão bloqueados pelo
> `.gitignore` e **não sobem**. Já verifiquei: nenhum nome de funcionário nem senha
> está nos arquivos versionados.

---

## Etapa 2 — Criar o serviço na Render

1. Crie a conta em <https://render.com> e conecte-a ao seu GitHub.
2. **New → Web Service** → escolha o repositório `painel-riva`.
3. A Render lê o arquivo `render.yaml` e preenche quase tudo sozinha. Confira:
   - **Runtime:** Docker
   - **Plan:** Starter
   - **Disk:** montado em `/app/data`, 1 GB
4. Em **Environment**, preencha as duas variáveis que ficaram em branco:

| Variável | O que colocar |
|---|---|
| `ADMIN_EMAIL` | `departamentopessoalriva@gmail.com` |
| `ADMIN_PASSWORD` | **uma senha nova**, que você ainda não usou em lugar nenhum |

5. Clique em **Create Web Service** e aguarde alguns minutos.

Ao final a Render mostra o endereço, algo como
`https://painel-treinamentos-riva.onrender.com`.

### ⚠️ O ponto que mais causa perda de dados

O **disco persistente em `/app/data` é obrigatório**. Sem ele, o banco é apagado toda
vez que o serviço reinicia — e a Render reinicia sozinha em atualizações e manutenções.
O plano gratuito **não oferece disco persistente**; por isso o `render.yaml` já vem com
o plano Starter (a partir de US$ 7/mês, cerca de R$ 40).

---

## Etapa 3 — Carregar os dados e liberar os acessos

1. Acesse o endereço e entre com `ADMIN_EMAIL` e a senha nova.
   O banco começa vazio — isso é esperado.
2. Vá em **Importar / Exportar → Importar planilha** e envie o
   `Balanço Normativos Att 05_08_26.xlsx`. Em segundos os 151 colaboradores,
   as trilhas e a matriz de carga horária estarão lá.
3. Vá em **Usuários e Acessos** e crie um login para cada gestor:
   - **Gestor** — vê todos os painéis, não altera nada.
   - **Líder** — vê apenas a equipe que você marcar para ele.
   - **Supervisor** — configura o sistema junto com você.
4. Envie a cada um o endereço e a senha, pedindo que troquem no botão **Senha**.

---

## Cuidados depois de publicado

**Uma senha por pessoa.** Nunca um login compartilhado — sem isso não dá para tirar o
acesso de alguém que sai da empresa sem trocar a senha de todo mundo.

**Troque a senha do administrador.** A senha que você usa hoje já circulou fora do
sistema, então não deve ser a mesma do ambiente publicado.

**Backup.** Uma vez por semana, entre em *Importar / Exportar* e baixe o `.xlsx`.
É seu backup completo e abre no Excel normalmente.

**LGPD.** O painel contém nome, cargo, empresa e admissão de 151 pessoas. Publicado,
ele fica atrás de uma tela de login acessível pela internet. Vale registrar
internamente quem tem acesso e revisar essa lista periodicamente.

---

## Proteções já implementadas

| Proteção | O que faz |
|---|---|
| HTTPS obrigatório | Cookie de sessão só trafega cifrado (`Secure` + HSTS) |
| Bloqueio de força bruta | 8 senhas erradas travam aquele login por 15 minutos |
| Renovação de sessão | Novo identificador a cada login, contra fixação de sessão |
| Isolamento do líder | Líder só lê e exporta a própria equipe, inclusive pela API |
| Cabeçalhos de segurança | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` |
| Senhas | Guardadas com bcrypt, nunca em texto puro |

Testado em modo de produção simulando o proxy da hospedagem: login íntegro, cookie
com `Secure` e `HttpOnly`, acesso sem sessão bloqueado com 401.

## Variáveis de ambiente

| Variável | Para que serve |
|---|---|
| `PORT` | Porta do servidor — a hospedagem define sozinha |
| `HOST` | Interface de escuta (padrão `0.0.0.0`) |
| `BEHIND_PROXY` | `1` quando há proxy HTTPS na frente; ativa cookie seguro e HSTS |
| `SESSION_SECRET` | Segredo dos cookies; a Render gera automaticamente |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Usados só na primeira execução, para criar a administradora |

---

## Alternativa mais barata

Se os R$ 40/mês pesarem, existe caminho gratuito, mas exige trocar o banco SQLite por
um PostgreSQL hospedado de graça (Neon ou Supabase). É uma alteração no código que
mexe em toda a camada de dados — dá para fazer, só precisa ser revalidada contra a
planilha depois. Peça se quiser seguir por aí.
