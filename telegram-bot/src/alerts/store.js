const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const config = require('../config');

const dbPath = path.resolve(config.DB_PATH);
const dbDir = path.dirname(dbPath);

// Ensure data directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Load or initialize data
let data = { nextId: 1, alerts: [] };

if (fs.existsSync(dbPath)) {
  try {
    data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  } catch {
    console.warn('[Store] Corrupted data file, starting fresh');
  }
}

// Debounced async save to avoid blocking the event loop
let saveTimer = null;
let isSaving = false;

function scheduleSave() {
  if (saveTimer) return; // Already scheduled
  saveTimer = setTimeout(() => {
    saveTimer = null;
    _persistToDisk();
  }, 500); // 500ms debounce
}

async function _persistToDisk() {
  if (isSaving) {
    // A save is in progress — reschedule so the latest data is eventually written
    scheduleSave();
    return;
  }
  isSaving = true;
  try {
    _pruneOldAlerts();
    const tmpPath = dbPath + '.tmp';
    await fsPromises.writeFile(tmpPath, JSON.stringify(data));
    await fsPromises.rename(tmpPath, dbPath);
  } catch (err) {
    console.error('[Store] Failed to save:', err.message);
  } finally {
    isSaving = false;
  }
}

// Remove triggered/inactive alerts older than 7 days to prevent unbounded growth
function _pruneOldAlerts() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const before = data.alerts.length;
  data.alerts = data.alerts.filter(a =>
    a.is_active === 1 || !a.triggered_at || new Date(a.triggered_at).getTime() > cutoff
  );
  const pruned = before - data.alerts.length;
  if (pruned > 0) {
    console.log(`[Store] Pruned ${pruned} old triggered alerts`);
  }
}

module.exports = {
  create(alertData) {
    const alert = {
      id: data.nextId++,
      user_id: alertData.userId,
      chat_id: alertData.chatId,
      mint: alertData.mint,
      token_name: alertData.tokenName,
      token_symbol: alertData.tokenSymbol,
      condition: alertData.condition,
      target_value: alertData.targetValue,
      mcap_at_creation: alertData.mcapAtCreation,
      is_active: 1,
      triggered_at: null,
      created_at: new Date().toISOString()
    };
    data.alerts.push(alert);
    scheduleSave();
    return alert;
  },

  listByUser(userId) {
    return data.alerts
      .filter(a => a.user_id === userId && a.is_active === 1)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },

  remove(id, userId) {
    const alert = data.alerts.find(a => a.id === id && a.user_id === userId);
    if (!alert) return false;
    alert.is_active = 0;
    scheduleSave();
    return true;
  },

  getAllActive() {
    return data.alerts.filter(a => a.is_active === 1);
  },

  getDistinctMints() {
    const mints = new Set(data.alerts.filter(a => a.is_active === 1).map(a => a.mint));
    return [...mints];
  },

  trigger(id) {
    const alert = data.alerts.find(a => a.id === id);
    if (alert) {
      alert.is_active = 0;
      alert.triggered_at = new Date().toISOString();
      scheduleSave();
    }
  },

  countAll() {
    return data.alerts.length;
  },

  countActive() {
    return data.alerts.filter(a => a.is_active === 1).length;
  },

  close() {
    // Flush any pending save immediately on shutdown
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    // Synchronous final save for graceful shutdown
    try {
      fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[Store] Failed to save on close:', err.message);
    }
  }
};
