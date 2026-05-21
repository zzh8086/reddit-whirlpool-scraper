// Shared rate limiter — ensures all Reddit HTTP requests share one global quota,
// regardless of how many tasks are running concurrently.

const log = require('./logger');

class RateLimiter {
  constructor(qpm) {
    this.minInterval = 60000 / (qpm || 10);
    this.lastTime = 0;
    this.waiting = 0;
  }

  setQPM(qpm) {
    this.minInterval = 60000 / qpm;
  }

  async acquire() {
    const now = Date.now();
    // Push lastTime forward immediately to reserve a slot —
    // prevents concurrent callers from getting the same window.
    const baseline = Math.max(now, this.lastTime);
    this.lastTime = baseline + this.minInterval;
    const wait = baseline - now;
    if (wait > 0) {
      this.waiting++;
      if (wait > 2000) {
        log.info(`Rate limiter: waiting ${(wait / 1000).toFixed(1)}s (${this.waiting} waiter(s))`);
      }
      await new Promise((r) => setTimeout(r, wait));
      this.waiting--;
    }
  }
}

const redditLimiter = new RateLimiter(10);

module.exports = { redditLimiter };
