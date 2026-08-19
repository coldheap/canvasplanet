param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("api", "caddy")]
    [string]$Component
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $env:ProgramData "CanvasPlanet/logs"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
Set-Location $repoRoot

if ($Component -eq "api") {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    & $node (Join-Path $repoRoot "packages/server/dist/db/syncCountries.js")
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    $process = Start-Process -FilePath $node `
        -ArgumentList (Join-Path $repoRoot "packages/server/dist/index.js") `
        -WorkingDirectory $repoRoot `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput (Join-Path $logRoot "server.out.log") `
        -RedirectStandardError (Join-Path $logRoot "server.err.log")
    exit $process.ExitCode
}

$env:DOMAIN = "canvasplanet.net"
$env:APP_UPSTREAM = "127.0.0.1:8080"
$env:WEB_ROOT = Join-Path $repoRoot "packages/web/dist"
$env:STATUS_ROOT = Join-Path $repoRoot "status"

$caddy = (Get-Command caddy.exe -ErrorAction Stop).Source
$process = Start-Process -FilePath $caddy `
    -ArgumentList @("run", "--config", (Join-Path $repoRoot "Caddyfile"), "--adapter", "caddyfile") `
    -WorkingDirectory $repoRoot `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $logRoot "caddy.out.log") `
    -RedirectStandardError (Join-Path $logRoot "caddy.err.log")
exit $process.ExitCode
