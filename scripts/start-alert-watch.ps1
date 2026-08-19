$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $env:ProgramData "CanvasPlanet\logs"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
Set-Location $repoRoot

$node = "C:\Program Files\nodejs\node.exe"
$tsx = Join-Path $repoRoot "packages\server\node_modules\tsx\dist\cli.mjs"
$watcher = Join-Path $repoRoot "packages\server\scripts\alert-watch.ts"
if (-not (Test-Path $node) -or -not (Test-Path $tsx)) {
    throw "Node and the installed tsx runtime are required"
}

$process = Start-Process -FilePath $node `
    -ArgumentList @($tsx, $watcher) `
    -WorkingDirectory $repoRoot `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $logRoot "alert.out.log") `
    -RedirectStandardError (Join-Path $logRoot "alert.err.log")
exit $process.ExitCode
