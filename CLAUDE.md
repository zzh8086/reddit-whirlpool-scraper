# Forum Scraper — Whirlpool, Reddit & ProductReview

Node.js forum scraping tool with Web UI. Supports 4 source types: Whirlpool threads, Reddit posts, Reddit search results, ProductReview car listings.

## Quick Start

### Whirlpool (CDP browser-based)
1. Run `start-chrome.bat`
2. In opened Chrome, visit `https://forums.whirlpool.net.au` (complete Cloudflare verification)
3. `node server.js`
4. Open `http://localhost:3000`

### Reddit Posts & Search (HTTP JSON API — requires proxy from China)
1. Start VPN/Clash (SOCKS5 proxy)
2. Copy `.env.example` to `.env`, set `SOCKS5_PROXY` to your proxy port
3. `node server.js`
4. Open `http://localhost:3000`
5. Paste a post URL or a search URL (e.g. `https://old.reddit.com/r/CarsAustralia/search?q=camry&restrict_sr=on`)

### ProductReview (CDP browser-based)
1. Run `start-chrome.bat`
2. In opened Chrome, visit `https://www.productreview.com.au/listings/toyota-camry` (complete Cloudflare verification)
3. `node server.js`
4. Open `http://localhost:3000`

## Supported URL Patterns

| Source | URL Pattern | Example |
|--------|------------|---------|
| `whirlpool` | `forums.whirlpool.net.au/thread/...` | `https://forums.whirlpool.net.au/thread/3rvj6xr7` |
| `reddit` | `reddit.com/r/{sub}/comments/{id}/...` | `https://old.reddit.com/r/CarsAustralia/comments/abc123/...` |
| `reddit-search` | `reddit.com/r/{sub}/search?q=...` or `reddit.com/search?q=...` (global) | `https://old.reddit.com/r/CarsAustralia/search?q=camry&restrict_sr=on` |
| `productreview` | `productreview.com.au/listings/{slug}` | `https://www.productreview.com.au/listings/toyota-camry` |

## Project Layout

- `scraper.js` — Whirlpool: CDP connection, DOM extraction, pagination. Exports `{ scrapeThread, closeBrowser, getBrowser, newPage }`
- `sources/reddit.js` — Reddit: thread scraper (`scrapeRedditThread`) + search scraper (`scrapeRedditSearch`), OAuth support, rate limiting
- `sources/productreview.js` — ProductReview: CDP navigation + `page.evaluate()` API calls, SSR data extraction, field definition resolution, author lookup from `collection.authors`
- `proxy.js` — SOCKS5 proxy agent factory, `fetchRedditJSON()` with error classification (Cloudflare block, rate limit, proxy error)
- `server.js` — Express server: URL auto-detection, source dispatch, batch concurrency (limit=3), SSE progress, task cancel, JSON/HTML output
- `logger.js` — daily file logger → `logs/scraper-YYYY-MM-DD.log`
- `debug.js` — standalone Whirlpool page-structure analyzer (playwright-extra + stealth)
- `start-chrome.bat` — launches Chrome with `--remote-debugging-port=9222 --user-data-dir`
- `public/index.html` — Web UI: textarea input, per-task progress cards with stop buttons, result links
- `public/style.css` — UI styling
- `output/` — scraped results (`.json` + `.html` per task)

## API Endpoints

| Method | Path | Body/Notes |
|--------|------|------------|
| POST | `/api/scrape` | `{ url }` → `{ taskId }` |
| POST | `/api/scrape-batch` | `{ urls: [...] }` → `{ batchId, tasks }` |
| POST | `/api/cancel/:taskId` | Cancel a running task (or batch sub-task) |
| GET | `/api/progress/:taskId` | SSE for single task |
| GET | `/api/batch-progress/:batchId` | SSE for batch |
| GET | `/api/logs` | Recent log files + today's last 100 lines |

## Output Format

All sources share a common post schema. Extra fields are source-specific (absent in other sources).

### Common fields (all sources)
```json
{
  "floor": 1,
  "userName": "...",
  "userId": "",
  "postCount": "",
  "date": "ISO-8601",
  "content": "...",
  "isOP": false,
  "shortLink": "...",
  "replyId": "..."
}
```

### Reddit extras
`score` (number)

### ProductReview extras
`rating`, `reviewTitle`, `verified`, `helpfulCount`, `subRatings?` (`{ buildQuality, valueForMoney, noiseLevel }`), `purchaseInfo?` (`{ condition, date, price, badge, year, transmission }`), `specificationValues` (all fields keyed by label)

### Reddit-search extras
`_threadUrl`, `_threadTitle` on each post; top-level `matchedThreads`, `successfulThreads`, `threadResults[]`

### Output file naming

| Source | Pattern | Example |
|--------|---------|---------|
| Whirlpool | `thread_{title}_{threadId}.json/html` | `thread_Best_Cars_2025_9j87f2.json` |
| Reddit | `reddit_{sub}_{title}_{postId}.json/html` | `reddit_CarsAustralia_Best_car_abc123.json` |
| Reddit-search | `reddit-search_{sub}_{title}_{taskId}.json/html` | `reddit-search_global_Search_camry_mpdxxx.json` |
| ProductReview | `productreview_{slug}_{title}_{listingId8}.json/html` | `productreview_toyota-camry_Toyota_Camry_d5f6769f.json` |

## Key Technical Details

- **URL auto-detect**: `detectSource(url)` → `'whirlpool'` | `'reddit'` | `'reddit-search'` | `'productreview'` | `null`
- **Whirlpool CDP**: `chromium.connectOverCDP('http://localhost:9222')` uses user's real Chrome session (bypasses Cloudflare)
- **Reddit thread API**: `old.reddit.com/r/{sub}/comments/{postId}.json`, unauthenticated (10 QPM) or OAuth (100 QPM)
- **Reddit search API**: `old.reddit.com/search.json?q=...` (global) or `old.reddit.com/r/{sub}/search.json?q=...&restrict_sr=on` (subreddit), pagination via `after` cursor, max 5 pages (~500 results)
- **ProductReview CDP+API**: `page.evaluate()` → `fetch('/api/au/listings/{slug}/reviews?limit=100')` in page context (inherits Cloudflare cookies). Author names resolved from `collection.authors[]`, field labels from SSR `__ssr_data`, choice UUIDs resolved via field definition `properties.options`
- **Proxy**: Set `SOCKS5_PROXY=socks5h://127.0.0.1:7897` in `.env` for Reddit access from China
- **Batch concurrency**: `runWithLimit()` caps at 3 simultaneous, sources can mix freely
- **SSE progress**: events include `{ batchId, taskId, url, source, status, page, totalPages, result? }`. Statuses: `starting`, `parsing`, `scraping`, `warning`, `done`/`complete`, `error`, `cancelled`
- **Task cancel**: Sets `aborted` flag on task/batch; `onProgress` callback throws `TASK_CANCELLED`; scrapers catch it and return partial results; server saves output files normally
- **Whirlpool selectors**: `div.reply` (post), `.replyuser .bu_name` (username), `.replytext.bodytext` (content), `ul.pagination li[data-page]` (pagination)

## Environment Variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `SOCKS5_PROXY` | (empty) | SOCKS5 proxy for Reddit, e.g. `socks5h://127.0.0.1:7897` |
| `REDDIT_CLIENT_ID` | (empty) | Reddit OAuth client ID (optional, enables 100 QPM) |
| `REDDIT_CLIENT_SECRET` | (empty) | Reddit OAuth client secret |
| `REDDIT_USER_AGENT` | `ForumScraper/1.0` | User-Agent header for Reddit requests |

## Common Issues

- **EADDRINUSE port 3000**: `powershell -Command "Get-NetTCPConnection -LocalPort 3000 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`
- **CDP connection failed**: Chrome not running with `--remote-debugging-port=9222`. Run `start-chrome.bat` first.
- **ProductReview 403 on page 5+**: Cloudflare rate-limiting API calls. Increase inter-page delay (currently 2-4s) or split into batches.
- **ProductReview scrape hangs**: Ensure Chrome has an open productreview.com.au tab with a valid Cloudflare session.
- **ProductReview 0 reviews**: The API response uses `collection.items` key. If structure changes, check diagnostic logs.
- **Reddit proxy fails**: Ensure Clash Verge is running and `SOCKS5_PROXY` matches the Mixed Port (usually 7897).
- **Zero posts extracted (Whirlpool)**: DOM selectors may have changed. Run `node debug.js` to re-analyze.
- **Stop button not working**: Browser may have cached old JS. Hard-refresh the page (Ctrl+Shift+R).

## If Selectors Break

- **Whirlpool**: Run `node debug.js` to re-analyze DOM structure
- **ProductReview**: Check `__ssr_data` script presence and `collection.items`/`collection.authors` structure in API response diagnostic logs
- **Reddit**: Reddit JSON API is stable; changes are rare. Check for Cloudflare blocks in proxy logs.
