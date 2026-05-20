const { getBrowser, newPage } = require('../scraper');
const log = require('../logger');

function parseProductReviewUrl(url) {
  const m = url.match(/productreview\.com\.au\/listings\/([^/?\s]+)/i);
  if (!m) return null;
  return { listingSlug: m[1] };
}

async function scrapeProductReviewListing(url, onProgress) {
  const parsed = parseProductReviewUrl(url);
  if (!parsed) throw new Error(`Invalid ProductReview URL: ${url}`);

  const { listingSlug } = parsed;
  const taskId = Date.now().toString(36);
  const page = await newPage();
  let meta = null;
  let allReviews = [];
  let totalPages = 1;
  let failedPages = [];

  try {
    onProgress({ taskId, status: 'starting', page: 1, totalPages: '?', message: '正在加载商品页面...' });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));

    // Extract SSR data for metadata and field definitions
    const pageInfo = await page.evaluate(() => {
      const title = document.title || '';
      let meta = null;
      let fieldDefs = {};
      let debugging = '';
      const el = document.querySelector('script[data-var="__ssr_data"]');
      if (el) {
        try {
          const data = JSON.parse(el.textContent);
          const rc = data?.reduxAsyncConnect;
          let listing = null;
          if (rc) {
            const itemKeys = Object.keys(rc.itemsMap || {});
            debugging = 'itemsMap keys: ' + itemKeys.join(', ');
            for (const key of itemKeys) {
              const item = rc.itemsMap[key];
              if (item?.data?.listing) {
                listing = item.data.listing;
                debugging += ' | found via: ' + key;
                break;
              }
            }
            // Extract field definitions from SSR data — search all itemsMap entries recursively
            function findFieldDefs(obj, depth) {
              if (!obj || typeof obj !== 'object' || depth > 8) return;
              if (Array.isArray(obj)) {
                for (const item of obj) findFieldDefs(item, depth + 1);
                return;
              }
              // Look for field objects with id + label
              if (obj.id && obj.label && typeof obj.id === 'string' && obj.id.includes('-')) {
                const def = { label: obj.label, type: obj.type || 'unknown' };
                // Extract choice options if present
                const choices = obj.properties?.choices || obj.properties?.options;
                if (choices) {
                  def.choices = {};
                  for (const choice of choices) {
                    if (choice.value && choice.label) {
                      def.choices[choice.value] = choice.label;
                    }
                  }
                }
                fieldDefs[obj.id] = def;
              }
              // Recurse into nested objects
              for (const [k, v] of Object.entries(obj)) {
                if (k === 'fields' && Array.isArray(v)) {
                  findFieldDefs(v, depth + 1);
                } else if (v && typeof v === 'object') {
                  findFieldDefs(v, depth + 1);
                }
              }
            }
            findFieldDefs(rc, 0);
          }
          if (listing) {
            meta = {
              catalogId: listing.catalogId,
              listingId: listing.id,
              title: listing.fullName || listing.name || '',
              slug: listing.slug || '',
              rating: listing.statistics?.rating || 0,
              totalReviews: listing.statistics?.numberOfReviews || 0,
            };
          }
        } catch (e) {
          debugging = 'JSON parse error: ' + e.message;
        }
      }
      return { title, meta, fieldDefs, debugging };
    });

    log.info('Page diagnostic', { title: pageInfo.title, hasMeta: !!pageInfo.meta, fieldDefCount: Object.keys(pageInfo.fieldDefs).length, debugging: pageInfo.debugging });

    meta = pageInfo.meta;
    const fieldDefs = pageInfo.fieldDefs || {};
    if (!meta) throw new Error('无法提取页面元数据，可能需要浏览器手动验证Cloudflare. Page title: ' + pageInfo.title);
    log.info('ProductReview metadata extracted', meta);
    if (Object.keys(fieldDefs).length > 0) {
      log.info('Field definitions extracted', { count: Object.keys(fieldDefs).length });
    }

    // Fetch all reviews via API from within the page context (inherits cookies/headers)
    allReviews = [];
    const limit = 100;
    let currentPage = 1;
    totalPages = 1;
    failedPages = [];

    onProgress({
      taskId, status: 'parsing',
      page: 1, totalPages: Math.ceil(meta.totalReviews / limit),
      message: `标题: ${meta.title} | 共 ${meta.totalReviews} 条评价，开始爬取...`,
    });

    while (currentPage <= totalPages) {
      const pageNum = currentPage;

      try {
        const result = await page.evaluate(async ({ catalogId, listingSlug, page, limit }) => {
          const url = `/api/${catalogId}/listings/${listingSlug}/reviews?page=${page}&limit=${limit}&sort=firstPublishedAt`;
          const resp = await fetch(url, { credentials: 'include' });
          const text = await resp.text();
          let json;
          try { json = JSON.parse(text); } catch (_) { json = null; }
          return { status: resp.status, ok: resp.ok, text: text.substring(0, 6000), json, jsonKeys: json ? Object.keys(json) : [] };
        }, { catalogId: meta.catalogId, listingSlug, page: pageNum, limit });

        const apiResp = result;

        if (!apiResp.ok) {
          throw new Error(`API HTTP ${apiResp.status}: ${apiResp.text.substring(0, 200)}`);
        }
        const data = apiResp.json;
        if (!data) {
          throw new Error('API returned non-JSON: ' + apiResp.text.substring(0, 200));
        }

        // Defensive parsing for reviews array and pagination
        let pageReviews = [];
        let paginationInfo = {};
        if (Array.isArray(data)) {
          pageReviews = data;
        } else if (data.collection && Array.isArray(data.collection.items)) {
          pageReviews = data.collection.items;
          paginationInfo = data.paging || data.collection.paging || {};
        } else if (data.reviews && Array.isArray(data.reviews)) {
          pageReviews = data.reviews;
        } else if (data.data && Array.isArray(data.data)) {
          pageReviews = data.data;
        } else if (data.items && Array.isArray(data.items)) {
          pageReviews = data.items;
        } else if (data.results && Array.isArray(data.results)) {
          pageReviews = data.results;
        } else if (data.reviews && typeof data.reviews === 'object' && Array.isArray(data.reviews.items)) {
          pageReviews = data.reviews.items;
          paginationInfo = data.reviews.paging || {};
        } else {
          log.warn('API response shape unknown', { page: pageNum, keys: Object.keys(data) });
        }

        // Determine pagination
        if (currentPage === 1 && pageReviews.length > 0) {
          const p = paginationInfo || data.pagination || data.meta || data.pageInfo || {};
          const candidatePages = p.totalPages || p.total || p.pageCount;
          if (candidatePages) {
            totalPages = Math.min(candidatePages, Math.ceil(meta.totalReviews / limit));
          } else if (pageReviews.length < limit) {
            totalPages = 1;
          } else {
            totalPages = Math.ceil(meta.totalReviews / limit);
          }
        } else if (currentPage === 1 && pageReviews.length === 0) {
          log.warn('API returned 0 reviews on first page', { keys: Object.keys(data), textPreview: apiResp.text.substring(0, 500) });
          totalPages = 1;
        }

        // Build author lookup from collection.authors
        const authorsList = data.collection?.authors || [];
        const authorMap = {};
        if (Array.isArray(authorsList)) {
          authorsList.forEach((author, idx) => {
            authorMap[idx] = author;
          });
        }

        // Resolve each review's author
        for (const review of pageReviews) {
          const refIdx = review._authorReference;
          if (refIdx !== undefined && authorMap[refIdx]) {
            const author = authorMap[refIdx];
            review._authorName = author.displayName || author.name || author.screenName || '';
          }
        }

        allReviews.push(...pageReviews);
        log.info(`ProductReview page ${pageNum}: ${pageReviews.length} reviews (total: ${allReviews.length})`);
      } catch (e) {
        log.warn(`ProductReview page ${pageNum} API fetch failed: ${e.message}`);
        // Retry once with a longer delay (Cloudflare might be rate-limiting)
        if (currentPage <= totalPages) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const retryResult = await page.evaluate(async ({ catalogId, listingSlug, page, limit }) => {
              const url = `/api/${catalogId}/listings/${listingSlug}/reviews?page=${page}&limit=${limit}&sort=firstPublishedAt`;
              const resp = await fetch(url, { credentials: 'include' });
              const text = await resp.text();
              let json;
              try { json = JSON.parse(text); } catch (_) { json = null; }
              return { status: resp.status, ok: resp.ok, text, json };
            }, { catalogId: meta.catalogId, listingSlug, page: pageNum, limit });

            if (!retryResult.ok || !retryResult.json) throw new Error(`API failed: HTTP ${retryResult.status}`);

            const rd = retryResult.json;
            let retryReviews = [];
            if (Array.isArray(rd)) retryReviews = rd;
            else if (rd.collection && Array.isArray(rd.collection.items)) retryReviews = rd.collection.items;
            else if (rd.reviews && Array.isArray(rd.reviews)) retryReviews = rd.reviews;
            else if (rd.data && Array.isArray(rd.data)) retryReviews = rd.data;
            else if (rd.items && Array.isArray(rd.items)) retryReviews = rd.items;
            else if (rd.results && Array.isArray(rd.results)) retryReviews = rd.results;
            else if (rd.reviews && typeof rd.reviews === 'object' && Array.isArray(rd.reviews.items)) retryReviews = rd.reviews.items;

            // Resolve authors for retry reviews
            const retryAuthorsList = rd.collection?.authors || [];
            if (retryAuthorsList.length > 0) {
              for (const review of retryReviews) {
                const refIdx = review._authorReference;
                if (refIdx !== undefined && retryAuthorsList[refIdx]) {
                  const author = retryAuthorsList[refIdx];
                  review._authorName = author.displayName || author.name || author.screenName || '';
                }
              }
            }

            allReviews.push(...retryReviews);
            log.info(`ProductReview page ${pageNum} retry OK: ${retryReviews.length} reviews`);
          } catch (e2) {
            log.error(`ProductReview page ${pageNum} failed after retry`, e2);
            failedPages.push(pageNum);
            onProgress({
              taskId, status: 'warning',
              page: pageNum, totalPages,
              message: `第 ${pageNum} 页失败(已跳过): ${e2.message}`,
            });
          }
        }
      }

      onProgress({
        taskId, status: 'scraping',
        page: currentPage, totalPages,
        message: `正在爬取第 ${currentPage}/${totalPages} 页...（已获取 ${allReviews.length} 条）`,
      });

      currentPage++;

      if (currentPage <= totalPages) {
        const delay = 2000 + Math.random() * 2000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // For reviews with short content, fetch full details
    const shortContentReviews = allReviews.filter((r) => {
      const body = r.body || r.text || r.content || '';
      return body.length < 80;
    });

    if (shortContentReviews.length > 0) {
      log.info(`Fetching full details for ${shortContentReviews.length} short reviews`);
      for (let i = 0; i < shortContentReviews.length; i++) {
        const review = shortContentReviews[i];
        const reviewId = review.id;
        if (!reviewId) continue;

        try {
          const detail = await page.evaluate(async ({ catalogId, reviewId }) => {
            const url = `/api/${catalogId}/reviews/${reviewId}/details`;
            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.json();
          }, { catalogId: meta.catalogId, reviewId });

          // Merge detail into the review
          const detailReview = detail.review || detail.data || detail;
          if (detailReview.body) review.body = detailReview.body;
          if (detailReview.text) review.text = detailReview.text;
          if (detailReview.content) review.content = detailReview.content;
          if (detailReview.title) review.title = detailReview.title;
          if (detailReview.verified !== undefined) review.verified = detailReview.verified;
          if (detailReview.statistics?.helpfulCount !== undefined) {
            review.statistics = review.statistics || {};
            review.statistics.helpfulCount = detailReview.statistics.helpfulCount;
          }
        } catch (e) {
          log.warn(`Failed to fetch details for review ${reviewId}: ${e.message}`);
        }

        if ((i + 1) % 5 === 0) {
          await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
        }
      }
    }

    await page.close();

    // Map to standard post format
    const posts = allReviews.map((review, i) => {
      const specVals = review.specificationValues;
      const spec = {};
      if (specVals && typeof specVals === 'object') {
        for (const [uuid, val] of Object.entries(specVals)) {
          const def = fieldDefs[uuid];
          const label = def ? def.label : uuid;
          // Resolve choice UUID to label if possible
          let resolvedVal = val;
          if (def && def.choices && def.choices[val]) {
            resolvedVal = def.choices[val];
          }
          spec[label] = resolvedVal;
        }
      }

      // Pull out key sub-ratings and purchase info
      const subRatings = {};
      const purchaseInfo = {};

      for (const [label, val] of Object.entries(spec)) {
        // Sub-ratings
        if (label === 'Build Quality') subRatings.buildQuality = val;
        if (label === 'Value for Money') subRatings.valueForMoney = val;
        if (label === 'Noise Level') subRatings.noiseLevel = val;
        // Purchase info (using resolved choice labels)
        if (label === 'Purchase Price') purchaseInfo.price = val;
        if (label === 'Purchase Date') purchaseInfo.date = val;
        if (label === 'Bought' || label === 'New or Used') purchaseInfo.condition = val;
        if (label === 'Badge') purchaseInfo.badge = val;
        if (label === 'Year') purchaseInfo.year = val;
        if (label === 'Transmission') purchaseInfo.transmission = val;
        if (label === 'Fuel Type') purchaseInfo.fuelType = val;
        if (label === 'Engine') purchaseInfo.engine = val;
      }

      return {
        floor: i + 1,
        userName: review._authorName || review.author?.displayName || review.user?.displayName || review.authorName || 'Anonymous',
        userId: review.author?.id || review.user?.id || '',
        postCount: '',
        date: review.firstPublishedAt || review.createdAt || review.date || '',
        content: review.body || review.text || review.content || '',
        isOP: false,
        shortLink: `https://www.productreview.com.au/listings/${listingSlug}`,
        replyId: review.id || '',
        // Source-specific extra fields
        rating: review.rating || 0,
        reviewTitle: review.title || '',
        verified: review.hasVerifiedPurchase || review.isVerified || false,
        helpfulCount: review.numberOfLikes || review.statistics?.helpfulCount || 0,
        subRatings: Object.keys(subRatings).length > 0 ? subRatings : undefined,
        purchaseInfo: Object.keys(purchaseInfo).length > 0 ? purchaseInfo : undefined,
        // Keep full specification values for reference
        specificationValues: spec,
      };
    });

    log.info('ProductReview scrape complete', {
      listingSlug,
      title: meta.title,
      totalPages,
      totalPosts: posts.length,
      failedPages: failedPages.length > 0 ? failedPages : 'none',
    });

    onProgress({
      taskId, status: 'done',
      page: totalPages, totalPages,
      message: `完成！${meta.title} 共 ${posts.length} 条评价` + (failedPages.length > 0 ? ` (${failedPages.length} 页失败)` : ''),
    });

    return {
      taskId,
      source: 'productreview',
      title: meta.title,
      threadUrl: url,
      listingSlug,
      listingId: meta.listingId,
      catalogId: meta.catalogId,
      rating: meta.rating,
      totalReviews: meta.totalReviews,
      totalPages,
      totalPosts: posts.length,
      posts,
      failedPages,
    };
  } catch (error) {
    if (error.message === 'TASK_CANCELLED') {
      log.info('ProductReview scrape cancelled, saving partial', { taskId, posts: allReviews.length });
      try { await page.close(); } catch (_) {}
      const posts = (allReviews || []).map((review, i) => ({
        floor: i + 1,
        userName: review._authorName || 'Anonymous',
        userId: '', postCount: '',
        date: review.firstPublishedAt || review.createdAt || '',
        content: review.body || review.text || review.content || '',
        isOP: false,
        shortLink: `https://www.productreview.com.au/listings/${listingSlug}`,
        replyId: review.id || '',
        rating: review.rating || 0,
        reviewTitle: review.title || '',
        verified: review.hasVerifiedPurchase || review.isVerified || false,
        helpfulCount: review.numberOfLikes || 0,
      }));
      return {
        taskId, source: 'productreview',
        title: (meta && meta.title) || 'Unknown',
        threadUrl: url, listingSlug, listingId: meta?.listingId || '', catalogId: meta?.catalogId || '',
        rating: meta?.rating || 0, totalReviews: meta?.totalReviews || 0,
        totalPages, totalPosts: posts.length, posts, failedPages, cancelled: true,
      };
    }
    log.error('ProductReview scrape failed', error);
    try { await page.close(); } catch (_) {}
    throw error;
  }
}

module.exports = { scrapeProductReviewListing, parseProductReviewUrl };
