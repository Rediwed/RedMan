# Portable start-dev script
# Ensures Node.js and system tools are on PATH, then starts both servers.

$nodePath = Join-Path $env:ProgramFiles "nodejs"
if (Test-Path $nodePath) {
    $env:PATH = "$nodePath;$env:SystemRoot\System32;$env:SystemRoot;$env:PATH"
} else {
    Write-Warning "Node.js not found at $nodePath — ensure Node.js is installed or update this script."
    exit 1
}

if (-not $env:PEER_HOST) { $env:PEER_HOST = "127.0.0.1" }
Set-Location (Join-Path $PSScriptRoot "app")
npm run dev
