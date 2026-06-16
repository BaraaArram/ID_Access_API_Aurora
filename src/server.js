const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

const PORT = Number(process.env.PORT || 5085);
const API_KEY = String(process.env.ACCESS_API_KEY || '').trim();
const DEFAULT_TABLE = String(process.env.DEFAULT_TABLE || 'Sgaza').trim();
const DB_PROVIDER = resolveProvider();
const PG_SCHEMA = String(process.env.PG_SCHEMA || 'public').trim();
const PG_TABLE = String(process.env.PG_TABLE || '').trim();
const PG_TABLE_EXTRA = String(process.env.PG_TABLE_EXTRA || '').trim();
const PG_SSL = toBool(process.env.PG_SSL, false);
const PG_SSL_EXTRA = toBool(process.env.PG_SSL_EXTRA, PG_SSL);
const STATS_PASSWORD = String(process.env.STATS_PASSWORD || '').trim();
const STATS_FILE_PATH = path.resolve(__dirname, '../stats.json');
const ALLOWED_TABLES = toSet(process.env.ALLOWED_TABLES, ['Sgaza', 'قائمة الموظفين', 'sgaza_extra']);
const ALLOWED_ID_COLUMNS = toSet(process.env.ALLOWED_ID_COLUMNS, ['الهوية', 'id', 'identity']);
const PG_COLUMN_CACHE = new Map();

let accessConnection = null;
let accessDbPath = '';
let pgPool = null;
let pgPoolExtra = null;

if (DB_PROVIDER === 'access') {
  ({ connection: accessConnection, dbPath: accessDbPath } = createAccessConnection());
}

if (DB_PROVIDER === 'postgres') {
  pgPool = createPgPool(process.env.DATABASE_URL, PG_SSL);
  const extraUrl = String(process.env.DATABASE_URL_EXTRA || '').trim();
  if (extraUrl) {
    pgPoolExtra = createPgPool(extraUrl, PG_SSL_EXTRA);
  }
}

app.use(cors());
app.use(express.json());
app.use(morgan('tiny'));

app.get('/health', async (_req, res) => {
  const payload = {
    success: true,
    service: 'access-api-node',
    provider: DB_PROVIDER,
    databases: {
      primary: {
        provider: DB_PROVIDER === 'postgres' ? 'postgres' : 'access',
        table: DB_PROVIDER === 'postgres' ? (PG_TABLE || DEFAULT_TABLE) : accessDbPath
      },
      extra: pgPoolExtra
        ? {
            provider: 'postgres',
            table: PG_TABLE_EXTRA || PG_TABLE || DEFAULT_TABLE
          }
        : null
    }
  };

  if (DB_PROVIDER === 'postgres') {
    try {
      await pgPool.query('SELECT 1');
      payload.databases.primaryStatus = 'ok';
    } catch (error) {
      payload.databases.primaryStatus = 'error';
      payload.databases.primaryError = String(error.message || error);
    }

    if (pgPoolExtra) {
      try {
        await pgPoolExtra.query('SELECT 1');
        payload.databases.extraStatus = 'ok';
      } catch (error) {
        payload.databases.extraStatus = 'error';
        payload.databases.extraError = String(error.message || error);
      }
    }
  }

  try {
    const walletStats = await loadWalletStats();
    payload.walletStats = {
      totalSubmissions: walletStats.totalSubmissions,
      walletsCreated: walletStats.walletsCreated,
      updatedAt: walletStats.updatedAt
    };
  } catch (error) {
    payload.walletStats = {
      totalSubmissions: 0,
      walletsCreated: 0,
      updatedAt: null,
      error: String(error.message || error)
    };
  }

  return res.json(payload);
});

const TOKEN_API_URL = process.env.TOKEN_API_URL || 'http://localhost:4000';

async function verifyTokenMiddleware(req, res, next) {
  const token = req.header('X-Access-Token') || req.header('X-Api-Key') || (req.header('Authorization') ? req.header('Authorization').replace(/^Bearer\s+/i, '') : '');
  const deviceId = req.header('X-Device-Id') || req.body?.deviceId || req.query?.deviceId;
  const username = req.header('X-Username') || req.body?.username || req.query?.username;

  if (API_KEY && token === API_KEY) {
    return next();
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access token is required' });
  }
  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'Device ID is required' });
  }

  try {
    const fetchResponse = await fetch(`${TOKEN_API_URL.replace(/\/$/, '')}/verify-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, deviceId, username })
    });

    const data = await fetchResponse.json().catch(() => ({}));
    if (!fetchResponse.ok || !data.success) {
      return res.status(fetchResponse.status === 200 ? 403 : fetchResponse.status).json({
        success: false,
        error: data.error || 'Token verification failed'
      });
    }

    req.tokenDetails = data;
    return next();
  } catch (error) {
    console.error('Failed to contact token-api for validation:', error);
    return res.status(502).json({ success: false, error: 'Token validation service unavailable' });
  }
}

app.get('/user', verifyTokenMiddleware, async (req, res) => {
  const idValue = resolveQueryValue(req, 'id', 'id64');
  const tableName = resolveQueryValue(req, 'table', 'table64') || DEFAULT_TABLE;
  const requestedIdColumn = resolveQueryValue(req, 'idColumn', 'idColumn64') || 'الهوية';

  if (!idValue) {
    return res.status(400).json({ success: false, error: 'Missing id query parameter' });
  }

  if (!tableName) {
    return res.status(400).json({ success: false, error: 'Table name is required' });
  }

  if (!ALLOWED_TABLES.has(tableName.toLowerCase())) {
    return res.status(400).json({ success: false, error: `Table '${tableName}' is not permitted` });
  }

  if (!ALLOWED_ID_COLUMNS.has(requestedIdColumn.toLowerCase())) {
    return res.status(400).json({ success: false, error: `Id column '${requestedIdColumn}' is not permitted` });
  }

  const idColumn = DB_PROVIDER === 'postgres'
    ? await resolvePostgresIdColumn({
      pool: pgPool,
      poolLabel: 'primary',
      tableName: PG_TABLE || tableName,
      requestedIdColumn
    })
    : requestedIdColumn;

  const escapedTable = escapeAccessIdentifier(tableName);
  const escapedIdColumn = escapeAccessIdentifier(idColumn);
  const escapedIdValue = String(idValue).replace(/'/g, "''");

  try {
    if (DB_PROVIDER === 'postgres') {
      const mergedResult = await queryUserMergedPostgres({
        tableName,
        requestedIdColumn,
        idValue
      });

      // Log per-request debug so platform logs show DB diagnostics (rowFound / error)
      try {
        console.log('user-debug', JSON.stringify(mergedResult ? mergedResult.debug : null));
      } catch (e) {
        console.log('user-debug', String(e && e.message ? e.message : e));
      }

      if (!mergedResult || !mergedResult.mergedUser) {
        return res.status(404).json({
          success: false,
          error: 'User not found',
          debug: mergedResult ? mergedResult.debug : null
        });
      }

      return res.json({
        success: true,
        user: mergedResult.mergedUser,
        resolvedIdColumn: idColumn,
        sources: mergedResult.sources,
        debug: mergedResult.debug
      });
    }

    const accessResult = await queryAccessSafe({ escapedTable, escapedIdColumn, escapedIdValue, tableName, idColumn });

    // Log per-request debug for Access provider too
    try {
      console.log('user-debug', JSON.stringify({ primary: accessResult, extra: null }));
    } catch (e) {
      console.log('user-debug', String(e && e.message ? e.message : e));
    }

    if (!accessResult.rowFound) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
        debug: {
          primary: accessResult,
          extra: null
        }
      });
    }

    return res.json({
      success: true,
      user: accessResult.row,
      resolvedIdColumn: idColumn,
      debug: {
        primary: accessResult,
        extra: null
      }
    });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);

    if (/Could not find input table or query/i.test(message) || /relation .* does not exist/i.test(message)) {
      return res.status(404).json({ success: false, error: `Table '${tableName}' was not found` });
    }

    if (
      /Too few parameters\. Expected/i.test(message) ||
      /No value given for one or more required parameters/i.test(message) ||
      /column .* does not exist/i.test(message)
    ) {
      return res.status(400).json({ success: false, error: `Could not resolve id column '${idColumn}'` });
    }

    return res.status(500).json({ success: false, error: message });
  }
});

app.post('/wallet-submission', verifyTokenMiddleware, async (req, res) => {
  const userId = String(req.body.userId || '').trim();
  if (!userId) {
    return res.status(400).json({ success: false, error: 'Missing userId' });
  }

  try {
    const stats = await loadWalletStats();
    stats.totalSubmissions += 1;
    stats.walletsCreated += 1;
    if (userId) {
      if (!stats.uniqueUserIds[userId]) {
        stats.uniqueUserIds[userId] = 0;
      }
      stats.uniqueUserIds[userId] += 1;
    }
    await saveWalletStats(stats);

    return res.json({
      success: true,
      stats: {
        totalSubmissions: stats.totalSubmissions,
        walletsCreated: stats.walletsCreated
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: String(error.message || error) });
  }
});

app.get('/stats', async (req, res) => {
  const authResult = validateStatsPassword(req);
  if (!authResult.success) {
    return res.status(authResult.status).json({ success: false, error: authResult.error });
  }

  try {
    const stats = await loadWalletStats();
    return res.json(createProtectedStatsResponse(stats));
  } catch (error) {
    return res.status(500).json({ success: false, error: String(error.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`Access API (Node) running on http://localhost:${PORT}`);
  console.log(`Provider: ${DB_PROVIDER}`);
  if (DB_PROVIDER === 'access') {
    console.log(`Database: ${accessDbPath}`);
  }
  if (DB_PROVIDER === 'postgres') {
    console.log(`Postgres schema: ${PG_SCHEMA}`);
    console.log(`Postgres table (primary): ${PG_TABLE || DEFAULT_TABLE}`);
    if (pgPoolExtra) {
      console.log(`Postgres table (extra): ${PG_TABLE_EXTRA || PG_TABLE || DEFAULT_TABLE}`);
    }
  }
});

async function loadWalletStats() {
  try {
    const content = await fs.promises.readFile(STATS_FILE_PATH, 'utf8');
    const stats = JSON.parse(content);
    return {
      totalSubmissions: Number(stats.totalSubmissions || 0),
      walletsCreated: Number(stats.walletsCreated || stats.uniqueWalletsCreated || 0),
      uniqueUserIds: stats.uniqueUserIds || {},
      updatedAt: stats.updatedAt || null
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        totalSubmissions: 0,
        walletsCreated: 0,
        uniqueUserIds: {},
        updatedAt: null
      };
    }
    throw error;
  }
}

async function saveWalletStats(stats) {
  const payload = {
    totalSubmissions: Number(stats.totalSubmissions || 0),
    walletsCreated: Number(stats.walletsCreated || stats.uniqueWalletsCreated || 0),
    uniqueWalletsCreated: Number(stats.walletsCreated || stats.uniqueWalletsCreated || 0),
    uniqueUserIds: stats.uniqueUserIds || {},
    updatedAt: new Date().toISOString()
  };
  await fs.promises.writeFile(STATS_FILE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function createProtectedStatsResponse(stats) {
  return {
    success: true,
    stats: {
      totalSubmissions: Number(stats.totalSubmissions || 0),
      walletsCreated: Number(stats.walletsCreated || stats.uniqueWalletsCreated || 0),
      updatedAt: stats.updatedAt || null
    }
  };
}

function validateStatsPassword(req) {
  if (!STATS_PASSWORD) {
    return { success: false, status: 503, error: 'Stats password is not configured' };
  }
  const provided = String(req.header('X-Stats-Password') || '').trim();
  if (!provided || provided !== STATS_PASSWORD) {
    return { success: false, status: 401, error: 'Unauthorized' };
  }
  return { success: true };
}

function resolveQueryValue(req, plainKey, base64Key) {
  const b64 = String(req.query[base64Key] || '').trim();
  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8').trim();
      if (decoded) {
        return decoded;
      }
    } catch (_err) {
      // Ignore invalid base64 and continue with plain query.
    }
  }

  const plain = String(req.query[plainKey] || '').trim();
  return plain || '';
}

function escapeAccessIdentifier(name) {
  return String(name || '').replace(/]/g, ']]');
}

function quotePgIdentifier(name) {
  return `"${String(name || '').replace(/"/g, '""')}"`;
}

function toSet(csvOrUndefined, fallbackArray) {
  const source = String(csvOrUndefined || '').trim();
  const values = source
    ? source.split(',').map((x) => x.trim()).filter(Boolean)
    : fallbackArray;

  return new Set(values.map((v) => String(v).toLowerCase()));
}

function toBool(value, fallback) {
  const source = String(value || '').trim().toLowerCase();
  if (!source) {
    return fallback;
  }

  return source === '1' || source === 'true' || source === 'yes' || source === 'on';
}

function resolveProvider() {
  const requested = String(process.env.DB_PROVIDER || 'access').trim().toLowerCase();

  if (requested === 'auto') {
    return process.env.DATABASE_URL ? 'postgres' : 'access';
  }

  if (requested === 'postgres' || requested === 'access') {
    return requested;
  }

  return 'access';
}

function createPgPool(connectionString, sslEnabled) {
  const url = String(connectionString || '').trim();
  if (!url) {
    throw new Error('PostgreSQL connection string is required');
  }

  return new Pool({
    connectionString: url,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false
  });
}

function createAccessConnection() {
  let ADODB;
  try {
    ADODB = require('node-adodb');
  } catch (_err) {
    throw new Error('node-adodb is unavailable. Use DB_PROVIDER=postgres on Linux or install Access components on Windows.');
  }

  const dbPath = resolveDbPath();
  return {
    dbPath,
    connection: ADODB.open(`Provider=Microsoft.ACE.OLEDB.12.0;Data Source=${dbPath};Persist Security Info=False;`)
  };
}

async function queryAccess({ escapedTable, escapedIdColumn, escapedIdValue }) {
  const query = `SELECT TOP 1 * FROM [${escapedTable}] WHERE [${escapedIdColumn}] = '${escapedIdValue}'`;
  return accessConnection.query(query);
}

async function queryAccessSafe({ escapedTable, escapedIdColumn, escapedIdValue, tableName, idColumn }) {
  const result = {
    tableName: tableName || String(escapedTable || '').replace(/\[|\]/g, ''),
    idColumn: idColumn || String(escapedIdColumn || '').replace(/\[|\]/g, ''),
    row: null,
    rowFound: false,
    error: null
  };

  try {
    const rows = await queryAccess({ escapedTable, escapedIdColumn, escapedIdValue });
    result.row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    result.rowFound = Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
  }

  return result;
}

async function queryPostgres({ pool, tableName, idColumn, idValue }) {
  const schemaSql = quotePgIdentifier(PG_SCHEMA);
  const tableSql = quotePgIdentifier(tableName);
  const idSql = quotePgIdentifier(idColumn);
  const sql = `SELECT * FROM ${schemaSql}.${tableSql} WHERE ${idSql} = $1 LIMIT 1`;
  const result = await pool.query(sql, [String(idValue)]);
  return result.rows;
}

async function queryPostgresSafe({ pool, poolLabel, tableName, idColumn, idValue }) {
  const result = {
    tableName,
    idColumn,
    row: null,
    rowFound: false,
    error: null
  };

  try {
    const rows = await queryPostgres({ pool, tableName, idColumn, idValue });
    result.row = rows[0] || null;
    result.rowFound = rows.length > 0;
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
  }

  return result;
}

async function resolvePostgresExtraTableName(tableName) {
  if (!pgPoolExtra) {
    return tableName;
  }

  const candidateNames = [
    PG_TABLE_EXTRA,
    tableName,
    `${tableName}_extra`,
    `${tableName}Extra`,
    `${tableName.toLowerCase()}_extra`,
    `${tableName.toLowerCase()}extra`,
    'sgaza_extra'
  ].filter((value) => Boolean(value)).map((value) => String(value).trim());

  const seen = new Set();
  const normalizedCandidates = [];
  for (const candidate of candidateNames) {
    const normalized = candidate.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      normalizedCandidates.push(candidate);
    }
  }

  const tableNameFound = await findPostgresTableName(pgPoolExtra, PG_SCHEMA, normalizedCandidates);
  return tableNameFound || tableName;
}

async function findPostgresTableName(pool, schemaName, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const lowerCandidates = candidates.map((name) => String(name || '').toLowerCase()).filter(Boolean);
  if (lowerCandidates.length === 0) {
    return null;
  }

  const sql = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1
      AND lower(table_name) = ANY($2)
    ORDER BY table_name
    LIMIT 1
  `;

  const result = await pool.query(sql, [schemaName, lowerCandidates]);
  return result.rows[0] ? String(result.rows[0].table_name || '') : null;
}

async function queryUserMergedPostgres({ tableName, requestedIdColumn, idValue }) {
  const primaryTable = PG_TABLE || tableName;
  const extraTable = await resolvePostgresExtraTableName(tableName);

  const [primaryIdColumn, extraIdColumn] = await Promise.all([
    resolvePostgresIdColumn({
      pool: pgPool,
      poolLabel: 'primary',
      tableName: primaryTable,
      requestedIdColumn
    }),
    pgPoolExtra
      ? resolvePostgresIdColumn({
        pool: pgPoolExtra,
        poolLabel: 'extra',
        tableName: extraTable,
        requestedIdColumn
      })
      : Promise.resolve(requestedIdColumn)
  ]);

  const [primaryResult, extraResult] = await Promise.all([
    queryPostgresSafe({ pool: pgPool, poolLabel: 'primary', tableName: primaryTable, idColumn: primaryIdColumn, idValue }),
    pgPoolExtra
      ? queryPostgresSafe({ pool: pgPoolExtra, poolLabel: 'extra', tableName: extraTable, idColumn: extraIdColumn, idValue })
      : Promise.resolve({ tableName: extraTable, idColumn: extraIdColumn, row: null, rowFound: false, error: null })
  ]);

  const primaryRow = primaryResult.row || null;
  const extraRow = extraResult.row || null;

  if (!primaryRow && !extraRow) {
    return {
      mergedUser: null,
      sources: { primary: false, extra: false },
      debug: {
        primary: primaryResult,
        extra: extraResult
      }
    };
  }

  const merged = {
    ...(primaryRow || {}),
    ...(extraRow || {})
  };

  delete merged.__sources;
  merged.__sources = {
    primary: Boolean(primaryRow),
    extra: Boolean(extraRow)
  };

  return {
    mergedUser: merged,
    sources: merged.__sources,
    debug: {
      primary: primaryResult,
      extra: extraResult
    }
  };
}

async function resolvePostgresIdColumn({ pool, poolLabel = 'primary', tableName, requestedIdColumn }) {
  const columns = await getPostgresTableColumns(pool, poolLabel, PG_SCHEMA, tableName);

  if (columns.length === 0) {
    return requestedIdColumn;
  }

  const byExact = new Set(columns);
  if (byExact.has(requestedIdColumn)) {
    return requestedIdColumn;
  }

  const requestedNormalized = normalizeColumnName(requestedIdColumn);
  const aliasCandidates = [
    requestedIdColumn,
    'الهوية',
    'الهوية رقم',
    'رقم الهوية',
    'id',
    'identity'
  ];

  for (const candidate of aliasCandidates) {
    const candidateNormalized = normalizeColumnName(candidate);
    const hit = columns.find((col) => normalizeColumnName(col) === candidateNormalized);
    if (hit) {
      return hit;
    }
  }

  const requestedFamilyHit = columns.find((col) => {
    const normalized = normalizeColumnName(col);
    return normalized === requestedNormalized || /(?:id|identity|هوية)/i.test(normalized);
  });

  return requestedFamilyHit || requestedIdColumn;
}

async function getPostgresTableColumns(pool, poolLabel, schemaName, tableName) {
  const cacheKey = `${poolLabel}::${schemaName}.${tableName}`;
  const cached = PG_COLUMN_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.at) < 300000) {
    return cached.columns;
  }

  const sql = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name = $2
    ORDER BY ordinal_position
  `;

  const result = await pool.query(sql, [schemaName, tableName]);
  const columns = result.rows.map((row) => String(row.column_name || '')).filter(Boolean);
  PG_COLUMN_CACHE.set(cacheKey, { columns, at: Date.now() });
  return columns;
}

function normalizeColumnName(value) {
  return String(value || '')
    .replace(/^[\uFEFF\u200B-\u200F\u202A-\u202E]+/, '')
    .replace(/[\s_\-]+/g, '')
    .toLowerCase()
    .trim();
}

function resolveDbPath() {
  const explicit = String(process.env.ACCESS_DB_PATH || '').trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const parentDir = path.resolve(__dirname, '..', '..');
  const files = fs.readdirSync(parentDir).filter((name) => name.toLowerCase().endsWith('.accdb'));
  if (files.length === 0) {
    throw new Error('No .accdb file found. Set ACCESS_DB_PATH in .env');
  }

  return path.join(parentDir, files[0]);
}
