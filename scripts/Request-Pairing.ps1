[CmdletBinding()]
param([string]$PrivateDirectory = (Join-Path $env:USERPROFILE '.codex-pocket'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Private-State.ps1')
$private = Get-CodexPhonePrivateDirectory
if (-not (Test-Path -LiteralPath (Join-Path $private 'service.lock'))) { throw 'BRIDGE_NOT_RUNNING' }
$requestId = [guid]::NewGuid().ToString('N')
$request = Join-Path $private 'pairing.request'
$temp = Join-Path $private ('pairing-request-' + $requestId + '.tmp')
$response = Join-Path $private 'pairing-renewed.json'
$payload = @{ requestId = $requestId; requestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
try {
    $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($payload); $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
    # Move without overwrite: never replace another local renewal request.
    [IO.File]::Move($temp, $request)
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp }
}
$deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
do {
    Start-Sleep -Milliseconds 250
    if (Test-Path -LiteralPath $response) {
        $result = [IO.File]::ReadAllText($response) | ConvertFrom-Json
        if ($result.requestId -eq $requestId -and $result.expires -gt [DateTimeOffset]::UtcNow.AddHours(23).ToUnixTimeMilliseconds()) {
            Write-Output 'PAIRING_RENEWED_PRIVATE_FILE_ONLY_24H'
            return
        }
    }
} while ([DateTimeOffset]::UtcNow -lt $deadline)
throw 'PAIRING_RENEWAL_TIMEOUT_REVIEW_PRIVATE_REQUEST_AND_SERVICE_LOG'
