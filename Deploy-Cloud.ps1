#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Full cloud deployment: Access DB -> Neon Postgres -> Fly.io.

.DESCRIPTION
  Step-by-step script that:
    1. Verifies prerequisites (flyctl, node, Access DB).
    2. Exports the Access table to CSV.
    3. Migrates the CSV to a free Neon PostgreSQL database.
    4. Sets Fly.io secrets (DATABASE_URL, ACCESS_API_KEY).
    5. Deploys the API container to Fly.io.

.PARAMETER TableName
  Access table to export and host. Default: Sgaza

.PARAMETER DatabaseUrl
  Neon postgres connection string (postgres://user:pass@host/db?sslmode=require).
  If omitted you will be prompted to paste it.

.PARAMETER ApiKey
  Value for the ACCESS_API_KEY secret on Fly.io. Default: prompted.

.PARAMETER DbPath
  Path to the .accdb file. Auto-detected from workspace root if omitted.

.PARAMETER SkipExport
  Skip the CSV export step (use if CSV already exists).

.PARAMETER ForceExport
  Force rebuilding the CSV even if one already exists.

.PARAMETER ShowImportStatus
  Show resumable import checkpoint status from Postgres and exit.

.PARAMETER StopAfterBatches
  Intentionally stop after N committed batches so the next run can resume from that point.

.PARAMETER SkipMigrate
  Skip the Postgres migration step (use if data is already in Neon).

.PARAMETER SkipDeploy
  Skip the Fly.io deploy step (dry-run mode).

.EXAMPLE
  # Full deployment prompting for secrets:
  .\Deploy-Cloud.ps1

  # Specify everything explicitly:
  .\Deploy-Cloud.ps1 -DatabaseUrl "postgres://..." -ApiKey "my-key"

  # Skip export and migration (data already in Neon, just redeploy):
  .\Deploy-Cloud.ps1 -SkipExport -SkipMigrate -DatabaseUrl "postgres://..." -ApiKey "my-key"
#>

param(
  [string]$TableName = 'Sgaza',
  [string]$DatabaseUrl = '',
  [string]$ApiKey = '',
  [string]$DbPath = '',
  [switch]$FullDataset,
  [switch]$ForceExport,
  [switch]$ShowImportStatus,
  [int]$StopAfterBatches = 0,
  [switch]$SkipExport,
  [switch]$SkipMigrate,
  [switch]$SkipDeploy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Split-Path -Parent $scriptRoot

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Step {
  param([string]$Text)
  Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Text)
  Write-Host "    OK: $Text" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Text)
  Write-Host "    WARN: $Text" -ForegroundColor Yellow
}

function Assert-Command {
  param([string]$Name, [string]$InstallHint)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "'$Name' was not found on PATH. $InstallHint"
  }
}

function Invoke-Flyctl {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$PassThruToHost
  )

  $previousPreference = $ErrorActionPreference
  $outputLines = @()
  $exitCode = 0

  try {
    # flyctl can emit non-fatal metrics warnings on stderr.
    $ErrorActionPreference = 'Continue'
    $outputLines = (& flyctl @Arguments 2>&1 | ForEach-Object { "$($_)" })
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }

  $filteredLines = @(
    $outputLines | Where-Object {
      -not [string]::IsNullOrWhiteSpace($_) -and
      $_ -notmatch '^Warning:\s+Metrics send issue:'
    }
  )

  if ($PassThruToHost) {
    $filteredLines | Out-Host
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    Lines    = $filteredLines
    RawLines = $outputLines
  }
}

function Prompt-Secret {
  param([string]$Prompt)

  $value = ''
  while ([string]::IsNullOrWhiteSpace($value)) {
    $value = (Read-Host $Prompt).Trim()
  }

  return $value
}

function Resolve-DatabasePath {
  param([string]$InputPath)

  if ($InputPath -and (Test-Path -LiteralPath $InputPath)) {
    return (Resolve-Path -LiteralPath $InputPath).Path
  }

  $candidate = Get-ChildItem -LiteralPath $workspaceRoot -Filter '*.accdb' -File | Select-Object -First 1
  if ($candidate) {
    return $candidate.FullName
  }

  return $null
}

function Get-CsvHeaderColumns {
  param([Parameter(Mandatory = $true)][string]$CsvPath)

  if (-not (Test-Path -LiteralPath $CsvPath)) {
    throw "CSV file not found: $CsvPath"
  }

  $headerLine = Get-Content -LiteralPath $CsvPath -TotalCount 1
  if ([string]::IsNullOrWhiteSpace($headerLine)) {
    throw 'CSV header row is empty.'
  }

  return ($headerLine -split ',') | ForEach-Object {
    $value = [string]$_
    $value = $value.TrimStart([char]0xFEFF).Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) {
      return $value.Substring(1, $value.Length - 2)
    }
    return $value.Trim()
  }
}

function Get-ColumnsFromHeaderByIndexes {
  param(
    [Parameter(Mandatory = $true)][string[]]$HeaderColumns,
    [Parameter(Mandatory = $true)][int[]]$TargetIndexes
  )

  $selected = @()

  foreach ($index in $TargetIndexes) {
    if ($index -lt $HeaderColumns.Count) {
      $name = [string]$HeaderColumns[$index]
      if (-not [string]::IsNullOrWhiteSpace($name)) {
        $selected += $name
      }
    }
  }

  if ($selected.Count -eq 0) {
    throw 'Unable to resolve profile columns from CSV header.'
  }

  return $selected
}

function Get-WithLocationColumnIndexes {
  # Zero-based indexes in Sgaza header for lookup + birthplace code resolution.
  # Always include index 0 (الهوية) so the ID column is preserved.
  # Include index 3 (الاسم رباعي بعد الزواج) so the full name is exported.
  return @(0, 1, 3, 4, 5, 6, 7, 9, 11, 12, 13, 14)
}

function Get-EssentialOnlyColumnIndexes {
  # Zero-based indexes in Sgaza header for core extension functionality.
  # Always include index 0 (الهوية) so the ID column is preserved.
  # Include index 3 (الاسم رباعي بعد الزواج) so the full name is exported.
  return @(0, 1, 3, 4, 5, 6, 7, 9, 11, 12)
}

# ---------------------------------------------------------------------------
# Step 0: Prerequisites
# ---------------------------------------------------------------------------

Write-Step 'Checking prerequisites'
I
Assert-Command 'flyctl' 'Download from https://fly.io/install.ps1 or run: winget install Fly.flyctl'
Assert-Command 'node' 'Download from https://nodejs.org'

$flyWhoami = Invoke-Flyctl -Arguments @('auth', 'whoami')
$flyUser = ($flyWhoami.Lines | Select-Object -First 1)
if ($flyWhoami.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($flyUser) -or $flyUser -match 'Error') {
  throw "Not logged in to Fly.io. Run: flyctl auth login"
}
Write-Ok "Fly.io account: $flyUser"

# Verify the target app exists
$appExists = $false
try {
  $appsListResult = Invoke-Flyctl -Arguments @('apps', 'list')
  if ($appsListResult.ExitCode -eq 0) {
    $appsList = ($appsListResult.Lines -join "`n")
    if ($appsList -match '(?m)^\s*access-api\s+') {
      $appExists = $true
    }
  } else {
    throw 'flyctl apps list returned a non-zero exit code.'
  }
} catch {
  Write-Warn "Could not list Fly apps cleanly. The script will continue and validate during deploy."
}

if (-not $appExists) {
  Write-Warn "App 'access-api' not found in apps list. Attempting to create it..."
  try {
    $createResult = Invoke-Flyctl -Arguments @('apps', 'create', 'access-api', '--org', 'personal') -PassThruToHost
    if ($createResult.ExitCode -eq 0) {
      $appExists = $true
    } else {
      throw 'flyctl apps create returned a non-zero exit code.'
    }
  } catch {
    Write-Warn "App create step returned an error. If the app already exists under another org, deploy may still work with -a access-api."
  }
}

Write-Ok "Fly.io target app: access-api"

if ($ShowImportStatus) {
  $migrateScript = Join-Path $scriptRoot 'scripts\migrate-csv-to-postgres.js'
  if (-not (Test-Path -LiteralPath $migrateScript)) {
    throw "Migration script not found: $migrateScript"
  }

  if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    Write-Step 'Neon PostgreSQL setup'
    $DatabaseUrl = Prompt-Secret 'Paste Neon DATABASE_URL'
  }

  Write-Step "Checking import status for $TableName"
  Push-Location $scriptRoot
  try {
    $env:DATABASE_URL = $DatabaseUrl
    $env:PG_SCHEMA = 'public'
    $env:PG_TABLE = $TableName
    $env:PG_SSL = 'true'
    $env:PG_STATUS_ONLY = 'true'

    node $migrateScript
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
      throw 'Status check failed.'
    }
  } finally {
    Pop-Location
    Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_SCHEMA -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_TABLE -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_SSL -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_STATUS_ONLY -ErrorAction SilentlyContinue
  }

  return
}

# ---------------------------------------------------------------------------
# Step 1: Export Access DB to CSV
# ---------------------------------------------------------------------------

$csvPath = Join-Path $workspaceRoot "${TableName}.csv"
$resolvedDb = $null
$exportScript = Join-Path $workspaceRoot 'data_tools\Export-AccessToCsv.ps1'
$hasExistingCsv = (Test-Path -LiteralPath $csvPath)

if ($SkipExport) {
  if (-not $hasExistingCsv) {
    throw "SkipExport was set but CSV not found at $csvPath"
  }
  Write-Step "Skipping export (CSV already at $csvPath)"
} elseif ($hasExistingCsv -and -not $ForceExport) {
  Write-Step "Reusing existing CSV at $csvPath (use -ForceExport to rebuild)"
} else {
  Write-Step "Exporting '$TableName' from Access to $csvPath"

  $resolvedDb = Resolve-DatabasePath -InputPath $DbPath
  if (-not $resolvedDb) {
    throw "No .accdb file found. Pass -DbPath explicitly."
  }
  Write-Ok "Database: $resolvedDb"

  if (-not (Test-Path -LiteralPath $exportScript)) {
    throw "Export script not found: $exportScript"
  }

  try {
    if ($FullDataset) {
      & $exportScript -DbPath $resolvedDb -TableName $TableName -OutputPath $csvPath
    } else {
      $withLocationIndexes = Get-WithLocationColumnIndexes
      Write-Ok "Using slim CSV export with location codes ($($withLocationIndexes.Count) columns)."
      & $exportScript -DbPath $resolvedDb -TableName $TableName -OutputPath $csvPath -ColumnIndexes $withLocationIndexes
    }
  } catch {
    $exportError = [string]$_.Exception.Message
    if ((-not $FullDataset) -and ($exportError -match '(?i)not enough space on the disk')) {
      Write-Warn 'Disk space is tight; retrying export with essential-only profile (8 columns).'
      $essentialIndexes = Get-EssentialOnlyColumnIndexes
      try {
        & $exportScript -DbPath $resolvedDb -TableName $TableName -OutputPath $csvPath -ColumnIndexes $essentialIndexes
      } catch {
        throw "CSV export failed after essential-only retry: $($_.Exception.Message)"
      }
    } else {
      throw "CSV export failed: $exportError"
    }
  }

  if (-not (Test-Path -LiteralPath $csvPath)) {
    throw "CSV export did not produce output file: $csvPath"
  }

  Write-Ok "CSV written: $csvPath"
}

# ---------------------------------------------------------------------------
# Step 2: Get Neon DATABASE_URL
# ---------------------------------------------------------------------------

if (-not $SkipMigrate -or [string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    Write-Step 'Neon PostgreSQL setup'
    Write-Host @"

  Free Neon Postgres (no credit card):
    1. Open  https://neon.tech  in your browser
    2. Click "Sign up" (GitHub login works)
    3. Create a project  (any name, region: US East - Ohio is fastest for Fly iad)
    4. On the project dashboard click "Connection string"
    5. Select your branch (main) and copy the string that looks like:
         postgres://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
    6. Paste it below.

"@ -ForegroundColor White

    $DatabaseUrl = Prompt-Secret 'Paste Neon DATABASE_URL'
  }
}

# ---------------------------------------------------------------------------
# Step 3: Migrate CSV to Neon Postgres
# ---------------------------------------------------------------------------

if (-not $SkipMigrate) {
  Write-Step "Migrating $csvPath to Neon Postgres (table: $TableName)"

  $migrateScript = Join-Path $scriptRoot 'scripts\migrate-csv-to-postgres.js'
  if (-not (Test-Path -LiteralPath $migrateScript)) {
    throw "Migration script not found: $migrateScript"
  }

  Push-Location $scriptRoot
  try {
    $headerColumns = Get-CsvHeaderColumns -CsvPath $csvPath

    $env:DATABASE_URL = $DatabaseUrl
    $env:PG_SCHEMA = 'public'
    $env:PG_TABLE = $TableName
    $env:PG_SSL = 'true'
    $env:CSV_PATH = $csvPath
    $env:PG_BATCH_SIZE = '1000'
    $env:PG_RESUME_IMPORT = 'true'
    $env:PG_RECREATE_FIRST = 'false'
    $env:PG_TRUNCATE_FIRST = 'false'
    $env:PG_STOP_AFTER_BATCHES = [string][Math]::Max(0, $StopAfterBatches)

    if (-not $FullDataset) {
      $withLocationColumns = @()
      if ($headerColumns.Count -le 10) {
        $withLocationColumns = $headerColumns
      } else {
        $withLocationColumns = Get-ColumnsFromHeaderByIndexes -HeaderColumns $headerColumns -TargetIndexes (Get-WithLocationColumnIndexes)
      }

      $essentialColumns = @()
      if ($withLocationColumns.Count -gt 8) {
        $essentialColumns = @($withLocationColumns | Select-Object -First 8)
      } elseif ($headerColumns.Count -gt 8) {
        $essentialColumns = Get-ColumnsFromHeaderByIndexes -HeaderColumns $headerColumns -TargetIndexes (Get-EssentialOnlyColumnIndexes)
      } else {
        $essentialColumns = $withLocationColumns
      }

      $env:PG_MAX_TABLE_MB = '500'
      $profiles = @(
        @{ Name = 'with-location + hash index'; Columns = $withLocationColumns; IndexMode = 'hash' },
        @{ Name = 'essential-only + hash index'; Columns = $essentialColumns; IndexMode = 'hash' },
        @{ Name = 'essential-only + no index'; Columns = $essentialColumns; IndexMode = 'none' }
      )

      $migrationSucceeded = $false
      $resetForNextAttempt = $false
      foreach ($candidateProfile in $profiles) {
        $profileColumns = @($candidateProfile.Columns)
        if ($profileColumns.Count -eq 0) {
          continue
        }

        $env:CSV_KEEP_COLUMNS = ($profileColumns -join ',')
        $env:PG_INDEX_MODE = [string]$candidateProfile.IndexMode
        $env:PG_RECREATE_FIRST = $(if ($resetForNextAttempt) { 'true' } else { 'false' })
        $env:PG_TRUNCATE_FIRST = $(if ($resetForNextAttempt) { 'true' } else { 'false' })
        Write-Ok "Trying migration profile: $($candidateProfile.Name) ($($profileColumns.Count) columns, limit 500 MB)."

        & node $migrateScript
        $exitCode = $LASTEXITCODE

        if (-not $exitCode -or $exitCode -eq 0) {
          $migrationSucceeded = $true
          break
        }

        if ($exitCode -eq 42) {
          Write-Warn "Profile '$($candidateProfile.Name)' exceeded 500 MB. Trying tighter compression profile..."
          $resetForNextAttempt = $true
          continue
        }

        throw "Migration failed."
      }

      if (-not $migrationSucceeded) {
        throw "Migration failed. Could not fit table under 500 MB with available compression profiles."
      }
    } else {
      Write-Warn 'Full dataset mode enabled. This may exceed free-tier storage limits.'
      Remove-Item Env:\PG_MAX_TABLE_MB -ErrorAction SilentlyContinue
      Remove-Item Env:\CSV_KEEP_COLUMNS -ErrorAction SilentlyContinue
      Remove-Item Env:\PG_INDEX_MODE -ErrorAction SilentlyContinue
      $env:PG_RECREATE_FIRST = 'false'
      $env:PG_TRUNCATE_FIRST = 'false'

      node $migrateScript
      if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "Migration failed."
      }
    }
  } finally {
    Pop-Location
    Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_SCHEMA -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_TABLE -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_SSL -ErrorAction SilentlyContinue
    Remove-Item Env:\CSV_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_BATCH_SIZE -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_RESUME_IMPORT -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_RECREATE_FIRST -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_TRUNCATE_FIRST -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_MAX_TABLE_MB -ErrorAction SilentlyContinue
    Remove-Item Env:\CSV_KEEP_COLUMNS -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_INDEX_MODE -ErrorAction SilentlyContinue
    Remove-Item Env:\PG_STOP_AFTER_BATCHES -ErrorAction SilentlyContinue
  }

  Write-Ok 'Migration complete.'
} else {
  Write-Step 'Skipping migration (SkipMigrate set)'
}

# ---------------------------------------------------------------------------
# Step 4: Set Fly.io secrets
# ---------------------------------------------------------------------------

Write-Step 'Setting Fly.io secrets'

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  $ApiKey = Prompt-Secret 'Enter ACCESS_API_KEY for the cloud API (any strong secret string)'
}

$secretsResult = Invoke-Flyctl -Arguments @(
  'secrets',
  'set',
  "DATABASE_URL=$DatabaseUrl",
  "ACCESS_API_KEY=$ApiKey",
  '-a',
  'access-api'
) -PassThruToHost
if ($secretsResult.ExitCode -ne 0) {
  throw 'flyctl secrets set failed.'
}

Write-Ok 'Secrets set on Fly.io.'

# ---------------------------------------------------------------------------
# Step 5: Deploy to Fly.io
# ---------------------------------------------------------------------------

if (-not $SkipDeploy) {
  Write-Step 'Deploying to Fly.io'
  Push-Location $scriptRoot
  try {
    $deployResult = Invoke-Flyctl -Arguments @('deploy', '-a', 'access-api', '--remote-only') -PassThruToHost
    if ($deployResult.ExitCode -ne 0) {
      throw "flyctl deploy failed."
    }
  } finally {
    Pop-Location
  }
  Write-Ok 'Deployed.'
} else {
  Write-Step 'Skipping deploy (SkipDeploy set)'
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '=== Deployment complete! ===' -ForegroundColor Green
Write-Host ''
Write-Host 'Test your live API:' -ForegroundColor Yellow
Write-Host "  curl https://access-api.fly.dev/health"
Write-Host "  curl -H 'X-Api-Key: $ApiKey' 'https://access-api.fly.dev/user?id=YOUR_ID&table=$TableName'"
Write-Host ''
Write-Host 'Configure the browser extension:' -ForegroundColor Yellow
Write-Host '  Popup -> Lookup tab -> Mode: Cloud'
Write-Host '  Worker URL: https://access-api.fly.dev'
Write-Host "  API Key: $ApiKey"
Write-Host ''
Write-Host 'Second Neon (extra columns, new free tier):' -ForegroundColor Yellow
Write-Host '  .\Deploy-SecondaryNeon.ps1 -ExtraDatabaseUrl "postgres://..."'
Write-Host ''
Write-Host 'Useful commands:' -ForegroundColor Yellow
Write-Host '  flyctl logs -a access-api -f'
Write-Host '  flyctl status -a access-api'
