# Synthetic Windows handle tests only. No GUI/process discovery, production home, login or network.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'Account-File.cs'))
$root = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'CodexPhone-Publication-QA-' + [Guid]::NewGuid().ToString())
$file = [IO.Path]::Combine($root, 'auth.json')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$old = [Text.Encoding]::UTF8.GetBytes('synthetic previous credential fixture only')
$new = [Text.Encoding]::UTF8.GetBytes('synthetic target credential fixture only')
$other = [Text.Encoding]::UTF8.GetBytes('synthetic unrelated concurrent writer only')
function Require($Condition, [string]$Name) { if (-not $Condition) { throw ('SYNTHETIC_ASSERT_' + $Name) } }
function Reset-Source {
    [IO.File]::WriteAllBytes($file, $old)
    $acl = [Security.AccessControl.FileSecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($false, $false)
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($file), $acl)
    return [CodexAccountFile]::ReadCache($file)
}
function Publish($Snapshot, [Action[string]]$Checkpoint = $null) {
    return [CodexAccountFile]::Publish($file, [CodexAccountFile]::Hash($Snapshot.Bytes), $Snapshot.FileId, $new, [Guid]::NewGuid().ToString(), $Checkpoint)
}
function Clean { Require (@([IO.Directory]::GetFiles($root, '.codex-phone-*')).Count -eq 0) 'NO_PLAINTEXT_ORPHANS' }
try {
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($principal), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'ReadAndExecute,Synchronize', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($root), $acl)
    $snapshot = Reset-Source
    $installed = Publish $snapshot
    Require ([CodexAccountFile]::Hash([IO.File]::ReadAllBytes($file)) -eq [CodexAccountFile]::Hash($new)) 'PUBLISH'
    Require ($installed -ne $snapshot.FileId) 'NEW_IDENTITY'; Clean
    $savedAcl = [IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]::new($file))
    Require ($savedAcl.AreAccessRulesProtected -and @($savedAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])).Count -eq 1) 'NEW_PRIVATE'
    $snapshot = Reset-Source; $failed = $false
    try { [CodexAccountFile]::Publish($file, ('0' * 64), $snapshot.FileId, $new, [Guid]::NewGuid().ToString()) | Out-Null } catch { $failed = $_.Exception.ToString().Contains('ACCOUNT_CACHE_CHANGED') }
    Require $failed 'STALE_HASH'; Clean
    $failed = $false
    try { [CodexAccountFile]::Publish($file, [CodexAccountFile]::Hash($old), 'different-file', $new, [Guid]::NewGuid().ToString()) | Out-Null } catch { $failed = $_.Exception.ToString().Contains('ACCOUNT_CACHE_CHANGED') }
    Require $failed 'STALE_FILE_ID'; Clean
    $reader = [IO.File]::Open($file, 'Open', 'Read', 'Read')
    try { $failed = $false; try { Publish $snapshot | Out-Null } catch { $failed = $_.Exception.ToString().Contains('ACCOUNT_CACHE_BUSY') }; Require $failed 'SHARING_CONFLICT' } finally { $reader.Dispose() }; Clean
    $failed = $false
    try { Publish $snapshot { param($phase) if ($phase -eq 'held') { [IO.File]::WriteAllBytes($file, $other) } } | Out-Null } catch { $failed = $_.Exception.ToString().Contains('ACCOUNT_CACHE_CHANGED') }
    Require $failed 'COLLISION_REFUSED'; Require ([CodexAccountFile]::Hash([IO.File]::ReadAllBytes($file)) -eq [CodexAccountFile]::Hash($other)) 'CONCURRENT_WRITER_RETAINED'; Clean
    $snapshot = Reset-Source; $failed = $false
    try { Publish $snapshot { param($phase) if ($phase -eq 'held') { throw 'SYNTHETIC_INTERRUPT' } } | Out-Null } catch { $failed = $true }
    Require $failed 'INTERRUPTED'; Require (-not [IO.File]::Exists($file)) 'RECOVERABLE_GAP'; Clean
    [CodexAccountFile]::Publish($file, $null, $null, $old, [Guid]::NewGuid().ToString()) | Out-Null
    Require ([CodexAccountFile]::Hash([IO.File]::ReadAllBytes($file)) -eq [CodexAccountFile]::Hash($old)) 'MISSING_RECOVERED'; Clean
    $failed = $false
    try { [CodexAccountFile]::Publish($file, $null, $null, $new, [Guid]::NewGuid().ToString()) | Out-Null } catch { $failed = $_.Exception.ToString().Contains('ACCOUNT_CACHE_CHANGED') }
    Require $failed 'MISSING_RACE_REFUSED'; Clean
    $snapshot = Reset-Source
    $acl = [IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]::new($file))
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Write', 'Allow'))
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($file), $acl)
    $failed = $false; try { Publish $snapshot | Out-Null } catch { $failed = $_.Exception.ToString().Contains('ACCOUNT_STORAGE_UNSAFE') }
    Require $failed 'UNPRIVILEGED_WRITE_REFUSED'; Clean
    [Console]::Out.WriteLine('ACCOUNT_PUBLICATION_SYNTHETIC_QA_PASSED')
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    throw
} finally {
    # Exact generated ordinary directory only; refuse unexpected leftovers instead of recursive removal.
    if ([IO.Directory]::Exists($root)) {
        if (([IO.File]::GetAttributes($root) -band [IO.FileAttributes]::ReparsePoint)) { throw 'SYNTHETIC_CLEANUP_REQUIRED' }
        if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
        [IO.Directory]::Delete($root, $false)
    }
}
