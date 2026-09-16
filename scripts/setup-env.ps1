<#
.SYNOPSIS
One-command local env setup for Windows (see setup-env.sh for the macOS/Linux equivalent).

Installs any missing prerequisite tooling (Node.js, pnpm, Docker), creates the single root
.env.local (from .env.example) if it doesn't exist yet, auto-generates CONNECTION_SECRET_KEY
(the one secret that doesn't need an external account), optionally prompts for
ANTHROPIC_API_KEY (skippable, only needed to run the worker), and points apps/web/.env.local
and apps/worker/.env.local at it — via a symlink where Windows allows one (Developer Mode or
an elevated shell), falling back to a plain copy otherwise — so Next.js and dotenv/config each
keep finding a config file exactly where they already look.

Run directly (.\scripts\setup-env.ps1), not via `pnpm setup:env` — this script is what gets
pnpm itself installed if it's missing, so a pnpm-based entry point would be chicken-and-egg.

Safe to re-run: never overwrites an existing root .env.local, and never silently discards an
existing per-app .env.local that isn't already one of our links/copies — those get backed up
instead, and you're told to fold any values only found there into the root file by hand.
Tooling installs are likewise skipped whenever the tool is already on PATH.
#>

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Node.js — needed for corepack (which provides pnpm) and for everything else in the repo.
function Ensure-Node {
    if (Test-CommandExists node) { return }
    Write-Host "Node.js not found."
    if (Test-CommandExists winget) {
        Write-Host "Installing Node.js via winget..."
        winget install -e --id OpenJS.NodeJS.LTS --source winget
        if ($LASTEXITCODE -ne 0) {
            Write-Host "winget install failed — install Node.js 22+ manually: https://nodejs.org/"
            exit 1
        }
        Write-Host "Node.js installed — restart your terminal (or open a new one) to pick up the updated PATH, then re-run this script."
        exit 0
    } else {
        Write-Host "winget not available — install Node.js 22+ manually: https://nodejs.org/"
        exit 1
    }
}

# pnpm — pinned to the version in package.json's "packageManager" field via corepack, which ships
# with Node.js itself, so this always prefers corepack over a bare `npm install -g pnpm`.
function Ensure-Pnpm {
    if (Test-CommandExists pnpm) { return }
    Write-Host "pnpm not found."
    if (Test-CommandExists corepack) {
        Write-Host "Enabling pnpm via corepack..."
        corepack enable
        corepack prepare pnpm@11.17.0 --activate
        if ($LASTEXITCODE -ne 0) {
            Write-Host "corepack failed to set up pnpm — install it manually: npm install -g pnpm@11.17.0"
            exit 1
        }
    } elseif (Test-CommandExists npm) {
        Write-Host "corepack unavailable — installing pnpm via npm instead..."
        npm install -g pnpm@11.17.0
        if ($LASTEXITCODE -ne 0) {
            Write-Host "npm install failed — install pnpm manually: https://pnpm.io/installation"
            exit 1
        }
    } else {
        Write-Host "Install Node.js 22+ (which includes corepack) first: https://nodejs.org/"
        exit 1
    }
}

# Docker — for local Postgres/Redis and the worker's sandbox image. Docker Desktop needs a
# one-time manual launch to finish onboarding and start the daemon; this only gets it onto disk.
function Ensure-Docker {
    if (Test-CommandExists docker) { return }
    Write-Host "Docker not found."
    if (Test-CommandExists winget) {
        Write-Host "Installing Docker Desktop via winget..."
        winget install -e --id Docker.DockerDesktop --source winget
        if ($LASTEXITCODE -ne 0) {
            Write-Host "winget install failed — install Docker Desktop manually: https://docs.docker.com/get-docker/"
            exit 1
        }
        Write-Host "Docker Desktop installed — launch it once from the Start menu to finish setup and start the daemon."
    } else {
        Write-Host "winget not available — install Docker Desktop manually: https://docs.docker.com/get-docker/"
        exit 1
    }
}

# The worker's sandbox image — built from the repo's own Dockerfile, no external inputs, so this
# can just build it non-interactively like everything else here. Skipped if it's already present
# (same idempotent pattern as Ensure-Docker) since a rebuild after every edit to sandbox-image/ is
# the developer's call, not this script's.
function Ensure-SandboxImage {
    if (-not (Test-CommandExists docker)) { return }
    docker image inspect agentfactory-sandbox:local *> $null
    if ($LASTEXITCODE -eq 0) { return }
    Write-Host "Building agentfactory-sandbox:local (needed to run the worker)..."
    docker build -t agentfactory-sandbox:local apps/worker/sandbox-image
}

Ensure-Node
Ensure-Pnpm
Ensure-Docker
Ensure-SandboxImage

$EnvLocal = ".env.local"
$EnvExample = ".env.example"

if (-not (Test-Path $EnvLocal)) {
    Copy-Item $EnvExample $EnvLocal
    Write-Host "Created $EnvLocal from $EnvExample."
} else {
    Write-Host "$EnvLocal already exists — leaving its values as they are."
}

# Fill in CONNECTION_SECRET_KEY only if it's still the empty placeholder from .env.example — never
# touch a value someone already set (matches the line exactly, not a prefix match, so an
# already-filled-in key is left alone even if it happens to start with the same text). The
# trailing (\r?) capture tolerates and preserves CRLF line endings, which is what a fresh Windows
# checkout gets by default (Git for Windows ships with core.autocrlf=true).
$envContent = Get-Content $EnvLocal -Raw
if ($envContent -match '(?m)^CONNECTION_SECRET_KEY=(\r?)$') {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $key = [Convert]::ToBase64String($bytes)
    $envContent = $envContent -replace '(?m)^CONNECTION_SECRET_KEY=(\r?)$', "CONNECTION_SECRET_KEY=$key`$1"
    Set-Content -Path $EnvLocal -Value $envContent -NoNewline
    Write-Host "Generated CONNECTION_SECRET_KEY."
}

# Offer to fill in ANTHROPIC_API_KEY interactively, same placeholder-only rule as above. Optional
# (only needed to run the worker) and skippable with a bare Enter; skipped automatically when
# stdin isn't a terminal (e.g. piped input, CI) so the script never hangs waiting for a prompt.
$envContent = Get-Content $EnvLocal -Raw
if ($envContent -match '(?m)^ANTHROPIC_API_KEY=(\r?)$' -and -not [Console]::IsInputRedirected) {
    Write-Host ""
    $anthropicKey = Read-Host "Enter your ANTHROPIC_API_KEY (only needed to run the worker — press Enter to skip)"
    if ($anthropicKey) {
        $envContent = Get-Content $EnvLocal -Raw
        $envContent = $envContent -replace '(?m)^ANTHROPIC_API_KEY=(\r?)$', "ANTHROPIC_API_KEY=$anthropicKey`$1"
        Set-Content -Path $EnvLocal -Value $envContent -NoNewline
        Write-Host "Saved ANTHROPIC_API_KEY."
    } else {
        Write-Host "Skipped — you can fill in ANTHROPIC_API_KEY in $EnvLocal later."
    }
}

function Link-Env {
    param([string]$AppDir)

    $target = Join-Path ".." (Join-Path ".." $EnvLocal)
    $linkPath = Join-Path $AppDir $EnvLocal
    $existing = Get-Item -Path $linkPath -ErrorAction SilentlyContinue

    if ($existing -and $existing.LinkType) {
        # Already a symlink — leave it (whether it points here or somewhere unexpected is not this
        # script's call to make; a developer who hand-rolled something already knows what they did).
        return
    }

    if ($existing) {
        # A real, pre-existing file. If it's byte-identical to the root file, it's almost certainly
        # our own copy-fallback from a previous run of this script (Windows without Developer Mode
        # can't symlink) — leave it alone rather than backing it up every single run.
        if ((Get-FileHash $linkPath).Hash -eq (Get-FileHash $EnvLocal).Hash) {
            return
        }
        # Otherwise it predates this consolidation (or was hand-edited after a copy-fallback) and may
        # hold values (a locally-issued GitHub App, a non-default DATABASE_URL) that never made it
        # into the root file — back it up rather than overwriting it.
        $backup = "$linkPath.pre-consolidation.bak"
        Move-Item $linkPath $backup -Force
        Write-Host "Backed up existing $linkPath to $backup — check it for any values not already in $EnvLocal, then remove it."
    }

    try {
        New-Item -ItemType SymbolicLink -Path $linkPath -Target $target -ErrorAction Stop | Out-Null
        Write-Host "Linked $linkPath -> $target."
    } catch {
        # Creating a symlink needs Developer Mode enabled or an elevated shell on Windows. Fall back
        # to a plain copy so the app still finds a config file; it just won't auto-follow edits to
        # the root file until you either re-run this script or enable Developer Mode and delete the
        # copy so a real symlink can take its place.
        Copy-Item -Path $EnvLocal -Destination $linkPath
        Write-Host "Could not create a symlink at $linkPath (needs Developer Mode or an elevated shell on Windows) — copied $EnvLocal there instead. Re-run this script whenever you change $EnvLocal to keep $linkPath in sync."
    }
}

Link-Env "apps\web"
Link-Env "apps\worker"

Write-Host ""
$envContent = Get-Content $EnvLocal -Raw
if ($envContent -match '(?m)^ANTHROPIC_API_KEY=\r?$') {
    Write-Host "Done. Edit $EnvLocal to fill in GITHUB_APP_* (see README's 'Setting up the GitHub App') and"
    Write-Host "ANTHROPIC_API_KEY if you're running the worker — everything else already has a working default."
} else {
    Write-Host "Done. Edit $EnvLocal to fill in GITHUB_APP_* (see README's 'Setting up the GitHub App') —"
    Write-Host "everything else already has a working default."
}
