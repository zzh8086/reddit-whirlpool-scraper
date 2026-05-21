require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { scrapeThread } = require('./scraper');
const { scrapeRedditThread, scrapeRedditSearch } = require('./sources/reddit');
const { scrapeProductReviewListing } = require('./sources/productreview');
const { ensureChrome, getChromeStatus, restartChrome, refreshStatus } = require('./chrome-manager');
const config = require('./config');
const log = require('./logger');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output')));

// Store active tasks and their SSE clients
const tasks = new Map();

// SSE helper
function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// URL source detection
function detectSource(url) {
  // Reddit search (subreddit or global)
  if (/reddit\.com\/(r\/[^/]+\/)?search\b/i.test(url) || /reddit\.com\/r\/[^/]+\/\?q=/i.test(url) || /reddit\.com\/r\/[^/]+\?q=/i.test(url)) {
    const p = new URL(url).searchParams;
    if (p.get('q')) return 'reddit-search';
  }
  if (/reddit\.com\/r\/.+\/comments\//i.test(url)) return 'reddit';
  if (/forums\.whirlpool\.net\.au\/thread\//i.test(url)) return 'whirlpool';
  if (/productreview\.com\.au\/listings\//i.test(url)) return 'productreview';
  return null;
}

// Sanitize title for filename use
function slugify(title) {
  if (!title) return 'untitled';
  return title
    .replace(/[\s]+/g, '_')
    .replace(/[<>:"/\\|?*.,;:!()\[\]{}'`~@#$%^&+=]+/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 50)
    .trim() || 'untitled';
}

// API: System status
app.get('/api/status', async (_req, res) => {
  const chrome = await refreshStatus();
  const proxy = config.get('SOCKS5_PROXY') || '';
  const hasOAuth = !!(config.get('REDDIT_CLIENT_ID') && config.get('REDDIT_CLIENT_SECRET'));
  res.json({
    chrome: { connected: chrome.connected, browser: chrome.browser || '' },
    proxy: { configured: !!proxy, url: proxy.replace(/:\/\/.*@/, '://***@') || '' },
    oauth: { configured: hasOAuth },
    serverStartTime: new Date().toISOString(),
  });
});

// API: Get config (safe version for UI)
app.get('/api/config', (_req, res) => {
  res.json(config.getAllSafe());
});

// API: Update config
app.post('/api/config', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  config.set(key, value || '');
  log.info('Config updated', { key, value: value ? '(set)' : '(cleared)' });
  res.json({ ok: true, config: config.getAllSafe() });
});

// API: Start/restart Chrome
app.post('/api/chrome/start', async (_req, res) => {
  const status = await restartChrome();
  res.json({ ok: status.connected, chrome: status });
});

// API: Reddit search — build URL from form fields, dispatch as normal scrape
app.post('/api/search-form', async (req, res) => {
  const { query, subreddit, sort } = req.body;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: '请输入搜索关键词' });
  }
  const q = encodeURIComponent(query.trim());
  const s = sort || 'relevance';
  let searchUrl;
  if (subreddit && subreddit.trim()) {
    const sub = subreddit.trim();
    searchUrl = `https://old.reddit.com/r/${sub}/search?q=${q}&restrict_sr=on&sort=${s}&limit=100`;
  } else {
    searchUrl = `https://old.reddit.com/search?q=${q}&sort=${s}&limit=100`;
  }
  log.info('Search form → URL', { query, subreddit: subreddit || 'all', sort: s, url: searchUrl });

  // Run the same scrape flow as /api/scrape
  const taskId = Date.now().toString(36);
  const clients = new Set();
  tasks.set(taskId, { clients, status: 'started', aborted: false });

  res.json({ taskId, searchUrl });

  try {
    const result = await scrapeRedditSearch(searchUrl, (progress) => {
      const t = tasks.get(taskId);
      if (t && t.aborted) throw new Error('TASK_CANCELLED');
      progress.taskId = taskId;
      t.lastProgress = progress;
      for (const clientRes of clients) {
        sendSSE(clientRes, progress);
      }
    });

    const outDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const slug = slugify(result.title);
    const sub = result.subreddit === 'all' ? 'global' : result.subreddit;
    const name = `reddit-search_${sub}_${slug}_${taskId}`;
    const jsonPath = path.join(outDir, `${name}.json`);
    const htmlPath = path.join(outDir, `${name}.html`);

    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
    const htmlContent = generateHTML(result);
    fs.writeFileSync(htmlPath, htmlContent, 'utf-8');

    tasks.get(taskId).result = {
      ...result,
      jsonPath: `/output/${path.basename(jsonPath)}`,
      htmlPath: `/output/${path.basename(htmlPath)}`,
    };

    const finalStatus = result.cancelled ? 'cancelled' : 'complete';
    for (const clientRes of clients) {
      sendSSE(clientRes, {
        taskId, status: finalStatus,
        message: result.cancelled ? '任务已取消（已爬取部分已保存）' : '爬取完成！',
        result: tasks.get(taskId).result,
      });
      clientRes.end();
    }
  } catch (error) {
    if (error.message === 'TASK_CANCELLED') {
      for (const clientRes of clients) {
        sendSSE(clientRes, { taskId, status: 'cancelled', message: '任务已取消' });
        clientRes.end();
      }
    } else {
      log.error('Search task failed', error);
      for (const clientRes of clients) {
        sendSSE(clientRes, { taskId, status: 'error', message: error.message });
        clientRes.end();
      }
    }
  }
});

// API: Start scraping
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  const source = detectSource(url || '');

  if (!source) {
    log.warn('Invalid URL submitted', { url });
    return res.status(400).json({ error: '请输入有效的帖子链接（Whirlpool / Reddit / ProductReview / Reddit搜索）' });
  }

  log.info('Scrape request received', { url, source });

  const taskId = Date.now().toString(36);
  const clients = new Set();
  tasks.set(taskId, { clients, status: 'started', aborted: false });

  let scraper;
  if (source === 'reddit') scraper = scrapeRedditThread;
  else if (source === 'reddit-search') scraper = scrapeRedditSearch;
  else if (source === 'productreview') scraper = scrapeProductReviewListing;
  else scraper = scrapeThread;

  res.json({ taskId });

  try {
    const result = await scraper(url, (progress) => {
      const t = tasks.get(taskId);
      if (t && t.aborted) throw new Error('TASK_CANCELLED');
      progress.taskId = taskId;
      t.lastProgress = progress;
      for (const clientRes of clients) {
        sendSSE(clientRes, progress);
      }
    });

    const outDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let jsonPath, htmlPath;
    if (source === 'reddit') {
      const slug = slugify(result.title);
      const name = `reddit_${result.subreddit}_${slug}_${result.postId}`;
      jsonPath = path.join(outDir, `${name}.json`);
      htmlPath = path.join(outDir, `${name}.html`);
    } else if (source === 'reddit-search') {
      const slug = slugify(result.title);
      const sub = result.subreddit === 'all' ? 'global' : result.subreddit;
      const name = `reddit-search_${sub}_${slug}_${taskId}`;
      jsonPath = path.join(outDir, `${name}.json`);
      htmlPath = path.join(outDir, `${name}.html`);
    } else if (source === 'productreview') {
      const slug = slugify(result.title);
      const shortId = (result.listingId || taskId).substring(0, 8);
      const name = `productreview_${result.listingSlug}_${slug}_${shortId}`;
      jsonPath = path.join(outDir, `${name}.json`);
      htmlPath = path.join(outDir, `${name}.html`);
    } else {
      const threadId = url.match(/\/thread\/([^?\s]+)/)?.[1] || taskId;
      const slug = slugify(result.title);
      const name = `thread_${slug}_${threadId}`;
      jsonPath = path.join(outDir, `${name}.json`);
      htmlPath = path.join(outDir, `${name}.html`);
    }

    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
    log.info('JSON saved', { path: jsonPath, sizeKb: (fs.statSync(jsonPath).size / 1024).toFixed(1) });

    const htmlContent = generateHTML(result);
    fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
    log.info('HTML saved', { path: htmlPath, sizeKb: (fs.statSync(htmlPath).size / 1024).toFixed(1) });

    tasks.get(taskId).result = {
      ...result,
      jsonPath: `/output/${path.basename(jsonPath)}`,
      htmlPath: `/output/${path.basename(htmlPath)}`,
    };

    const finalStatus = result.cancelled ? 'cancelled' : 'complete';
    for (const clientRes of clients) {
      sendSSE(clientRes, {
        taskId,
        status: finalStatus,
        message: result.cancelled ? '任务已取消（已爬取部分已保存）' : '爬取完成！',
        result: tasks.get(taskId).result,
      });
      clientRes.end();
    }
  } catch (error) {
    if (error.message === 'TASK_CANCELLED') {
      log.info('Task cancelled, saving partial result', { taskId });
      // Save partial results if available
      const partialResult = tasks.get(taskId)?.lastProgress;
      for (const clientRes of clients) {
        sendSSE(clientRes, { taskId, status: 'cancelled', message: '任务已取消（已爬取部分已保存）' });
        clientRes.end();
      }
    } else {
      log.error('Scrape task failed', error);
      for (const clientRes of clients) {
        sendSSE(clientRes, { taskId, status: 'error', message: error.message });
        clientRes.end();
      }
    }
  }
});

// API: Cancel a task
app.post('/api/cancel/:taskId', (req, res) => {
  let { taskId } = req.params;
  // Decode URL-encoded taskId (batch IDs contain underscores)
  taskId = decodeURIComponent(taskId);

  // Check direct match first
  let task = tasks.get(taskId);
  if (task) {
    task.aborted = true;
    return res.json({ taskId, status: 'cancelling' });
  }

  // Check if it's a batch sub-task: batchId_index format
  const lastUnderscore = taskId.lastIndexOf('_');
  if (lastUnderscore > 0) {
    const batchId = taskId.substring(0, lastUnderscore);
    const idx = taskId.substring(lastUnderscore + 1);
    if (/^\d+$/.test(idx)) {
      const batch = tasks.get(batchId);
      if (batch) {
        batch.aborted = true;
        return res.json({ taskId, batchId, status: 'cancelling' });
      }
    }
  }

  res.status(404).json({ error: '任务未找到' });
});

// Helper: run async tasks with concurrency limit
async function runWithLimit(tasks, limit, worker) {
  const results = new Array(tasks.length);
  let running = 0;
  let nextIdx = 0;

  return new Promise((resolve) => {
    function startNext() {
      while (running < limit && nextIdx < tasks.length) {
        const idx = nextIdx++;
        running++;
        worker(tasks[idx], idx)
          .then((r) => { results[idx] = r; })
          .catch((e) => { results[idx] = { error: e.message }; })
          .finally(() => {
            running--;
            startNext();
            if (running === 0 && nextIdx >= tasks.length) resolve(results);
          });
      }
      if (running === 0 && nextIdx >= tasks.length) resolve(results);
    }
    startNext();
  });
}

// API: Batch scrape multiple threads
app.post('/api/scrape-batch', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: '请提供至少一个帖子链接' });
  }

  // Classify URLs
  const classified = urls.map((u, i) => ({ url: u, index: i, source: detectSource(u) }));
  const invalid = classified.filter((c) => !c.source);
  if (invalid.length > 0) {
    return res.status(400).json({
      error: `${invalid.length} 个链接格式无效（不支持该网站或格式不对）`,
      invalidUrls: invalid.map((c) => c.url),
    });
  }

  log.info('Batch scrape request received', { count: urls.length });

  const batchId = Date.now().toString(36);
  const batchClients = new Set();
  const batchTasks = classified.map((c) => ({
    taskId: batchId + '_' + c.index,
    url: c.url,
    source: c.source,
    status: 'pending',
  }));

  tasks.set(batchId, { clients: batchClients, tasks: batchTasks, aborted: false });

  res.json({ batchId, tasks: batchTasks.map((t) => ({ taskId: t.taskId, url: t.url, source: t.source })) });

  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  await runWithLimit(classified, 3, async (item) => {
    const { url, source, index } = item;
    const task = batchTasks.find((t) => t.taskId === batchId + '_' + index);
    if (!task) return;
    task.status = 'scraping';

    const broadcast = (data) => {
      const batch = tasks.get(batchId);
      if (batch && batch.aborted && data.status !== 'cancelled') throw new Error('TASK_CANCELLED');
      for (const client of batchClients) {
        sendSSE(client, { batchId, taskId: task.taskId, url, source, ...data });
      }
    };

    let scraper;
    if (source === 'reddit') scraper = scrapeRedditThread;
    else if (source === 'reddit-search') scraper = scrapeRedditSearch;
    else if (source === 'productreview') scraper = scrapeProductReviewListing;
    else scraper = scrapeThread;

    try {
      const result = await scraper(url, (progress) => {
        broadcast({
          status: progress.status,
          page: progress.page,
          totalPages: progress.totalPages,
          message: progress.message,
        });
      });

      let jsonPath, htmlPath;
      if (source === 'reddit') {
        const slug = slugify(result.title);
        const name = `reddit_${result.subreddit}_${slug}_${result.postId}`;
        jsonPath = path.join(outDir, `${name}.json`);
        htmlPath = path.join(outDir, `${name}.html`);
      } else if (source === 'reddit-search') {
        const slug = slugify(result.title);
        const sub = result.subreddit === 'all' ? 'global' : result.subreddit;
        const name = `reddit-search_${sub}_${slug}_${task.taskId}`;
        jsonPath = path.join(outDir, `${name}.json`);
        htmlPath = path.join(outDir, `${name}.html`);
      } else if (source === 'productreview') {
        const slug = slugify(result.title);
        const shortId = (result.listingId || task.taskId).substring(0, 8);
        const name = `productreview_${result.listingSlug}_${slug}_${shortId}`;
        jsonPath = path.join(outDir, `${name}.json`);
        htmlPath = path.join(outDir, `${name}.html`);
      } else {
        const threadId = url.match(/\/thread\/([^?\s]+)/)?.[1] || task.taskId;
        const slug = slugify(result.title);
        const name = `thread_${slug}_${threadId}`;
        jsonPath = path.join(outDir, `${name}.json`);
        htmlPath = path.join(outDir, `${name}.html`);
      }

      fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
      fs.writeFileSync(htmlPath, generateHTML(result), 'utf-8');

      task.status = result.cancelled ? 'cancelled' : 'done';
      broadcast({
        status: result.cancelled ? 'cancelled' : 'done',
        message: result.cancelled ? `${result.title}（已取消，已保存 ${result.totalPosts} 条）` : `完成：${result.title}（${result.totalPosts} 条内容）`,
        result: {
          ...result,
          jsonPath: `/output/${path.basename(jsonPath)}`,
          htmlPath: `/output/${path.basename(htmlPath)}`,
        },
      });
    } catch (err) {
      if (err.message === 'TASK_CANCELLED') {
        task.status = 'cancelled';
        broadcast({ status: 'cancelled', message: '任务已取消' });
      } else {
        log.error(`Batch task ${task.taskId} failed`, err);
        task.status = 'error';
        broadcast({ status: 'error', message: err.message });
      }
    }
  });

  for (const client of batchClients) {
    sendSSE(client, { batchId, status: 'batch_done', message: '全部任务完成' });
    client.end();
  }
  tasks.delete(batchId);
});

// SSE endpoint for batch progress
app.get('/api/batch-progress/:batchId', (req, res) => {
  const { batchId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const batch = tasks.get(batchId);
  if (!batch) {
    sendSSE(res, { batchId, status: 'error', message: '批次未找到' });
    res.end();
    return;
  }

  batch.clients.add(res);
  req.on('close', () => {
    batch.clients.delete(res);
  });
});

// SSE endpoint for progress updates (single task, kept for backward compat)
app.get('/api/progress/:taskId', (req, res) => {
  const { taskId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const task = tasks.get(taskId);
  if (!task) {
    sendSSE(res, { taskId, status: 'error', message: '任务未找到' });
    res.end();
    return;
  }

  task.clients.add(res);

  // Send last progress if available
  if (task.lastProgress) {
    sendSSE(res, task.lastProgress);
  }

  req.on('close', () => {
    task.clients.delete(res);
  });
});

// API: View recent logs
app.get('/api/logs', (_req, res) => {
  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) return res.json({ logs: [] });
  const files = fs.readdirSync(logDir)
    .filter(f => f.endsWith('.log'))
    .sort()
    .reverse()
    .slice(0, 7); // last 7 days
  const today = new Date().toISOString().substring(0, 10);
  const todayFile = `scraper-${today}.log`;
  const todayLog = fs.existsSync(path.join(logDir, todayFile))
    ? fs.readFileSync(path.join(logDir, todayFile), 'utf-8').split('\n').filter(Boolean).slice(-100)
    : [];
  res.json({ files, todayLog });
});

// Serve the main UI
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function generateHTML(data) {
  if (data.source === 'reddit') return generateRedditHTML(data);
  if (data.source === 'reddit-search') return generateRedditSearchHTML(data);
  if (data.source === 'productreview') return generateProductReviewHTML(data);
  return generateWhirlpoolHTML(data);
}

function generateRedditHTML(data) {
  const postsHTML = data.posts
    .map(
      (p) => `
    <div class="post ${p.isOP ? 'op' : ''}" id="post-${p.floor}">
      <div class="post-header">
        <span class="floor">#${p.floor}</span>
        <span class="user">${escapeHTML(p.userName)}</span>
        ${p.isOP ? '<span class="op-badge">楼主</span>' : ''}
        <span class="score">${p.score !== undefined ? `+${p.score}` : ''}</span>
        <span class="date">${escapeHTML(p.date)}</span>
        ${p.shortLink ? `<a class="anchor" href="${escapeHTML(p.shortLink)}" target="_blank">原文链接</a>` : ''}
      </div>
      <div class="post-body">${escapeHTML(p.content).replace(/\n/g, '<br>')}</div>
    </div>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(data.title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .meta { color: #666; font-size: 13px; margin-bottom: 20px; }
    .meta a { color: #ff4500; }
    .post { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 10px; border-left: 3px solid #ddd; }
    .post.op { border-left-color: #ff4500; }
    .post-header { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; font-size: 13px; color: #555; flex-wrap: wrap; }
    .floor { font-weight: 700; color: #999; }
    .user { font-weight: 600; color: #333; }
    .op-badge { background: #ff4500; color: #fff; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
    .score { color: #ff4500; font-weight: 600; }
    .date { color: #999; margin-left: auto; }
    .anchor { color: #ff4500; font-size: 12px; text-decoration: none; }
    .post-body { line-height: 1.7; color: #222; word-break: break-word; }
  </style>
</head>
<body>
  <h1>${escapeHTML(data.title)}</h1>
  <div class="meta">r/${escapeHTML(data.subreddit)} | 总内容: ${data.totalPosts} | 页数: ${data.totalPages} | <a href="${escapeHTML(data.threadUrl)}" target="_blank">原帖链接</a></div>
  ${postsHTML}
</body>
</html>`;
}

function generateProductReviewHTML(data) {
  const renderStars = (rating) => {
    const full = Math.round(rating);
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  };

  const postsHTML = data.posts
    .map(
      (p) => {
        const sr = p.subRatings;
        const pi = p.purchaseInfo;
        let extraHTML = '';
        // Sub-ratings badges
        if (sr) {
          const parts = [];
          if (sr.buildQuality !== undefined) parts.push(`<span class="sub-rating">品质: ${renderStars(sr.buildQuality)}</span>`);
          if (sr.valueForMoney !== undefined) parts.push(`<span class="sub-rating">性价比: ${renderStars(sr.valueForMoney)}</span>`);
          if (sr.noiseLevel !== undefined) parts.push(`<span class="sub-rating">噪音: ${renderStars(sr.noiseLevel)}</span>`);
          if (parts.length > 0) extraHTML += `<div class="sub-ratings">${parts.join(' ')}</div>`;
        }
        // Purchase info
        if (pi) {
          const info = [];
          if (pi.condition) info.push(pi.condition);
          if (pi.date) info.push('购买日期: ' + escapeHTML(pi.date));
          if (pi.badge) info.push('型号: ' + escapeHTML(pi.badge));
          if (pi.year) info.push('年份: ' + escapeHTML(String(pi.year).substring(0, 4)));
          if (pi.price > 0) info.push('A$' + pi.price.toLocaleString());
          if (pi.transmission) info.push(pi.transmission);
          if (info.length > 0) extraHTML += `<div class="purchase-info">${info.join(' | ')}</div>`;
        }
        return `
    <div class="post" id="post-${p.floor}">
      <div class="post-header">
        <span class="floor">#${p.floor}</span>
        <span class="user">${escapeHTML(p.userName)}</span>
        ${p.verified ? '<span class="verified-badge">已验证购买</span>' : ''}
        <span class="rating-stars" title="评分: ${p.rating}/5">${renderStars(p.rating)}</span>
        <span class="date">${escapeHTML(p.date)}</span>
        ${p.replyId ? `<a class="anchor" href="https://www.productreview.com.au/listings/${escapeHTML(data.listingSlug)}?reviewId=${escapeHTML(p.replyId)}" target="_blank">原文链接</a>` : ''}
      </div>
      ${p.reviewTitle ? `<div class="review-title">${escapeHTML(p.reviewTitle)}</div>` : ''}
      ${extraHTML}
      <div class="post-body">${escapeHTML(p.content).replace(/\n/g, '<br>')}</div>
      ${p.helpfulCount > 0 ? `<div class="helpful-count">${p.helpfulCount} 人觉得有帮助</div>` : ''}
    </div>`;
      }
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(data.title)} - ProductReview</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .meta { color: #666; font-size: 13px; margin-bottom: 20px; }
    .meta a { color: #80ba27; }
    .post { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 10px; border-left: 3px solid #80ba27; }
    .post-header { display: flex; gap: 12px; align-items: center; margin-bottom: 6px; font-size: 13px; color: #555; flex-wrap: wrap; }
    .floor { font-weight: 700; color: #999; }
    .user { font-weight: 600; color: #333; }
    .verified-badge { background: #80ba27; color: #fff; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
    .rating-stars { color: #f5a623; font-size: 14px; letter-spacing: 1px; }
    .date { color: #999; margin-left: auto; }
    .anchor { color: #80ba27; font-size: 12px; text-decoration: none; }
    .review-title { font-weight: 600; font-size: 15px; margin-bottom: 6px; color: #333; }
    .post-body { line-height: 1.7; color: #222; word-break: break-word; }
    .helpful-count { font-size: 12px; color: #999; margin-top: 8px; }
    .sub-ratings { display: flex; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
    .sub-rating { font-size: 12px; color: #f5a623; white-space: nowrap; }
    .purchase-info { font-size: 12px; color: #888; margin-bottom: 6px; }
  </style>
</head>
<body>
  <h1>${escapeHTML(data.title)}</h1>
  <div class="meta">ProductReview.com.au | 平均评分: ${renderStars(data.rating)} (${data.rating}) | 总评价: ${data.totalReviews} | 爬取: ${data.totalPosts} | <a href="${escapeHTML(data.threadUrl)}" target="_blank">原链接</a></div>
  ${postsHTML}
</body>
</html>`;
}

function generateRedditSearchHTML(data) {
  const postsHTML = data.posts
    .map(
      (p) => `
    <div class="post ${p.isOP ? 'op' : ''}" id="post-${p.floor}">
      <div class="post-header">
        <span class="floor">#${p.floor}</span>
        <span class="user">${escapeHTML(p.userName)}</span>
        ${p.isOP ? '<span class="op-badge">楼主</span>' : ''}
        <span class="score">${p.score !== undefined ? `+${p.score}` : ''}</span>
        <span class="date">${escapeHTML(p.date)}</span>
        <span class="thread-ref">[${escapeHTML(p._threadTitle || '').substring(0, 50)}]</span>
        ${p.shortLink ? `<a class="anchor" href="${escapeHTML(p.shortLink)}" target="_blank">原文链接</a>` : ''}
      </div>
      <div class="post-body">${escapeHTML(p.content).replace(/\n/g, '<br>')}</div>
    </div>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(data.title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .meta { color: #666; font-size: 13px; margin-bottom: 20px; }
    .meta a { color: #ff4500; }
    .post { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 10px; border-left: 3px solid #ddd; }
    .post.op { border-left-color: #ff4500; }
    .post-header { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; font-size: 13px; color: #555; flex-wrap: wrap; }
    .floor { font-weight: 700; color: #999; }
    .user { font-weight: 600; color: #333; }
    .op-badge { background: #ff4500; color: #fff; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
    .score { color: #ff4500; font-weight: 600; }
    .date { color: #999; }
    .thread-ref { color: #ff4500; font-size: 11px; font-style: italic; }
    .anchor { color: #ff4500; font-size: 12px; text-decoration: none; margin-left: auto; }
    .post-body { line-height: 1.7; color: #222; word-break: break-word; }
  </style>
</head>
<body>
  <h1>${escapeHTML(data.title)}</h1>
  <div class="meta">${data.subreddit === 'all' ? 'Reddit全站' : 'r/' + escapeHTML(data.subreddit)} | 匹配帖子: ${data.matchedThreads} | 成功: ${data.successfulThreads} | 总回复: ${data.totalPosts} | <a href="${escapeHTML(data.threadUrl)}" target="_blank">搜索链接</a></div>
  ${postsHTML}
</body>
</html>`;
}

function generateWhirlpoolHTML(data) {
  const postsHTML = data.posts
    .map(
      (p) => `
    <div class="post ${p.isOP ? 'op' : ''}" id="post-${p.floor}">
      <div class="post-header">
        <span class="floor">#${p.floor}</span>
        <span class="user">${escapeHTML(p.userName)}</span>
        ${p.userId ? `<span class="uid">${escapeHTML(p.userId)}</span>` : ''}
        ${p.isOP ? '<span class="op-badge">楼主</span>' : ''}
        ${p.postCount ? `<span class="postcount">${escapeHTML(p.postCount)}</span>` : ''}
        <span class="date">${escapeHTML(p.date)}</span>
        ${p.replyId ? `<a class="anchor" href="https://forums.whirlpool.net.au/thread/${escapeHTML(data.threadUrl.split('/thread/')[1] || '')}#r${escapeHTML(p.replyId)}" target="_blank">#r${escapeHTML(p.replyId)}</a>` : ''}
      </div>
      <div class="post-body">${escapeHTML(p.content).replace(/\n/g, '<br>')}</div>
    </div>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(data.title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .meta { color: #666; font-size: 13px; margin-bottom: 20px; }
    .post { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 10px; border-left: 3px solid #ddd; }
    .post.op { border-left-color: #4a90d9; }
    .post-header { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; font-size: 13px; color: #555; }
    .floor { font-weight: 700; color: #999; }
    .user { font-weight: 600; color: #333; }
    .op-badge { background: #4a90d9; color: #fff; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
    .date { color: #999; margin-left: auto; }
    .post-body { line-height: 1.7; color: #222; word-break: break-word; }
  </style>
</head>
<body>
  <h1>${escapeHTML(data.title)}</h1>
  <div class="meta">帖子链接: ${escapeHTML(data.threadUrl)} | 总回复: ${data.totalPosts} | 总页数: ${data.totalPages}</div>
  ${postsHTML}
</body>
</html>`;
}

function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop');
  console.log('');
  try {
    const status = await ensureChrome();
    if (status.connected) {
      console.log(`Chrome CDP connected: ${status.browser || 'OK'}`);
    } else {
      console.log('Chrome not available — Whirlpool/ProductReview scraping unavailable.');
      console.log('  You can start Chrome manually or use the Web UI button.');
    }
  } catch (e) {
    console.log('Chrome auto-start skipped:', e.message);
  }
});
