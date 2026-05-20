const { fetchRedditJSON } = require('../proxy');
const log = require('../logger');

let oauthToken = null;
let oauthExpiry = 0;

async function getOAuthToken() {
  if (oauthToken && Date.now() < oauthExpiry - 60000) return oauthToken;

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = 'grant_type=client_credentials';

  return new Promise((resolve) => {
    const https = require('https');
    const opts = {
      hostname: 'www.reddit.com',
      path: '/api/v1/access_token',
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': process.env.REDDIT_USER_AGENT || 'ForumScraper/1.0',
      },
      timeout: 15000,
    };
    const proxyAgent = require('../proxy').getProxyAgent();
    if (proxyAgent) opts.agent = proxyAgent;

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          oauthToken = data.access_token;
          oauthExpiry = Date.now() + (data.expires_in || 3600) * 1000;
          log.info(`OAuth token acquired, expires in ${data.expires_in}s`);
          resolve(oauthToken);
        } catch (e) {
          log.warn('OAuth token parse failed, falling back to unauthenticated');
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function fetchRedditOAuth(url) {
  const token = await getOAuthToken();
  // fall back to unauthenticated
  if (!token) return fetchRedditJSON(url);

  const https = require('https');
  const parsedUrl = new URL(url);

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': process.env.REDDIT_USER_AGENT || 'ForumScraper/1.0',
        Authorization: `Bearer ${token}`,
      },
      timeout: 30000,
    };
    const proxyAgent = require('../proxy').getProxyAgent();
    if (proxyAgent) opts.agent = proxyAgent;

    const startTime = Date.now();
    log.info(`HTTP GET (OAuth) ${url}`);

    https.get(opts, (res) => {
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

        if (res.statusCode === 401) {
          oauthToken = null;
          oauthExpiry = 0;
          log.warn('OAuth token expired, will retry unauthenticated');
          // Retry without auth
          fetchRedditJSON(url).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(Object.assign(new Error(`Reddit returned HTTP ${res.statusCode}`), {
            code: 'HTTP_ERROR', statusCode: res.statusCode,
          }));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(Object.assign(new Error('Failed to parse Reddit JSON response'), {
            code: 'PARSE_ERROR', bodyPreview: body.substring(0, 300),
          }));
        }
      });
    }).on('error', (err) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        reject(Object.assign(new Error(
          `Cannot connect to proxy ${process.env.SOCKS5_PROXY || 'direct'}. Is your VPN/Clash running?`
        ), { code: 'PROXY_CONNECTION' }));
      } else {
        reject(Object.assign(new Error(`Network error: ${err.message}`), { code: 'NETWORK' }));
      }
    });
  });
}

function hasOAuth() {
  return !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

function rateLimitDelay() {
  return hasOAuth() ? 600 : 6000;
}

function parseRedditUrl(postUrl) {
  // Support: www.reddit.com, old.reddit.com, reddit.com (with or without trailing slug)
  const m = postUrl.match(/reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
  if (!m) return null;
  return { subreddit: m[1], postId: m[2] };
}

function flattenComments(children, postAuthor, startFloor) {
  const posts = [];
  let floor = startFloor;

  function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.kind !== 't1') continue;
      const d = node.data;
      if (!d) continue;

      // Skip deleted/removed without body
      if ((d.author === '[deleted]' || d.author === '[removed]') && !d.body) continue;

      floor++;
      posts.push({
        floor,
        userName: d.author || '[unknown]',
        userId: '',
        postCount: '',
        date: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
        content: d.body || '(empty)',
        isOP: d.author === postAuthor,
        shortLink: d.permalink ? `https://www.reddit.com${d.permalink}` : '',
        replyId: d.id || '',
        score: d.score,
      });

      // Recurse into replies
      if (d.replies && typeof d.replies === 'object' && d.replies.data && d.replies.data.children) {
        walk(d.replies.data.children);
      }
    }
  }

  walk(children);
  return { posts, floor };
}

async function fetchCommentPage(postId, subreddit, after) {
  let url = `https://old.reddit.com/r/${subreddit}/comments/${postId}.json?limit=500&sort=top`;
  if (after) url += `&after=${after}`;

  const fetcher = hasOAuth() ? fetchRedditOAuth : fetchRedditJSON;
  return fetcher(url);
}

async function scrapeRedditThread(postUrl, onProgress) {
  const parsed = parseRedditUrl(postUrl);
  if (!parsed) {
    throw new Error(`Invalid Reddit URL: ${postUrl}. Expected format: https://www.reddit.com/r/{subreddit}/comments/{postId}/...`);
  }

  const { subreddit, postId } = parsed;
  const taskId = Date.now().toString(36);
  const baseUrl = `https://www.reddit.com/r/${subreddit}/comments/${postId}/`;

  log.info('=== Starting Reddit scrape ===', { url: baseUrl, subreddit, postId });

  let title = '';
  let allPosts = [];
  let pageNum = 0;
  let score = 0;
  let postData = null;
  let estimatedPages = 0;

  try {
    onProgress({ taskId, status: 'starting', page: 1, totalPages: '?', message: '正在连接 Reddit...' });

  // Fetch first page
  const data = await fetchCommentPage(postId, subreddit, null);

  if (!Array.isArray(data) || data.length < 2) {
    throw new Error('Unexpected Reddit response structure. The API may have changed.');
  }

  const postListing = data[0];
  const commentListing = data[1];

  postData = postListing.data?.children?.[0]?.data;
  if (!postData) {
    throw new Error('Could not find post data in Reddit response');
  }

  title = postData.title || '(Untitled)';
  const postAuthor = postData.author || '';
  const totalComments = postData.num_comments || 0;
  score = postData.score || 0;
  const createdUtc = postData.created_utc;

  // Estimate total comment pages
  const estimatedPages = Math.ceil(Math.min(totalComments, 1000) / 500) || 1;

  onProgress({
    taskId, status: 'scraping',
    page: 1, totalPages: estimatedPages,
    message: `标题: ${title} | r/${subreddit} | 约 ${totalComments} 条评论`,
  });

  allPosts = [];
  let floor = 0;

  // Add OP selftext as post #1 if present
  if (postData.selftext) {
    floor++;
    allPosts.push({
      floor,
      userName: postAuthor,
      userId: '',
      postCount: '',
      date: createdUtc ? new Date(createdUtc * 1000).toISOString() : '',
      content: postData.selftext,
      isOP: true,
      shortLink: `https://www.reddit.com${postData.permalink || ''}`,
      replyId: postData.id || '',
      score,
    });
  }

  // Flatten comments from first page
  const firstResult = flattenComments(commentListing.data?.children || [], postAuthor, floor);
  allPosts.push(...firstResult.posts);
  floor = firstResult.floor;

  // Paginate through remaining comments
  let after = commentListing.data?.after;
  pageNum = 1;

  while (after) {
    pageNum++;

    await new Promise((r) => setTimeout(r, rateLimitDelay()));

    onProgress({
      taskId, status: 'scraping',
      page: pageNum, totalPages: estimatedPages,
      message: `正在爬取评论第 ${pageNum}/${estimatedPages} 页...`,
    });

    let pageData;
    try {
      pageData = await fetchCommentPage(postId, subreddit, after);
    } catch (e) {
      log.error(`Comment page ${pageNum} failed`, e);
      onProgress({
        taskId, status: 'warning',
        page: pageNum, totalPages: estimatedPages,
        message: `评论第 ${pageNum} 页失败(已跳过): ${e.message}`,
      });
      break;
    }

    const listing = Array.isArray(pageData) ? pageData[1] : pageData;
    const children = listing?.data?.children || [];

    const result = flattenComments(children, postAuthor, floor);
    allPosts.push(...result.posts);
    floor = result.floor;

    after = listing?.data?.after || null;

    // Reddit API 1000-item cap
    if (allPosts.length >= 1000) {
      log.warn('Hit Reddit 1000-item pagination limit');
      allPosts.push({
        floor: floor + 1,
        userName: '[SYSTEM]',
        userId: '',
        postCount: '',
        date: new Date().toISOString(),
        content: 'Reddit API limit reached: more comments exist but cannot be fetched (1,000 item limit).',
        isOP: false,
        shortLink: '',
        replyId: '',
      });
      break;
    }
  }

  log.info('=== Reddit scrape complete ===', {
    url: baseUrl,
    title,
    subreddit,
    commentPages: pageNum,
    totalPosts: allPosts.length,
  });

  onProgress({
    taskId, status: 'done',
    page: pageNum, totalPages: pageNum,
    message: `完成！共 ${allPosts.length} 条内容（r/${subreddit}）`,
  });

    return {
      taskId,
      source: 'reddit',
      title,
      threadUrl: baseUrl,
      subreddit,
      postId,
      score,
      url: postData?.url || baseUrl,
      totalPages: pageNum,
      totalPosts: allPosts.length,
      posts: allPosts,
      failedPages: [],
    };
  } catch (error) {
    if (error.message === 'TASK_CANCELLED') {
      log.info('Reddit scrape cancelled, saving partial', { taskId, posts: allPosts.length });
      return {
        taskId, source: 'reddit',
        title: title || 'Unknown',
        threadUrl: baseUrl, subreddit, postId,
        score, url: postData?.url || baseUrl,
        totalPages: pageNum,
        totalPosts: allPosts.length,
        posts: allPosts, failedPages: [],
        cancelled: true,
      };
    }
    throw error;
  }
}

function parseRedditSearchUrl(url) {
  const params = new URL(url).searchParams;
  const query = params.get('q') || '';
  if (!query) return null;

  let subreddit = null;
  let restrictSr = false;

  // Subreddit-specific search: /r/subreddit/search?q=...
  const m1 = url.match(/reddit\.com\/r\/([^/]+)\/search\b/i);
  if (m1) {
    subreddit = m1[1];
    restrictSr = params.get('restrict_sr') !== 'off';
  }
  // New Reddit sub search: /r/subreddit/?q=... or /r/subreddit?q=...
  const m2 = url.match(/reddit\.com\/r\/([^/]+)\/\?q=/i) || url.match(/reddit\.com\/r\/([^/]+)\?q=/i);
  if (m2 && !subreddit) {
    subreddit = m2[1];
  }
  // Global search: /search/?q=... or /search?q=...
  const m3 = url.match(/reddit\.com\/search\b/i);
  if (m3 && !subreddit) {
    subreddit = 'all';
  }

  if (!query) return null;
  return {
    subreddit: subreddit || 'all',
    query,
    sort: params.get('sort') || 'relevance',
    restrictSr,
  };
}

async function scrapeRedditSearch(searchUrl, onProgress) {
  const parsed = parseRedditSearchUrl(searchUrl);
  if (!parsed) throw new Error('Invalid Reddit search URL: ' + searchUrl);

  const { subreddit, query, sort, restrictSr } = parsed;
  const taskId = Date.now().toString(36);

  const scopeLabel = subreddit === 'all' ? 'Reddit全站' : `r/${subreddit}`;
  onProgress({ taskId, status: 'starting', page: 1, totalPages: '?', message: `正在搜索 ${scopeLabel} 中 "${query}" 的帖子...` });

  // Fetch all search result pages to collect post links
  let allPosts = [];
  let scrapedCount = 0;
  let results = [];
  let allFlattenedPosts = [];
  let searchPage = 0;

  try {
    let after = null;
    const maxSearchPages = 5; // cap at ~500 results

  const searchPath = subreddit === 'all'
    ? `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=100`
    : `https://old.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=${restrictSr ? 'on' : 'off'}&sort=${sort}&limit=100`;
  const baseSearchUrl = searchPath;

  while (searchPage < maxSearchPages) {
    const url = baseSearchUrl + (after ? `&after=${after}` : '');
    log.info(`Reddit search page ${searchPage + 1}: ${url}`);

    let data;
    try {
      data = await fetchRedditJSON(url);
    } catch (e) {
      if (searchPage === 0) throw e;
      log.warn(`Reddit search page ${searchPage + 1} failed: ${e.message}`);
      break;
    }

    const children = data?.data?.children || [];
    for (const child of children) {
      if (child.kind === 't3' && child.data) {
        const d = child.data;
        allPosts.push({
          subreddit: d.subreddit,
          postId: d.id,
          title: d.title || '',
          permalink: d.permalink || '',
          numComments: d.num_comments || 0,
          score: d.score || 0,
        });
      }
    }

    log.info(`Reddit search page ${searchPage + 1}: found ${children.length} results (total: ${allPosts.length})`);

    after = data?.data?.after;
    if (!after) break;
    searchPage++;

    if (after) {
      const delay = 1000 + Math.random() * 2000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  log.info(`Reddit search complete: ${allPosts.length} total posts found`);

  if (allPosts.length === 0) {
    onProgress({ taskId, status: 'done', page: 1, totalPages: 1, message: '搜索未找到任何帖子' });
    return {
      taskId,
      source: 'reddit-search',
      title: subreddit === 'all' ? `Search: ${query} (all Reddit)` : `Search: ${query} in r/${subreddit}`,
      threadUrl: searchUrl,
      subreddit,
      searchQuery: query,
      totalPosts: 0,
      totalPages: 0,
      posts: [],
      failedPages: [],
    };
  }

  onProgress({
    taskId, status: 'parsing',
    page: 1, totalPages: allPosts.length,
    message: `找到 ${allPosts.length} 个帖子，开始逐个爬取...`,
  });

  // Scrape each thread
  results = [];
  const failedThreads = [];
  scrapedCount = 0;

  for (let i = 0; i < allPosts.length; i++) {
    const p = allPosts[i];
    const threadUrl = `https://old.reddit.com/r/${p.subreddit}/comments/${p.postId}/.json`;

    onProgress({
      taskId, status: 'scraping',
      page: i + 1, totalPages: allPosts.length,
      message: `[${i + 1}/${allPosts.length}] 正在爬取: ${p.title.substring(0, 60)}...`,
    });

    try {
      const result = await scrapeRedditThread(threadUrl, () => {
        // inner progress ignored for simplicity; outer progress tracks thread-level
      });
      results.push({
        threadUrl,
        title: result.title,
        totalPosts: result.totalPosts,
        posts: result.posts,
      });
      scrapedCount++;
    } catch (e) {
      log.warn(`Reddit thread failed: ${threadUrl} — ${e.message}`);
      failedThreads.push({ url: threadUrl, error: e.message });
      results.push({
        threadUrl,
        title: p.title,
        totalPosts: 0,
        posts: [],
        error: e.message,
      });
    }

    // Rate limiting between threads
    const delay = hasOAuth() ? 1000 + Math.random() * 1000 : 5000 + Math.random() * 2000;
    await new Promise((r) => setTimeout(r, delay));
  }

  // Flatten all posts with global floor numbering
  let globalFloor = 0;
  allFlattenedPosts = [];
  for (const r of results) {
    for (const post of r.posts) {
      globalFloor++;
      allFlattenedPosts.push({ floor: globalFloor, ...post, _threadUrl: r.threadUrl, _threadTitle: r.title });
    }
  }

  const totalSuccessfulPosts = results.reduce((sum, r) => sum + r.totalPosts, 0);

  onProgress({
    taskId, status: 'done',
    page: allPosts.length, totalPages: allPosts.length,
    message: `完成！${scrapedCount}/${allPosts.length} 个帖子成功，共 ${totalSuccessfulPosts} 条回复`,
  });

    return {
      taskId,
      source: 'reddit-search',
      title: subreddit === 'all' ? `Search: ${query} (all Reddit)` : `Search: ${query} in r/${subreddit}`,
      threadUrl: searchUrl,
      subreddit,
      searchQuery: query,
      totalPages: allPosts.length,
      totalPosts: totalSuccessfulPosts,
      matchedThreads: allPosts.length,
      successfulThreads: scrapedCount,
      failedThreads: failedThreads.length,
      posts: allFlattenedPosts,
      threadResults: results,
      failedPages: failedThreads.map((f) => f.url),
    };
  } catch (error) {
    if (error.message === 'TASK_CANCELLED') {
      log.info('Reddit search cancelled, saving partial', { taskId, threads: results.length, posts: allFlattenedPosts.length });
      return {
        taskId, source: 'reddit-search',
        title: subreddit === 'all' ? `Search: ${query} (all Reddit)` : `Search: ${query} in r/${subreddit}`,
        threadUrl: searchUrl, subreddit, searchQuery: query,
        totalPages: allPosts.length,
        totalPosts: allFlattenedPosts.length,
        matchedThreads: allPosts.length,
        successfulThreads: scrapedCount,
        failedThreads: 0,
        posts: allFlattenedPosts,
        threadResults: results,
        failedPages: [],
        cancelled: true,
      };
    }
    throw error;
  }
}

function hasOAuth() {
  return !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET && oauthToken);
}

module.exports = { scrapeRedditThread, parseRedditUrl, scrapeRedditSearch, parseRedditSearchUrl };
