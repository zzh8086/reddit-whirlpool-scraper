const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
  SOCKS5_PROXY: '',
  REDDIT_CLIENT_ID: '',
  REDDIT_CLIENT_SECRET: '',
  REDDIT_USER_AGENT: 'ForumScraper/1.0',
  CHROME_PATH: '',
};

let config = { ...DEFAULTS };

// Load from config.json, fall back to .env
function load() {
  // First try config.json
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      Object.assign(config, data);
    } catch (e) {
      console.warn('config.json parse error, using defaults');
    }
  }

  // Fill gaps from .env (backward compat)
  for (const key of Object.keys(DEFAULTS)) {
    if (!config[key] && process.env[key]) {
      config[key] = process.env[key];
    }
  }

  // Mirror to process.env so existing code still works
  syncToEnv();
}

function syncToEnv() {
  for (const [key, val] of Object.entries(config)) {
    if (val) process.env[key] = val;
  }
}

function save() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  syncToEnv();

  // Notify proxy to reset if proxy URL changed
  try {
    const { resetProxyAgent } = require('./proxy');
    resetProxyAgent();
  } catch (_) {}
}

function get(key) {
  if (key) return config[key];
  return undefined;
}

function set(key, value) {
  config[key] = value;
  save();
}

function getAll() {
  return { ...config };
}

// Return safe version for UI (mask secrets)
function getAllSafe() {
  const safe = { ...config };
  if (safe.REDDIT_CLIENT_SECRET && safe.REDDIT_CLIENT_SECRET.length > 4) {
    safe.REDDIT_CLIENT_SECRET = safe.REDDIT_CLIENT_SECRET.substring(0, 4) + '****';
  }
  return safe;
}

// Initialize on require
load();

module.exports = { get, set, getAll, getAllSafe, save };
