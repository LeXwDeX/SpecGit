# Download, verify and install the standalone SpecGit executable.
param(
    [string]$Version = 'latest',
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'SpecGit\bin')
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $env:PROCESSOR_ARCHITEW6432) {
    throw 'Run 64-bit PowerShell on Windows x64. Other architectures are unsupported.'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = 'https://github.com/LeXwDeX/SpecGit'
if ($Version -eq 'latest') {
    $release = Invoke-RestMethod -TimeoutSec 180 -Uri 'https://api.github.com/repos/LeXwDeX/SpecGit/releases/latest'
    if ($release.draft -or $release.prerelease) { throw 'A stable release is required.' }
    $Version = $release.tag_name
}
$Version = $Version -replace '^v', ''
if ($Version -cnotmatch '^\d+\.\d+\.\d+$') { throw 'Use a stable version such as 2.0.0, or latest.' }
$archive = "specgit-win32-x64-$Version.tgz"
$base = "$repo/releases/download/v$Version"
$scratch = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
$staged = $null
try {
    New-Item -ItemType Directory -Path $scratch | Out-Null
    $sums = Join-Path $scratch 'SHASUMS256.txt'
    $packed = Join-Path $scratch $archive
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 180 -Uri "$base/SHASUMS256.txt" -OutFile $sums
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 180 -Uri "$base/$archive" -OutFile $packed
    $entries = @(Get-Content $sums | Where-Object { $_ -cmatch ('^[0-9a-f]{64}  ' + [Regex]::Escape($archive) + '$') })
    if ($entries.Count -ne 1) { throw 'Missing or invalid archive checksum.' }
    $expected = $entries[0].Substring(0, 64)
    if ((Get-FileHash -Algorithm SHA256 $packed).Hash.ToLowerInvariant() -cne $expected) {
        throw 'SHA-256 mismatch; existing installation was preserved.'
    }
    # GNU tar also appears on Windows PATH; drive-letter archive arguments are
    # interpreted as remote hosts. Select the directory separately.
    Push-Location -LiteralPath $scratch
    try {
        & tar -xzf "./$archive" package/bin/specgit.exe
        if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the native executable.' }
    } finally {
        Pop-Location
    }
    $binary = Join-Path $scratch 'package\bin\specgit.exe'
    $reported = & $binary --human --version
    if ($LASTEXITCODE -ne 0 -or $reported -cne "specgit $Version") { throw 'Native version/platform check failed.' }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $destination = Join-Path $InstallDir 'specgit.exe'
    $staged = Join-Path $InstallDir ('.specgit-install-' + [Guid]::NewGuid().ToString('N') + '.exe')
    Copy-Item -LiteralPath $binary -Destination $staged
    if (Test-Path -LiteralPath $destination) {
        [IO.File]::Replace($staged, $destination, $null)
    } else {
        [IO.File]::Move($staged, $destination)
    }
    $staged = $null
    Write-Output "Installed SpecGit $Version at $destination"
    Write-Output "Add $InstallDir to PATH if needed."
} finally {
    if ($staged -and (Test-Path -LiteralPath $staged)) { Remove-Item -LiteralPath $staged -Force }
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
