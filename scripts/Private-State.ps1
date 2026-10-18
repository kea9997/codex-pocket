Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-CodexPhonePrivateDirectory {
    param([string]$Path = $PrivateDirectory)
    if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'WINDOWS_POWERSHELL7_REQUIRED' }
    if (-not $Path -or -not [IO.Path]::IsPathFullyQualified($Path) -or $Path -match '["\r\n]' -or $Path.StartsWith('\\')) { throw 'PRIVATE_DIRECTORY_ABSOLUTE_REQUIRED' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.TrimEnd('\') -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw 'PRIVATE_DIRECTORY_LOCATION_REJECTED' }
    $root = $full.TrimEnd('\')
    if ($root -eq $env:USERPROFILE -or $env:USERPROFILE.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'PRIVATE_DIRECTORY_LOCATION_REJECTED' }
    $project = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
    foreach ($forbidden in @($project, $env:APPDATA, $env:LOCALAPPDATA)) {
        if ($forbidden -and ($root -eq $forbidden -or $root.StartsWith($forbidden.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'PRIVATE_DIRECTORY_LOCATION_REJECTED' }
    }
    $ancestor = $root
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $entry = Get-Item -LiteralPath $ancestor -Force
            if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'PRIVATE_DIRECTORY_REPARSE_POINT' }
        }
        $ancestor = Split-Path $ancestor -Parent
    }
    if (-not (Test-Path -LiteralPath $root)) { [IO.Directory]::CreateDirectory($root) | Out-Null }
    $marker = Join-Path $root '.pocket-private'
    if (-not (Test-Path -LiteralPath $marker) -and @(Get-ChildItem -LiteralPath $root -Force).Count -ne 0) { throw 'PRIVATE_DIRECTORY_NOT_DEDICATED' }
    $item = Get-Item -LiteralPath $root -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PRIVATE_DIRECTORY_REPARSE_POINT' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $current = [IO.FileSystemAclExtensions]::GetAccessControl($item, ([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner))
    if ($current.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'PRIVATE_DIRECTORY_OWNER_MISMATCH' }
    $rules = @($current.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $valid = $current.AreAccessRulesProtected -and $rules.Count -eq 1 -and
        $rules[0].IdentityReference.Value -eq $sid.Value -and
        $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        ($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and
        ($rules[0].InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -and
        ($rules[0].InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -and
        $rules[0].PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
    if (-not $valid) {
        # Change DACL only. Never set ownership, group or SACL; no admin privilege required.
        $dacl = New-Object Security.AccessControl.DirectorySecurity
        $dacl.SetAccessRuleProtection($true, $false)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $dacl.AddAccessRule($rule)
        [IO.FileSystemAclExtensions]::SetAccessControl($item, $dacl)
    }
    $verify = [IO.FileSystemAclExtensions]::GetAccessControl($item, [Security.AccessControl.AccessControlSections]::Access)
    $verifiedRules = @($verify.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $verify.AreAccessRulesProtected -or $verifiedRules.Count -ne 1 -or
        $verifiedRules[0].IdentityReference.Value -ne $sid.Value -or
        $verifiedRules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        ($verifiedRules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $verifiedRules[0].InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
        $verifiedRules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'PRIVATE_DACL_VERIFICATION_FAILED' }
    if (-not (Test-Path -LiteralPath $marker)) {
        $stream = [IO.File]::Open($marker, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $bytes = [Text.Encoding]::UTF8.GetBytes('CodexPocket private directory v1'); $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
    }
    if (-not ('PocketPrivateFile' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'Pocket-PrivateFile.cs') }
    $lease = [PocketPrivateFile]::Open($marker, 128)
    try { if ($lease.ReadUtf8(128) -cne 'CodexPocket private directory v1') { throw 'PRIVATE_DIRECTORY_MARKER_INVALID' } } finally { $lease.Dispose() }
    return $root
}
