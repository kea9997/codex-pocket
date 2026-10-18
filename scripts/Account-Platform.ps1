# Private stdin/stdout protocol for this bridge only. Never run with real credentials for QA.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'Account-File.cs')) | Out-Null
function Assert-Path([string]$Path, [bool]$File, [bool]$Missing = $false) {
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\') -or [IO.Path]::GetFullPath($Path) -cne $Path -or $Path -match '[\x00-\x1f]') { throw 'ACCOUNT_STORAGE_UNSAFE' }
    $parts = $Path.Substring([IO.Path]::GetPathRoot($Path).Length).Split([IO.Path]::DirectorySeparatorChar)
    $current = [IO.Path]::GetPathRoot($Path)
    foreach ($part in $parts) {
        if (-not $part -or $part -match '[<>:"|?*]|[. ]$') { throw 'ACCOUNT_STORAGE_UNSAFE' }
        $current = [IO.Path]::Combine($current, $part)
        if ($Missing -and $current -eq $Path -and -not [IO.File]::Exists($current) -and -not [IO.Directory]::Exists($current)) { return }
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint -or (($current -ne $Path -or -not $File) -and -not $item.PSIsContainer)) { throw 'ACCOUNT_STORAGE_UNSAFE' }
    }
    if ($File) { [CodexAccountFile]::CheckFile($Path) }
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function Assert-Acl([string]$Path, [bool]$Private) {
    $item = Get-Item -LiteralPath $Path -Force
    $acl = [IO.FileSystemAclExtensions]::GetAccessControl($item, ([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner))
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'ACCOUNT_STORAGE_UNSAFE' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($Private -and (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1)) { throw 'ACCOUNT_STORAGE_UNSAFE' }
    $own = $false
    foreach ($r in $rules) {
        if ($r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { throw 'ACCOUNT_STORAGE_UNSAFE' }
        if ($r.IdentityReference.Value -eq $sid.Value -and ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $own = $true }
        elseif ($Private -or ($r.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544') -and ([int]$r.FileSystemRights -band (-bnot [int]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize))) -ne 0)) { throw 'ACCOUNT_STORAGE_UNSAFE' }
    }
    if (-not $own) { throw 'ACCOUNT_STORAGE_UNSAFE' }
}
function Set-PrivateAcl([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($Directory) { $acl = [Security.AccessControl.DirectorySecurity]::new(); $flags = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit }
    else { $acl = [Security.AccessControl.FileSecurity]::new(); $flags = [Security.AccessControl.InheritanceFlags]::None }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $flags, 'None', 'Allow'))
    [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl)
    Assert-Acl $Path $true
}
function Get-Package {
    $packages = @(Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' })
    if ($packages.Count -ne 1) { throw 'ACCOUNT_APP_UNAVAILABLE' }
    $package = $packages[0]
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    $apps = @($manifest.Package.Applications.Application | Where-Object { $_.Id -eq 'App' -and $_.Executable -eq 'app/ChatGPT.exe' })
    if ($apps.Count -ne 1) { throw 'ACCOUNT_APP_UNAVAILABLE' }
    $exe = [IO.Path]::Combine($package.InstallLocation, 'app', 'ChatGPT.exe')
    Assert-Path $exe $true
    return @{ executable = $exe; aumid = 'OpenAI.Codex_2p2nqsd0c76g0!App' }
}
function Get-ProcessSnapshot($Row) {
    $p = [Diagnostics.Process]::GetProcessById($Row.ProcessId)
    try { return @{ pid = $p.Id; started = $p.StartTime.ToUniversalTime().Ticks.ToString(); window = ($p.MainWindowHandle -ne [IntPtr]::Zero) } }
    finally { $p.Dispose() }
}
function Get-Gui($Package) {
    $rows = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'")
    if ($rows.Count -gt 128) { throw 'ACCOUNT_APP_UNAVAILABLE' }
    $guiRows = @()
    foreach ($row in $rows) {
        if ($row.ExecutablePath -ine $Package.executable) { continue }
        $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid
        if ($owner.ReturnValue -ne 0) { throw 'ACCOUNT_APP_UNAVAILABLE' }
        if ($owner.Sid -ne $sid.Value) { continue }
        $entry = Get-ProcessSnapshot $row
        $entry.root = ($row.CommandLine -notmatch '(?:^|\s)--type='); $guiRows += $entry
    }
    # Only exact current-user native descendants of these GUI instances, never unrelated CLI workers.
    $native = @(Get-CimInstance Win32_Process -Filter "Name='codex.exe'")
    if ($native.Count -gt 256) { throw 'ACCOUNT_APP_UNAVAILABLE' }
    for ($depth = 0; $depth -lt 16; $depth++) {
        $added = $false
        foreach ($row in $native) {
            if (@($guiRows | ForEach-Object { $_.pid }) -contains [int]$row.ProcessId) { continue }
            $parent = @($guiRows | Where-Object { $_.pid -eq [int]$row.ParentProcessId })
            if ($parent.Count -ne 1) { continue }
            $nativeRoot = [IO.Path]::Combine($env:LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') + '\'
            if (-not $row.ExecutablePath -or -not $row.ExecutablePath.StartsWith($nativeRoot, [StringComparison]::OrdinalIgnoreCase) -or $row.ExecutablePath.Substring($nativeRoot.Length) -notmatch '^[a-f0-9]{16}\\codex\.exe$') { throw 'ACCOUNT_APP_UNAVAILABLE' }
            Assert-Path $row.ExecutablePath $true
            $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid
            if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid.Value) { throw 'ACCOUNT_APP_UNAVAILABLE' }
            $entry = Get-ProcessSnapshot $row
            if ([long]$entry.started -lt [long]$parent[0].started) { throw 'ACCOUNT_APP_UNAVAILABLE' }
            $entry.window = $false; $entry.root = $false; $entry.native = $true; $guiRows += $entry
            $added = $true
        }
        if (-not $added) { return $guiRows }
    }
    throw 'ACCOUNT_APP_UNAVAILABLE'
}
function Open-GuiProcess($Row) {
    $p = [Diagnostics.Process]::GetProcessById($Row.pid)
    try {
        if ($p.StartTime.ToUniversalTime().Ticks.ToString() -cne $Row.started) { throw 'ACCOUNT_DESKTOP_CLOSE_REQUIRED' }
        $p.Handle | Out-Null; return $p
    } catch { $p.Dispose(); throw }
}
function Wait-GuiExit($Package, $Tracked, [int]$Seconds = 15) {
    $additional = @(); $end = [DateTime]::UtcNow.AddSeconds($Seconds)
    try {
        do {
            Start-Sleep -Milliseconds 200; $remaining = @(Get-Gui $Package)
            foreach ($row in $remaining) {
                if (@(($Tracked + $additional) | ForEach-Object { $_.Id }) -notcontains $row.pid) { $additional += (Open-GuiProcess $row) }
            }
            $alive = @(($Tracked + $additional) | Where-Object { -not $_.HasExited })
        } while (($remaining.Count -gt 0 -or $alive.Count -gt 0) -and [DateTime]::UtcNow -lt $end)
        if ($remaining.Count -gt 0 -or $alive.Count -gt 0) { throw 'ACCOUNT_DESKTOP_CLOSE_REQUIRED' }
    } finally { foreach ($p in $additional) { $p.Dispose() } }
}
try {
    $line = [Console]::In.ReadLine()
    if (-not $line -or $line.Length -gt 1500000) { throw 'ACCOUNT_STORAGE_UNSAFE' }
    $r = $line | ConvertFrom-Json -AsHashtable
    $result = @{}
    switch ($r.action) {
        'protect' { $result.data = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($r.data), [Text.Encoding]::UTF8.GetBytes('CodexPhone.Accounts.v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)) }
        'unprotect' { $result.data = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($r.data), [Text.Encoding]::UTF8.GetBytes('CodexPhone.Accounts.v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)) }
        'private' { Assert-Path $r.path $r.file; Assert-Acl $r.path $true }
        'prepare' {
            Assert-Path $r.root $false; Assert-Acl $r.root $true
            if ([IO.Path]::GetDirectoryName($r.path) -cne $r.root) { throw 'ACCOUNT_STORAGE_UNSAFE' }
            if (-not [IO.Directory]::Exists($r.path)) { [IO.Directory]::CreateDirectory($r.path) | Out-Null; Set-PrivateAcl $r.path $true }
            Assert-Path $r.path $false; Assert-Acl $r.path $true
        }
        'cache' {
            $cache = [CodexAccountFile]::ReadCache($r.path)
            try { $result.data = [Convert]::ToBase64String($cache.Bytes); $result.fileId = $cache.FileId }
            finally { [Array]::Clear($cache.Bytes) }
        }
        'install' {
            $bytes = [Convert]::FromBase64String($r.data)
            try { $result.fileId = [CodexAccountFile]::Publish($r.path, $r.expected, $r.fileId, $bytes, $r.transaction) }
            finally { [Array]::Clear($bytes) }
        }
        'replace' {
            # Only broker-owned encrypted state; shared auth uses exact-handle no-overwrite publication.
            if (-not $r.private -or [IO.Path]::GetFileName($r.path) -cne 'profiles.bin') { throw 'ACCOUNT_STORAGE_UNSUPPORTED' }
            $parent = [IO.Path]::GetDirectoryName($r.path)
            Assert-Path $parent $false; if ($r.private) { Assert-Acl $parent $true }
            Assert-Path $r.path $true $true
            if ([IO.File]::Exists($r.path)) { Assert-Acl $r.path ([bool]$r.private) }
            $bytes = [Convert]::FromBase64String($r.data)
            if ($bytes.Length -lt 1 -or $bytes.Length -gt 524288 -or $r.transaction -notmatch '^[a-f0-9-]{36}$') { throw 'ACCOUNT_STORAGE_UNSAFE' }
            $staged = [IO.Path]::Combine($parent, '.codex-phone-' + $r.transaction + '.new')
            $held = [IO.Path]::Combine($parent, '.codex-phone-' + $r.transaction + '.old')
            if ([IO.File]::Exists($held) -or [IO.Directory]::Exists($held)) { throw 'ACCOUNT_RECOVERY_REQUIRED' }
            $stream = [IO.File]::Open($staged, 'CreateNew', 'Write', 'None')
            try { Set-PrivateAcl $staged $false; $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
            try {
                if ($r.private -and $null -ne $r.expected) {
                    # Single broker encrypted state: atomic replacement keeps its recovery record crash-durable.
                    $old = [IO.File]::ReadAllBytes($r.path)
                    $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($old)).ToLowerInvariant()
                    if ($actual -cne $r.expected) { throw 'ACCOUNT_CACHE_CHANGED' }
                    [CodexAccountFile]::ReplaceStore($staged, $r.path)
                } else { [IO.File]::Move($staged, $r.path, $false) }
                Assert-Path $r.path $true; Assert-Acl $r.path $true
            } finally {
                if ([IO.File]::Exists($staged)) {
                    Assert-Path $staged $true; Assert-Acl $staged $true
                    $left = [IO.File]::ReadAllBytes($staged)
                    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($left)) -cne [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))) { throw 'ACCOUNT_STORAGE_UNSAFE' }
                    [IO.File]::Delete($staged)
                }
            }
        }
        'policy' {
            foreach ($key in @('HKLM:\SOFTWARE\Policies\OpenAI\Codex', 'HKCU:\SOFTWARE\Policies\OpenAI\Codex')) { if (Test-Path -LiteralPath $key) { throw 'ACCOUNT_STORAGE_UNSUPPORTED' } }
            foreach ($root in @([IO.Path]::Combine($env:ProgramData, 'OpenAI', 'Codex'), [IO.Path]::Combine($env:ProgramData, 'codex'))) {
                foreach ($name in @('requirements.toml', 'managed_config.toml')) { if (Test-Path -LiteralPath ([IO.Path]::Combine($root, $name))) { throw 'ACCOUNT_STORAGE_UNSUPPORTED' } }
            }
        }
        'inspect' { $package = Get-Package; $result = @{ package = $package; processes = @(Get-Gui $package) } }
        'close' {
            $package = Get-Package; $rows = @(Get-Gui $package); $roots = @($rows | Where-Object { $_.root })
            if ($package.executable -cne $r.executable -or $roots.Count -ne 1 -or $roots[0].pid -ne $r.pid -or $roots[0].started -cne $r.started -or -not $roots[0].window) { throw 'ACCOUNT_DESKTOP_CLOSE_REQUIRED' }
            $tracked = @()
            try {
                foreach ($row in $rows) {
                    $tracked += (Open-GuiProcess $row)
                }
                $p = @($tracked | Where-Object { $_.Id -eq $r.pid })[0]
                if (-not $p.CloseMainWindow()) { throw 'ACCOUNT_DESKTOP_CLOSE_REQUIRED' }
                Wait-GuiExit $package $tracked
            } finally { foreach ($owned in $tracked) { $owned.Dispose() } }
        }
        'launch' {
            $package = Get-Package
            if ($package.executable -cne $r.executable -or @(Get-Gui $package).Count -ne 0) { throw 'ACCOUNT_APP_CHANGED' }
            Start-Process -WindowStyle Hidden -FilePath ([IO.Path]::Combine($env:SystemRoot, 'explorer.exe')) -ArgumentList ('shell:AppsFolder\' + $package.aumid) | Out-Null
        }
        default { throw 'ACCOUNT_PLATFORM_UNAVAILABLE' }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
} catch {
    # Never print exception messages, child output, paths or data from credentials.
    $code = 'ACCOUNT_PLATFORM_FAILED'
    foreach ($known in @('ACCOUNT_STORAGE_UNSAFE','ACCOUNT_CACHE_BUSY','ACCOUNT_CACHE_UNSUPPORTED','ACCOUNT_CACHE_CHANGED','ACCOUNT_STORAGE_UNSUPPORTED','ACCOUNT_APP_UNAVAILABLE','ACCOUNT_APP_CHANGED','ACCOUNT_DESKTOP_CLOSE_REQUIRED','ACCOUNT_RECOVERY_REQUIRED')) {
        if ($_.Exception.ToString().Contains($known)) { $code = $known; break }
    }
    [Console]::Out.WriteLine('{"error":"' + $code + '"}')
    exit 1
}
