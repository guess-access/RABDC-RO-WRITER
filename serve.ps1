# RO Ledger Link
# Zero-dependency, browser-only utility. Runs from the filesystem or any
# static host. The only network call is to your own Google Apps Script.

$root = $PSScriptRoot

Write-Host ""
Write-Host "  RO LEDGER LINK" -ForegroundColor Yellow
Write-Host "  Serving: $root" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  NOTE: opening index.html directly via file:// also works." -ForegroundColor DarkGray
Write-Host ""

if (Get-Command py -ErrorAction SilentlyContinue) {
    Write-Host "  Open: http://localhost:8080/" -ForegroundColor Green
    Push-Location $root
    try { py -m http.server 8080 } finally { Pop-Location }
}
elseif (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Host "  Open: http://localhost:8080/" -ForegroundColor Green
    Push-Location $root
    try { python -m http.server 8080 } finally { Pop-Location }
}
elseif (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "  Open: http://localhost:8080/" -ForegroundColor Green
    npx --yes serve -l 8080 $root
}
else {
    Write-Host "  No local server found - opening the file directly:" -ForegroundColor Cyan
    Write-Host "  $root\index.html" -ForegroundColor White
    Write-Host "  (Everything works from file://; no server needed.)" -ForegroundColor DarkGray
    Start-Process "$root\index.html"
}
