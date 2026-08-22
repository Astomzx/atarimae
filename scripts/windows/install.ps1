[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$EnvFile = Join-Path $ProjectRoot ".env"
$ExampleFile = Join-Path $ProjectRoot ".env.example"

function Write-Step([string]$Text) {
  Write-Host "`n▶ $Text" -ForegroundColor Cyan
}

function New-RandomBase64([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($buffer)
}

function New-RandomUrl([int]$Bytes) {
  return (New-RandomBase64 $Bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Set-EnvValue([string]$Content, [string]$Name, [string]$Value) {
  $escaped = [Regex]::Escape($Name)
  if ($Content -match "(?m)^$escaped=") {
    return [Regex]::Replace($Content, "(?m)^$escaped=.*$", "$Name=$Value")
  }
  return $Content.TrimEnd() + "`r`n$Name=$Value`r`n"
}

function Wait-ForDocker {
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -eq 1) { Write-Host "Docker Desktop の起動を待っています…" }
    Start-Sleep -Seconds 3
  }
  throw "Docker Desktop が起動しませんでした。Docker Desktop の画面を開き、表示された初期設定を完了してから、もう一度 install-windows.cmd を実行してください。"
}

Write-Host ""
Write-Host "Atarimae かんたんセットアップ" -ForegroundColor Green
Write-Host "この画面の質問に答えるだけで、必要な設定と起動確認を行います。"

if (-not (Test-Path $ExampleFile)) {
  throw "必要なファイル .env.example がありません。ZIP を展開し直してください。"
}

Write-Step "Docker Desktop を確認"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Docker Desktop を自動インストールするための winget がありません。Windows Update を実行してから、もう一度お試しください。"
  }

  $answer = Read-Host "Docker Desktop がありません。今すぐ自動インストールしますか？ [Y/n]"
  if ($answer -and $answer -notmatch "^[Yy]$") {
    throw "Docker Desktop が必要です。セットアップを中止しました。"
  }

  winget install --id Docker.DockerDesktop --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Docker Desktop のインストールに失敗しました。" }

  Write-Host "`nDocker Desktop をインストールしました。Windows を再起動し、その後このファイルをもう一度ダブルクリックしてください。" -ForegroundColor Yellow
  exit 10
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  $dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dockerDesktop) {
    Start-Process -FilePath $dockerDesktop
  }
  Wait-ForDocker
}
Write-Host "Docker Desktop: OK" -ForegroundColor Green

Write-Step "利用方法を選択"
Write-Host "1: 会社で利用（スマートフォン・他のPCからHTTPS接続）"
Write-Host "2: このPCだけで試用"
$mode = Read-Host "番号を入力してください [1]"
if (-not $mode) { $mode = "1" }
if ($mode -notin @("1", "2")) { throw "1 または 2 を入力してください。" }

$appPort = "3000"
$publicHost = ""
if ($mode -eq "1") {
  $publicHost = (Read-Host "利用するドメイン名（例: atarimae.example.co.jp）").Trim().ToLowerInvariant()
  if ($publicHost -notmatch "^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$") {
    throw "ドメイン名だけを入力してください。https:// や / は不要です。"
  }
  $publicOrigin = "https://$publicHost"
} else {
  $publicOrigin = "http://localhost:$appPort"
}

Write-Step "安全な設定ファイルを作成"
if (Test-Path $EnvFile) {
  Write-Host "既存の設定と暗号鍵を保持します。再インストールでもデータを読めなくしません。"
  $content = [IO.File]::ReadAllText($EnvFile)
} else {
  $content = [IO.File]::ReadAllText($ExampleFile)
  $content = Set-EnvValue $content "ENCRYPTION_KEY_CURRENT" ("key01:" + (New-RandomBase64 32))
  $content = Set-EnvValue $content "SESSION_SECRET" (New-RandomBase64 32)
  $content = Set-EnvValue $content "POSTGRES_PASSWORD" (New-RandomUrl 24)
}

$content = Set-EnvValue $content "NODE_ENV" "production"
$content = Set-EnvValue $content "PUBLIC_ORIGIN" $publicOrigin
$content = Set-EnvValue $content "APP_PORT" $appPort
$content = Set-EnvValue $content "APP_BIND_ADDRESS" "127.0.0.1"
if ($mode -eq "1") {
  $content = Set-EnvValue $content "PUBLIC_HOST" $publicHost
  $content = Set-EnvValue $content "TRUSTED_PROXY_IPS" "172.16.0.0/12"
}
[IO.File]::WriteAllText($EnvFile, $content, [Text.UTF8Encoding]::new($false))
Write-Host "設定ファイル: OK" -ForegroundColor Green

Write-Step "Atarimae を起動"
Push-Location $ProjectRoot
try {
  if ($mode -eq "1") {
    docker compose -f docker-compose.yml -f docker-compose.windows.yml up -d --build
  } else {
    docker compose up -d --build
  }
  if ($LASTEXITCODE -ne 0) { throw "コンテナーの起動に失敗しました。" }
} finally {
  Pop-Location
}

Write-Step "動作確認"
$health = "http://127.0.0.1:$appPort/api/v1/health"
$healthy = $false
for ($attempt = 1; $attempt -le 60; $attempt++) {
  try {
    $answer = Invoke-RestMethod -Uri $health -TimeoutSec 3
    if ($answer.status -eq "ok") { $healthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $healthy) {
  throw "Atarimae の起動確認ができませんでした。Docker Desktop の Containers 画面で atarimae-app のログを確認してください。"
}
Write-Host "アプリとデータベース: OK" -ForegroundColor Green

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcut = Join-Path $desktop "Atarimae.url"
[IO.File]::WriteAllText($shortcut, "[InternetShortcut]`r`nURL=$publicOrigin`r`n", [Text.Encoding]::ASCII)

if ($mode -eq "1") {
  Write-Host "`nサーバー側の準備は完了しました。" -ForegroundColor Green
  Write-Host "外部接続には、次の2点だけをネットワーク担当者に確認してください。" -ForegroundColor Yellow
  Write-Host "  1. $publicHost のDNSがこのPCのグローバルIPを指している"
  Write-Host "  2. ルーターの TCP 80/443 と UDP 443 がこのPCへ転送されている"
  Write-Host "確認後、デスクトップの Atarimae を開いて最初のオーナーを登録してください。"
} else {
  Write-Host "`nセットアップが完了しました。ブラウザーを開きます。" -ForegroundColor Green
}

Start-Process $publicOrigin
