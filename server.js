require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { scrapeThread } = require('./scraper');
const { scrapeRedditThread } = require('./sources/reddit');
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
  if (/reddit\.com\/r\/.+\/comments\//i.test(url)) return 'reddit';
  if (/forums\.whirlpool\.net\.au\/thread\//i.test(url)) return 'whirlpool';
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

// API: Start scraping
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  const source = detectSource(url || '');

  if (!source) {
    log.warn('Invalid URL submitted', { url });
    return res.status(400).json({ error: '请输入有效的帖子链接（Whirlpool 或 Reddit）' });
  }

  log.info('Scrape request received', { url, source });

  const taskId = Date.now().toString(36);
  const clients = new Set();
  tasks.set(taskId, { clients, status: 'started' });

  const scraper = source === 'reddit' ? scrapeRedditThread : scrapeThread;

  res.json({ taskId });

  try {
    const result = await scraper(url, (progress) => {
      progress.taskId = taskId;
      tasks.get(taskId).lastProgress = progress;
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

    for (const clientRes of clients) {
      sendSSE(clientRes, {
        taskId,
        status: 'complete',
        message: '爬取完成！',
        result: tasks.get(taskId).result,
      });
      clientRes.end();
    }
  } catch (error) {
    log.error('Scrape task failed', error);
    for (const clientRes of clients) {
      sendSSE(clientRes, { taskId, status: 'error', message: error.message });
      clientRes.end();
    }
  }
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

  tasks.set(batchId, { clients: batchClients, tasks: batchTasks });

  res.json({ batchId, tasks: batchTasks.map((t) => ({ taskId: t.taskId, url: t.url, source: t.source })) });

  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  await runWithLimit(classified, 3, async (item) => {
    const { url, source, index } = item;
    const task = batchTasks.find((t) => t.taskId === batchId + '_' + index);
    if (!task) return;
    task.status = 'scraping';

    const broadcast = (data) => {
      for (const client of batchClients) {
        sendSSE(client, { batchId, taskId: task.taskId, url, source, ...data });
      }
    };

    const scraper = source === 'reddit' ? scrapeRedditThread : scrapeThread;

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
      } else {
        const threadId = url.match(/\/thread\/([^?\s]+)/)?.[1] || task.taskId;
        const slug = slugify(result.title);
        const name = `thread_${slug}_${threadId}`;
        jsonPath = path.join(outDir, `${name}.json`);
        htmlPath = path.join(outDir, `${name}.html`);
      }

      fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
      fs.writeFileSync(htmlPath, generateHTML(result), 'utf-8');

      task.status = 'done';
      broadcast({
        status: 'done',
        message: `完成：${result.title}（${result.totalPosts} 条内容）`,
        result: {
          ...result,
          jsonPath: `/output/${path.basename(jsonPath)}`,
          htmlPath: `/output/${path.basename(htmlPath)}`,
        },
      });
    } catch (err) {
      log.error(`Batch task ${task.taskId} failed`, err);
      task.status = 'error';
      broadcast({ status: 'error', message: err.message });
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop');
});
