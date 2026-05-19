<#
.SYNOPSIS
  Deploy extra Sgaza columns to a second Neon Postgres (new free-tier account).

.DESCRIPTION
  Primary Neon (DATABASE_URL) already has:
    الهوية, الاسم, الاب, الجد, العائلة, اسم الام, الجنس  (CSV indexes 0-5 and 7)

  Secondary Neon gets الهوية (for lookups) plus every other column not in primary
  (e.g. تاريخ الميلاد, رمز المحافظة, رمز المنطقة, الاسم رباعي بعد الزواج, ...).

.PARAMETER ShowImportStatus
  Show resumable import checkpoint status from the extra Neon DB and exit.

.PARAMETER StopAfterBatches
  Stop after N committed batches (1000 rows each). Re-run the same command to resume.

.PARAMETER RecreateFirst
  Drop and recreate the table before import (use after a failed/broken import).

.EXAMPLE
  .\Deploy-SecondaryNeon.ps1 -ExtraDatabaseUrl "postgresql://..."

.EXAMPLE
  # Pause after 50 batches (~50k rows), then resume later:
  .\Deploy-SecondaryNeon.ps1 -ExtraDatabaseUrl "postgresql://..." -StopAfterBatches 50
  .\Deploy-SecondaryNeon.ps1 -ExtraDatabaseUrl "postgresql://..."

.EXAMPLE
  .\Deploy-SecondaryNeon.ps1 -ExtraDatabaseUrl "postgresql://..." -ShowImportStatus
#>

param(
  [Parameter(Mandatory = $true)][string]$ExtraDatabaseUrl,
  [string]$CsvPath = '',
  [string]$TableName = 'Sgaza',
  [string]$DbPath = '',
  [switch]$SkipExport,
  [switch]$ForceCsvExport,
  [switch]$ShowImportStatus,
  [int]$StopAfterBatches = 0,
  [switch]$RecreateFirst,
  [string]$ApiKey = '',
  [switch]$SkipFlySecrets,
  [int]$MaxTableMb = 500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = $PSScriptRoot
$workspaceRoot = Split-Path $scriptRoot -Parent
$exportScript = Join-Path $workspaceRoot 'data_tools\Export-AccessToCsv.ps1'
$migrateScript = Join-Path $scriptRoot 'scripts\migrate-csv-to-postgres.js'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "WARN $msg" -ForegroundColor Yellow }

# Matches your primary Neon table (see screenshot): الهوية .. الجنس (index 6 = birth date skipped)
function Get-PrimaryColumnIndexes {
  @(0, 1, 2, 3, 4, 5, 7)
}

# All Sgaza columns to export for the secondary DB (primary columns + the rest)
function Get-FullSecondaryExportIndexes {
  @(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14)
}

function Get-CsvHeaderColumns {
  param([Parameter(Mandatory = $true)][string]$Path)

  $headerLine = $null
  foreach ($encoding in @([System.Text.UTF8Encoding]::new($false), [System.Text.Encoding]::Default)) {
    try {
      $headerLine = [System.IO.File]::ReadAllLines($Path, $encoding)[0]
      if (-not [string]::IsNullOrWhiteSpace($headerLine)) { break }
    } catch {
      continue
    }
  }

  if ([string]::IsNullOrWhiteSpace($headerLine)) {
    throw 'CSV header row is empty.'
  }

  return ($headerLine -split ',') | ForEach-Object {
    $value = ([string]$_).TrimStart([char]0xFEFF).Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) {
      $value.Substring(1, $value.Length - 2)
    } else {
      $value.Trim()
    }
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
    throw 'Unable to resolve columns from CSV header indexes.'
  }

  return $selected
}

function Get-ExtraOriginalColumnIndexes {
  param([Parameter(Mandatory = $true)][string[]]$HeaderColumns)

  $primary = Get-PrimaryColumnIndexes
  $exportSet = Get-FullSecondaryExportIndexes
  $maxIndex = [Math]::Max($exportSet[-1], $HeaderColumns.Count - 1)
  $extra = [System.Collections.Generic.List[int]]::new()

  # Always keep الهوية (index 0) in secondary for merged lookups
  [void]$extra.Add(0)

  for ($index = 0; $index -le $maxIndex; $index++) {
    if ($index -eq 0) { continue }
    if ($primary -contains $index) { continue }
    if ($index -ge $HeaderColumns.Count) { continue }
    if ([string]::IsNullOrWhiteSpace($HeaderColumns[$index])) { continue }
    if (-not $extra.Contains($index)) { [void]$extra.Add($index) }
  }

  return @($extra)
}

function Convert-OriginalIndexesToCsvPositions {
  param(
    [Parameter(Mandatory = $true)][int[]]$OriginalIndexes,
    [Parameter(Mandatory = $true)][string[]]$HeaderColumns
  )

  $exportSet = Get-FullSecondaryExportIndexes
  $isSlimExport = ($HeaderColumns.Count -eq $exportSet.Count)

  if ($isSlimExport) {
    $positions = [System.Collections.Generic.List[int]]::new()
    foreach ($orig in $OriginalIndexes) {
      $pos = [array]::IndexOf([int[]]$exportSet, [int]$orig)
      if ($pos -ge 0 -and -not $positions.Contains($pos)) {
        [void]$positions.Add($pos)
      }
    }
    return @($positions)
  }

  $positions = @()
  foreach ($orig in $OriginalIndexes) {
    if ($orig -ge 0 -and $orig -lt $HeaderColumns.Count) {
      if ($positions -notcontains $orig) { $positions += $orig }
    }
  }
  return $positions
}

function Get-ColumnsFromCsvPositions {
  param(
    [Parameter(Mandatory = $true)][string[]]$HeaderColumns,
    [Parameter(Mandatory = $true)][int[]]$CsvPositions
  )

  $selected = @()
  foreach ($pos in $CsvPositions) {
    if ($pos -ge 0 -and $pos -lt $HeaderColumns.Count) {
      $name = [string]$HeaderColumns[$pos]
      if (-not [string]::IsNullOrWhiteSpace($name) -and ($selected -notcontains $name)) {
        $selected += $name
      }
    }
  }

  if ($selected.Count -eq 0) {
    throw 'Unable to resolve columns from CSV positions.'
  }

  return $selected
}

if ($ShowImportStatus) {
  Write-Step "Checking import status (extra Neon, table: $TableName)"
  Push-Location $scriptRoot
  try {
    $env:DATABASE_URL = $ExtraDatabaseUrl
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
    Remove-Item Env:\DATABASE_URL, Env:\PG_SCHEMA, Env:\PG_TABLE, Env:\PG_SSL, Env:\PG_STATUS_ONLY -ErrorAction SilentlyContinue
  }
  return
}

if ([string]::IsNullOrWhiteSpace($CsvPath)) {
  $CsvPath = Join-Path $workspaceRoot 'Sgaza.csv'
}

if ($ForceCsvExport -and (Test-Path -LiteralPath $CsvPath)) {
  Remove-Item -LiteralPath $CsvPath -Force
  Write-Ok 'Removed old CSV for fresh export'
}

if (-not $SkipExport -and -not (Test-Path -LiteralPath $CsvPath)) {
  Write-Step 'Exporting Access table to CSV'
  if (-not (Test-Path -LiteralPath $exportScript)) {
    throw "Export script not found: $exportScript"
  }
  if ([string]::IsNullOrWhiteSpace($DbPath)) {
    $candidate = Get-ChildItem -LiteralPath $workspaceRoot -Filter '*.accdb' -File | Select-Object -First 1
    if (-not $candidate) { throw 'No .accdb found. Pass -DbPath or create Sgaza.csv manually.' }
    $DbPath = $candidate.FullName
  }
  $indexes = Get-FullSecondaryExportIndexes
  & $exportScript -DbPath $DbPath -TableName $TableName -OutputPath $CsvPath -ColumnIndexes $indexes
  Write-Ok "CSV: $CsvPath"
}

if (-not (Test-Path -LiteralPath $CsvPath)) {
  throw "CSV not found: $CsvPath"
}

$headerColumns = Get-CsvHeaderColumns -Path $CsvPath
$primaryOriginalIndexes = Get-PrimaryColumnIndexes
$extraOriginalIndexes = Get-ExtraOriginalColumnIndexes -HeaderColumns $headerColumns
$primaryColumns = Get-ColumnsFromHeaderByIndexes -HeaderColumns $headerColumns -TargetIndexes $primaryOriginalIndexes
$extraCsvPositions = Convert-OriginalIndexesToCsvPositions -OriginalIndexes $extraOriginalIndexes -HeaderColumns $headerColumns
$extraColumns = Get-ColumnsFromCsvPositions -HeaderColumns $headerColumns -CsvPositions $extraCsvPositions

Write-Step 'Extra Neon column profile'
Write-Host "  CSV columns              : $($headerColumns.Count)"
Write-Host "  Primary DB indexes (skip): $($primaryOriginalIndexes -join ', ')"
Write-Host "  Primary DB columns       : $($primaryColumns -join ' | ')"
Write-Host "  Extra original indexes   : $($extraOriginalIndexes -join ', ')"
Write-Host "  Extra CSV positions      : $($extraCsvPositions -join ', ')"
Write-Host "  Extra DB columns         : $($extraColumns -join ' | ')"

if ($extraCsvPositions.Count -eq 0) {
  throw 'No extra CSV positions resolved. Re-export Sgaza.csv with -ColumnIndexes from Get-WithLocationColumnIndexes.'
}

if ($extraCsvPositions -notcontains 0) {
  throw 'Join column (CSV position 0) is required in extra DB for lookups.'
}

if ($extraColumns.Count -le 1) {
  throw 'No extra columns resolved. Re-export Sgaza.csv (run without -SkipExport).'
}

Write-Step "Migrating to extra Neon (table: $TableName, max ${MaxTableMb} MB)"
Push-Location $scriptRoot
try {
  $env:DATABASE_URL = $ExtraDatabaseUrl
  $env:PG_SCHEMA = 'public'
  $env:PG_TABLE = $TableName
  $env:PG_SSL = 'true'
  $env:CSV_PATH = $CsvPath
  $env:CSV_KEEP_COLUMN_INDEXES = ($extraCsvPositions -join ',')
  $env:PG_INDEX_MODE = 'hash'
  $env:PG_BATCH_SIZE = '1000'
  $env:PG_RESUME_IMPORT = 'true'
  $env:PG_RECREATE_FIRST = $(if ($RecreateFirst) { 'true' } else { 'false' })
  $env:PG_TRUNCATE_FIRST = $(if ($RecreateFirst) { 'true' } else { 'false' })
  $env:PG_STOP_AFTER_BATCHES = [string][Math]::Max(0, $StopAfterBatches)
  $env:PG_MAX_TABLE_MB = [string]$MaxTableMb

  node $migrateScript
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    if ($LASTEXITCODE -eq 42) {
      Write-Warn 'Still over size limit. Retrying with index disabled (smaller table)...'
      $env:PG_INDEX_MODE = 'none'
      $env:PG_RECREATE_FIRST = 'true'
      $env:PG_TRUNCATE_FIRST = 'true'
      $env:PG_RESUME_IMPORT = 'false'
      node $migrateScript
    }
  }

  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "Migration failed (exit $LASTEXITCODE). Try -MaxTableMb 512 or reduce extra columns."
  }
} finally {
  Pop-Location
  Remove-Item Env:\DATABASE_URL, Env:\CSV_KEEP_COLUMN_INDEXES, Env:\PG_MAX_TABLE_MB, Env:\PG_INDEX_MODE, Env:\PG_RESUME_IMPORT, Env:\PG_RECREATE_FIRST, Env:\PG_TRUNCATE_FIRST, Env:\PG_STOP_AFTER_BATCHES -ErrorAction SilentlyContinue
}

Write-Ok 'Extra Neon database ready.'

if (-not $SkipFlySecrets) {
  Write-Step 'Setting Fly.io secret DATABASE_URL_EXTRA'
  $flyArgs = @('secrets', 'set', "DATABASE_URL_EXTRA=$ExtraDatabaseUrl", '-a', 'access-api')
  if (-not [string]::IsNullOrWhiteSpace($ApiKey)) {
    $flyArgs = @('secrets', 'set', "DATABASE_URL_EXTRA=$ExtraDatabaseUrl", "ACCESS_API_KEY=$ApiKey", '-a', 'access-api')
  }
  & flyctl @flyArgs
  if ($LASTEXITCODE -ne 0) {
    throw 'flyctl secrets set failed. Run manually: flyctl secrets set DATABASE_URL_EXTRA=... -a access-api'
  }
  Write-Ok 'Fly secret DATABASE_URL_EXTRA set. Redeploy: flyctl deploy -a access-api'
}

Write-Host ''
Write-Host '=== Done ===' -ForegroundColor Green
Write-Host 'Test merged lookup (after deploy):'
Write-Host '  curl https://access-api.fly.dev/health'
Write-Host ('  curl -H "X-Api-Key: YOUR_KEY" "https://access-api.fly.dev/user?id=YOUR_ID&table=' + $TableName + '&idColumn=ID_COLUMN"')
