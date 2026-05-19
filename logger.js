const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function format(level, message, data) {
  let line = `[${timestamp()}] [${level}] ${message}`;
  if (data !== undefined) {
    if (typeof data === 'string') {
      line += ' ' + data;
    } else if (data instanceof Error) {
      line += '\n  ' + data.stack;
    } else {
      line += '\n  ' + JSON.stringify(data, null, 2);
    }
  }
  return line + '\n';
}

function write(level, message, data) {
  ensureDir();
  const line = format(level, message, data);
  // Write to daily log file
  const date = new Date().toISOString().substring(0, 10);
  const logFile = path.join(LOG_DIR, `scraper-${date}.log`);
  fs.appendFileSync(logFile, line, 'utf-8');
  // Also print to console
  if (level === 'ERROR') {
    console.error(line.trim());
  } else {
    console.log(line.trim());
  }
}

module.exports = {
  info(msg, data) { write('INFO', msg, data); },
  warn(msg, data) { write('WARN', msg, data); },
  error(msg, data) { write('ERROR', msg, data); },
  logPath() { ensureDir(); return LOG_DIR; },
};
