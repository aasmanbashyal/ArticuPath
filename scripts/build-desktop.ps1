param([switch] $FullMedia)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dist = [IO.Directory]::CreateDirectory((Join-Path $repo 'dist')).FullName
$cache = [IO.Directory]::CreateDirectory((Join-Path $dist '.downloads')).FullName

function Run([string] $Program, [string[]] $Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE." }
}

$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
if ($cargo) {
  $cargoPath = $cargo.Source
} else {
  $rust = Join-Path $repo '.rust'
  $env:CARGO_HOME = Join-Path $rust 'cargo'
  $env:RUSTUP_HOME = Join-Path $rust 'rustup'
  $cargoPath = Join-Path $env:CARGO_HOME 'bin/cargo.exe'
  if (-not (Test-Path -LiteralPath $cargoPath)) { throw 'Install Rust with the Windows x64 MSVC toolchain before building Rehearsal.' }
}

$programFiles = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$vswhere = Join-Path $programFiles 'Microsoft Visual Studio/Installer/vswhere.exe'
$runtimePath = & $vswhere -latest -products '*' -find 'VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT\msvcp140.dll' | Select-Object -First 1
if (-not $runtimePath) { throw 'Visual Studio Build Tools with the x64 C++ redistributable files are required to build Rehearsal.' }
$runtime = Split-Path -Parent $runtimePath

$release = 'autobuild-2026-11-11-12-39'
$media = 'ffmpeg-n9.0.2-49-gc179411bbb-win64-lgpl-shared-9.0'
$url = "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/$release/$media.zip"
$sha256 = '4ac2a4a732ee66707ab2a4d7fc135d085e1da691f365cdb2f1b48f8f3816d4d8'
$download = Join-Path $cache "$media.zip"
if ($FullMedia -and (-not (Test-Path -LiteralPath $download) -or (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $sha256)) {
  $tempDownload = "$download.partial"
  try {
    Run 'curl.exe' @('--fail', '--silent', '--show-error', '--location', '--output', $tempDownload, $url)
    if ((Get-FileHash -LiteralPath $tempDownload -Algorithm SHA256).Hash -ne $sha256) { throw 'FFmpeg checksum mismatch.' }
    Move-Item -LiteralPath $tempDownload -Destination $download -Force
  } finally {
    Remove-Item -LiteralPath $tempDownload -Force -ErrorAction SilentlyContinue
  }
}

$manifest = Join-Path $repo 'desktop-rust/Cargo.toml'
$rustTarget = 'x86_64-pc-windows-msvc'
$targetDir = Join-Path $repo 'desktop-rust/target'
$build = @('build','--locked','--release','--target',$rustTarget,'--target-dir',$targetDir,'--manifest-path',$manifest)
if ($FullMedia) { $build += @('--features','full-media') }
Run $cargoPath $build

$stage = [IO.Directory]::CreateDirectory((Join-Path $dist ('.rust-build-' + [guid]::NewGuid()))).FullName
try {
  $app = [IO.Directory]::CreateDirectory((Join-Path $stage 'Rehearsal')).FullName
  $resources = [IO.Directory]::CreateDirectory((Join-Path $app 'resources')).FullName
  Copy-Item -LiteralPath (Join-Path $targetDir "$rustTarget/release/rehearse.exe") -Destination (Join-Path $app 'Rehearsal.exe')
  foreach ($file in @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
    Copy-Item -LiteralPath (Join-Path $runtime $file) -Destination $app
  }
  $notices = @"
# Included software

- Microsoft Visual C++ runtime. https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
"@
  if ($FullMedia) {
    Run 'tar.exe' @('-xf', $download, '-C', $stage, "$media/bin", "$media/LICENSE.txt")
    $mediaDir = Join-Path $resources 'media'
    $unpackedMedia = (Resolve-Path -LiteralPath (Join-Path $stage "$media/bin")).Path
    if (-not $unpackedMedia.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected unpacked media directory.' }
    Move-Item -LiteralPath $unpackedMedia -Destination $mediaDir
    Remove-Item -LiteralPath (Join-Path $mediaDir 'ffplay.exe')
    Copy-Item -LiteralPath (Join-Path $stage "$media/LICENSE.txt") -Destination $mediaDir
    $notices += @"

- FFmpeg LGPL shared build. https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/$release
- FFmpeg source. https://github.com/FFmpeg/FFmpeg/tree/c179411bbb
"@
  } else {
    $notices += @"

- Symphonia audio decoders and media readers. https://github.com/pdeljanov/Symphonia
- Symphonia Opus decoder. https://crates.io/crates/symphonia-opus
- Rubato audio resampler. https://github.com/HEnquist/rubato
"@
  }
  Set-Content -LiteralPath (Join-Path $resources 'Third-party.md') -Value $notices -Encoding UTF8
  $archive = if ($FullMedia) { 'Rehearsal-windows-x64-full-media.zip' } else { 'Rehearsal-windows-x64-standalone.zip' }
  Run 'tar.exe' @('-a', '-cf', (Join-Path $stage $archive), '-C', $stage, 'Rehearsal')
  $output = Join-Path $dist $archive
  Move-Item -LiteralPath (Join-Path $stage $archive) -Destination $output -Force
  Write-Output "$output ($([math]::Round((Get-Item -LiteralPath $output).Length / 1MB, 1)) MiB)"
} finally {
  $resolved = (Resolve-Path -LiteralPath $stage).Path
  if ((Split-Path -Parent $resolved) -ne $dist) { throw 'Unexpected build directory.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
