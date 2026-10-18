[CmdletBinding(SupportsShouldProcess)]
param([string]$PrivateDirectory = (Join-Path $env:USERPROFILE '.codex-pocket'), [string]$NodePath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'WINDOWS_POWERSHELL7_REQUIRED' }
. (Join-Path $PSScriptRoot 'Runtime.ps1')
# WhatIf must not create/protect a directory or write configuration.
$config = Read-PocketConfig $PrivateDirectory
$node = Resolve-PocketNode $NodePath
$name = 'CodexPocket-Bridge'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'TASK_ALREADY_EXISTS_REVIEW_FIRST' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$start = Join-Path $PSScriptRoot 'Start-Bridge.ps1'
$pwsh = (Get-Process -Id $PID).Path
foreach ($value in @($start, $PrivateDirectory, $node)) { if ($value -match '["\r\n]') { throw 'TASK_ARGUMENT_REJECTED' } }
$action = New-ScheduledTaskAction -Execute $pwsh -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $start + '" -Foreground -PrivateDirectory "' + $PrivateDirectory + '" -NodePath "' + $node + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
if ($PSCmdlet.ShouldProcess($name, 'Register new at-login Codex Pocket task without starting it')) {
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}
