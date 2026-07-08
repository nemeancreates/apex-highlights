# Pinned stable FFmpeg build — n7.1 series, broad NVIDIA driver compatibility
$FFmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-shared-7.1.zip"
$ClientRoot = Split-Path -Parent $PSScriptRoot
$FFmpegDir  = Join-Path $ClientRoot "ffmpeg"
$TempZip    = Join-Path $env:TEMP "peakabu-ffmpeg.zip"
$TempExtract = Join-Path $env:TEMP "peakabu-ffmpeg-extract"

Write-Host "Downloading FFmpeg stable build..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $FFmpegUrl -OutFile $TempZip -UseBasicParsing

Write-Host "Extracting..." -ForegroundColor Cyan
if (Test-Path $TempExtract) { Remove-Item $TempExtract -Recurse -Force }
Expand-Archive -Path $TempZip -DestinationPath $TempExtract -Force

$BinDir = Get-ChildItem -Path $TempExtract -Recurse -Directory | Where-Object { $_.Name -eq "bin" } | Select-Object -First 1
if (-not $BinDir) { throw "Could not locate bin/ inside extracted archive" }

Write-Host "Replacing client/ffmpeg/ contents..." -ForegroundColor Cyan
if (Test-Path $FFmpegDir) { Remove-Item $FFmpegDir -Recurse -Force }
New-Item -ItemType Directory -Path $FFmpegDir | Out-Null
Copy-Item -Path (Join-Path $BinDir.FullName "*") -Destination $FFmpegDir -Recurse -Force

Remove-Item $TempZip -Force
Remove-Item $TempExtract -Recurse -Force

Write-Host "Done. Contents of client/ffmpeg/:" -ForegroundColor Green
Get-ChildItem $FFmpegDir | Select-Object Name, Length
& (Join-Path $FFmpegDir "ffmpeg.exe") -version | Select-Object -First 1