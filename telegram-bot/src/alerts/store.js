const path = require('path');
const fs = require('fs');
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

function save() {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
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
      price_at_creation: alertData.priceAtCreation,
      is_active: 1,
      triggered_at: null,
      created_at: new Date().toISOString()
    };
    data.alerts.push(alert);
    save();
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
    save();
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
      save();
    }
  },

  countAll() {
    return data.alerts.length;
  },

  countActive() {
    return data.alerts.filter(a => a.is_active === 1).length;
  },

  close() {
    save();
  }
};
