# =============================================================
# Confluence — One-click Cloudflare Worker Setup
# Run this once in PowerShell to deploy everything.
# =============================================================
# How to run:
#   1. Open PowerShell in this folder (Shift+Right-click → Open PowerShell here)
#   2. Type:  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. Type:  .\setup.ps1
# =============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "   Confluence — Cloudflare Worker Setup" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ── Check Node.js ──────────────────────────────────────────────
try {
    $nodeVer = node --version 2>&1
    Write-Host "Node.js found: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "Node.js is not installed." -ForegroundColor Red
    Write-Host "Download it from https://nodejs.org (LTS version) and re-run this script." -ForegroundColor Yellow
    exit 1
}

# ── Collect inputs ─────────────────────────────────────────────
Write-Host "Answer two questions, then everything is automatic." -ForegroundColor White
Write-Host ""

$githubPagesUrl = Read-Host "  Your GitHub Pages URL (e.g. https://abajpai29.github.io)"
$githubPagesUrl = $githubPagesUrl.TrimEnd('/')

$apiKeySecure = Read-Host "  Your Anthropic API key" -AsSecureString
$apiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($apiKeySecure)
)

Write-Host ""
Write-Host "Got it. Running setup automatically..." -ForegroundColor Cyan
Write-Host ""

# ── Install Wrangler ───────────────────────────────────────────
Write-Host "[1/6] Installing Wrangler CLI..." -ForegroundColor Yellow
npm install -g wrangler | Out-Null
Write-Host "      Done." -ForegroundColor Green

# ── Cloudflare login ───────────────────────────────────────────
Write-Host "[2/6] Logging into Cloudflare (browser will open)..." -ForegroundColor Yellow
wrangler login
Write-Host "      Logged in." -ForegroundColor Green

# ── Create KV namespace ────────────────────────────────────────
Write-Host "[3/6] Creating rate-limit KV namespace..." -ForegroundColor Yellow
$kvOutput = wrangler kv:namespace create "confluence-rate-limit" 2>&1 | Out-String

# Extract the KV ID from wrangler output
$kvIdMatch = [regex]::Match($kvOutput, '"id":\s*"([a-f0-9]{32})"')
if (-not $kvIdMatch.Success) {
    # Try alternate format (older wrangler versions)
    $kvIdMatch = [regex]::Match($kvOutput, 'id\s*=\s*"([a-f0-9]{32})"')
}
if (-not $kvIdMatch.Success) {
    Write-Host ""
    Write-Host "Could not auto-detect KV ID from output:" -ForegroundColor Red
    Write-Host $kvOutput
    $kvId = Read-Host "Please paste the KV namespace ID shown above"
} else {
    $kvId = $kvIdMatch.Groups[1].Value
}
Write-Host "      KV ID: $kvId" -ForegroundColor Green

# ── Update wrangler.toml ───────────────────────────────────────
Write-Host "[4/6] Updating wrangler.toml..." -ForegroundColor Yellow
$toml = Get-Content "wrangler.toml" -Raw
$toml = $toml -replace "REPLACE_WITH_KV_ID", $kvId
$toml = $toml -replace "REPLACE_WITH_GITHUB_PAGES_URL", $githubPagesUrl
Set-Content "wrangler.toml" $toml
Write-Host "      Done." -ForegroundColor Green

# ── Set Anthropic API key as encrypted secret ──────────────────
Write-Host "[5/6] Setting Anthropic API key as encrypted secret..." -ForegroundColor Yellow
$apiKey | wrangler secret put ANTHROPIC_API_KEY
Write-Host "      Secret stored securely in Cloudflare." -ForegroundColor Green

# ── Deploy Worker ──────────────────────────────────────────────
Write-Host "[6/6] Deploying Worker to Cloudflare..." -ForegroundColor Yellow
$deployOutput = wrangler deploy 2>&1 | Out-String
Write-Host $deployOutput

# Extract Worker URL from deploy output
$urlMatch = [regex]::Match($deployOutput, 'https://[^\s]+\.workers\.dev')
if ($urlMatch.Success) {
    $workerUrl = $urlMatch.Value.Trim()
    Write-Host "      Worker URL: $workerUrl" -ForegroundColor Green

    # ── Update index.html with Worker URL ─────────────────────
    $html = Get-Content "index.html" -Raw
    $html = $html -replace "REPLACE_WITH_YOUR_WORKER_URL", $workerUrl
    Set-Content "index.html" $html
    Write-Host "      index.html updated with Worker URL." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Could not auto-detect Worker URL. Copy it from above and paste it into" -ForegroundColor Yellow
    Write-Host "index.html at the line: const WORKER_URL = 'REPLACE_WITH_YOUR_WORKER_URL'" -ForegroundColor Yellow
    $workerUrl = Read-Host "Paste your Worker URL here (to auto-update index.html)"
    $html = Get-Content "index.html" -Raw
    $html = $html -replace "REPLACE_WITH_YOUR_WORKER_URL", $workerUrl.Trim()
    Set-Content "index.html" $html
    Write-Host "      index.html updated." -ForegroundColor Green
}

# ── Done ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "   Setup Complete!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Now push to GitHub to go live:" -ForegroundColor White
Write-Host ""
Write-Host "   git add -A" -ForegroundColor Cyan
Write-Host "   git commit -m 'Deploy: Cloudflare Worker + full rebuild'" -ForegroundColor Cyan
Write-Host "   git push" -ForegroundColor Cyan
Write-Host ""
Write-Host "Your app will be live at: $githubPagesUrl" -ForegroundColor Green
Write-Host ""
