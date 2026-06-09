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
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

let articleCache = [];
let lastRefresh = 0;

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

async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

async function fetchOneJohnsonEntry(index = 0) {
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 HumanitiesFeed/1.0 JohnsonDictionaryFeed');
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(JOHNSON_RANDOM_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    // The page is JavaScript-driven. The /views/word.php page loads the
    // random-word interface; in headless Chromium we explicitly press its
    // Random Word control rather than assuming the first load will populate it.
    await sleep(1500);

    await page.evaluate(() => {
      const textOf = (el) => (el?.innerText || el?.textContent || '').trim();
      const candidates = Array.from(document.querySelectorAll('button, input[type=button], input[type=submit], a, [role=button]'));
      const randomControl = candidates.find(el => /random\s+word|random/i.test(textOf(el) || el.value || el.getAttribute('aria-label') || ''));
      if (randomControl) randomControl.click();
    });

    await sleep(5000);

    const data = await page.evaluate((defaultImage) => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+\n/g, '\n').trim();

      // Prefer likely entry containers, but fall back to the largest non-navigation text block.
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

      // Trim obvious site chrome if the fallback was the full body.
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
        imgs.find(img => /1755|1773|default/i.test(img.src))?.src ||
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
  });
}

async function fetchJohnsonEntries(count = 5) {
  const entries = [];
  const seen = new Set();

  for (let i = 0; i < count && entries.length < count; i++) {
    try {
      const entry = await fetchOneJohnsonEntry(i);
      const key = entry.title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        entries.push(entry);
      }
    } catch (err) {
      console.error(`[JOHNSON] Entry ${i + 1} failed:`, err.message || err);
    }
  }

  return entries;
}

app.get('/api/articles', async (req, res) => {
  try {
    const now = Date.now();
    const force = String(req.query.force || '').toLowerCase();
    const bypass = force === '1' || force === 'true';

    if (!bypass && articleCache.length && (now - lastRefresh) < CACHE_DURATION) {
      return res.json({ articles: articleCache, cached: true, source: 'johnson' });
    }

    const articles = await fetchJohnsonEntries(5);

    if (!articles.length) {
      return res.status(502).json({
        error: 'Failed to fetch Johnson Dictionary entries. The upstream site may have changed its JavaScript or blocked automated access.'
      });
    }

    articleCache = articles;
    lastRefresh = now;
    return res.json({ articles, cached: false, source: 'johnson' });
  } catch (err) {
    console.error('[JOHNSON] /api/articles error:', err.message || err);
    return res.status(500).json({ error: 'Failed to fetch Johnson Dictionary entries' });
  }
});

app.get('/debug/johnson', async (req, res) => {
  try {
    const entry = await fetchOneJohnsonEntry(0);
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', cacheSize: articleCache.length, lastRefresh });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Johnson Dictionary Feed API is running' });
});

console.log(`[BOOT] Starting Johnson Dictionary Feed API... (node ${process.version})`);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] Listening on 0.0.0.0:${PORT}`);
});
