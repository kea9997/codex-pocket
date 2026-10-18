[CmdletBinding()]
param([string]$PrivateDirectory = (Join-Path $env:USERPROFILE '.codex-pocket'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Private-State.ps1')
$private = Get-CodexPhonePrivateDirectory
$lock = Join-Path $private 'service.lock'
if (-not (Test-Path -LiteralPath $lock)) { Write-Output 'Codex Phone is not running.'; return }
# Graceful local control file, consumed only by our bridge. No process enumeration/kill.
$stream = [IO.File]::Open((Join-Path $private 'stop.request'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $bytes = [Text.Encoding]::UTF8.GetBytes('stop'); $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path -LiteralPath $lock)) { Write-Output 'Codex Phone stopped.'; return }
}
throw 'STOP_NOT_CONFIRMED_REVIEW_LOCK_AND_BRIDGE_PID_ONLY'
