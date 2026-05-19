const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const csv = require('csv-parser');
const { Pool } = require('pg');
require('dotenv').config();

const CSV_PATH = path.resolve(process.env.CSV_PATH || path.join(__dirname, '..', 'Sgaza.csv'));
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const PG_SCHEMA = String(process.env.PG_SCHEMA || 'public').trim();
const PG_TABLE = String(process.env.PG_TABLE || 'Sgaza').trim();
const PG_SSL = toBool(process.env.PG_SSL, false);
const TRUNCATE_FIRST = toBool(process.env.PG_TRUNCATE_FIRST, false);
const RECREATE_FIRST = toBool(process.env.PG_RECREATE_FIRST, false);
const RESUME_IMPORT = toBool(process.env.PG_RESUME_IMPORT, true);
const STATUS_ONLY = toBool(process.env.PG_STATUS_ONLY, false);
const STOP_AFTER_BATCHES = Math.max(0, Number(process.env.PG_STOP_AFTER_BATCHES || 0));
const BATCH_SIZE = Math.max(1, Number(process.env.PG_BATCH_SIZE || 500));
const MAX_TABLE_MB = Math.max(0, Number(process.env.PG_MAX_TABLE_MB || 0));
const PRECHECK_SAFETY_FACTOR = Math.max(1, Number(process.env.PG_PRECHECK_SAFETY_FACTOR || 1.35));
const RETRY_MAX_ATTEMPTS = Math.max(1, Number(process.env.PG_RETRY_MAX_ATTEMPTS || 5));
const RETRY_BASE_DELAY_MS = Math.max(100, Number(process.env.PG_RETRY_BASE_DELAY_MS || 1000));
const KEEP_COLUMNS = parseCsvList(process.env.CSV_KEEP_COLUMNS);
const KEEP_COLUMN_INDEXES = parseIndexList(process.env.CSV_KEEP_COLUMN_INDEXES);
const INDEX_MODE = parseIndexMode(process.env.PG_INDEX_MODE);
const IMPORT_PROGRESS_TABLE = '__import_progress';

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

if (!STATUS_ONLY && !fs.existsSync(CSV_PATH)) {
  throw new Error(`CSV file not found: ${CSV_PATH}`);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PG_SSL ? { rejectUnauthorized: false } : false,
  keepAlive: true,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  const message = err && err.message ? String(err.message) : String(err || 'unknown pool error');
  console.warn(`Warning: idle PostgreSQL client error: ${message}`);
});

async function main() {
  console.log(`CSV      : ${CSV_PATH}`);
  console.log(`Schema   : ${PG_SCHEMA}`);
  console.log(`Table    : ${PG_TABLE}`);
  console.log(`Batch    : ${BATCH_SIZE}`);
  console.log(`Truncate : ${TRUNCATE_FIRST}`);
  console.log(`Recreate : ${RECREATE_FIRST}`);
  console.log(`Resume   : ${RESUME_IMPORT}`);
  console.log(`Status   : ${STATUS_ONLY}`);
  console.log(`Stop     : ${STOP_AFTER_BATCHES}`);
  console.log(`Index    : ${INDEX_MODE}`);
  if (MAX_TABLE_MB > 0) {
    console.log(`Max MB   : ${MAX_TABLE_MB}`);
  }
  if (KEEP_COLUMN_INDEXES.length > 0) {
    console.log(`Keep idx: ${KEEP_COLUMN_INDEXES.join(', ')}`);
  } else if (KEEP_COLUMNS.length > 0) {
    console.log(`Keep cols: ${KEEP_COLUMNS.join(', ')}`);
  }

  if (STATUS_ONLY) {
    await showImportStatus();
    return;
  }

  let preselectedColumns = null;
  if (MAX_TABLE_MB > 0) {
    const estimate = await estimateImportSizeBeforeStart();
    preselectedColumns = estimate.columns;
    console.log(`Precheck : estimated ${estimate.estimatedMb.toFixed(2)} MB before import (${estimate.rowCount} rows, safety x${PRECHECK_SAFETY_FACTOR})`);

    if (estimate.estimatedMb > MAX_TABLE_MB) {
      throw new Error(`Estimated table size ${estimate.estimatedMb.toFixed(2)} MB exceeds limit ${MAX_TABLE_MB} MB before migration start`);
    }
  }

  const stream = createCsvStream();

  let columns = null;
  let insertSql = '';
  let batch = [];
  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  let checkpoint = null;
  let committedBatches = 0;

  for await (const row of stream) {
    if (!columns) {
      const csvColumns = Object.keys(row);
      const resolvedColumns = resolveImportColumns(csvColumns);
      columns = Array.isArray(preselectedColumns) && preselectedColumns.length > 0
        ? preselectedColumns
        : resolvedColumns;

      if (columns.length === 0) {
        throw new Error('CSV has no headers/columns');
      }

      logColumnResolutionWarnings(csvColumns);

      await ensureImportProgressTable();
      checkpoint = buildImportCheckpoint(columns);

      if (RECREATE_FIRST) {
        await clearImportProgress(checkpoint.key);
      }

      if (RECREATE_FIRST) {
        await dropTable();
      }

      await ensureTable(columns);
      if (TRUNCATE_FIRST) {
        await truncateTable();
      }

      insertSql = buildInsertSql(columns);
      await ensureLookupIndexes(columns);

      if (RESUME_IMPORT && !RECREATE_FIRST && !TRUNCATE_FIRST) {
        const savedProgress = await getImportProgress(checkpoint.key, checkpoint.profileSignature);
        if (savedProgress && savedProgress.status === 'completed') {
          console.log(`Resume   : previous import already completed at row ${savedProgress.processed_rows}`);
          const tableSizeBytes = await getTableSizeBytes();
          const tableSizeMb = tableSizeBytes / (1024 * 1024);
          console.log(`Table MB : ${tableSizeMb.toFixed(2)}`);
          if (MAX_TABLE_MB > 0 && tableSizeMb > MAX_TABLE_MB) {
            throw new Error(`Table size ${tableSizeMb.toFixed(2)} MB exceeds limit ${MAX_TABLE_MB} MB`);
          }
          console.log(`Done. Processed ${savedProgress.processed_rows} rows, inserted ${savedProgress.inserted_rows || savedProgress.processed_rows} rows.`);
          return;
        }

        if (!savedProgress) {
          const anyCompleted = await getImportProgressAny(checkpoint.key);
          if (anyCompleted && anyCompleted.status === 'completed') {
            console.log('Resume   : found completed import checkpoint from a previous profile. Skipping re-import.');
            console.log(`Rows     : processed=${anyCompleted.processed_rows} inserted=${anyCompleted.inserted_rows || anyCompleted.processed_rows}`);
            const tableSizeBytes = await getTableSizeBytes();
            const tableSizeMb = tableSizeBytes / (1024 * 1024);
            console.log(`Table MB : ${tableSizeMb.toFixed(2)}`);
            if (MAX_TABLE_MB > 0 && tableSizeMb > MAX_TABLE_MB) {
              throw new Error(`Table size ${tableSizeMb.toFixed(2)} MB exceeds limit ${MAX_TABLE_MB} MB`);
            }
            console.log(`Done. Processed ${anyCompleted.processed_rows} rows, inserted ${anyCompleted.inserted_rows || anyCompleted.processed_rows} rows.`);
            return;
          }
        }

        if (savedProgress && Number(savedProgress.processed_rows || 0) > 0) {
          skipped = Number(savedProgress.processed_rows || 0);
          inserted = Number(savedProgress.inserted_rows || 0);
          console.log(`Resume   : continuing from row ${skipped}`);
        }
      }
    }

    if (skipped > 0) {
      skipped--;
      processed++;
      continue;
    }

    batch.push(columns.map((column) => normalizeValue(row[column])));
    processed++;

    if (batch.length >= BATCH_SIZE) {
      const count = await insertBatch(insertSql, batch, checkpoint, processed, inserted + batch.length);
      inserted += count;
      batch = [];
      committedBatches++;

      if (STOP_AFTER_BATCHES > 0 && committedBatches >= STOP_AFTER_BATCHES) {
        console.log(`Paused   : stopped after ${committedBatches} committed batches at row ${processed}`);
        return;
      }

      if (inserted % 10000 === 0) {
        console.log(`Inserted ${inserted} rows...`);
      }
    }
  }

  if (batch.length > 0) {
    inserted += await insertBatch(insertSql, batch, checkpoint, processed, inserted + batch.length);
    committedBatches++;

    if (STOP_AFTER_BATCHES > 0 && committedBatches >= STOP_AFTER_BATCHES) {
      console.log(`Paused   : stopped after ${committedBatches} committed batches at row ${processed}`);
      return;
    }
  }

  if (checkpoint) {
    await markImportCompleted(checkpoint.key, checkpoint.profileSignature, processed, inserted);
  }

  const tableSizeBytes = await getTableSizeBytes();
  const tableSizeMb = tableSizeBytes / (1024 * 1024);
  console.log(`Table MB : ${tableSizeMb.toFixed(2)}`);

  if (MAX_TABLE_MB > 0 && tableSizeMb > MAX_TABLE_MB) {
    throw new Error(`Table size ${tableSizeMb.toFixed(2)} MB exceeds limit ${MAX_TABLE_MB} MB`);
  }

  console.log(`Done. Processed ${processed} rows, inserted ${inserted} rows.`);
}

async function estimateImportSizeBeforeStart() {
  const stream = createCsvStream();
  let columns = null;
  let rowCount = 0;
  let payloadBytes = 0;

  for await (const row of stream) {
    if (!columns) {
      const csvColumns = Object.keys(row);
      columns = resolveImportColumns(csvColumns);

      if (columns.length === 0) {
        throw new Error('CSV has no headers/columns');
      }

      logColumnResolutionWarnings(csvColumns);
    }

    rowCount++;
    payloadBytes += estimateRowPayloadBytes(row, columns);
  }

  if (!columns || rowCount === 0) {
    throw new Error('CSV is empty or has no data rows');
  }

  const tableBytesEstimate = estimateTableBytes(payloadBytes, rowCount, columns);
  return {
    columns,
    rowCount,
    estimatedMb: tableBytesEstimate / (1024 * 1024)
  };
}

function estimateRowPayloadBytes(row, columns) {
  let rowBytes = 24; // conservative tuple overhead
  for (const column of columns) {
    const value = normalizeValue(row[column]);
    if (value == null) {
      rowBytes += 1;
      continue;
    }

    rowBytes += Buffer.byteLength(value, 'utf8') + 1;
  }

  return rowBytes;
}

function estimateTableBytes(payloadBytes, rowCount, columns) {
  let estimate = payloadBytes * PRECHECK_SAFETY_FACTOR;

  const normalized = new Set(columns.map((x) => String(x || '').toLowerCase()));
  const hasLookupIndex = ['الهوية', 'id', 'identity'].some((x) => normalized.has(x.toLowerCase()));
  if (INDEX_MODE !== 'none' && hasLookupIndex) {
    // Approximate additional bytes for single-column lookup index.
    estimate += rowCount * 40;
  }

  return estimate;
}

async function ensureTable(columns) {
  if (!columns.length) {
    throw new Error('No valid column names to create table');
  }

  const columnSql = columns.map((column) => `${quoteIdent(column)} text`).join(', ');
  const sql = `
    CREATE SCHEMA IF NOT EXISTS ${quoteIdent(PG_SCHEMA)};
    CREATE TABLE IF NOT EXISTS ${qualifiedTable()} (${columnSql});
  `;

  await pool.query(sql);

  // If the table already existed from a previous profile, ensure all required
  // columns are present so subsequent inserts do not fail.
  const existingColumns = await getExistingTableColumns();
  for (const column of columns) {
    if (existingColumns.has(column)) {
      continue;
    }

    const addColumnSql = `ALTER TABLE ${qualifiedTable()} ADD COLUMN IF NOT EXISTS ${quoteIdent(column)} text`;
    await pool.query(addColumnSql);
  }
}

async function getExistingTableColumns() {
  const result = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
    `,
    [PG_SCHEMA, PG_TABLE]
  );

  return new Set(result.rows.map((row) => String(row.column_name || '')));
}

async function truncateTable() {
  await pool.query(`TRUNCATE TABLE ${qualifiedTable()}`);
}

async function dropTable() {
  await pool.query(`DROP TABLE IF EXISTS ${qualifiedTable()}`);
}

function buildInsertSql(columns) {
  const columnSql = columns.map((column) => quoteIdent(column)).join(', ');
  return `INSERT INTO ${qualifiedTable()} (${columnSql}) VALUES `;
}

async function insertBatch(insertBaseSql, rows, checkpoint, processedRows, insertedRows) {
  if (!rows.length) {
    return 0;
  }

  const values = [];
  const tuples = rows.map((row, rowIndex) => {
    const placeholders = row.map((_value, colIndex) => {
      const placeholderIndex = rowIndex * row.length + colIndex + 1;
      values.push(row[colIndex]);
      return `$${placeholderIndex}::text`;
    });
    return `(${placeholders.join(', ')})`;
  });

  const sql = `${insertBaseSql}${tuples.join(', ')}`;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    const onClientError = (err) => {
      const message = err && err.message ? String(err.message) : String(err || 'unknown client error');
      console.warn(`Warning: PostgreSQL client error during batch write: ${message}`);
    };

    client.on('error', onClientError);

    try {
      await client.query('BEGIN');
      await client.query(sql, values);
      if (checkpoint) {
        await upsertImportProgress(client, checkpoint.key, checkpoint.profileSignature, processedRows, insertedRows, 'in_progress');
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {
        // Connection may already be closed; rollback is best effort.
      }

      if (checkpoint) {
        const existing = await getImportProgressAny(checkpoint.key);
        const progressed = existing
          && Number(existing.processed_rows || 0) >= Number(processedRows || 0)
          && Number(existing.inserted_rows || 0) >= Number(insertedRows || 0);
        if (progressed) {
          return rows.length;
        }
      }

      const canRetry = isRetryablePgError(error) && attempt < RETRY_MAX_ATTEMPTS;
      if (!canRetry) {
        throw error;
      }

      const waitMs = RETRY_BASE_DELAY_MS * attempt;
      const errorMessage = error && error.message ? String(error.message) : String(error || 'unknown error');
      console.warn(`Warning: batch insert attempt ${attempt}/${RETRY_MAX_ATTEMPTS} failed (${errorMessage}). Retrying in ${waitMs} ms...`);
      await delay(waitMs);
    } finally {
      client.removeListener('error', onClientError);
      client.release();
    }
  }

  throw new Error('Batch insert failed after maximum retry attempts');
}

async function ensureLookupIndexes(columns) {
  if (INDEX_MODE === 'none') {
    return;
  }

  const normalized = new Set(columns.map((x) => String(x || '').toLowerCase()));
  const indexTargets = ['الهوية', 'id', 'identity'].filter((x) => normalized.has(x.toLowerCase()));

  for (const column of indexTargets) {
    const idxName = `idx_${slugify(PG_TABLE)}_${slugify(column)}_lookup`;
    const usingSql = INDEX_MODE === 'hash' ? ' USING HASH' : '';
    const sql = `CREATE INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${qualifiedTable()}${usingSql} (${quoteIdent(column)})`;
    await pool.query(sql);
  }
}

async function getTableSizeBytes() {
  const result = await pool.query(
    "SELECT pg_total_relation_size(format('%I.%I', $1::text, $2::text)::regclass) AS bytes",
    [PG_SCHEMA, PG_TABLE]
  );
  const value = result.rows[0] && result.rows[0].bytes;
  return Number(value || 0);
}

async function showImportStatus() {
  const importKey = `${PG_SCHEMA}.${PG_TABLE}`;
  const hasProgressTable = await importProgressTableExists();
  const progress = hasProgressTable ? await getImportProgressAny(importKey) : null;
  const tableSizeBytes = await getExistingTableSizeBytes();
  const tableSizeMb = tableSizeBytes / (1024 * 1024);

  console.log(`Import   : ${importKey}`);
  if (!progress) {
    console.log('Progress : no checkpoint found');
  } else {
    console.log(`Progress : ${progress.status}`);
    console.log(`Rows     : processed=${progress.processed_rows} inserted=${progress.inserted_rows}`);
    console.log(`Updated  : ${progress.updated_at}`);
  }
  console.log(`Table MB : ${tableSizeMb.toFixed(2)}`);
}

async function ensureImportProgressTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${quoteIdent(PG_SCHEMA)}.${quoteIdent(IMPORT_PROGRESS_TABLE)} (
      import_key text PRIMARY KEY,
      profile_signature text NOT NULL,
      processed_rows bigint NOT NULL DEFAULT 0,
      inserted_rows bigint NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'in_progress',
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  await pool.query(sql);
}

async function importProgressTableExists() {
  const result = await pool.query(
    "SELECT to_regclass(format('%I.%I', $1::text, $2::text)) AS name",
    [PG_SCHEMA, IMPORT_PROGRESS_TABLE]
  );
  return Boolean(result.rows[0] && result.rows[0].name);
}

function buildImportCheckpoint(columns) {
  const profileSignature = JSON.stringify({
    csvPath: CSV_PATH,
    schema: PG_SCHEMA,
    table: PG_TABLE,
    columns,
    indexMode: INDEX_MODE
  });

  return {
    key: `${PG_SCHEMA}.${PG_TABLE}`,
    profileSignature
  };
}

async function getImportProgress(importKey, profileSignature) {
  const sql = `
    SELECT import_key, profile_signature, processed_rows, inserted_rows, status
    FROM ${quoteIdent(PG_SCHEMA)}.${quoteIdent(IMPORT_PROGRESS_TABLE)}
    WHERE import_key = $1
  `;
  const result = await pool.query(sql, [importKey]);
  const row = result.rows[0] || null;
  if (!row) {
    return null;
  }

  if (String(row.profile_signature || '') !== String(profileSignature || '')) {
    return null;
  }

  return row;
}

async function getImportProgressAny(importKey) {
  const sql = `
    SELECT import_key, profile_signature, processed_rows, inserted_rows, status, updated_at
    FROM ${quoteIdent(PG_SCHEMA)}.${quoteIdent(IMPORT_PROGRESS_TABLE)}
    WHERE import_key = $1
  `;
  const result = await pool.query(sql, [importKey]);
  return result.rows[0] || null;
}

async function getExistingTableSizeBytes() {
  const exists = await pool.query(
    "SELECT to_regclass(format('%I.%I', $1::text, $2::text)) AS name",
    [PG_SCHEMA, PG_TABLE]
  );
  if (!exists.rows[0] || !exists.rows[0].name) {
    return 0;
  }

  return getTableSizeBytes();
}

async function clearImportProgress(importKey) {
  const sql = `DELETE FROM ${quoteIdent(PG_SCHEMA)}.${quoteIdent(IMPORT_PROGRESS_TABLE)} WHERE import_key = $1`;
  await pool.query(sql, [importKey]);
}

async function upsertImportProgress(client, importKey, profileSignature, processedRows, insertedRows, status) {
  const sql = `
    INSERT INTO ${quoteIdent(PG_SCHEMA)}.${quoteIdent(IMPORT_PROGRESS_TABLE)}
      (import_key, profile_signature, processed_rows, inserted_rows, status, updated_at)
    VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (import_key)
    DO UPDATE SET
      profile_signature = EXCLUDED.profile_signature,
      processed_rows = EXCLUDED.processed_rows,
      inserted_rows = EXCLUDED.inserted_rows,
      status = EXCLUDED.status,
      updated_at = now()
  `;
  await client.query(sql, [importKey, profileSignature, processedRows, insertedRows, status]);
}

async function markImportCompleted(importKey, profileSignature, processedRows, insertedRows) {
  const client = await pool.connect();
  try {
    await upsertImportProgress(client, importKey, profileSignature, processedRows, insertedRows, 'completed');
  } finally {
    client.release();
  }
}

function qualifiedTable() {
  return `${quoteIdent(PG_SCHEMA)}.${quoteIdent(PG_TABLE)}`;
}

function quoteIdent(name) {
  return `"${String(name || '').replace(/"/g, '""')}"`;
}

function createCsvStream() {
  let bomChecked = false;

  const stripFileBom = new Transform({
    transform(chunk, encoding, callback) {
      if (!bomChecked) {
        bomChecked = true;
        if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
          chunk = chunk.subarray(3);
        }
      }

      callback(null, chunk);
    }
  });

  return fs.createReadStream(CSV_PATH)
    .pipe(stripFileBom)
    .pipe(csv({ mapHeaders: ({ header }) => sanitizeColumnName(header) || stripBom(header) }));
}

function stripBom(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim();
}

function sanitizeColumnName(value) {
  const cleaned = stripBom(String(value || ''))
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, '')
    .trim();

  return cleaned || null;
}

function normalizeValue(value) {
  const source = String(value == null ? '' : value).trim();
  return source === '' ? null : source;
}

function toBool(value, fallback) {
  const source = String(value || '').trim().toLowerCase();
  if (!source) {
    return fallback;
  }

  return source === '1' || source === 'true' || source === 'yes' || source === 'on';
}

function parseCsvList(value) {
  const source = String(value || '').trim();
  if (!source) {
    return [];
  }

  return source
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIndexList(value) {
  return parseCsvList(value)
    .map((item) => Number.parseInt(item, 10))
    .filter((index) => Number.isInteger(index) && index >= 0);
}

function resolveImportColumns(csvColumns) {
  let resolved = csvColumns;

  if (KEEP_COLUMN_INDEXES.length > 0) {
    resolved = resolveColumnsByIndexes(csvColumns, KEEP_COLUMN_INDEXES);
  } else if (KEEP_COLUMNS.length > 0) {
    resolved = resolveRequestedColumns(csvColumns, KEEP_COLUMNS);
  }

  return resolved
    .map((column) => sanitizeColumnName(column))
    .filter(Boolean);
}

function resolveColumnsByIndexes(csvColumns, indexes) {
  const selected = [];
  const seen = new Set();

  for (const index of indexes) {
    if (index >= csvColumns.length) {
      continue;
    }

    let name = sanitizeColumnName(csvColumns[index]);
    if (!name && index === 0) {
      name = findIdentityColumnName(csvColumns);
    }

    if (!name) {
      console.log(`Warning: skipping CSV index ${index} (empty or invalid column name)`);
      continue;
    }

    if (seen.has(name)) {
      continue;
    }

    selected.push(name);
    seen.add(name);
  }

  return selected;
}

function findIdentityColumnName(csvColumns) {
  const aliases = ['الهوية', 'الهوية رقم', 'رقم الهوية', 'id', 'identity'];
  for (const column of csvColumns) {
    const cleaned = sanitizeColumnName(column);
    if (!cleaned) {
      continue;
    }

    const normalized = normalizeColumnName(cleaned);
    if (aliases.some((alias) => normalizeColumnName(alias) === normalized)) {
      return cleaned;
    }
  }

  for (const column of csvColumns) {
    const cleaned = sanitizeColumnName(column);
    if (cleaned) {
      return cleaned;
    }
  }

  return null;
}

function logColumnResolutionWarnings(csvColumns) {
  if (KEEP_COLUMN_INDEXES.length > 0) {
    const missingIndexes = KEEP_COLUMN_INDEXES.filter((index) => index >= csvColumns.length);
    if (missingIndexes.length > 0) {
      console.log(`Warning: ${missingIndexes.length} requested column indexes are out of range: ${missingIndexes.join(', ')} (CSV has ${csvColumns.length} columns)`);
    }

    return;
  }

  if (KEEP_COLUMNS.length > 0) {
    const missing = findMissingRequestedColumns(csvColumns, KEEP_COLUMNS);
    if (missing.length > 0) {
      console.log(`Warning: ${missing.length} requested columns were not found in CSV: ${missing.join(', ')}`);
    }
  }
}

function resolveRequestedColumns(csvColumns, requestedColumns) {
  const byNormalized = new Map();
  csvColumns.forEach((name) => {
    byNormalized.set(normalizeColumnName(name), name);
  });

  const selected = [];
  const seen = new Set();
  for (const requested of requestedColumns) {
    const candidates = getColumnCandidates(requested);
    for (const candidate of candidates) {
      const hit = byNormalized.get(normalizeColumnName(candidate));
      if (hit && !seen.has(hit)) {
        selected.push(hit);
        seen.add(hit);
        break;
      }
    }
  }

  return selected;
}

function findMissingRequestedColumns(csvColumns, requestedColumns) {
  const byNormalized = new Set(csvColumns.map((name) => normalizeColumnName(name)));
  return requestedColumns.filter((requested) => {
    const candidates = getColumnCandidates(requested);
    return !candidates.some((candidate) => byNormalized.has(normalizeColumnName(candidate)));
  });
}

function getColumnCandidates(name) {
  const source = String(name || '').trim();
  const normalized = normalizeColumnName(source);

  if (normalized === normalizeColumnName('الهوية')) {
    return ['الهوية', 'الهوية رقم', source];
  }

  if (normalized === normalizeColumnName('الهوية رقم')) {
    return ['الهوية رقم', 'الهوية', source];
  }

  return [source];
}

function normalizeColumnName(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, '')
    .trim();
}

function parseIndexMode(value) {
  const mode = String(value || 'hash').trim().toLowerCase();
  if (mode === 'none' || mode === 'hash' || mode === 'btree') {
    return mode;
  }

  return 'hash';
}

function isRetryablePgError(error) {
  const message = String((error && error.message) || error || '').toLowerCase();
  return [
    'connection terminated unexpectedly',
    'server closed the connection unexpectedly',
    'connection ended unexpectedly',
    'socket hang up',
    'econnreset',
    'etimedout',
    'connection timeout',
    'terminating connection due to administrator command'
  ].some((token) => message.includes(token));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(input) {
  const base = String(input || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return base || 'col';
}

main()
  .catch((err) => {
    const message = err && err.message ? String(err.message) : String(err || 'Migration failed');
    console.error(message);

    if (/exceeds limit \d+\s*MB/i.test(message)) {
      process.exitCode = 42;
      return;
    }

    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
