[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$HostIPv4,
    [ValidateRange(1024,65535)][int]$Port = 47831,
    [string]$SdkPath = $(if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $env:ANDROID_HOME }),
    [string]$JdkPath = $env:JAVA_HOME,
    [string]$BuildToolsVersion = '36.0.0',
    [string]$PrivateDirectory = (Join-Path $env:USERPROFILE '.codex-pocket'),
    [switch]$Unsigned
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Runtime.ps1')
. (Join-Path $PSScriptRoot 'Private-State.ps1')
if (-not (Test-PocketIP $HostIPv4)) { throw 'EXACT_TAILNET_IPV4_REQUIRED' }
if (-not $SdkPath -or -not $JdkPath -or $BuildToolsVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'ANDROID_SDK_JDK_REQUIRED' }
foreach ($directory in @($SdkPath, $JdkPath)) {
    if (-not [IO.Path]::IsPathFullyQualified($directory) -or $directory -match '["\r\n]' -or -not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'ANDROID_TOOLCHAIN_PATH_INVALID' }
}
$sdk = [IO.Path]::GetFullPath($SdkPath); $jdk = [IO.Path]::GetFullPath($JdkPath)
$tools = Join-Path $sdk ('build-tools\' + $BuildToolsVersion)
$androidJar = Join-Path $sdk 'platforms\android-36\android.jar'
foreach ($file in @("$jdk\bin\java.exe", "$jdk\bin\javac.exe", "$jdk\bin\jar.exe", "$jdk\bin\keytool.exe", "$tools\aapt2.exe", "$tools\lib\d8.jar", "$tools\zipalign.exe", "$tools\lib\apksigner.jar", $androidJar)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'ANDROID_TOOLCHAIN_MISSING' }
}
$javaVersion = & "$jdk\bin\javac.exe" --version
if ($LASTEXITCODE -ne 0 -or $javaVersion -notmatch '^javac 17(?:\.|$)') { throw 'JDK17_REQUIRED' }
$private = Get-CodexPhonePrivateDirectory
$project = Split-Path $PSScriptRoot -Parent
# New private work directory only. Never modify source resources or reuse another build.
$build = Join-Path $private ('build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $build -ErrorAction Stop | Out-Null
$classes = Join-Path $build 'classes'; $dex = Join-Path $build 'dex'; $generated = Join-Path $build 'generated'
$res = Join-Path $build 'res'
foreach ($directory in @($classes, $dex, $generated, $res)) { New-Item -ItemType Directory -Path $directory | Out-Null }
$source = Join-Path $project 'android\app\src\main'
function Invoke-BuildTool([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'ANDROID_BUILD_TOOL_FAILED' }
}
Get-ChildItem -LiteralPath (Join-Path $source 'res') | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $res -Recurse -ErrorAction Stop }
$utf8 = [Text.UTF8Encoding]::new($false)
$network = '<?xml version="1.0" encoding="utf-8"?><network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">' + $HostIPv4 + '</domain></domain-config></network-security-config>'
[IO.File]::WriteAllText((Join-Path $res 'xml\network_security_config.xml'), $network, $utf8)
$origin = 'http://' + $HostIPv4 + ':' + $Port
$configJava = 'package dev.codexpocket.app; final class PocketConfig { static final String HOST = "' + $HostIPv4 + '"; static final int PORT = ' + $Port + '; static final String ORIGIN = "' + $origin + '"; private PocketConfig() {} }'
[IO.File]::WriteAllText((Join-Path $generated 'PocketConfig.java'), $configJava, $utf8)
Invoke-BuildTool "$tools\aapt2.exe" @('compile', '--dir', $res, '-o', "$build\resources.zip")
[xml]$manifest = [IO.File]::ReadAllText("$source\AndroidManifest.xml")
$manifest.DocumentElement.SetAttribute('package', 'dev.codexpocket.app')
$manifest.Save("$build\AndroidManifest.xml")
Invoke-BuildTool "$tools\aapt2.exe" @('link', '-o', "$build\resources.apk", '-I', $androidJar, '--manifest', "$build\AndroidManifest.xml", '--java', $generated, '--min-sdk-version', '26', '--target-sdk-version', '36', '--version-code', '4', '--version-name', '0.3.0', "$build\resources.zip")
$javaFiles = @(Get-ChildItem -LiteralPath "$source\java" -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
$javaFiles += @(Get-ChildItem -LiteralPath $generated -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
# A javac argument file supports spaces and long checkout paths without cmd/batch interpolation.
$javacArgs = @('-encoding', 'UTF-8', '-source', '17', '-target', '17', '-classpath', $androidJar, '-d', $classes) + $javaFiles
$argText = ($javacArgs | ForEach-Object { '"' + $_.Replace('\', '/').Replace('"', '\"') + '"' }) -join "`n"
[IO.File]::WriteAllText("$build\javac.args", $argText, $utf8)
Invoke-BuildTool "$jdk\bin\javac.exe" @("@$build\javac.args")
Invoke-BuildTool "$jdk\bin\jar.exe" @('--create', '--file', "$build\classes.jar", '-C', $classes, '.')
Invoke-BuildTool "$jdk\bin\java.exe" @('-cp', "$tools\lib\d8.jar", 'com.android.tools.r8.D8', '--lib', $androidJar, '--min-api', '26', '--output', $dex, "$build\classes.jar")
Invoke-BuildTool "$jdk\bin\jar.exe" @('--update', '--file', "$build\resources.apk", '-C', $dex, 'classes.dex')
Invoke-BuildTool "$tools\zipalign.exe" @('-p', '4', "$build\resources.apk", "$build\aligned.apk")
$output = Join-Path $build 'codex-pocket-0.3.0-unsigned.apk'
if ($Unsigned) {
    [IO.File]::Move("$build\aligned.apk", $output)
} else {
    $key = Join-Path $private 'android-signing.p12'; $password = Join-Path $private 'android-signing-password.txt'
    if (-not ('PocketPrivateFile' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'Pocket-PrivateFile.cs') }
    $identity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($private.ToLowerInvariant())))
    $signingMutex = [Threading.Mutex]::new($false, ('Local\CodexPocket-Signing-' + $identity))
    $locked = $false; $keyLease = $null; $passwordLease = $null
    $oldPass = $env:CODEX_POCKET_SIGN_PASS
    try {
        try { $locked = $signingMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true; throw 'SIGNING_INTERRUPTED_REVIEW_MANUALLY' }
        if (-not $locked) { throw 'SIGNING_ALREADY_IN_PROGRESS' }
        if ((Test-Path -LiteralPath $key) -ne (Test-Path -LiteralPath $password)) { throw 'SIGNING_STATE_INCONSISTENT_REVIEW_MANUALLY' }
        if (-not (Test-Path -LiteralPath $key)) {
            $secret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
            $stream = [IO.File]::Open($password, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $bytes = $utf8.GetBytes($secret); $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
            $env:CODEX_POCKET_SIGN_PASS = $secret
            $stagedKey = Join-Path $build 'new-signing.p12'
            Invoke-BuildTool "$jdk\bin\keytool.exe" @('-genkeypair', '-keystore', $stagedKey, '-storetype', 'PKCS12', '-storepass:env', 'CODEX_POCKET_SIGN_PASS', '-keypass:env', 'CODEX_POCKET_SIGN_PASS', '-alias', 'codexpocket', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Codex Pocket, O=User Owned App')
            [IO.File]::Move($stagedKey, $key)
        }
        # Keep canonical CurrentUser-only, single-link handles open without write/delete sharing through signing.
        $keyLease = [PocketPrivateFile]::Open($key, 65536)
        $passwordLease = [PocketPrivateFile]::Open($password, 256)
        $secret = $passwordLease.ReadUtf8(256)
        if ($secret -notmatch '^[A-Za-z0-9+/]{43}=$') { throw 'SIGNING_PASSWORD_FORMAT_INVALID' }
        $env:CODEX_POCKET_SIGN_PASS = $secret
        $output = Join-Path $build 'codex-pocket-0.3.0-signed.apk'
        Invoke-BuildTool "$jdk\bin\java.exe" @('-jar', "$tools\lib\apksigner.jar", 'sign', '--ks', $key, '--ks-key-alias', 'codexpocket', '--ks-pass', 'env:CODEX_POCKET_SIGN_PASS', '--key-pass', 'env:CODEX_POCKET_SIGN_PASS', '--out', $output, "$build\aligned.apk")
        Invoke-BuildTool "$jdk\bin\java.exe" @('-jar', "$tools\lib\apksigner.jar", 'verify', '--verbose', $output)
    } finally {
        $env:CODEX_POCKET_SIGN_PASS = $oldPass; $secret = $null
        if ($passwordLease) { $passwordLease.Dispose() }; if ($keyLease) { $keyLease.Dispose() }
        if ($locked) { $signingMutex.ReleaseMutex() }; $signingMutex.Dispose()
    }
}
Invoke-BuildTool "$tools\zipalign.exe" @('-c', '4', $output)
Get-FileHash -LiteralPath $output -Algorithm SHA256 | Format-List
Write-Output "APK: $output"
Write-Output 'New private build retained. No install, startup, firewall, account or delivery action performed.'
