[CmdletBinding()]
param(
    [switch]$Foreground,
    [string]$PrivateDirectory = (Join-Path $env:USERPROFILE '.codex-pocket'),
    [string]$NodePath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Private-State.ps1')
$private = Get-CodexPhonePrivateDirectory
$project = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'Runtime.ps1')
$config = Read-PocketConfig $private
$pwsh = (Get-Process -Id $PID).Path
$node = Resolve-PocketNode $NodePath
$env:CODEX_POCKET_PWSH = $pwsh
if ($Foreground) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = [Threading.Mutex]::new($false, ('Global\CodexPocket-Bridge-' + $sid))
    $owned = $false
    $code = 1
    try {
        try { $owned = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw 'INSTANCE_ALREADY_RUNNING' }
        $lock = Join-Path $private 'service.lock'
        if (Test-Path -LiteralPath $lock) {
            $item = Get-Item -LiteralPath $lock -Force
            if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                $item.Length -lt 1 -or $item.Length -gt 1024) { throw 'INSTANCE_LOCK_INVALID_REVIEW_MANUALLY' }
            # Read a bounded regular guard exclusively; sharing/access failures are unknown, never stale.
            $stream = [IO.File]::Open($lock, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
            try {
                if ($stream.Length -lt 1 -or $stream.Length -gt 1024) { throw 'INSTANCE_LOCK_INVALID_REVIEW_MANUALLY' }
                $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true, 1024, $true)
                try {
                    try { $guard = $reader.ReadToEnd() | ConvertFrom-Json -AsHashtable }
                    catch { throw 'INSTANCE_LOCK_INVALID_REVIEW_MANUALLY' }
                } finally { $reader.Dispose() }
            } finally { $stream.Dispose() }
            if ($guard -isnot [Collections.IDictionary] -or $guard.Count -ne 1 -or -not $guard.Contains('pid')) {
                throw 'INSTANCE_LOCK_INVALID_REVIEW_MANUALLY'
            }
            if (($guard.pid -isnot [int] -and $guard.pid -isnot [long]) -or $guard.pid -le 0 -or $guard.pid -gt [int]::MaxValue) {
                throw 'INSTANCE_LOCK_INVALID_REVIEW_MANUALLY'
            }
            $absent = $false
            try {
                $guardProcess = [Diagnostics.Process]::GetProcessById([int]$guard.pid)
                try { $absent = $guardProcess.HasExited }
                finally { $guardProcess.Dispose() }
            } catch [ArgumentException] { $absent = $true }
            catch { $absent = $false }
            $priorBoot = $false
            try {
                $boot = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
                if ($boot -is [datetime]) { $priorBoot = $item.LastWriteTimeUtc -lt $boot.ToUniversalTime() }
            } catch { $priorBoot = $false }
            if (-not $absent -and -not $priorBoot) { throw 'INSTANCE_LOCKED_LIVE_OR_UNKNOWN_REVIEW_MANUALLY' }
            $current = Get-Item -LiteralPath $lock -Force
            if ($current.PSIsContainer -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                $current.Length -ne $item.Length -or $current.LastWriteTimeUtc -ne $item.LastWriteTimeUtc) {
                throw 'INSTANCE_LOCK_CHANGED_REVIEW_MANUALLY'
            }
            # Only this confirmed-stale private guard, under our startup/runtime mutex. Never kill a PID.
            Remove-Item -LiteralPath $lock -ErrorAction Stop
        }
        & $node (Join-Path $project 'server\main.mjs') $private
        $code = $LASTEXITCODE
    } finally {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
    exit $code
}
# Manual parent never takes the mutex: only the foreground wrapper owns it for the child lifetime.
if ($PSCommandPath -match '["\r\n]') { throw 'SCRIPT_PATH_REJECTED' }
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $PSCommandPath + '" -Foreground -PrivateDirectory "' + $private + '" -NodePath "' + $node + '"'
$process = Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $project -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
if ($process.HasExited) { throw 'START_FAILED_CHECK_PRIVATE_SERVICE_LOG' }
Write-Output 'Codex Phone wrapper started. Verify tailnet health and private service.log. Pairing code stays in private pairing.json.'
