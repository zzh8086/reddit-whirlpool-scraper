const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const CDP_PORT = 9222;
const CDP_HOST = `http://localhost:${CDP_PORT}`;

function findChromeWin() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  // Also check LOCALAPPDATA
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try registry as last resort
  try {
    const reg = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve 2>nul',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const m = reg.match(/([A-Z]:\\[^\r\n]+chrome\.exe)/i);
    if (m && fs.existsSync(m[1])) return m[1];
  } catch (_) {}
  return null;
}

function getChromeUserDataDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(localAppData, 'chrome-debug-profile');
}

function checkCDP() {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_HOST}/json/version`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ connected: true, wsUrl: json.webSocketDebuggerUrl, browser: json.Browser });
        } catch (_) {
          resolve({ connected: false });
        }
      });
    });
    req.setTimeout(3000, () => { req.destroy(); resolve({ connected: false }); });
    req.on('error', () => resolve({ connected: false }));
  });
}

let chromeProcess = null;
let chromeStatus = { connected: false };
let starting = false;

async function startChrome() {
  if (starting) return chromeStatus;
  starting = true;

  const chromePath = findChromeWin();
  if (!chromePath) {
    log.warn('Chrome executable not found. Please configure path in Web UI settings.');
    starting = false;
    chromeStatus = { connected: false, error: 'Chrome not found' };
    return chromeStatus;
  }

  const userDataDir = getChromeUserDataDir();
  log.info(`Starting Chrome: ${chromePath} --remote-debugging-port=${CDP_PORT}`);

  chromeProcess = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
  ], { detached: false, stdio: 'ignore' });

  chromeProcess.on('exit', () => {
    chromeProcess = null;
    chromeStatus = { connected: false };
  });

  // Wait for CDP to become ready
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    chromeStatus = await checkCDP();
    if (chromeStatus.connected) {
      log.info('Chrome CDP ready');
      break;
    }
  }

  if (!chromeStatus.connected) {
    log.warn('Chrome started but CDP not responding after 10s');
  }
  starting = false;
  return chromeStatus;
}

async function ensureChrome() {
  chromeStatus = await checkCDP();
  if (chromeStatus.connected) return chromeStatus;
  return startChrome();
}

function getChromeStatus() {
  return chromeStatus;
}

async function restartChrome() {
  if (chromeProcess) {
    chromeProcess.kill();
    chromeProcess = null;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return startChrome();
}

// Refresh CDP status (polled by UI)
async function refreshStatus() {
  chromeStatus = await checkCDP();
  return chromeStatus;
}

module.exports = { ensureChrome, getChromeStatus, restartChrome, refreshStatus, findChromeWin };
