# ZILLION DEPLOYMENT SCRIPT
# Run this from your project root: C:\Users\OWNER\Downloads\ERP\lederlearn\Marketing\Zillion\files\zillion-mvp\zillion\
# Usage: Right-click → Run with PowerShell

Write-Host "=== ZILLION DEPLOYMENT SCRIPT ===" -ForegroundColor Green
Write-Host ""

# Check we're in right directory
if (-not (Test-Path "netlify.toml")) {
    Write-Host "ERROR: Run from project root (where netlify.toml lives)" -ForegroundColor Red
    exit 1
}

Write-Host "Working directory: $(Get-Location)" -ForegroundColor Cyan
Write-Host ""

# Show current file sizes BEFORE
Write-Host "--- CURRENT file sizes (BEFORE) ---" -ForegroundColor Yellow
$files = @("admin\index.html","merchant\index.html","agent\index.html","wallet\index.html","_redirects")
foreach ($f in $files) {
    if (Test-Path $f) {
        $size = (Get-Item $f).Length
        Write-Host "  $f : $size bytes"
    } else {
        Write-Host "  $f : MISSING" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "REQUIRED sizes after update:" -ForegroundColor Cyan
Write-Host "  admin\index.html    : 77244 bytes"
Write-Host "  merchant\index.html : 62408 bytes"
Write-Host ""

# Check merchant folder exists
if (-not (Test-Path "merchant")) {
    New-Item -ItemType Directory -Path "merchant" | Out-Null
    Write-Host "Created merchant\ folder" -ForegroundColor Green
}

Write-Host "--- Staging all files ---" -ForegroundColor Yellow
git add admin\index.html
git add merchant\index.html  
git add agent\index.html
git add wallet\index.html
git add _redirects
git add netlify.toml
git add backend\netlify\functions\merchant-register.js
git add backend\netlify\functions\admin-merchants.js
git add backend\netlify\functions\merchant-login.js
git add backend\netlify\functions\create-claim.js
git add backend\netlify\functions\fetch-claim.js
git add backend\netlify\functions\create-payment-request.js

Write-Host ""
Write-Host "--- Git status ---" -ForegroundColor Yellow
git status --short

Write-Host ""
$msg = "fix: merchant onboarding + admin merchants tab - complete rebuild $(Get-Date -Format 'HH:mm')"
git commit -m $msg

Write-Host ""
Write-Host "--- Pulling latest ---" -ForegroundColor Yellow
git pull origin main --allow-unrelated-histories

Write-Host ""
Write-Host "--- Pushing to Netlify ---" -ForegroundColor Yellow
git push origin main

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "Check https://zillion-mvp.netlify.app/admin/ in 2 minutes"
Write-Host "Check https://zillion-mvp.netlify.app/merchant/ in 2 minutes"
