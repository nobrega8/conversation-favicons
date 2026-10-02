# Empacota o add-on em dist/conversation-favicons-<versão>.xpi
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json).version
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$xpi = Join-Path $dist "conversation-favicons-$version.xpi"
if (Test-Path $xpi) { Remove-Item $xpi }

$files = @("manifest.json", "settings.js", "background.js", "icon.svg", "api/schema.json", "api/implementation.js", "options/options.html", "options/options.css", "options/options.js", "assign/assign.html", "assign/assign.css", "assign/assign.js", "consent/consent.html", "consent/consent.css", "consent/consent.js", "LICENSE")
$zip = [System.IO.Compression.ZipFile]::Open($xpi, "Create")
try {
  foreach ($f in $files) {
    # As entradas do zip têm de usar "/" (o Compress-Archive do PS 5.1 usa "\").
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $f), $f) | Out-Null
  }
} finally {
  $zip.Dispose()
}
Write-Host "Criado $xpi"
