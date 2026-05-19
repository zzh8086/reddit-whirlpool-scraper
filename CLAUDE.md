# Whirlpool Forum Scraper

Node.js tool to scrape Whirlpool forum threads via CDP-connected Chrome (bypasses Cloudflare). Web UI at `http://localhost:3000`.

## Quick Start

1. Run `start-chrome.bat`
2. In opened Chrome, visit `https://forums.whirlpool.net.au` (complete verification if needed)
3. `node server.js`
4. Open `http://localhost:3000`

## Project Layout

- `scraper.js` — core: CDP connection, DOM extraction, pagination. Exports `scrapeThread(url, onProgress)`
- `server.js` — Express server: single + batch endpoints, SSE, JSON/HTML output
- `logger.js` — daily file logger → `logs/`
- `debug.js` — standalone page-structure analyzer (playwright-extra + stealth)
- `start-chrome.bat` — launches Chrome with `--remote-debugging-port=9222`
- `public/` — Web UI (textarea input, per-task progress cards, result links)
- `output/` — scraped results (`.json` + `.html` per thread)

## Key Technical Details

- **CDP bypass**: `chromium.connectOverCDP('http://localhost:9222')` uses user's real Chrome session
- **Batch concurrency**: `runWithLimit()` caps at 3 simultaneous scrapes
- **Progress**: SSE per batch, events include `{ batchId, taskId, url, status, page, totalPages, result? }`
- **Whirlpool selectors**: `div.reply` (post), `.replyuser .bu_name` (username), `.replytext.bodytext` (content), `ul.pagination li[data-page]` (pagination)

## API

| Method | Path | Body/Notes |
|--------|------|------------|
| POST | `/api/scrape` | `{ url }` → `{ taskId }` |
| POST | `/api/scrape-batch` | `{ urls: [...] }` → `{ batchId, tasks }` |
| GET | `/api/progress/:taskId` | SSE for single |
| GET | `/api/batch-progress/:batchId` | SSE for batch |
| GET | `/api/logs` | Recent logs |

## If Selectors Break

Run `node debug.js` to re-analyze Whirlpool's current DOM structure. It opens a stealth browser, inspects the page, and prints recommended selectors.
