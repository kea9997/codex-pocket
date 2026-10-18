param([ValidateSet('staged','held','published')][string]$Phase, [string]$FixtureRoot)
# Dies only in this synthetic helper process, proving kernel cleanup after an interrupted publication.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$parent = [IO.Path]::GetTempPath().TrimEnd('\')
if ([IO.Path]::GetDirectoryName($FixtureRoot) -cne $parent -or [IO.Path]::GetFileName($FixtureRoot) -notmatch '^CodexPhone-Crash-QA-[a-f0-9-]{36}$' -or -not [IO.Directory]::Exists($FixtureRoot) -or @([IO.Directory]::GetFileSystemEntries($FixtureRoot)).Count -ne 0 -or ([IO.File]::GetAttributes($FixtureRoot) -band [IO.FileAttributes]::ReparsePoint)) { throw 'SYNTHETIC_BOUNDARY' }
Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'Account-File.cs'))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($FixtureRoot), $acl)
$file = [IO.Path]::Combine($FixtureRoot, 'auth.json')
$old = [Text.Encoding]::UTF8.GetBytes('synthetic crash previous only')
$new = [Text.Encoding]::UTF8.GetBytes('synthetic crash target only')
[IO.File]::WriteAllBytes($file, $old)
$transaction = [Guid]::NewGuid().ToString()
$source = [CodexAccountFile]::ReadCache($file)
$plain = [Text.Encoding]::UTF8.GetBytes((@{ previous = [Convert]::ToBase64String($old); target = [Convert]::ToBase64String($new); fileId = $source.FileId; transaction = $transaction } | ConvertTo-Json -Compress))
$encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$stream = [IO.File]::Open([IO.Path]::Combine($FixtureRoot, 'recovery.bin'), 'CreateNew', 'Write', 'None')
try { $stream.Write($encrypted); $stream.Flush($true) } finally { $stream.Dispose(); [Array]::Clear($plain) }
[CodexAccountFile]::Publish($file, [CodexAccountFile]::Hash($old), $source.FileId, $new, $transaction, [Action[string]]{ param($at) if ($at -eq $Phase) { [Environment]::Exit(77) } }) | Out-Null
throw 'SYNTHETIC_CHECKPOINT_NOT_REACHED'
