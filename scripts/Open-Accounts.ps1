# Opens the same authenticated picker as the phone; no login or service changes.
[CmdletBinding()]
param([string]$PrivateDirectory = (Join-Path $env:USERPROFILE '.codex-pocket'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Private-State.ps1')
. (Join-Path $PSScriptRoot 'Runtime.ps1')
$private = Get-CodexPhonePrivateDirectory
$config = Read-PocketConfig $private
Start-Process -FilePath ('http://' + $config.host + ':' + $config.port + '/#accounts')
