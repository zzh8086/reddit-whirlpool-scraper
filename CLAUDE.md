# Forum Scraper — Whirlpool & Reddit

Node.js forum scraping tool. Web UI at `http://localhost:3000`.

## Quick Start

### Whirlpool (CDP browser-based)
1. Run `start-chrome.bat`
2. In opened Chrome, visit `https://forums.whirlpool.net.au` (complete Cloudflare verification if needed)
3. `node server.js`
4. Open `http://localhost:3000`

### Reddit (HTTP JSON API — for mainland China users)
1. Start your VPN/Clash (SOCKS5 proxy)
2. Copy `.env.example` to `.env`, set `SOCKS5_PROXY` to your proxy port
3. `node server.js`
4. Open `http://localhost:3000`

## Project Layout

- `scraper.js` — Whirlpool: CDP connection, DOM extraction, pagination. Exports `scrapeThread(url, onProgress)`
- `sources/reddit.js` — Reddit: old.reddit.com JSON API scraper. Exports `scrapeRedditThread(url, onProgress)`
- `proxy.js` — SOCKS5 proxy agent factory, `fetchRedditJSON()` with error classification
- `server.js` — Express server: URL auto-detection, source dispatch, batch concurrency, SSE, JSON/HTML output
- `logger.js` — daily file logger → `logs/`
- `debug.js` — standalone Whirlpool page-structure analyzer (playwright-extra + stealth)
- `start-chrome.bat` — launches Chrome with `--remote-debugging-port=9222`
- `public/` — Web UI (textarea input, per-task progress cards, result links)
- `output/` — scraped results (`.json` + `.html` per thread)

## Key Technical Details

- **URL auto-detect**: `detectSource(url)` checks URL pattern → `'whirlpool'` | `'reddit'` | `null`
- **Whirlpool CDP**: `chromium.connectOverCDP('http://localhost:9222')` uses user's real Chrome session
- **Reddit API**: `old.reddit.com/r/{sub}/comments/{postId}.json`, no auth needed (10 QPM), OAuth optional (100 QPM)
- **Proxy**: Set `SOCKS5_PROXY=socks5h://127.0.0.1:7897` in `.env` for Reddit access from China
- **Batch concurrency**: `runWithLimit()` caps at 3 simultaneous scrapes, sources can mix
- **Progress**: SSE per batch, events include `{ batchId, taskId, url, source, status, page, totalPages, result? }`
- **Whirlpool selectors**: `div.reply` (post), `.replyuser .bu_name` (username), `.replytext.bodytext` (content), `ul.pagination li[data-page]` (pagination)
- **Reddit output fields**: `{ floor, userName, date, content, isOP, replyId, score }` — aligned with Whirlpool format

## Environment Variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `SOCKS5_PROXY` | (empty) | SOCKS5 proxy for Reddit access, e.g. `socks5h://127.0.0.1:7897` |
| `REDDIT_CLIENT_ID` | (empty) | Reddit OAuth client ID (optional, enables 100 QPM) |
| `REDDIT_CLIENT_SECRET` | (empty) | Reddit OAuth client secret |
| `REDDIT_USER_AGENT` | `ForumScraper/1.0` | User-Agent header for Reddit requests |

## API

| Method | Path | Body/Notes |
|--------|------|------------|
| POST | `/api/scrape` | `{ url }` → `{ taskId }` |
| POST | `/api/scrape-batch` | `{ urls: [...] }` → `{ batchId, tasks }` |
| GET | `/api/progress/:taskId` | SSE for single |
| GET | `/api/batch-progress/:batchId` | SSE for batch |
| GET | `/api/logs` | Recent logs |

## If Whirlpool Selectors Break

Run `node debug.js` to re-analyze Whirlpool's current DOM structure.
