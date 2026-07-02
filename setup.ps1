# setup.ps1 - Jarvis V2 First-Run Setup Script
# Run this once before starting the agent for the first time.

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   AUTONOMOUS AGENT HUB V2 - SETUP        " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# --------------------------------------------------------------
# [1/5] Node.js & NPM
# --------------------------------------------------------------
Write-Host "[1/5] Checking Node.js & NPM..." -ForegroundColor Yellow
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
# [2/5] Ollama
# --------------------------------------------------------------
Write-Host ""
Write-Host "[2/5] Checking Ollama..." -ForegroundColor Yellow
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
# [3/5] OpenClaw Gateway (WhatsApp)
# --------------------------------------------------------------
Write-Host ""
Write-Host "[3/5] OpenClaw Gateway (WhatsApp)..." -ForegroundColor Yellow
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
# [4/5] Environment Config
# --------------------------------------------------------------
Write-Host ""
Write-Host "[4/5] Environment Configuration..." -ForegroundColor Yellow
if (!(Test-Path ".env")) {
    Write-Host "  No .env file found. Creating from template..." -ForegroundColor DarkGray
    Set-Content -Path ".env" -Value "PORT=3000`nOLLAMA_URL=http://127.0.0.1:11434`nGEMINI_API_KEY=`nDEFAULT_LOCAL_MODEL=hermes3"
    Write-Host "  .env created. You can add your GEMINI_API_KEY now, or the setup wizard will prompt you on first run." -ForegroundColor Cyan
} else {
    Write-Host "  .env already exists. Skipping." -ForegroundColor DarkGray
}

# --------------------------------------------------------------
# [5/5] WhatsApp Authentication
# --------------------------------------------------------------
Write-Host ""
Write-Host "[5/5] WhatsApp Authentication..." -ForegroundColor Yellow
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
