const { Pool } = require('pg');
const config = require('../config');

// ── Connection pool ──────────────────────────────────────────────────
let pool = null;

function getPool() {
  if (!pool) {
    if (!config.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for alert storage');
    }
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: config.DB_SSL_REJECT_UNAUTHORIZED === 'false'
        ? { rejectUnauthorized: false }
        : undefined
    });
    pool.on('error', (err) => {
      console.error('[Store] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

// ── Schema bootstrap ─────────────────────────────────────────────────
async function ensureTable() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS telegram_alerts (
      id            SERIAL PRIMARY KEY,
      user_id       BIGINT NOT NULL,
      chat_id       BIGINT NOT NULL,
      mint          TEXT NOT NULL,
      token_name    TEXT,
      token_symbol  TEXT,
      condition     TEXT NOT NULL CHECK (condition IN ('above', 'below', 'change')),
      target_value  DOUBLE PRECISION NOT NULL,
      mcap_at_creation DOUBLE PRECISION DEFAULT 0,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      triggered_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_alerts_user_active
      ON telegram_alerts (user_id) WHERE is_active = TRUE;
    CREATE INDEX IF NOT EXISTS idx_telegram_alerts_active
      ON telegram_alerts (is_active) WHERE is_active = TRUE;
  `);
}

// ── Group settings table ─────────────────────────────────────────────
async function ensureGroupSettingsTable() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS telegram_group_settings (
      chat_id       BIGINT PRIMARY KEY,
      ca_detect     BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ── CRUD operations ──────────────────────────────────────────────────

async function create(alertData) {
  const db = getPool();

  // Enforce per-user cap
  const countRes = await db.query(
    'SELECT COUNT(*) AS cnt FROM telegram_alerts WHERE user_id = $1 AND is_active = TRUE',
    [alertData.userId]
  );
  if (parseInt(countRes.rows[0].cnt) >= config.MAX_ALERTS_PER_USER) {
    throw new Error(`Maximum of ${config.MAX_ALERTS_PER_USER} active alerts reached`);
  }

  // Enforce global cap
  const globalRes = await db.query(
    'SELECT COUNT(*) AS cnt FROM telegram_alerts WHERE is_active = TRUE'
  );
  if (parseInt(globalRes.rows[0].cnt) >= 10000) {
    throw new Error('Maximum alert capacity reached. Please try again later.');
  }

  const res = await db.query(
    `INSERT INTO telegram_alerts (user_id, chat_id, mint, token_name, token_symbol, condition, target_value, mcap_at_creation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [alertData.userId, alertData.chatId, alertData.mint, alertData.tokenName,
     alertData.tokenSymbol, alertData.condition, alertData.targetValue, alertData.mcapAtCreation]
  );
  return res.rows[0];
}

function listByUser(userId) {
  const db = getPool();
  return db.query(
    'SELECT * FROM telegram_alerts WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at DESC',
    [userId]
  ).then(r => r.rows);
}

function remove(id, userId) {
  const db = getPool();
  return db.query(
    'UPDATE telegram_alerts SET is_active = FALSE WHERE id = $1 AND user_id = $2 AND is_active = TRUE RETURNING id',
    [id, userId]
  ).then(r => r.rowCount > 0);
}

function getAllActive() {
  const db = getPool();
  return db.query('SELECT * FROM telegram_alerts WHERE is_active = TRUE').then(r => r.rows);
}

function getDistinctMints() {
  const db = getPool();
  return db.query('SELECT DISTINCT mint FROM telegram_alerts WHERE is_active = TRUE').then(r => r.rows.map(row => row.mint));
}

function trigger(id) {
  const db = getPool();
  return db.query(
    'UPDATE telegram_alerts SET is_active = FALSE, triggered_at = NOW() WHERE id = $1',
    [id]
  );
}

function countAll() {
  const db = getPool();
  return db.query('SELECT COUNT(*) AS cnt FROM telegram_alerts').then(r => parseInt(r.rows[0].cnt));
}

function countActive() {
  const db = getPool();
  return db.query('SELECT COUNT(*) AS cnt FROM telegram_alerts WHERE is_active = TRUE').then(r => parseInt(r.rows[0].cnt));
}

// Prune triggered alerts older than 7 days
async function pruneOld() {
  const db = getPool();
  const res = await db.query(
    `DELETE FROM telegram_alerts WHERE is_active = FALSE AND triggered_at < NOW() - INTERVAL '7 days'`
  );
  if (res.rowCount > 0) {
    console.log(`[Store] Pruned ${res.rowCount} old triggered alerts`);
  }
}

// ── Group settings ───────────────────────────────────────────────────

async function getGroupSetting(chatId) {
  const db = getPool();
  const res = await db.query('SELECT ca_detect FROM telegram_group_settings WHERE chat_id = $1', [chatId]);
  return res.rows[0] || { ca_detect: false };
}

async function setGroupCaDetect(chatId, enabled) {
  const db = getPool();
  await db.query(
    `INSERT INTO telegram_group_settings (chat_id, ca_detect, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chat_id) DO UPDATE SET ca_detect = $2, updated_at = NOW()`,
    [chatId, enabled]
  );
}

// ── Daily brief subscriptions ────────────────────────────────────────

async function ensureBriefSubsTable() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS telegram_brief_subs (
      id            SERIAL PRIMARY KEY,
      user_id       BIGINT NOT NULL,
      chat_id       BIGINT NOT NULL,
      frequency_hrs INTEGER NOT NULL DEFAULT 24,
      filter_mcap   TEXT NOT NULL DEFAULT 'all',
      filter_vol    DOUBLE PRECISION NOT NULL DEFAULT 0,
      filter_ratio  DOUBLE PRECISION NOT NULL DEFAULT 1,
      hours_window  INTEGER NOT NULL DEFAULT 24,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      last_sent_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, chat_id)
    );
    CREATE INDEX IF NOT EXISTS idx_brief_subs_active
      ON telegram_brief_subs (is_active) WHERE is_active = TRUE;
  `);
}

async function upsertBriefSub(data) {
  const db = getPool();
  const res = await db.query(
    `INSERT INTO telegram_brief_subs (user_id, chat_id, frequency_hrs, filter_mcap, filter_vol, filter_ratio, hours_window)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, chat_id) DO UPDATE SET
       frequency_hrs = $3, filter_mcap = $4, filter_vol = $5, filter_ratio = $6,
       hours_window = $7, is_active = TRUE, last_sent_at = NULL
     RETURNING *`,
    [data.userId, data.chatId, data.frequencyHrs, data.filterMcap, data.filterVol, data.filterRatio, data.hoursWindow]
  );
  return res.rows[0];
}

async function getBriefSub(userId, chatId) {
  const db = getPool();
  const res = await db.query(
    'SELECT * FROM telegram_brief_subs WHERE user_id = $1 AND chat_id = $2 AND is_active = TRUE',
    [userId, chatId]
  );
  return res.rows[0] || null;
}

async function removeBriefSub(userId, chatId) {
  const db = getPool();
  const res = await db.query(
    'UPDATE telegram_brief_subs SET is_active = FALSE WHERE user_id = $1 AND chat_id = $2 AND is_active = TRUE RETURNING id',
    [userId, chatId]
  );
  return res.rowCount > 0;
}

async function getDueBriefSubs() {
  const db = getPool();
  const res = await db.query(
    `SELECT * FROM telegram_brief_subs
     WHERE is_active = TRUE
       AND (last_sent_at IS NULL OR last_sent_at < NOW() - (frequency_hrs || ' hours')::INTERVAL)`
  );
  return res.rows;
}

async function markBriefSent(id) {
  const db = getPool();
  await db.query('UPDATE telegram_brief_subs SET last_sent_at = NOW() WHERE id = $1', [id]);
}

// ── Lifecycle ────────────────────────────────────────────────────────

async function init() {
  await ensureTable();
  await ensureGroupSettingsTable();
  await ensureBriefSubsTable();
  console.log('[Store] PostgreSQL tables ready');
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  init,
  create,
  listByUser,
  remove,
  getAllActive,
  getDistinctMints,
  trigger,
  countAll,
  countActive,
  pruneOld,
  getGroupSetting,
  setGroupCaDetect,
  upsertBriefSub,
  getBriefSub,
  removeBriefSub,
  getDueBriefSubs,
  markBriefSent,
  close
};
