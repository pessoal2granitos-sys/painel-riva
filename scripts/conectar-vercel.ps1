# Faz apenas o login do computador na conta Vercel. É a única etapa que exige
# você — depois dela, a publicação inteira pode ser feita por comando.

$ProgressPreference = 'SilentlyContinue'
$raiz = Split-Path $PSScriptRoot -Parent
Set-Location $raiz
$env:VERCEL_TELEMETRY_DISABLED = '1'

function Achar-Node {
  $c = @()
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $c += $cmd.Source }
  $c += "$env:ProgramFiles\nodejs\node.exe"
  $c += "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  $raizNode = "$env:LOCALAPPDATA\node-portable"
  if (Test-Path $raizNode) {
    $c += (Get-ChildItem $raizNode -Directory -EA SilentlyContinue | Sort-Object Name -Descending |
           ForEach-Object { Join-Path $_.FullName 'node.exe' })
  }
  foreach ($x in $c) { if ($x -and (Test-Path $x -PathType Leaf)) { return $x } }
  return $null
}
function Sessao {
  foreach ($p in @("$env:APPDATA\com.vercel.cli\auth.json",
                   "$env:LOCALAPPDATA\com.vercel.cli\auth.json",
                   "$env:USERPROFILE\.vercel\auth.json")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

Write-Host ''
Write-Host '  ===========================================================' -ForegroundColor Blue
Write-Host '   CONECTAR O COMPUTADOR A SUA CONTA VERCEL' -ForegroundColor White
Write-Host '  ===========================================================' -ForegroundColor Blue
Write-Host ''

$NODE = Achar-Node
if (-not $NODE) {
  Write-Host '  Baixando o Node.js (uma vez so)...' -ForegroundColor Yellow
  $dest = "$env:LOCALAPPDATA\node-portable"
  $zip = Join-Path $env:TEMP 'node-v24.19.0-win-x64.zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  New-Item -ItemType Directory -Force $dest | Out-Null
  Invoke-WebRequest 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip' -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $dest -Force
  Remove-Item $zip -Force -EA SilentlyContinue
  $NODE = Achar-Node
}
if (-not $NODE) { Write-Host '  [X] Node nao encontrado.' -ForegroundColor Red; Read-Host '  Enter para sair'; exit 1 }

$VERCEL = Join-Path $raiz 'node_modules\vercel\dist\index.js'
if (-not (Test-Path $VERCEL)) {
  Write-Host '  Instalando a ferramenta da Vercel (uma vez so)...' -ForegroundColor Yellow
  $npm = Join-Path (Split-Path $NODE) 'npm.cmd'
  & $npm install --no-save vercel 2>&1 | Out-Null
}
if (-not (Test-Path $VERCEL)) { Write-Host '  [X] Falha ao instalar.' -ForegroundColor Red; Read-Host '  Enter para sair'; exit 1 }

if (Sessao) {
  Write-Host '  Este computador JA esta conectado a Vercel.' -ForegroundColor Green
  & $NODE $VERCEL whoami
  Write-Host ''
  Write-Host '  Pode avisar que ja pode continuar a publicacao.' -ForegroundColor White
  Read-Host '  Enter para fechar'
  exit 0
}

Write-Host '  Criar a conta no site NAO conecta este computador.' -ForegroundColor Yellow
Write-Host '  E preciso autorizar aqui tambem. Vai aparecer uma lista:' -ForegroundColor White
Write-Host ''
Write-Host '    Continue with GitHub' -ForegroundColor Gray
Write-Host '    Continue with Google      <-- escolha o mesmo metodo' -ForegroundColor Gray
Write-Host '    Continue with Email           que usou no site' -ForegroundColor Gray
Write-Host ''
Write-Host '  Use as SETAS do teclado, aperte ENTER, e aprove no navegador.' -ForegroundColor White
Write-Host ''

& $NODE $VERCEL login

Write-Host ''
if (Sessao) {
  Write-Host '  [ok] Conectada com sucesso.' -ForegroundColor Green
  & $NODE $VERCEL whoami
  Write-Host ''
  Write-Host '  PRONTO. Agora e so avisar que eu continuo daqui.' -ForegroundColor White
} else {
  Write-Host '  [!] O login nao foi concluido. Rode este arquivo de novo.' -ForegroundColor Yellow
}
Write-Host ''
Read-Host '  Enter para fechar'
