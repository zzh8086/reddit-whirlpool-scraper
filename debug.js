const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');

(async () => {
  // Copy user's Chrome profile (to avoid locking the real one)
  const srcProfile = process.env.LOCALAPPDATA + '/Google/Chrome/User Data';
  const tmpProfile = path.join(__dirname, '.chrome-profile-tmp');

  console.log('Copying Chrome profile for cookies... (may take a few seconds)');
  if (fs.existsSync(tmpProfile)) {
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  }

  // Copy only essential files: Cookies, Network, Local Storage, Preferences
  const copyDir = (src, dst) => {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        // Skip large/cache directories
        if (['Cache', 'Code Cache', 'GPUCache', 'Service Worker', 'IndexedDB',
             'WebStorage', 'extensions', 'blob_storage', 'File System'].includes(entry.name)) {
          continue;
        }
        try { copyDir(srcPath, dstPath); } catch (_) {}
      } else {
        try { fs.copyFileSync(srcPath, dstPath); } catch (_) {}
      }
    }
  };

  try {
    copyDir(srcProfile, tmpProfile);
    console.log('Profile copied.');
  } catch (e) {
    console.log('Warning: Could not copy profile fully:', e.message);
    console.log('Will try without profile copy...');
  }

  const browser = await chromium.launchPersistentContext(tmpProfile, {
    executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    headless: false,
    viewport: { width: 1366, height: 768 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  const targetUrl = process.argv[2] || 'https://forums.whirlpool.net.au/forum/133';
  console.log(`Opening: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 }).catch((e) => {
    console.log('Nav warning:', e.message);
  });

  await page.waitForTimeout(3000);

  const title = await page.title();
  const bodyLen = (await page.textContent('body').catch(() => '')).length;

  console.log(`\nTitle: "${title}"`);
  console.log(`Body length: ${bodyLen} chars`);

  if (bodyLen < 500 || title === 'Just a moment...') {
    console.log('\nStill on Cloudflare. Please complete verification manually, then re-run.');
    await new Promise((r) => setTimeout(r, 300000)); // 5 min for manual intervention
  }

  // Extract page structure
  const info = await page.evaluate(() => {
    const cls = {};
    document.querySelectorAll('*[class]').forEach((el) => {
      el.className.split(/\s+/).forEach((c) => {
        if (c.length && c.length < 80) cls[c] = true;
      });
    });

    const userLinks = document.querySelectorAll('a[href*="/user/"]');
    const postContainers = [];
    userLinks.forEach((link) => {
      let el = link.parentElement;
      for (let i = 0; i < 10 && el && el.tagName !== 'BODY' && el.tagName !== 'HTML'; i++) {
        const clsName = (el.className || '').split(/\s+/)[0];
        const parent = el.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
          if (sameTag.length >= 2) {
            const key = `${el.tagName}.${clsName}`;
            if (!postContainers.find((p) => p.key === key)) {
              // Extract sub-structure
              const subClasses = {};
              el.querySelectorAll('*[class]').forEach((child) => {
                child.className.split(/\s+/).forEach((c) => {
                  if (c && c.length < 60) {
                    if (!subClasses[c]) subClasses[c] = { count: 0, text: '' };
                    subClasses[c].count++;
                    if (!subClasses[c].text && child.textContent.trim().length > 5 && child.textContent.trim().length < 100) {
                      subClasses[c].text = child.textContent.trim();
                    }
                  }
                });
              });

              postContainers.push({
                key, tag: el.tagName.toLowerCase(), class: clsName,
                count: sameTag.length, level: i,
                html: el.outerHTML.substring(0, 500),
                subClasses,
              });
            }
            break;
          }
        }
        el = el.parentElement;
      }
    });

    // Pagination
    const pageLinks = [];
    document.querySelectorAll('a[href*="?p="]').forEach((a) => {
      pageLinks.push({ text: a.textContent.trim(), href: a.getAttribute('href').substring(0, 120) });
    });

    const h1s = Array.from(document.querySelectorAll('h1')).map((h) => h.textContent.trim().substring(0, 200));

    return {
      title: document.title,
      url: location.href,
      h1s,
      classes: Object.keys(cls).sort(),
      postContainers,
      pageLinks,
      bodyPreview: (document.body.textContent || '').substring(0, 2000),
    };
  });

  console.log('\n========== PAGE STRUCTURE ==========');
  console.log('URL:', info.url);
  console.log('H1:', info.h1s.join(' | '));
  console.log('\nBody preview:');
  console.log(info.bodyPreview);

  console.log('\n--- Post Containers ---');
  info.postContainers.forEach((p) => {
    console.log(`\n★ <${p.tag} class="${p.class}"> x${p.count} (level ${p.level})`);
    console.log(`  HTML: ${p.html}`);

    const sorted = Object.entries(p.subClasses).sort((a, b) => b[1].count - a[1].count);
    console.log('  Sub-classes:');
    sorted.slice(0, 20).forEach(([name, data]) => {
      console.log(`    .${name} (x${data.count}) "${data.text}"`);
    });
  });

  console.log('\n--- Pagination ---');
  info.pageLinks.slice(0, 15).forEach((p) => {
    console.log(`  "${p.text}" -> ${p.href}`);
  });

  // All classes
  console.log('\n--- All CSS Classes ---');
  const relevant = info.classes.filter((c) =>
    /post|msg|reply|user|thread|forum|page|content|body|text|date|time|author|header|row|table|item|foot|head/i.test(c)
  );
  console.log('Relevant:', relevant.join(', '));
  console.log('All:', info.classes.join(', '));

  if (!fs.existsSync('output')) fs.mkdirSync('output');
  fs.writeFileSync('output/debug_page.html', await page.content());
  console.log('\nHTML saved: output/debug_page.html');

  if (info.postContainers.length > 0) {
    const best = info.postContainers[0];
    console.log(`\n===== RECOMMENDED SELECTOR =====`);
    console.log(`Post container: "${best.tag}.${best.class}" or .${best.class}`);
  }

  await browser.close();
  console.log('\nDone.');
})();
