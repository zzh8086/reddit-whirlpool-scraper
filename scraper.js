const { chromium } = require('playwright');
const log = require('./logger');

let browser = null;
const CDP_URL = 'http://localhost:9222';

// ---- Browser connection ----

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    log.info('CDP connected to Chrome on port 9222');
    return browser;
  } catch (e) {
    log.error('CDP connection failed', e);
    throw new Error(
      '无法连接到Chrome。请确保：\n' +
      '1. 关闭所有Chrome窗口\n' +
      '2. 运行: start-chrome.bat\n' +
      '3. 在新Chrome中访问 Whirlpool 确认能正常加载\n' +
      '4. 再运行本程序\n' +
      '错误: ' + e.message
    );
  }
}

async function newPage() {
  const b = await getBrowser();
  const contexts = b.contexts();
  const context = contexts.length > 0 ? contexts[0] : await b.newContext();
  return context.newPage();
}

async function closeBrowser() {
  browser = null;
  console.log('Session ended. Your Chrome stays open with other tabs intact.');
}

// ---- Content extraction (using verified Whirlpool selectors) ----

async function extractPostsFromDOM(page) {
  return page.evaluate(() => {
    const posts = [];
    // Whirlpool exact selector: each reply is a div.reply
    const replyEls = document.querySelectorAll('div.reply');

    replyEls.forEach((el) => {
      // Username: .replyuser .username .bu_name
      const nameEl = el.querySelector('.replyuser .bu_name');
      const userName = nameEl ? nameEl.textContent.trim() : '';

      // User ID: .replyuser .userstats .userid
      const uidEl = el.querySelector('.replyuser .userid');
      const userId = uidEl ? uidEl.textContent.trim() : '';

      // Post count: .replyuser .userstats .replycount
      const countEl = el.querySelector('.replyuser .replycount');
      const postCount = countEl ? countEl.textContent.trim() : '';

      // Date: .replytools .date (contains "posted" text + date)
      const dateEl = el.querySelector('.replytools .date');
      let date = '';
      if (dateEl) {
        date = dateEl.textContent.replace(/posted|\(edited\)|edited|moments later/gi, '').trim();
      }

      // Edited flag
      const editedEl = el.querySelector('.replytools .edited');

      // Content: .replytext.bodytext
      const bodyEl = el.querySelector('.replytext.bodytext');
      let content = '';
      if (bodyEl) {
        // Remove OP badge from content
        const opEl = bodyEl.querySelector('.op');
        if (opEl) opEl.remove();
        // Get text preserving paragraph breaks
        content = bodyEl.textContent.trim().replace(/\n{3,}/g, '\n\n');
      }

      // Is OP?
      const opBadge = el.querySelector('.replytext .op');
      const isOP = !!opBadge;

      // Short link
      const shortLinkEl = el.querySelector('.replytools .shortcode');
      const shortLink = shortLinkEl ? shortLinkEl.textContent.trim() : '';

      // Reply anchor ID
      const anchorEl = el.querySelector('.replytools a[href*="#r"]');
      let replyId = '';
      if (anchorEl) {
        const m = anchorEl.getAttribute('href').match(/#r(\d+)/);
        if (m) replyId = m[1];
      }

      if (userName || content) {
        posts.push({ userName, userId, postCount, date, content, isOP, shortLink, replyId });
      }
    });

    return posts;
  });
}

async function getTotalPages(page) {
  return page.evaluate(() => {
    // Whirlpool exact: ul.pagination li[data-page] contains page numbers
    const pageItems = document.querySelectorAll('ul.pagination li[data-page]');
    let maxPage = 1;
    pageItems.forEach((li) => {
      const n = parseInt(li.getAttribute('data-page'), 10);
      if (!isNaN(n) && n > maxPage) maxPage = n;
    });
    return maxPage;
  });
}

async function getThreadTitle(page) {
  return page.evaluate(() => {
    // Whirlpool page title: "Thread Title - Category - Whirlpool Forums"
    const titleEl = document.querySelector('title');
    if (titleEl) {
      let title = titleEl.textContent.trim();
      // Strip " - Whirlpool Forums" suffix
      title = title.replace(/\s*[-–]\s*Whirlpool\s+Forums\s*$/i, '').trim();
      // Strip category suffix after last " - "
      const lastDash = title.lastIndexOf(' - ');
      if (lastDash > 0) title = title.substring(0, lastDash).trim();
      return title;
    }
    return 'Unknown Title';
  });
}

// ---- Main scraping flow ----

async function extractPageContent(page, pageNum, threadUrl) {
  const url = pageNum === 1 ? threadUrl : `${threadUrl}?p=${pageNum}`;
  log.info(`Navigating to page ${pageNum}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Brief delay for content to settle
  await new Promise((r) => setTimeout(r, 800 + Math.random() * 700));
  const posts = await extractPostsFromDOM(page);
  log.info(`Page ${pageNum}: extracted ${posts.length} posts`);
  if (posts.length === 0) {
    log.warn(`Page ${pageNum}: zero posts extracted`, { url, pageTitle: await page.title().catch(() => '?') });
  }
  return posts;
}

async function scrapeThread(threadUrl, onProgress) {
  // Normalize URL: ensure no trailing ?p= params for the base URL
  const baseUrl = threadUrl.replace(/[?&]p=\d+.*$/, '');

  log.info('=== Starting scrape ===', { url: baseUrl });
  const page = await newPage();
  const taskId = Date.now().toString(36);

  try {
    onProgress({ taskId, status: 'starting', page: 1, totalPages: '?', message: '正在加载第1页...' });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const title = await getThreadTitle(page);
    const totalPages = await getTotalPages(page);
    log.info(`Thread title: "${title}", total pages: ${totalPages}`);

    onProgress({
      taskId, status: 'parsing',
      page: 1, totalPages,
      message: `标题: ${title} | 共 ${totalPages} 页，开始爬取...`,
    });

    const allPosts = [];
    let globalFloor = 0;
    let failedPages = [];

    for (let p = 1; p <= totalPages; p++) {
      onProgress({
        taskId, status: 'scraping',
        page: p, totalPages,
        message: `正在爬取第 ${p}/${totalPages} 页...`,
      });

      let posts;
      let retries = 0;
      while (retries < 3) {
        try {
          posts = await extractPageContent(page, p, baseUrl);
          break;
        } catch (e) {
          retries++;
          log.warn(`Page ${p} attempt ${retries} failed: ${e.message}`);
          if (retries === 3) {
            log.error(`Page ${p} failed after 3 retries`, e);
            failedPages.push(p);
            onProgress({
              taskId, status: 'warning',
              page: p, totalPages,
              message: `第 ${p} 页失败(已跳过): ${e.message}`,
            });
            posts = [];
          } else {
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }

      for (const post of posts) {
        globalFloor++;
        allPosts.push({ floor: globalFloor, ...post });
      }

      if (p < totalPages) {
        const delay = 1000 + Math.random() * 2000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    await page.close();

    log.info('=== Scrape complete ===', {
      url: baseUrl,
      title,
      totalPages,
      totalPosts: allPosts.length,
      failedPages: failedPages.length > 0 ? failedPages : 'none',
    });

    onProgress({
      taskId, status: 'done',
      page: totalPages, totalPages,
      message: `完成！共 ${allPosts.length} 条回复` + (failedPages.length > 0 ? ` (${failedPages.length} 页失败)` : ''),
    });

    return { taskId, title, threadUrl: baseUrl, totalPages, totalPosts: allPosts.length, posts: allPosts, failedPages };
  } catch (error) {
    log.error('Scrape failed', error);
    try { await page.close(); } catch (_) {}
    throw error;
  }
}

module.exports = { scrapeThread, closeBrowser };
