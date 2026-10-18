[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$HostIPv4,
    [Parameter(Mandatory)][string[]]$PhonePeers,
    [Parameter(Mandatory)][string]$ControllerThreadId,
    [int]$Port = 47831,
    [string]$PrivateDirectory = (Join-Path $env:USERPROFILE '.codex-pocket')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Runtime.ps1')
. (Join-Path $PSScriptRoot 'Private-State.ps1')
$config = @{ host = $HostIPv4; peers = @($PhonePeers); port = $Port; controllerThreadId = $ControllerThreadId }
Assert-PocketConfig $config
if ($PSCmdlet.ShouldProcess($PrivateDirectory, 'Create private user-owned bridge configuration (never overwrite)')) {
    $private = Get-CodexPhonePrivateDirectory
    $file = Join-Path $private 'bridge.json'
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($config | ConvertTo-Json -Compress))
    $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    [IO.FileSystemAclExtensions]::SetAccessControl((Get-Item -LiteralPath $file -Force), $acl)
    $verified = Read-PocketConfig $private
    Write-Output 'CONFIGURED_PRIVATE_FILE_ONLY. No login, service, firewall, tailnet or startup changes.'
}
