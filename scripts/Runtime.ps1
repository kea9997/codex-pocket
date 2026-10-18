Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Resolve-PocketNode([string]$Path) {
    if (-not $Path) { $Path = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source }
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path -match '["\r\n]' -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'NODE_EXECUTABLE_REQUIRED' }
    $version = & $Path --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'NODE22_REQUIRED' }
    return [IO.Path]::GetFullPath($Path)
}
function Read-PocketConfig([string]$Directory) {
    $file = Join-Path $Directory 'bridge.json'
    $item = Get-Item -LiteralPath $file -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 4096) { throw 'BRIDGE_CONFIG_INVALID' }
    if (-not ('PocketPrivateFile' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'Pocket-PrivateFile.cs') }
    $lease = [PocketPrivateFile]::Open([IO.Path]::GetFullPath($file), 4096)
    try { $value = $lease.ReadUtf8(4096).TrimStart([char]0xfeff) | ConvertFrom-Json -AsHashtable } finally { $lease.Dispose() }
    Assert-PocketConfig $value
    return $value
}
function Test-PocketIP($Value) {
    if ($Value -isnot [string] -or $Value -notmatch '^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$') { return $false }
    $n = @($Value.Split('.') | ForEach-Object { [int]$_ })
    return $n[0] -eq 100 -and $n[1] -ge 64 -and $n[1] -le 127 -and $n[2] -le 255 -and $n[3] -le 255
}
function Assert-PocketConfig($Value) {
    if ($Value -isnot [Collections.IDictionary] -or (($Value.Keys | Sort-Object) -join ',') -cne 'controllerThreadId,host,peers,port') { throw 'BRIDGE_CONFIG_INVALID' }
    if (-not (Test-PocketIP $Value.host) -or ($Value.port -isnot [int] -and $Value.port -isnot [long]) -or $Value.port -lt 1024 -or $Value.port -gt 65535 -or
        $Value.controllerThreadId -notmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or $Value.controllerThreadId -match '^0{8}-' -or
        $Value.peers -isnot [array] -or $Value.peers.Count -lt 1 -or $Value.peers.Count -gt 16) { throw 'BRIDGE_CONFIG_INVALID' }
    $seen = @{}
    foreach ($peer in $Value.peers) {
        if (-not (Test-PocketIP $peer) -or $peer -eq $Value.host -or $seen.ContainsKey($peer)) { throw 'BRIDGE_CONFIG_INVALID' }
        $seen[$peer] = $true
    }
}
