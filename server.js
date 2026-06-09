// server.js - Johnson Dictionary Feed Backend
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const JOHNSON_RANDOM_URL = 'https://johnsonsdictionaryonline.com/views/word.php';
const JOHNSON_DEFAULT_IMAGE = 'https://johnsonsdictionaryonline.com/img/default.png';
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours
const ENTRY_COUNT = 5;
const PAGE_CONCURRENCY = 3;

let articleCache = [];
let lastRefresh = 0;
let refreshInFlight = null;

app.use(cors());
app.use(express.json());

process.on('uncaughtException', (err) => console.error('[FATAL] Uncaught exception:', err));
process.on('unhandledRejection', (reason, p) => console.error('[FATAL] Unhandled rejection:', p, reason));

function normalizeText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleFromText(text, fallback) {
  const lines = normalizeText(text).split('\n').map(l => l.trim()).filter(Boolean);
  const bad = /^(samuel johnson|dictionary|search|random|permalink|cite|feedback|close|copy|send|cancel|funding|no results)/i;
  const line = lines.find(l => l.length >= 2 && l.length <= 90 && !bad.test(l));
  return line || fallback || 'Johnson Dictionary Entry';
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding'
    ]
  });
}

async function fetchOneJohnsonEntry(browser, index = 0) {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      // Keep images because we need the facsimile URL, but block heavy extras.
      if (['font', 'media'].includes(type)) return req.abort();
      return req.continue();
    });

    await page.setUserAgent('Mozilla/5.0 HumanitiesFeed/1.0 JohnsonDictionaryFeed');
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(JOHNSON_RANDOM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(600);

    await page.evaluate(() => {
      const textOf = (el) => (el?.innerText || el?.textContent || '').trim();
      const candidates = Array.from(document.querySelectorAll('button, input[type=button], input[type=submit], a, [role=button]'));
      const randomControl = candidates.find(el => /random\s+word|random/i.test(textOf(el) || el.value || el.getAttribute('aria-label') || ''));
      if (randomControl) randomControl.click();
    });

    // Wait until the entry body appears instead of sleeping for a fixed 5 seconds.
    await page.waitForFunction(() => {
      const t = document.body?.innerText || '';
      return t.length > 300 && !/No Results found/i.test(t) && /\b(n\.s\.|v\.a\.|v\.n\.|adj\.|adv\.|interj\.|prep\.|conj\.)\b/i.test(t);
    }, { timeout: 12000 }).catch(() => null);

    const data = await page.evaluate((defaultImage) => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+\n/g, '\n').trim();

      const selectors = [
        '[id*=entry]', '[class*=entry]',
        '[id*=definition]', '[class*=definition]',
        '[id*=text]', '[class*=text]',
        '[id*=result]', '[class*=result]',
        'main', 'article', '#content', '.content'
      ];

      const candidates = [];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          if (!visible(el)) return;
          const t = textOf(el);
          if (t.length < 80) return;
          if (/Funding and support provided/i.test(t)) return;
          candidates.push(t);
        });
      });

      let entryText = candidates.sort((a, b) => b.length - a.length)[0] || textOf(document.body);

      entryText = entryText
        .replace(/^.*?Permalink\s*/is, '')
        .replace(/For more information about the selected word[\s\S]*$/i, '')
        .replace(/Funding and support provided[\s\S]*$/i, '')
        .trim();

      const headings = Array.from(document.querySelectorAll('h1,h2,h3,.selected,.active,[aria-selected=true]'))
        .filter(visible)
        .map(textOf)
        .filter(t => t && t.length < 100);

      const imgs = Array.from(document.images)
        .map(img => ({ src: img.currentSrc || img.src || '', alt: img.alt || '' }))
        .filter(img => img.src);

      const entryImage =
        imgs.find(img => /clip|facsimile|word/i.test(img.alt + ' ' + img.src))?.src ||
        imgs.find(img => /1755|1773|f1773|default/i.test(img.src))?.src ||
        defaultImage;

      const permalink = Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({ href: a.href, text: textOf(a) }))
        .find(a => /permalink/i.test(a.text) || /\/1755\//.test(a.href) || /\/1773\//.test(a.href));

      return {
        heading: headings[0] || '',
        text: entryText,
        image: entryImage,
        url: permalink?.href || window.location.href
      };
    }, JOHNSON_DEFAULT_IMAGE);

    const text = normalizeText(data.text);

    if (!text || /No Results found/i.test(text) || text.length < 40) {
      throw new Error('Johnson page loaded, but no usable random entry text was found.');
    }

    const title = titleFromText(data.heading || text, `Johnson Entry ${index + 1}`);
    const extract = text.length > 900 ? text.slice(0, 900).trim() + '…' : text;

    return {
      id: `johnson-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
      title,
      extract,
      thumbnail: data.image || JOHNSON_DEFAULT_IMAGE,
      url: data.url || JOHNSON_RANDOM_URL,
      type: 'Dictionary Entry',
      readTime: Math.max(1, Math.ceil(extract.split(/\s+/).length / 200)),
      category: 'dictionary',
      source: "Johnson's Dictionary Online"
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runPool(count, concurrency, worker) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const idx = next++;
      try {
        results[idx] = await worker(idx);
      } catch (err) {
        console.error(`[JOHNSON] Entry ${idx + 1} failed:`, err.message || err);
        results[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

async function fetchJohnsonEntries(count = ENTRY_COUNT) {
  const browser = await launchBrowser();
  try {
    const raw = await runPool(count + 2, PAGE_CONCURRENCY, (idx) => fetchOneJohnsonEntry(browser, idx));
    const entries = [];
    const seen = new Set();

    for (const entry of raw) {
      const key = entry.title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        entries.push(entry);
      }
      if (entries.length >= count) break;
    }

    return entries;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function refreshCache() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const started = Date.now();
    const articles = await fetchJohnsonEntries(ENTRY_COUNT);
    if (!articles.length) throw new Error('No Johnson entries fetched.');
    articleCache = articles;
    lastRefresh = Date.now();
    console.log(`[JOHNSON] Refreshed ${articles.length} entries in ${lastRefresh - started}ms`);
    return articles;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

app.get('/api/articles', async (req, res) => {
  try {
    const now = Date.now();
    const force = String(req.query.force || '').toLowerCase();
    const bypass = force === '1' || force === 'true';
    const freshEnough = articleCache.length && (now - lastRefresh) < CACHE_DURATION;

    if (!bypass && freshEnough) {
      return res.json({ articles: articleCache, cached: true, source: 'johnson' });
    }

    // If a stale cache exists, return it immediately and refresh in the background.
    // This keeps normal app loads fast even when Johnson or Chromium is slow.
    if (!bypass && articleCache.length) {
      refreshCache().catch(err => console.error('[JOHNSON] Background refresh failed:', err.message || err));
      return res.json({ articles: articleCache, cached: true, stale: true, source: 'johnson' });
    }

    const articles = await refreshCache();
    return res.json({ articles, cached: false, source: 'johnson' });
  } catch (err) {
    console.error('[JOHNSON] /api/articles error:', err.message || err);
    return res.status(502).json({
      error: 'Failed to fetch Johnson Dictionary entries. The upstream site may have changed its JavaScript or blocked automated access.'
    });
  }
});

app.get('/debug/johnson', async (req, res) => {
  try {
    const browser = await launchBrowser();
    try {
      const started = Date.now();
      const entry = await fetchOneJohnsonEntry(browser, 0);
      res.json({ ok: true, elapsedMs: Date.now() - started, entry });
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cacheSize: articleCache.length,
    lastRefresh,
    refreshInFlight: Boolean(refreshInFlight)
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Johnson Dictionary Feed API is running' });
});

console.log(`[BOOT] Starting Johnson Dictionary Feed API... (node ${process.version})`);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] Listening on 0.0.0.0:${PORT}`);
  if (String(process.env.PREFETCH_ON_START).toLowerCase() === 'true') {
    console.log('[BOOT] Prefetching Johnson entries...');
    refreshCache().catch(err => console.error('[BOOT] Prefetch failed:', err.message || err));
  }
});
