#!/usr/bin/env pwsh
# ServiceNow MCP Installation Script for Windows (PowerShell)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Installing ServiceNow MCP..." -ForegroundColor Cyan
Write-Host ""

# Change to repository root
Set-Location (Join-Path $PSScriptRoot "..")

# Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: npm install failed" -ForegroundColor Red
    exit 1
}

# Build the project
Write-Host "Building project..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: build failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✅ ServiceNow MCP installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Add to $env:USERPROFILE\.claude\user-mcps.json (see README.md)"
Write-Host "2. Restart Claude"
Write-Host "3. Use auth_browser tool to authenticate via SSO"
Write-Host ""
