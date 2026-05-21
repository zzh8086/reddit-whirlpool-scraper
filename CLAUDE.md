# Forum Scraper — Whirlpool, Reddit & ProductReview

Node.js forum scraping tool with Web UI. Supports 4 source types: Whirlpool threads, Reddit posts, Reddit search results, ProductReview car listings.

## Quick Start

```
node server.js
# 浏览器打开 http://localhost:3000
```

一条命令启动。服务器会自动：
- 检测并启动 Chrome（CDP 模式，供 Whirlpool/ProductReview 使用）
- 加载配置（优先 `config.json`，回退 `.env`）

### 首次配置（一次性）

1. 打开 `http://localhost:3000`，点击右上角 ⚙ 齿轮按钮
2. 如果使用 Reddit（中国大陆），填入 SOCKS5 代理地址，如 `socks5h://127.0.0.1:7897`
3. 如需 Reddit OAuth 提速，填入 Client ID 和 Client Secret
4. 如果 Chrome 路径自动检测失败，手动填入
5. 保存

### Reddit 搜索（Web UI 一键操作）

点击 **Reddit 搜索** 标签页，输入关键词、可选版块、排序方式，点击"开始搜索"即可——不需要手写 URL。

### 各数据源首次 Cloudflare 验证

Chrome 自动启动后，对于 Whirlpool 和 ProductReview：
1. 在爬虫专用的 Chrome 窗口中访问目标网站（爬虫会自动打开标签页）
2. 完成 Cloudflare 人机验证（一次性，Chrome profile 会记住）
3. 之后同站点的爬取无需再次验证

### Reddit OAuth（可选，提升速率 10→100 QPM）

1. 访问 https://old.reddit.com/prefs/apps
2. 创建 **script** 类型应用，redirect uri 填 `http://localhost:8080`
3. 将 Client ID 和 Secret 填入 Web UI 设置面板
4. 保存后立即生效，状态栏显示 🟢 OAuth 已配置 (100 QPM)

## Supported URL Patterns

| Source | URL Pattern | Example |
|--------|------------|---------|
| `whirlpool` | `forums.whirlpool.net.au/thread/...` | `https://forums.whirlpool.net.au/thread/3rvj6xr7` |
| `reddit` | `reddit.com/r/{sub}/comments/{id}/...` | `https://old.reddit.com/r/CarsAustralia/comments/abc123/...` |
| `reddit-search` | `reddit.com/r/{sub}/search?q=...` or `reddit.com/search?q=...` (global) | `https://old.reddit.com/r/CarsAustralia/search?q=camry&restrict_sr=on` |
| `productreview` | `productreview.com.au/listings/{slug}` | `https://www.productreview.com.au/listings/toyota-camry` |

Reddit 搜索也支持 Web UI 表单提交（`POST /api/search-form`），无需拼接 URL。

## Project Layout

### 核心爬虫
- `scraper.js` — Whirlpool: CDP 连接, DOM 提取, 分页. 导出 `{ scrapeThread, closeBrowser, getBrowser, newPage }`
- `sources/reddit.js` — Reddit: 帖子爬虫 (`scrapeRedditThread`) + 搜索爬虫 (`scrapeRedditSearch`), OAuth 支持, 限流
- `sources/productreview.js` — ProductReview: CDP 导航 + `page.evaluate()` API 调用, SSR 数据提取, 字段定义解析, author lookup from `collection.authors`

### 基础设施
- `server.js` — Express 服务器: URL 自动识别, 数据源分发, 批量并发 (limit=3), SSE 进度, 任务取消, JSON/HTML 输出, 设置/状态 API
- `chrome-manager.js` — **NEW** Chrome 生命周期: 自动检测路径, 启动/重启 CDP Chrome, 状态检查
- `config.js` — **NEW** 运行时配置管理: `config.json` 读写, `.env` 回退兼容, 配置变更时通知 proxy 重置
- `rate-limiter.js` — **NEW** 全局共享限流器: 令牌桶算法, 所有 Reddit 并发任务共享同一配额, 动态 QPM (OAuth 切换)
- `proxy.js` — SOCKS5 代理工厂, `fetchRedditJSON()` 含错误分类 (Cloudflare block, rate limit, proxy error), 代理重置
- `logger.js` — 按日文件日志 → `logs/scraper-YYYY-MM-DD.log`

### 前端
- `public/index.html` — Web UI: 状态栏 (Chrome/代理/OAuth), 设置面板 (模态框), Tab 切换 (粘贴 URL / Reddit 搜索), 任务卡片 + 停止按钮 + 结果链接
- `public/style.css` — UI 样式

### 辅助
- `debug.js` — 独立 Whirlpool 页面结构分析器 (playwright-extra + stealth)
- `start-chrome.bat` — **[已弃用]** 手动启动 Chrome CDP。保留供调试, 正常使用无需运行
- `output/` — 爬取结果 (每任务 `.json` + `.html`)
- `config.json` — 运行时配置 (从 Web UI 设置面板生成, 用户特定, 建议 `.gitignore`)

## API Endpoints

| Method | Path | Body/Notes |
|--------|------|------------|
| GET | `/api/status` | `{ chrome, proxy, oauth, serverStartTime }` — 系统状态 |
| GET | `/api/config` | 返回所有配置 (敏感字段脱敏) |
| POST | `/api/config` | `{ key, value }` — 更新单项配置 |
| POST | `/api/chrome/start` | 手动启动/重启 Chrome CDP |
| POST | `/api/search-form` | `{ query, subreddit?, sort? }` → Reddit 搜索 (构建 URL, 调用 scrapeRedditSearch) |
| POST | `/api/scrape` | `{ url }` → `{ taskId }` |
| POST | `/api/scrape-batch` | `{ urls: [...] }` → `{ batchId, tasks }` |
| POST | `/api/cancel/:taskId` | 取消运行中的任务 (或批量子任务) |
| GET | `/api/progress/:taskId` | SSE 单任务进度 |
| GET | `/api/batch-progress/:batchId` | SSE 批量进度 |
| GET | `/api/logs` | 最近日志文件 + 今天最后 100 行 |

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

### Chrome 自动管理 (`chrome-manager.js`)
- 启动时检测 `localhost:9222` 是否有可用 CDP 连接
- 不可用时自动查找 Chrome 路径 (Windows: 常见安装位置 + 注册表)
- 以独立 profile (`%LOCALAPPDATA%\chrome-debug-profile`) 启动, 不影响日常 Chrome
- Web UI 状态栏实时显示连接状态, 可手动重启

### 配置系统 (`config.js`)
- 优先级: `config.json` → `.env` → 默认值
- Web UI 设置面板 + `POST /api/config` 修改即时持久化到 `config.json`
- 代理变更时自动调用 `resetProxyAgent()` 重建代理实例
- 从 `.env` 迁移: 首次启动时将 `.env` 值同步到内存, 通过 UI 保存后写入 `config.json`

### 全局速率限制 (`rate-limiter.js`)
- 令牌桶算法, 所有 Reddit 请求共享一个限流器实例
- 默认 10 QPM (无 OAuth), OAuth token 获取后自动切换 100 QPM
- OAuth token 过期 (401) 自动回退 10 QPM
- 并发安全: `acquire()` 调用时立即推进 `lastTime` 预留时间槽, 防止多任务抢占同一窗口
- 3 个 Reddit 任务并发时, 请求被严格序列化为每 6s/0.6s 一个, 不会触发 429

### Reddit 爬取
- **Thread API**: `old.reddit.com/r/{sub}/comments/{postId}.json`, 无认证 (10 QPM) 或 OAuth (100 QPM)
- **Search API**: `old.reddit.com/search.json?q=...` (全站) 或 `old.reddit.com/r/{sub}/search.json?q=...&restrict_sr=on` (版块), 通过 `after` 游标分页, 上限 5 页 (~500 结果)
- **OAuth 获取**: 在 https://old.reddit.com/prefs/apps 创建 script 应用 (redirect uri 填 `http://localhost:8080`)
- **每请求间隔**: `rateLimitDelay()` 降为 200ms(OAuth)/500ms(无认证), 主限流由全局 rate-limiter 负责

### Whirlpool CDP
- `chromium.connectOverCDP('http://localhost:9222')` — 使用独立 Chrome 实例 (bypasses Cloudflare)
- 选择器: `div.reply` (帖子), `.replyuser .bu_name` (用户名), `.replytext.bodytext` (内容), `ul.pagination li[data-page]` (分页)

### ProductReview CDP+API
- `page.evaluate()` → `fetch('/api/au/listings/{slug}/reviews?limit=100')` in page context (继承 Cloudflare cookies)
- Author names resolved from `collection.authors[]`, field labels from SSR `__ssr_data`, choice UUIDs resolved via field definition `properties.options`

### 其他
- **URL auto-detect**: `detectSource(url)` → `'whirlpool'` | `'reddit'` | `'reddit-search'` | `'productreview'` | `null`
- **Batch concurrency**: `runWithLimit()` caps at 3 simultaneous, sources can mix freely
- **SSE progress**: events include `{ batchId, taskId, url, source, status, page, totalPages, result? }`. Statuses: `starting`, `parsing`, `scraping`, `warning`, `done`/`complete`, `error`, `cancelled`
- **Task cancel**: Sets `aborted` flag on task/batch; `onProgress` callback throws `TASK_CANCELLED`; scrapers catch it and return partial results; server saves output files normally

## Configuration (`config.json` / Web UI Settings)

| Key | Default | Description |
|-----|---------|-------------|
| `SOCKS5_PROXY` | (empty) | SOCKS5 proxy for Reddit, e.g. `socks5h://127.0.0.1:7897` |
| `REDDIT_CLIENT_ID` | (empty) | Reddit OAuth client ID (optional, enables 100 QPM) |
| `REDDIT_CLIENT_SECRET` | (empty) | Reddit OAuth client secret |
| `REDDIT_USER_AGENT` | `ForumScraper/1.0` | User-Agent header for Reddit requests |
| `CHROME_PATH` | (auto-detect) | Chrome executable path, manual override |

`.env` 文件仍然支持作为备选配置源。两者同时存在时 `config.json` 优先。

## Known Issues & Caveats

### Chrome/CDP
- **首次 Cloudflare 验证仍需人工**: CDP Chrome 使用独立 profile, 首次访问 Whirlpool/ProductReview 需在 Chrome 窗口手动完成一次 CF 点击验证。之后 Chrome profile 记住验证状态, 同站点不需要重复
- **CDP Chrome 与日常 Chrome 独立**: 两个 Chrome 实例互不干扰。CDP Chrome 没有日常书签/密码/插件
- **Chrome 路径自动检测可能失败**: Windows 非标准安装路径可能检测不到, 需在设置面板手动填入
- **关闭 CDP Chrome 窗口会导致爬虫失败**: Whirlpool/ProductReview 依赖此 Chrome, 关闭后需通过状态栏按钮重启
- **Chrome 内存开销**: CDP Chrome 会消耗额外内存, 长时间运行可能影响系统性能

### Reddit / 代理
- **代理客户端 (Clash/VPN) 仍需用户自行启动**: Web UI 只配置代理地址, 不启动代理本身
- **并发 Reddit 任务共享 QPM**: 全局限流器确保不超配额, 但 3 任务均分 10 QPM = 每条任务约 ~3.3 请求/分钟, 单独跑比批量快
- **未配置代理时 Reddit 不可用**: 中国大陆直连 Reddit 会被封锁。确保 Clash/VPN 已运行且 `SOCKS5_PROXY` 配置正确
- **Reddit 搜索 API 质量有限**: Reddit 内置搜索不如 Google 精准, 只能搜到 Reddit 索引的内容
- **Reddit OAuth app 创建可能受限**: Reddit 新政策要求阅读 Responsible Builder Policy 后才能创建。如遇阻碍, 改用旧版页面 `old.reddit.com/prefs/apps`

### ProductReview
- **CF 403 on page 5+**: Cloudflare 限制 API 调用频率。约能抓到 ~400/416 条评价。这是已知限制, 非 UX 问题
- **依赖 Chrome 保持 productreview.com.au 标签页**: 需要有效的 Cloudflare session
- **0 reviews 输出**: 检查 API 返回结构 (`collection.items` key), 查看诊断日志

### 通用
- **仅限 localhost 单用户**: 无登录/权限控制, 不要暴露到公网
- **端口 3000 占用**: `powershell -Command "Get-NetTCPConnection -LocalPort 3000 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`
- **批量 Reddit+CDP 混合**: 可以同时跑, 但建议每批 Reddit≤2 条, 其余放 Whirlpool/ProductReview

## If Selectors Break

- **Whirlpool**: Run `node debug.js` to re-analyze DOM structure
- **ProductReview**: Check `__ssr_data` script presence and `collection.items`/`collection.authors` structure in API response diagnostic logs
- **Reddit**: Reddit JSON API is stable; changes are rare. Check for Cloudflare blocks in proxy logs.

## Troubleshooting Flow

```
启动失败?
├─ EADDRINUSE → kill port 3000
├─ Chrome 未连接 → 状态栏点"启动 Chrome"或检查路径设置
└─ Reddit 请求失败
   ├─ proxy connection → Clash/VPN 是否运行? SOCKS5_PROXY 端口是否正确?
   ├─ 429 rate limit → 正常限流, 全局限流器会排队等待
   ├─ 403/401 blocked → 代理 IP 被标记, 换代理节点
   └─ Cloudflare block → 代理节点 IP 在黑名单, 换节点

产品抓不到数据?
├─ Whirlpool 0 posts → 运行 node debug.js 检查选择器
├─ ProductReview 0 reviews → 检查 SSR/API 结构, 查看诊断日志
├─ ProductReview hang → Chrome 是否有 productreview.com.au 标签页?
└─ Reddit 0 results → 搜索关键词有没有结果? 检查 proxy 日志
```
