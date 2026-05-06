# Build a LocalSURV .msi from the staged dist tree.
#
# Inputs (env or params):
#   -Version 0.2.0
#   -StagingDir <path>      where the runtime files were prepped (defaults to repo root)
#   -OutFile dist\localsurv-<version>.msi
#   $env:CODE_SIGNING_THUMBPRINT  optional. signtool /sha1 thumbprint — triggers signing.
#
# Prerequisites on the build host:
#   - .NET 6+ SDK (`dotnet --version`)
#   - WiX 4 CLI (`dotnet tool install --global wix`)
#   - signtool.exe on PATH (when signing)

[CmdletBinding()]
param(
    [string] $Version = "0.0.0",
    [string] $StagingDir = (Resolve-Path "$PSScriptRoot\..\..").Path,
    [string] $OutFile = "dist\localsurv-$Version.msi"
)

$ErrorActionPreference = "Stop"

# 1. Stage the runtime tree --------------------------------------------------

$stage = Join-Path $env:TEMP "localsurv-msi-stage-$Version"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null

$includeDirs = @(
    "apps\server\dist",
    "apps\web\dist",
    "packaging\windows",
    "packaging\landing"
)
foreach ($d in $includeDirs) {
    $src = Join-Path $StagingDir $d
    if (Test-Path $src) {
        $dst = Join-Path $stage $d
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
        Copy-Item "$src\*" $dst -Recurse -Force
    }
}
foreach ($f in @("package.json", "package-lock.json", "LICENSE", "README.md", "Dockerfile")) {
    $src = Join-Path $StagingDir $f
    if (Test-Path $src) { Copy-Item $src $stage -Force }
}

# 2. Harvest staged files into a WiX fragment -------------------------------

$harvested = Join-Path $env:TEMP "localsurv-files-$Version.wxs"
& wix harvest dir $stage `
    -cg LocalSurvFiles `
    -dr INSTALLFOLDER `
    -srd `
    -ke `
    -sreg `
    -out $harvested
if ($LASTEXITCODE -ne 0) { throw "wix harvest failed" }

# 3. Build the .msi ---------------------------------------------------------

$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

& wix build (Join-Path $PSScriptRoot "localsurv.wxs") $harvested `
    -d Version=$Version `
    -d StagingDir=$stage `
    -bindpath $stage `
    -o $OutFile
if ($LASTEXITCODE -ne 0) { throw "wix build failed" }

# 4. Sign (optional) --------------------------------------------------------

if ($env:CODE_SIGNING_THUMBPRINT) {
    Write-Host "[build-msi] signing $OutFile with $env:CODE_SIGNING_THUMBPRINT" -ForegroundColor Cyan
    & signtool sign /a /sha1 $env:CODE_SIGNING_THUMBPRINT `
        /tr http://timestamp.digicert.com /td sha256 /fd sha256 `
        $OutFile
    if ($LASTEXITCODE -ne 0) { throw "signtool sign failed" }
} else {
    Write-Host "[build-msi] CODE_SIGNING_THUMBPRINT not set — emitting unsigned .msi" -ForegroundColor Yellow
}

Write-Host "[build-msi] wrote $OutFile" -ForegroundColor Green
