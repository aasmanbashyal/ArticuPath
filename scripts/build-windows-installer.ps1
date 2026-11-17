param([string] $CompilerPath = 'ISCC.exe')

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repo 'dist'
$archive = Join-Path $dist 'ArticuPath-windows-x64-standalone.zip'
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
  throw 'Run scripts/build-desktop.ps1 to create the Windows ZIP first.'
}

$compiler = Get-Command $CompilerPath -CommandType Application -ErrorAction SilentlyContinue
if (-not $compiler) {
  throw 'Install Inno Setup and pass -CompilerPath with the path to ISCC.exe.'
}

$version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$stage = [IO.Directory]::CreateDirectory((Join-Path $dist ('.installer-' + [guid]::NewGuid()))).FullName
try {
  Expand-Archive -LiteralPath $archive -DestinationPath $stage
  $payload = Join-Path $stage 'ArticuPath'
  if (-not (Test-Path -LiteralPath (Join-Path $payload 'ArticuPath.exe') -PathType Leaf)) {
    throw 'The Windows ZIP does not contain ArticuPath.exe in its expected folder.'
  }

  $definition = Join-Path $PSScriptRoot 'windows-installer.iss'
  & $compiler.Source "/DArticuPathVersion=$version" "/DPayloadDir=$payload" "/O$dist" $definition
  if ($LASTEXITCODE -ne 0) { throw "ISCC exited with code $LASTEXITCODE." }
} finally {
  $resolved = (Resolve-Path -LiteralPath $stage).Path
  if ((Split-Path -Parent $resolved) -ne (Resolve-Path -LiteralPath $dist).Path) {
    throw 'Unexpected installer staging directory.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
