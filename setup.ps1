# setup.ps1 - Jarvis V2 First-Run Setup Script
# Run this once before starting the agent for the first time.

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   AUTONOMOUS AGENT HUB V2 - SETUP        " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# --------------------------------------------------------------
# [1/6] Node.js & NPM
# --------------------------------------------------------------
Write-Host "[1/6] Checking Node.js & NPM..." -ForegroundColor Yellow
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  Node.js not found. Attempting to install via Winget..." -ForegroundColor Cyan
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS -e --silent --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        if (!(Get-Command node -ErrorAction SilentlyContinue)) {
            Write-Host "  Node.js installed but not in PATH. Please restart this terminal and run setup.ps1 again." -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "  Winget not available. Install Node.js manually from https://nodejs.org" -ForegroundColor Red
        exit 1
    }
}
$nodeVersion = (node --version)
Write-Host "  Node.js found: $nodeVersion" -ForegroundColor Green

Write-Host "  Installing NPM dependencies..." -ForegroundColor DarkGray
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "  npm install failed." -ForegroundColor Red; exit 1 }

# --------------------------------------------------------------
# [2/6] Ollama
# --------------------------------------------------------------
Write-Host ""
Write-Host "[2/6] Checking Ollama..." -ForegroundColor Yellow
if (!(Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "  Ollama not found. Downloading installer..." -ForegroundColor Cyan
    $ollamaInstaller = "$env:TEMP\OllamaSetup.exe"
    Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $ollamaInstaller
    Write-Host "  Running Ollama installer (silent)..." -ForegroundColor DarkGray
    $installerProc = Start-Process -FilePath $ollamaInstaller -ArgumentList "/S" -PassThru
    while (-not $installerProc.HasExited) { Start-Sleep -Seconds 2 }
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (!(Get-Command ollama -ErrorAction SilentlyContinue)) {
        Write-Host "  Ollama installed but not in PATH. Restart your terminal and run setup.ps1 again." -ForegroundColor Red
        exit 1
    }
}
Write-Host "  Ollama found." -ForegroundColor Green

# --------------------------------------------------------------
# [3/6] Assessing Hardware & Local AI Models
# --------------------------------------------------------------
Write-Host ""
Write-Host "[3/6] Assessing Hardware & Local AI Models..." -ForegroundColor Yellow

$ramGB = 0
$vramGB = 0

try {
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    if ($cs) {
        $ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB)
    }
    
    $vc = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    if ($vc) {
        foreach ($v in $vc) {
            if ($v.AdapterRAM) {
                $gb = [math]::Round($v.AdapterRAM / 1GB)
                if ($gb -gt $vramGB) { $vramGB = $gb }
            }
        }
    }
} catch {
    Write-Host "  Could not fully assess hardware." -ForegroundColor DarkGray
}

Write-Host "  System RAM: ${ramGB}GB" -ForegroundColor DarkGray
Write-Host "  Dedicated VRAM: ${vramGB}GB" -ForegroundColor DarkGray

$recommendedModel = "deepseek-r1:1.5b"
$capability = "Low-end"

if ($ramGB -gt 15 -and $vramGB -gt 6) {
    $recommendedModel = "deepseek-r1:7b"
    $capability = "High-end"
} elseif ($ramGB -ge 8) {
    $recommendedModel = "deepseek-r1:1.5b"
    $capability = "Mid-range"
}

Write-Host "  Hardware Capability: $capability" -ForegroundColor Cyan
Write-Host "  Recommended Local AI Model: $recommendedModel" -ForegroundColor Green

$downloadNow = Read-Host "  Do you want to download $recommendedModel now? (Y/N) [Default: Y]"
if ([string]::IsNullOrWhiteSpace($downloadNow) -or $downloadNow.ToLower().StartsWith("y")) {
    Write-Host "  Pulling $recommendedModel via Ollama..." -ForegroundColor DarkGray
    ollama pull $recommendedModel
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Successfully downloaded $recommendedModel." -ForegroundColor Green
    } else {
        Write-Host "  Failed to download $recommendedModel." -ForegroundColor Red
    }
} else {
    Write-Host "  Skipping model download." -ForegroundColor DarkGray
}

# --------------------------------------------------------------
# [4/6] OpenClaw Gateway (WhatsApp)
# --------------------------------------------------------------
Write-Host ""
Write-Host "[4/6] OpenClaw Gateway (WhatsApp)..." -ForegroundColor Yellow
$openClawDir = "src\gateway\openclaw"
if (Test-Path "$openClawDir\package.json") {
    Write-Host "  Installing OpenClaw dependencies..." -ForegroundColor DarkGray
    Push-Location $openClawDir
    $env:PUPPETEER_SKIP_DOWNLOAD = "true"
    npm install
    $env:PUPPETEER_SKIP_DOWNLOAD = $null
    Write-Host "  Downloading Chromium for Puppeteer (WhatsApp Web)..." -ForegroundColor DarkGray
    npx puppeteer browsers install chrome
    Pop-Location
    Write-Host "  OpenClaw ready." -ForegroundColor Green
} else {
    Write-Host "  OpenClaw directory not found. Skipping WhatsApp gateway." -ForegroundColor DarkGray
}

# --------------------------------------------------------------
# [5/6] Environment Config
# --------------------------------------------------------------
Write-Host ""
Write-Host "[5/6] Environment Configuration..." -ForegroundColor Yellow
if (!(Test-Path ".env")) {
    Write-Host "  No .env file found. Creating from template..." -ForegroundColor DarkGray
    Set-Content -Path ".env" -Value "PORT=3000`nOLLAMA_URL=http://127.0.0.1:11434`nGEMINI_API_KEY=`nDEFAULT_LOCAL_MODEL=hermes3"
    Write-Host "  .env created. You can add your GEMINI_API_KEY now, or the setup wizard will prompt you on first run." -ForegroundColor Cyan
} else {
    Write-Host "  .env already exists. Skipping." -ForegroundColor DarkGray
}

# --------------------------------------------------------------
# [6/6] WhatsApp Authentication
# --------------------------------------------------------------
Write-Host ""
Write-Host "[6/6] WhatsApp Authentication..." -ForegroundColor Yellow
if (Test-Path "$openClawDir\package.json") {
    $authDir = "$openClawDir\.wwebjs_auth"
    if (!(Test-Path $authDir)) {
        Write-Host "  WhatsApp authentication required. Generating QR Code..." -ForegroundColor Cyan
        Write-Host "  Scan the QR code in WhatsApp > Linked Devices." -ForegroundColor DarkGray
        Push-Location $openClawDir
        node index.js --setup
        Pop-Location
    } else {
        Write-Host "  WhatsApp already authenticated." -ForegroundColor Green
    }
} else {
    Write-Host "  OpenClaw not present. Skipping WhatsApp auth." -ForegroundColor DarkGray
}

# --------------------------------------------------------------
# DONE
# --------------------------------------------------------------
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   Setup Complete!                         " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Run 'npm start' to launch the Agent." -ForegroundColor Green
Write-Host "On first run, a setup wizard will appear in this terminal window." -ForegroundColor Green
Write-Host "You will be able to type your agent name and choices directly." -ForegroundColor Green
Write-Host ""

$startNow = Read-Host "Start the agent now? (Y/N) [Default: Y]"
if ([string]::IsNullOrWhiteSpace($startNow) -or $startNow.ToLower().StartsWith("y")) {
    Write-Host "Starting Agent Hub..." -ForegroundColor Cyan
    npm start
}
