<#
.SYNOPSIS
    Downloads the whisper.cpp binaries and a ggml model that dsh-voice-widget needs.

.DESCRIPTION
    Everything lands under %LOCALAPPDATA%\dsh-voice-widget\whisper by default:

        cuda\Release\whisper-server.exe   CUDA build, loaded once and kept warm (default path)
        bin\whisper-cli.exe               CPU build, fallback when CUDA is unavailable
        models\ggml-*.bin                 transcription model

    GitHub release assets are fetched through gh-proxy.com and models through
    hf-mirror.com first, because both hosts are frequently unreachable from
    mainland China. Failures fall back to the original URLs.

.PARAMETER CpuOnly
    Skip the CUDA build (about 650 MB). Transcription will run on the CPU.

.PARAMETER Model
    Model file name to download, default ggml-large-v3-q5_0.bin.
    Pick something smaller for weak machines: ggml-medium-q5_0.bin,
    ggml-small-q5_1.bin.

.PARAMETER Dest
    Target root, default %LOCALAPPDATA%\dsh-voice-widget\whisper.

.PARAMETER SkipModel
    Only fetch the binaries.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1 -CpuOnly -Model ggml-small-q5_1.bin
#>
[CmdletBinding()]
param(
    [switch]$CpuOnly,
    [string]$Model = 'ggml-large-v3-q5_0.bin',
    [string]$Dest,
    [switch]$SkipModel
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$tag = 'b5454'
if (-not $Dest) { $Dest = Join-Path $env:LOCALAPPDATA 'dsh-voice-widget\whisper' }
$Dest = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dest)

$base = "https://github.com/ggml-org/whisper.cpp/releases/download/$tag"
$proxy = 'https://gh-proxy.com/'
$hfModel = "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/$Model"
$hfModelAlt = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$Model"

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }

function Get-Remote($urls, $outFile) {
    foreach ($url in $urls) {
        Write-Host "    $url"
        & curl.exe -L -S --no-progress-meter --retry 3 --retry-delay 2 --connect-timeout 20 -o $outFile $url
        if ($LASTEXITCODE -eq 0 -and (Test-Path $outFile) -and (Get-Item $outFile).Length -gt 1MB) { return $true }
        Remove-Item $outFile -ErrorAction SilentlyContinue
    }
    return $false
}

# whisper.cpp ships the CUDA assets inside a Release\ folder, the CPU ones inside bin\.
function Install-Build($zipBase, $targetDir) {
    $work = Join-Path $env:TEMP ('dsh-voice-widget-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $zip = Join-Path $work 'build.zip'

    $urls = @("$proxy$zipBase", $zipBase)
    if (-not (Get-Remote $urls $zip)) {
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
        throw "download failed: $zipBase"
    }

    $unpacked = Join-Path $work 'unpacked'
    Expand-Archive -Path $zip -DestinationPath $unpacked -Force

    $exe = Get-ChildItem -Path $unpacked -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'whisper-server.exe' -or $_.Name -eq 'whisper-cli.exe' } |
        Select-Object -First 1
    if (-not $exe) {
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
        throw "no whisper executable inside $zipBase"
    }

    $source = $exe.Directory.FullName
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    Copy-Item -Path (Join-Path $source '*') -Destination $targetDir -Recurse -Force
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "    -> $targetDir" -ForegroundColor DarkGray
}

Write-Step "target: $Dest"
New-Item -ItemType Directory -Path $Dest -Force | Out-Null

if (-not $CpuOnly) {
    Write-Step 'CUDA build (whisper-server.exe, about 650 MB)'
    Install-Build "$base/whisper-bin-win-cuda-12.4.0-x64.zip" (Join-Path $Dest 'cuda\Release')
} else {
    Write-Host '    skipped (-CpuOnly)' -ForegroundColor DarkGray
}

Write-Step 'CPU build (whisper-cli.exe, about 9 MB)'
Install-Build "$base/whisper-bin-x64.zip" (Join-Path $Dest 'bin')

if (-not $SkipModel) {
    Write-Step "model $Model"
    $models = Join-Path $Dest 'models'
    New-Item -ItemType Directory -Path $models -Force | Out-Null
    $out = Join-Path $models $Model
    if ((Test-Path $out) -and (Get-Item $out).Length -gt 1MB) {
        Write-Host "    already present, skipped" -ForegroundColor DarkGray
    } elseif (-not (Get-Remote @($hfModel, $hfModelAlt) $out)) {
        throw "download failed: $Model (try another -Model or fetch it by hand)"
    }
}

Write-Step 'done'
$report = @()
foreach ($dir in @('cuda\Release', 'bin', 'models')) {
    $full = Join-Path $Dest $dir
    if (Test-Path $full) {
        $fileCount = (Get-ChildItem $full -File -ErrorAction SilentlyContinue).Count
        $report += "    {0,-14} {1} file(s)" -f $dir, $fileCount
    }
}
$report
Write-Host ''
Write-Host 'If DSH is running, reload the plugin (toggle it off and on in the plugin page).' -ForegroundColor Yellow
