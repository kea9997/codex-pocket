# Extract only the pure enumeration/wait functions; protocol, Appx, real CIM and real process handles are NEVER executed.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile([IO.Path]::Combine($PSScriptRoot, 'Account-Platform.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'SYNTHETIC_PARSE_FAILED' }
foreach ($name in @('Get-Gui', 'Wait-GuiExit')) {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([ScriptBlock]::Create($function.Extent.Text))
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$package = @{ executable = 'C:\Synthetic-CodexPhone-Fixture\ChatGPT.exe' }
$nativePath = [IO.Path]::Combine($env:LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', '0123456789abcdef', 'codex.exe')
$script:gui = @(); $script:native = @()
function Get-CimInstance([string]$Class, [string]$Filter) { if ($Filter -eq "Name='ChatGPT.exe'") { return $script:gui }; if ($Filter -eq "Name='codex.exe'") { return $script:native }; throw 'SYNTHETIC_BOUNDARY' }
function Invoke-CimMethod($InputObject, [string]$MethodName) { if ($MethodName -ne 'GetOwnerSid') { throw 'SYNTHETIC_BOUNDARY' }; return @{ ReturnValue = 0; Sid = $sid.Value } }
function Get-ProcessSnapshot($Row) { return @{ pid = $Row.ProcessId; started = $Row.started; window = $true } }
function Assert-Path([string]$Path, [bool]$File) { if ($Path -cne $nativePath -or -not $File) { throw 'SYNTHETIC_BOUNDARY' } }
function Start-Sleep([int]$Milliseconds) {}
function Require($Condition) { if (-not $Condition) { throw 'SYNTHETIC_PROCESS_ASSERTION' } }
Require (@(Get-Gui $package).Count -eq 0)
$script:gui = @(@{ ExecutablePath = $package.executable; ProcessId = 100; started = '1000'; CommandLine = 'synthetic.exe' })
$rows = @(Get-Gui $package); Require ($rows.Count -eq 1 -and $rows[0].root)
for ($i = 1; $i -le 16; $i++) { $script:gui += @{ ExecutablePath = $package.executable; ProcessId = (100 + $i); started = '1100'; CommandLine = 'synthetic.exe --type=renderer' } }
$script:native = @(
    @{ ExecutablePath = $nativePath; ProcessId = 201; ParentProcessId = 101; started = '1200' },
    @{ ExecutablePath = $nativePath; ProcessId = 202; ParentProcessId = 201; started = '1300' },
    @{ ExecutablePath = 'C:\Unrelated-Fixture\codex.exe'; ProcessId = 999; ParentProcessId = 888; started = '1300' }
)
$rows = @(Get-Gui $package)
Require ($rows.Count -eq 19); Require (@($rows | Where-Object { $_.root }).Count -eq 1)
Require (@($rows | Where-Object { $_.ContainsKey('native') }).Count -eq 2)
$json = @{ processes = $rows } | ConvertTo-Json -Compress -Depth 8
Require (($json | ConvertFrom-Json -AsHashtable).processes.Count -eq 19)
# Once GUI enumeration is empty, an exact captured native child must STILL prevent publication.
function Get-Gui($Package) {}
$tracked = @([pscustomobject]@{ Id = 201; HasExited = $false })
$failed = $false; try { Wait-GuiExit $package $tracked 0 } catch { $failed = $_.Exception.ToString().Contains('ACCOUNT_DESKTOP_CLOSE_REQUIRED') }
Require $failed
$tracked[0].HasExited = $true; Wait-GuiExit $package $tracked 0
[Console]::Out.WriteLine('ACCOUNT_PROCESSES_SYNTHETIC_QA_PASSED')
