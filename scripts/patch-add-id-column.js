/**
 * patch-add-id-column.js
 *
 * Adds the missing "الهوية" column to the Sgaza table and populates it
 * by matching rows on all other shared columns from the CSV.
 *
 * Usage:
 *   $env:DATABASE_URL = "postgres://..."
 *   $env:PG_SSL = "true"          # optional, default false
 *   $env:CSV_PATH = "..."          # optional, defaults to ../Sgaza.csv
 *   $env:PG_SCHEMA = "public"      # optional
 *   $env:PG_TABLE  = "Sgaza"       # optional
 *   node scripts/patch-add-id-column.js
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Pool } = require('pg');
require('dotenv').config();

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const PG_SCHEMA    = String(process.env.PG_SCHEMA || 'public').trim();
const PG_TABLE     = String(process.env.PG_TABLE  || 'Sgaza').trim();
const PG_SSL       = ['1','true','yes','on'].includes(String(process.env.PG_SSL || '').trim().toLowerCase());
const CSV_PATH     = path.resolve(process.env.CSV_PATH || path.join(__dirname, '..', 'Sgaza.csv'));

const ID_COLUMN     = 'الهوية';
// Columns used to find the matching row in Postgres.
// Must already exist in the table.
const MATCH_COLUMNS = ['الاسم', 'الاب', 'الجد', 'العائلة', 'اسم الام', 'تاريخ الميلاد', 'الجنس'];

const BATCH_SIZE = 500;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is required');
  process.exit(1);
}
if (!fs.existsSync(CSV_PATH)) {
  console.error(`ERROR: CSV not found: ${CSV_PATH}`);
  process.exit(1);
}

function q(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function normalizeCsvKey(key) {
  const noBom = String(key || '').replace(/^\uFEFF/, '').trim();
  return noBom.replace(/^"(.+)"$/, '$1').trim();
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PG_SSL ? { rejectUnauthorized: false } : false,
});

async function main() {
  const client = await pool.connect();

  try {
    // 1. Add the column if it doesn't exist yet
    const qualTable = `${q(PG_SCHEMA)}.${q(PG_TABLE)}`;
    console.log(`Adding column ${ID_COLUMN} to ${qualTable} (if missing)…`);
    await client.query(
      `ALTER TABLE ${qualTable} ADD COLUMN IF NOT EXISTS ${q(ID_COLUMN)} text`
    );
    console.log('Column added (or already present).');

    // 2. Check how many rows already have the ID filled
    const already = await client.query(
      `SELECT COUNT(*) AS n FROM ${qualTable} WHERE ${q(ID_COLUMN)} IS NOT NULL`
    );
    const alreadyFilled = Number(already.rows[0].n);
    if (alreadyFilled > 0) {
      console.log(`${alreadyFilled} rows already have ${ID_COLUMN} — only patching NULL rows.`);
    }

    // 3. Stream CSV, build batches of { id, matchValues }
    console.log(`Reading ${CSV_PATH}…`);

    let batch = [];
    let totalRead = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;

    await new Promise((resolve, reject) => {
      fs.createReadStream(CSV_PATH)
        .pipe(csv({ bom: true }))
        .on('data', (row) => {
          // Normalize keys to handle BOM + quoted header edge cases.
          const normalizedRow = {};
          for (const [k, v] of Object.entries(row)) {
            normalizedRow[normalizeCsvKey(k)] = v;
          }
          const idVal = normalizedRow[ID_COLUMN];
          if (!idVal) { totalSkipped++; return; }

          const matchVals = MATCH_COLUMNS.map((col) => (normalizedRow[col] !== undefined ? normalizedRow[col] : null));
          batch.push({ id: idVal, matchVals });
          totalRead++;
        })
        .on('end', resolve)
        .on('error', reject);
    });

    console.log(`Read ${totalRead} rows from CSV (${totalSkipped} skipped, no ID).`);

    // Build parameterised UPDATE for each row
    // UPDATE schema.table SET "الهوية" = $1 WHERE "الاسم" = $2 AND ... AND "الهوية" IS NULL
    const whereClause = MATCH_COLUMNS
      .map((col, i) => `${q(col)} = $${i + 2}`)
      .join(' AND ');
    const updateSql = `
      UPDATE ${qualTable}
      SET ${q(ID_COLUMN)} = $1
      WHERE ${whereClause}
        AND ${q(ID_COLUMN)} IS NULL
    `;

    console.log('Patching rows…');
    for (let i = 0; i < batch.length; i += BATCH_SIZE) {
      const slice = batch.slice(i, i + BATCH_SIZE);
      for (const { id, matchVals } of slice) {
        const result = await client.query(updateSql, [id, ...matchVals]);
        totalUpdated += result.rowCount;
      }
      const pct = Math.round(((i + slice.length) / batch.length) * 100);
      process.stdout.write(`\r  ${i + slice.length}/${batch.length} (${pct}%) — updated ${totalUpdated} rows`);
    }

    console.log(`\nDone. Updated ${totalUpdated} rows out of ${totalRead} CSV entries.`);

    // 4. Report any rows still NULL (unmatched)
    const nullCount = await client.query(
      `SELECT COUNT(*) AS n FROM ${qualTable} WHERE ${q(ID_COLUMN)} IS NULL`
    );
    const nullRows = Number(nullCount.rows[0].n);
    if (nullRows > 0) {
      console.warn(`WARNING: ${nullRows} rows in Postgres still have NULL ${ID_COLUMN} (no CSV match).`);
    } else {
      console.log(`All rows have ${ID_COLUMN} filled.`);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
