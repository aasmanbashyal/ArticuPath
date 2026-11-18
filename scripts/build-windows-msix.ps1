param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9A-Fa-f]{64}$')][string] $ArchiveSha256,
  [string] $ArchivePath,
  [string] $MakeAppxPath
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$release = (Get-Content -Raw -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json).version
$dist = Join-Path $repo "dist/microsoft-store/v$release"
if (-not $ArchivePath) {
  $ArchivePath = Join-Path $repo "dist/release-v$release/Rehearsal-windows-x64-standalone.zip"
}
if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ne $ArchiveSha256) {
  throw 'The standalone ZIP does not match the release SHA-256.'
}
if (-not $MakeAppxPath) {
  $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
  $MakeAppxPath = Get-ChildItem -Path "$sdk/*/x64/makeappx.exe" -File |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $MakeAppxPath) { throw 'Install the Windows SDK or specify -MakeAppxPath.' }

$assets = Join-Path $PSScriptRoot 'msix'
[xml]$manifest = Get-Content -Raw -LiteralPath (Join-Path $assets 'AppxManifest.xml')
$appVersion = [version]$release
# Offset the app major by one because the Store reserves zero.
$storeVersion = '{0}.{1}.{2}.0' -f ($appVersion.Major + 1), $appVersion.Minor, $appVersion.Build
$manifest.Package.Identity.SetAttribute('Version', $storeVersion)
$output = Join-Path $dist "Rehearsal-$storeVersion-x64.msix"
$stage = [IO.Directory]::CreateDirectory((Join-Path $dist ('.build-' + [guid]::NewGuid()))).FullName
try {
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath (Join-Path $stage 'zip')
  $payload = Join-Path $stage 'payload'
  [void][IO.Directory]::CreateDirectory((Join-Path $payload 'resources'))
  foreach ($file in 'Rehearsal.exe', 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'resources/Third-party.md') {
    Copy-Item -LiteralPath (Join-Path "$stage/zip/Rehearsal" $file) -Destination (Join-Path $payload $file)
  }
  [void][IO.Directory]::CreateDirectory((Join-Path $payload 'Assets'))
  foreach ($logo in 'StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png') {
    Copy-Item -LiteralPath (Join-Path "$assets/Assets" $logo) -Destination "$payload/Assets"
  }
  $manifest.Save((Join-Path $payload 'AppxManifest.xml'))
  $package = Join-Path $stage 'release.msix'
  & $MakeAppxPath pack /d $payload /p $package /h SHA256
  if ($LASTEXITCODE -ne 0) { throw "MakeAppx pack exited with code $LASTEXITCODE." }
  Move-Item -LiteralPath $package -Destination $output -Force
  Get-FileHash -LiteralPath $output -Algorithm SHA256
} finally {
  $resolved = (Resolve-Path -LiteralPath $stage).Path
  if ((Split-Path -Parent $resolved) -ne (Resolve-Path -LiteralPath $dist).Path) {
    throw 'Unexpected MSIX staging directory.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
