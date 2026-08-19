$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $repoRoot "backups"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

$bash = "C:\Program Files\Git\bin\bash.exe"
if (-not (Test-Path $bash)) {
    throw "Git Bash is required at $bash"
}

Set-Location $repoRoot
$env:PATH = "C:\Program Files\PostgreSQL\16\bin;C:\Program Files\nodejs;$env:PATH"
& $bash (Join-Path $repoRoot "scripts\backup.sh") 2>&1 |
    Tee-Object -FilePath (Join-Path $logRoot "backup.log") -Append
exit $LASTEXITCODE
