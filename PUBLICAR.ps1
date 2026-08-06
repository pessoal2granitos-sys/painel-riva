# Publica o Painel de Treinamentos na Vercel.
# Faz tudo sozinho, parando apenas onde é necessário você autenticar ou colar
# os dados do banco — coisas que só você pode fazer.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-Location $PSScriptRoot

$NODE = "$env:LOCALAPPDATA\node-portable\node-v24.19.0-win-x64\node.exe"
$VERCEL = Join-Path $PSScriptRoot 'node_modules\vercel\dist\index.js'
$env:VERCEL_TELEMETRY_DISABLED = '1'

function Titulo($t) {
  Write-Host ''
  Write-Host ('  ' + $t) -ForegroundColor Cyan
  Write-Host ('  ' + ('-' * $t.Length)) -ForegroundColor DarkCyan
}
function Ok($t)   { Write-Host "  [ok] $t" -ForegroundColor Green }
function Aviso($t){ Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Erro($t) { Write-Host "  [X]  $t" -ForegroundColor Red }
function Vercel { & $NODE $VERCEL @args }

Write-Host ''
Write-Host '  ===========================================================' -ForegroundColor Blue
Write-Host '   PUBLICAR PAINEL DE TREINAMENTOS - RIVA STONES' -ForegroundColor White
Write-Host '  ===========================================================' -ForegroundColor Blue

if (-not (Test-Path $NODE)) { Erro "Node nao encontrado em $NODE"; Read-Host 'Enter para sair'; exit 1 }

if (-not (Test-Path $VERCEL)) {
  Write-Host '  Instalando a ferramenta de publicacao (so na primeira vez)...'
  $npm = "$env:LOCALAPPDATA\node-portable\node-v24.19.0-win-x64\npm.cmd"
  & $npm install --no-save vercel 2>&1 | Out-Null
  if (-not (Test-Path $VERCEL)) { Erro 'Falha ao instalar o Vercel CLI. Verifique a internet.'; Read-Host 'Enter para sair'; exit 1 }
  Ok 'Ferramenta instalada.'
}

# ---------------------------------------------------------------- 1. Login
Titulo '1 de 5 - Entrar na Vercel'
$logado = $false
try { $quem = (Vercel whoami 2>&1 | Out-String).Trim(); if ($quem -and $quem -notmatch 'not authenticated|Error') { $logado = $true } } catch {}

if ($logado) {
  Ok "Ja conectada como: $($quem -split "`n" | Select-Object -Last 1)"
} else {
  Write-Host '  Vai abrir o navegador para voce entrar (ou criar a conta, e gratis).'
  Write-Host '  Pode entrar com o Google usando seu e-mail de sempre.'
  Write-Host ''
  Vercel login
  if ($LASTEXITCODE -ne 0) { Erro 'Login nao concluido.'; Read-Host 'Enter para sair'; exit 1 }
  Ok 'Conectada.'
}

# ---------------------------------------------------------------- 2. Projeto
Titulo '2 de 5 - Preparar o projeto'
Vercel link --yes --project painel-riva | Out-Null
if ($LASTEXITCODE -ne 0) { Erro 'Nao foi possivel criar o projeto.'; Read-Host 'Enter para sair'; exit 1 }
Ok 'Projeto painel-riva pronto.'

# ---------------------------------------------------------------- 3. Banco
Titulo '3 de 5 - Banco de dados'
$envAtual = (Vercel env ls production 2>&1 | Out-String)
$temBanco = $envAtual -match 'TURSO_DATABASE_URL'

if ($temBanco) {
  Ok 'Banco ja configurado neste projeto.'
} else {
  Write-Host '  O painel precisa de um banco Turso (SQLite hospedado, plano gratuito).'
  Write-Host ''
  Write-Host '  1. Abra https://turso.tech e entre com o GitHub ou Google' -ForegroundColor White
  Write-Host '  2. Create Database -> nome: painel-riva' -ForegroundColor White
  Write-Host '  3. Copie a Database URL (comeca com libsql://)' -ForegroundColor White
  Write-Host '  4. Em Generate Token, copie o token' -ForegroundColor White
  Write-Host ''
  Start-Process 'https://turso.tech'

  $url = (Read-Host '  Cole a Database URL').Trim()
  if ($url -notmatch '^libsql://') { Erro 'A URL deve comecar com libsql://'; Read-Host 'Enter para sair'; exit 1 }
  $token = (Read-Host '  Cole o Token').Trim()
  if ($token.Length -lt 20) { Erro 'Token invalido.'; Read-Host 'Enter para sair'; exit 1 }

  # O valor vai pela entrada padrao. Precisa chamar o executavel direto: canalizar
  # para uma funcao do PowerShell nao repassa a entrada ao processo.
  $url   | & $NODE $VERCEL env add TURSO_DATABASE_URL production | Out-Null
  $token | & $NODE $VERCEL env add TURSO_AUTH_TOKEN  production  | Out-Null
  Ok 'Banco configurado.'
}

# ---------------------------------------------------------------- 4. Acesso
Titulo '4 de 5 - Acesso de administradora'
if ($envAtual -match 'ADMIN_PASSWORD') {
  Ok 'Acesso ja configurado.'
  $senhaNova = $null
} else {
  $email = (Read-Host '  Seu e-mail de administradora [departamentopessoalriva@gmail.com]').Trim()
  if (-not $email) { $email = 'departamentopessoalriva@gmail.com' }

  Write-Host '  Escolha uma senha NOVA (minimo 8 caracteres).'
  $sec = Read-Host '  Senha' -AsSecureString
  $senhaNova = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  if ($senhaNova.Length -lt 8) { Erro 'Senha muito curta.'; Read-Host 'Enter para sair'; exit 1 }

  # Segredo de sessao gerado aqui, aleatorio, sem passar por ninguem.
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $segredo = [Convert]::ToBase64String($bytes)

  $email     | & $NODE $VERCEL env add ADMIN_EMAIL    production | Out-Null
  $senhaNova | & $NODE $VERCEL env add ADMIN_PASSWORD production | Out-Null
  $segredo   | & $NODE $VERCEL env add SESSION_SECRET production | Out-Null
  Ok 'Acesso configurado.'
}

# ---------------------------------------------------------------- 5. Publicar
Titulo '5 de 5 - Publicar'
Write-Host '  Enviando o site... (leva um a dois minutos)'
$saida = (Vercel deploy --prod --yes 2>&1 | Out-String)
Write-Host $saida
$endereco = ([regex]::Matches($saida, 'https://[a-zA-Z0-9\.\-]+\.vercel\.app') | Select-Object -Last 1).Value
if (-not $endereco) { Erro 'Nao consegui identificar o endereco publicado. Veja a saida acima.'; Read-Host 'Enter para sair'; exit 1 }
Ok "Publicado em: $endereco"

# ------------------------------------------------------- Carregar a planilha
Titulo 'Carregando a planilha'
$planilha = Get-ChildItem (Join-Path $PSScriptRoot '..') -Filter '*.xlsx' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $planilha) {
  Aviso 'Planilha nao encontrada. Importe manualmente pela aba Importar / Exportar.'
} elseif (-not $senhaNova) {
  Aviso 'Como o acesso ja existia, importe a planilha pela aba Importar / Exportar.'
} else {
  Write-Host "  Aguardando o site responder..."
  $pronto = $false
  for ($i = 0; $i -lt 30; $i++) {
    try { if ((Invoke-WebRequest "$endereco/login" -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200) { $pronto = $true; break } } catch {}
    Start-Sleep -Seconds 4
  }
  if (-not $pronto) {
    Aviso 'O site demorou a responder. Importe a planilha pela aba Importar / Exportar.'
  } else {
    $env:PAINEL_URL = $endereco
    $env:PAINEL_EMAIL = $email
    $env:PAINEL_SENHA = $senhaNova
    $env:PAINEL_XLSX = $planilha.FullName
    & $NODE (Join-Path $PSScriptRoot 'scripts\enviar-planilha.js')
    if ($LASTEXITCODE -ne 0) { Aviso 'Falha ao enviar. Importe pela aba Importar / Exportar.' }
  }
}

Write-Host ''
Write-Host '  ===========================================================' -ForegroundColor Green
Write-Host '   PRONTO' -ForegroundColor White
Write-Host '  ===========================================================' -ForegroundColor Green
Write-Host ''
Write-Host "   Endereco: $endereco" -ForegroundColor White
Write-Host "   Entre com o seu e-mail e a senha que voce escolheu."
Write-Host ''
Write-Host '   Proximo passo: crie um login para cada gestor em'
Write-Host '   Usuarios e Acessos. Nunca compartilhe uma senha unica.'
Write-Host ''
Read-Host '  Enter para fechar'
