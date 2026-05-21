const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { redditLimiter } = require('./rate-limiter');
const log = require('./logger');

let agent = null;
let agentWarned = false;

function getProxyAgent() {
  if (agent) return agent;
  const proxyUrl = process.env.SOCKS5_PROXY || '';
  if (!proxyUrl) {
    if (!agentWarned) {
      log.warn('SOCKS5_PROXY not set — Reddit requests will go direct (likely blocked from China)');
      agentWarned = true;
    }
    return null;
  }
  try {
    agent = new SocksProxyAgent(proxyUrl);
    log.info(`Proxy agent created: ${proxyUrl}`);
    return agent;
  } catch (e) {
    log.error('Failed to create proxy agent', e);
    return null;
  }
}

async function fetchRedditJSON(url) {
  await redditLimiter.acquire();

  return new Promise((resolve, reject) => {
    const proxyAgent = getProxyAgent();
    const parsedUrl = new URL(url);

    const opts = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': process.env.REDDIT_USER_AGENT || 'ForumScraper/1.0',
      },
      timeout: 30000,
    };

    if (proxyAgent) {
      opts.agent = proxyAgent;
    }

    const startTime = Date.now();
    log.info(`HTTP GET ${url}`);

    const req = https.get(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        const body = Buffer.concat(chunks).toString('utf-8');

        log.info(`HTTP ${res.statusCode} ${elapsed}ms ${(body.length / 1024).toFixed(1)}KB ${url}`);

        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers['retry-after'], 10) || 60;
          reject(Object.assign(new Error(`Rate limited (429), retry after ${retryAfter}s`), {
            code: 'RATE_LIMIT', retryAfter,
          }));
          return;
        }

        if (res.statusCode === 403 || res.statusCode === 401) {
          reject(Object.assign(new Error(`Blocked by Reddit (${res.statusCode}). Your proxy IP may be flagged. Try a different node.`), {
            code: 'BLOCKED', statusCode: res.statusCode,
          }));
          return;
        }

        if (res.statusCode !== 200) {
          reject(Object.assign(new Error(`Reddit returned HTTP ${res.statusCode}`), {
            code: 'HTTP_ERROR', statusCode: res.statusCode,
          }));
          return;
        }

        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          // Check for Cloudflare HTML response
          if (body.includes('cf-browser-verify') || body.includes('Just a moment')) {
            reject(Object.assign(new Error('Cloudflare block detected — your proxy IP is flagged. Try a different node.'), {
              code: 'CLOUDFLARE_BLOCK',
            }));
          } else {
            reject(Object.assign(new Error('Failed to parse Reddit JSON response'), {
              code: 'PARSE_ERROR', bodyPreview: body.substring(0, 300),
            }));
          }
        }
      });
    });

    req.on('error', (err) => {
      const elapsed = Date.now() - startTime;
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        const proxyUrl = process.env.SOCKS5_PROXY || 'direct';
        reject(Object.assign(new Error(
          `Cannot connect to proxy (${proxyUrl}). Is your VPN/Clash running? Error: ${err.message}`
        ), { code: 'PROXY_CONNECTION' }));
      } else if (err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
        reject(Object.assign(new Error(
          `Network error reaching Reddit: ${err.message}. If in China, check your SOCKS5_PROXY setting.`
        ), { code: 'NETWORK' }));
      } else {
        reject(Object.assign(new Error(`Network error: ${err.message}`), { code: 'NETWORK' }));
      }
      log.error(`HTTP GET failed ${elapsed}ms`, err);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(Object.assign(new Error('Request timed out after 30s'), { code: 'TIMEOUT' }));
    });
  });
}

function resetProxyAgent() {
  agent = null;
  agentWarned = false;
}

module.exports = { getProxyAgent, resetProxyAgent, fetchRedditJSON };
