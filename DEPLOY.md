# Como publicar o painel para os gestores

O sistema já está preparado para sair da sua máquina. Existem dois caminhos, e a
escolha depende de **onde os gestores precisam acessar**.

> **Antes de decidir:** o painel contém nome, cargo, empresa e data de admissão de
> 151 pessoas — dado pessoal sujeito à LGPD. Publicar na internet significa que
> qualquer pessoa com o endereço chega na tela de login. Se os gestores acessam de
> dentro da empresa, a Opção A é mais segura e não custa nada.

---

## Opção A — Rede interna da empresa (recomendada, funciona hoje)

Os gestores acessam pelo navegador de qualquer computador da mesma rede.
Os dados **não saem da empresa**.

**1. Liberar a porta no Windows Firewall** (uma única vez, precisa de administrador).
Abra o PowerShell **como administrador** e rode:

```
New-NetFirewallRule -DisplayName "Painel Treinamentos Riva" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow -Profile Private
```

**2. Iniciar o painel** com o `Iniciar Painel.bat`. A janela mostra o endereço:

```
Acesso na rede (Wi-Fi): http://192.168.2.107:3000
```

**3. Enviar esse endereço aos gestores.** Cada um entra com o login que você criar
em *Usuários e Acessos*.

**Limitações honestas desta opção:**
- Seu computador precisa estar ligado e com o painel aberto.
- O IP pode mudar quando o computador reconecta na rede. Para fixar, peça ao TI um
  IP fixo (reserva de DHCP) para sua máquina.
- A conexão é HTTP, sem criptografia. Dentro da rede da empresa o risco é baixo,
  mas as senhas trafegam sem cifra — por isso **não use esta opção pela internet**.
- Não funciona para quem está fora da empresa nem pelo celular na rua.

---

## Opção B — Internet, com endereço próprio e HTTPS

Indicada se os gestores precisam acessar de casa, de outra unidade ou pelo celular.
Aqui o painel ganha um endereço tipo `painel-riva.onrender.com`, com cadeado.

**Eu não posso executar esta etapa por você**: ela exige criar uma conta e informar
um meio de pagamento, e não crio contas nem insiro dados de pagamento em nome de
ninguém. Mas deixei tudo pronto — o `Dockerfile` e o `render.yaml` nesta pasta fazem
o serviço subir sem configuração manual.

**Passo a passo:**

1. Crie uma conta em <https://render.com> (ou Railway, Fly.io — o `Dockerfile`
   funciona em qualquer um).
2. Suba esta pasta `painel-riva` para um repositório **privado** no GitHub.
   O `.gitignore` já impede que a pasta `data/` e planilhas subam junto.
3. Na Render: *New → Web Service* → aponte para o repositório. Ela lê o
   `render.yaml` sozinha.
4. Em *Environment*, preencha as duas variáveis marcadas como `sync: false`:
   - `ADMIN_EMAIL` → seu e-mail
   - `ADMIN_PASSWORD` → **uma senha nova, diferente da que você usa hoje**
5. Confirme que o disco persistente está montado em `/app/data`. **Sem isso os
   dados são apagados a cada reinício do serviço.** O plano gratuito da Render não
   oferece disco persistente — é preciso o plano pago (a partir de US$ 7/mês).
6. Depois do primeiro acesso, entre em *Cadastros → Importar* e envie a planilha
   para carregar os dados.

**Cuidados desta opção:**
- Troque a senha de administrador. A senha atual já circulou fora do sistema.
- Crie um usuário por gestor, nunca uma senha compartilhada — assim dá para revogar
  o acesso de um sem afetar os outros.
- Configure backup: baixe o `.xlsx` pela aba *Importar / Exportar* periodicamente.

---

## O que já foi preparado para a publicação

| Proteção | O que faz |
|---|---|
| Cookie `Secure` + HSTS | Sessão só trafega por HTTPS quando `BEHIND_PROXY=1` |
| Bloqueio de força bruta | 8 senhas erradas travam o login por 15 minutos |
| Renovação de sessão | Novo id de sessão a cada login, contra fixação de sessão |
| Alcance do líder | Líder só lê e exporta a própria equipe, inclusive via API |
| Cabeçalhos de segurança | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` |
| Segredo de sessão | Vem de `SESSION_SECRET`, gerado automaticamente na Render |

## Variáveis de ambiente

| Variável | Para que serve |
|---|---|
| `PORT` | Porta do servidor (padrão 3000; a hospedagem define sozinha) |
| `HOST` | Interface de escuta (padrão `0.0.0.0`) |
| `BEHIND_PROXY` | `1` quando há proxy HTTPS na frente — ativa cookie seguro e HSTS |
| `SESSION_SECRET` | Segredo dos cookies de sessão |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Só usados na primeira execução, para criar a administradora |
