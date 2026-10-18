# Constrained synthetic QA. Never reads a real Codex home or inspects/closes/launches Codex.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$pwsh = (Get-Process -Id $PID).Path
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'POWERSHELL7_REQUIRED' }
$helper = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, 'Account-Platform.ps1'))
foreach ($name in @('Account-Platform.ps1', 'Test-AccountPlatform.ps1', 'Open-Accounts.ps1')) {
    $tokens = $null; $errors = $null
    [Management.Automation.Language.Parser]::ParseFile([IO.Path]::Combine($PSScriptRoot, $name), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw 'ACCOUNT_SYNTHETIC_PARSE_FAILED' }
}
function Invoke-SyntheticHelper($InputValue) {
    if ($InputValue.action -notin @('private', 'prepare', 'protect', 'unprotect', 'replace', 'cache', 'install')) { throw 'ACCOUNT_SYNTHETIC_BOUNDARY' }
    foreach ($name in @('path', 'root')) {
        if ($InputValue.ContainsKey($name) -and $InputValue[$name] -cne $root -and -not $InputValue[$name].StartsWith($root + '\', [StringComparison]::Ordinal)) { throw 'ACCOUNT_SYNTHETIC_BOUNDARY' }
    }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $pwsh; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    foreach ($arg in @('-NoProfile', '-NonInteractive', '-File', $helper)) { $info.ArgumentList.Add($arg) }
    $p = [Diagnostics.Process]::new(); $p.StartInfo = $info
    try {
        if (-not $p.Start()) { throw 'ACCOUNT_SYNTHETIC_HELPER_FAILED' }
        $output = $p.StandardOutput.ReadToEndAsync(); $ignored = $p.StandardError.ReadToEndAsync()
        $p.StandardInput.WriteLine(($InputValue | ConvertTo-Json -Compress)); $p.StandardInput.Close()
        if (-not $p.WaitForExit(25000)) { $p.Kill(); throw 'ACCOUNT_SYNTHETIC_HELPER_TIMEOUT' }
        $value = $output.GetAwaiter().GetResult()
        if ($value.Length -gt 1500000) { throw 'ACCOUNT_SYNTHETIC_HELPER_FAILED' }
        $parsed = $value | ConvertFrom-Json -AsHashtable
        if ($parsed.ContainsKey('error')) { [Console]::Error.WriteLine('SYNTHETIC_' + $InputValue.action + '_' + $parsed.error) }
        return $parsed
    } finally { $p.Dispose() }
}
function Require($Condition) { if (-not $Condition) { throw ('ACCOUNT_SYNTHETIC_ASSERTION_FAILED_LINE_' + (Get-PSCallStack)[1].ScriptLineNumber) } }
function Hash([byte[]]$Bytes) { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
$root = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'CodexPhone-Account-QA-' + [Guid]::NewGuid().ToString())
$dir = [IO.Path]::Combine($root, 'accounts'); $file = [IO.Path]::Combine($dir, 'profiles.bin'); $link = [IO.Path]::Combine($dir, 'fixture-link.bin')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
try {
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($root), $acl)
    $check = Invoke-SyntheticHelper @{ action = 'private'; path = $root; file = $false }; Require (-not $check.ContainsKey('error'))
    $prepare = Invoke-SyntheticHelper @{ action = 'prepare'; root = $root; path = $dir }; Require (-not $prepare.ContainsKey('error'))
    $plain = [Text.Encoding]::UTF8.GetBytes('invented synthetic account fixture; NOT credentials')
    $protected = Invoke-SyntheticHelper @{ action = 'protect'; data = [Convert]::ToBase64String($plain) }; Require ($protected.ContainsKey('data'))
    $roundtrip = Invoke-SyntheticHelper @{ action = 'unprotect'; data = $protected.data }; Require ($roundtrip.data -ceq [Convert]::ToBase64String($plain))
    $encrypted = [Convert]::FromBase64String($protected.data); $bad = [byte[]]$encrypted.Clone(); $bad[$bad.Length - 1] = $bad[$bad.Length - 1] -bxor 1
    $tamper = Invoke-SyntheticHelper @{ action = 'unprotect'; data = [Convert]::ToBase64String($bad) }; Require ($tamper.ContainsKey('error'))
    $created = Invoke-SyntheticHelper @{ action = 'replace'; private = $true; path = $file; expected = $null; data = $protected.data; transaction = [Guid]::NewGuid().ToString() }; Require (-not $created.ContainsKey('error'))
    $check = Invoke-SyntheticHelper @{ action = 'private'; path = $file; file = $true }; Require (-not $check.ContainsKey('error'))
    $stale = Invoke-SyntheticHelper @{ action = 'replace'; private = $true; path = $file; expected = ('0' * 64); data = $protected.data; transaction = [Guid]::NewGuid().ToString() }; Require ($stale.error -eq 'ACCOUNT_CACHE_CHANGED')
    $replaced = Invoke-SyntheticHelper @{ action = 'replace'; private = $true; path = $file; expected = (Hash $encrypted); data = $protected.data; transaction = [Guid]::NewGuid().ToString() }; Require (-not $replaced.ContainsKey('error'))
    New-Item -ItemType HardLink -Path $link -Target $file | Out-Null
    $linked = Invoke-SyntheticHelper @{ action = 'private'; path = $file; file = $true }; Require ($linked.error -eq 'ACCOUNT_STORAGE_UNSAFE')
    [IO.File]::Delete($link)
    $denied = Invoke-SyntheticHelper @{ action = 'replace'; private = $false; path = $file; expected = (Hash $encrypted); data = $protected.data; transaction = [Guid]::NewGuid().ToString() }; Require ($denied.error -eq 'ACCOUNT_STORAGE_UNSUPPORTED')
    $weakened = [Security.AccessControl.DirectorySecurity]::new(); $weakened.SetAccessRuleProtection($true, $false)
    $weakened.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    $weakened.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($root), $weakened)
    $rejectAcl = Invoke-SyntheticHelper @{ action = 'private'; path = $root; file = $false }; Require ($rejectAcl.error -eq 'ACCOUNT_STORAGE_UNSAFE')
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($root), $acl)
    $auth = [IO.Path]::Combine($root, 'auth.json'); [IO.File]::WriteAllBytes($auth, $plain)
    $snapshot = Invoke-SyntheticHelper @{ action = 'cache'; path = $auth }; Require ($snapshot.ContainsKey('fileId'))
    $target = [Text.Encoding]::UTF8.GetBytes('another invented synthetic fixture; NOT credentials')
    $installed = Invoke-SyntheticHelper @{ action = 'install'; path = $auth; expected = (Hash $plain); fileId = $snapshot.fileId; data = [Convert]::ToBase64String($target); transaction = [Guid]::NewGuid().ToString() }
    Require ($installed.ContainsKey('fileId')); Require ((Hash ([IO.File]::ReadAllBytes($auth))) -eq (Hash $target))
    $check = Invoke-SyntheticHelper @{ action = 'private'; path = $auth; file = $true }; Require (-not $check.ContainsKey('error'))
    # Exercise explicit JSON null through ConvertFrom-Json -AsHashtable and the production C# string boundary.
    [IO.File]::Delete($auth); Require (-not [IO.File]::Exists($auth))
    $recovered = Invoke-SyntheticHelper @{ action = 'install'; path = $auth; expected = $null; fileId = $null; data = [Convert]::ToBase64String($plain); transaction = [Guid]::NewGuid().ToString() }
    Require ($recovered.ContainsKey('fileId')); Require ((Hash ([IO.File]::ReadAllBytes($auth))) -eq (Hash $plain))
    $check = Invoke-SyntheticHelper @{ action = 'private'; path = $auth; file = $true }; Require (-not $check.ContainsKey('error'))
    $collision = Invoke-SyntheticHelper @{ action = 'install'; path = $auth; expected = $null; fileId = $null; data = [Convert]::ToBase64String($target); transaction = [Guid]::NewGuid().ToString() }
    Require ($collision.error -eq 'ACCOUNT_CACHE_CHANGED'); Require ((Hash ([IO.File]::ReadAllBytes($auth))) -eq (Hash $plain))
    $preserved = Invoke-SyntheticHelper @{ action = 'cache'; path = $auth }; Require ($preserved.fileId -ceq $recovered.fileId)
    Require (@([IO.Directory]::GetFiles($root, '.codex-phone-*')).Count -eq 0)
    [Console]::Out.WriteLine('ACCOUNT_PLATFORM_SYNTHETIC_QA_PASSED')
} finally {
    # Only this run's exact generated ordinary files. No recursive deletion and no production state.
    if ([IO.Directory]::Exists($root)) {
        $item = Get-Item -LiteralPath $root -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ACCOUNT_SYNTHETIC_CLEANUP_REQUIRED' }
        if ([IO.Directory]::Exists($dir)) {
            $item = Get-Item -LiteralPath $dir -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ACCOUNT_SYNTHETIC_CLEANUP_REQUIRED' }
        }
        foreach ($p in @($link, $file, [IO.Path]::Combine($root, 'auth.json'))) {
            if ([IO.File]::Exists($p)) {
                $item = Get-Item -LiteralPath $p -Force
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'ACCOUNT_SYNTHETIC_CLEANUP_REQUIRED' }
                [IO.File]::Delete($p)
            }
        }
        if ([IO.Directory]::Exists($dir)) { [IO.Directory]::Delete($dir, $false) }
        [IO.Directory]::Delete($root, $false)
    }
}
