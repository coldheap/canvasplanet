param(
    [Parameter(Mandatory = $true)]
    [string]$BackupFile
)

$ErrorActionPreference = "Stop"
$pgRoot = "C:\Program Files\PostgreSQL\16\bin"
$tempBase = [IO.Path]::GetTempPath()

# A killed verification process can leave a stopped temporary cluster behind.
# Remove only our exact, stopped temp directories before starting a new drill.
Get-ChildItem $tempBase -Directory -Filter "canvasplanet-restore-*" -ErrorAction SilentlyContinue |
    Where-Object { -not (Test-Path (Join-Path $_.FullName "data\postmaster.pid")) } |
    ForEach-Object {
        $candidate = [IO.Path]::GetFullPath($_.FullName)
        $safeName = (Split-Path $candidate -Leaf) -like "canvasplanet-restore-*"
        if ($candidate.StartsWith([IO.Path]::GetFullPath($tempBase), [StringComparison]::OrdinalIgnoreCase) -and $safeName) {
            Remove-Item -LiteralPath $candidate -Recurse -Force
        }
    }

$restoreRoot = Join-Path $tempBase ("canvasplanet-restore-" + [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $restoreRoot "data"
$sqlFile = Join-Path $restoreRoot "backup.sql"
$port = 5545
New-Item -ItemType Directory -Path $restoreRoot | Out-Null

try {
    & (Join-Path $pgRoot "initdb.exe") -D $dataDir -A trust -U postgres -E UTF8 --no-sync | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "initdb failed" }

    & (Join-Path $pgRoot "pg_ctl.exe") -D $dataDir -l (Join-Path $restoreRoot "postgres.log") `
        -o "-p $port -h 127.0.0.1" -w start
    if ($LASTEXITCODE -ne 0) { throw "temporary postgres failed to start" }

    & (Join-Path $pgRoot "psql.exe") -h 127.0.0.1 -p $port -U postgres -d postgres `
        -X -v ON_ERROR_STOP=1 -c "CREATE ROLE canvasplanet LOGIN" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "temporary application role creation failed" }

    & (Join-Path $pgRoot "createdb.exe") -h 127.0.0.1 -p $port -U postgres `
        -O canvasplanet canvasplanet_restore
    if ($LASTEXITCODE -ne 0) { throw "temporary database creation failed" }

    $gzip = "C:\Program Files\Git\usr\bin\gzip.exe"
    $backup = (Resolve-Path $BackupFile).Path
    $decompress = '"{0}" -dc "{1}" > "{2}"' -f $gzip, $backup, $sqlFile
    & cmd.exe /d /c $decompress
    if ($LASTEXITCODE -ne 0) { throw "backup decompression failed" }

    & (Join-Path $pgRoot "psql.exe") -h 127.0.0.1 -p $port -U postgres `
        -d canvasplanet_restore -X -v ON_ERROR_STOP=1 -f $sqlFile | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "backup restore failed" }

    $count = & (Join-Path $pgRoot "psql.exe") -h 127.0.0.1 -p $port -U postgres `
        -d canvasplanet_restore -X -t -A -c "SELECT count(*) FROM _migrations"
    if ($count.Trim() -ne "27") { throw "restored migration count was $count" }
    Write-Output "[backup] isolated restore verified with 27 migrations"
}
finally {
    if (Test-Path $dataDir) {
        & (Join-Path $pgRoot "pg_ctl.exe") -D $dataDir -m fast -w stop 2>$null
    }
    $resolved = [IO.Path]::GetFullPath($restoreRoot)
    $tempResolved = [IO.Path]::GetFullPath($tempBase)
    $safeName = (Split-Path $resolved -Leaf) -like "canvasplanet-restore-*"
    if ($resolved.StartsWith($tempResolved, [StringComparison]::OrdinalIgnoreCase) -and $safeName) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    else {
        Write-Error "refused to remove unexpected temporary path"
    }
}
