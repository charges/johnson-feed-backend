// server.js - Johnson-O-Matic Backend v9
// Direct Johnson AJAX backend with structured entry parsing for frontend typography.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = 'johnson-backend-v10-compact-structured-content';

const BASE = 'https://johnsonsdictionaryonline.com';
const RANDOM_URL = `${BASE}/ajax/search_mysql_new.php`;
const DISPLAY_WORD_URL = `${BASE}/ajax/displayWord.php`;
const WORD_PAGE_URL = `${BASE}/views/word.php`;

function buildEntryUrl(year, permalink) {
  const y = String(year || '').match(/^(1755|1773)$/) ? String(year) : '1755';
  const p = String(permalink || '').trim();
  if (!p) return WORD_PAGE_URL;
  return `${BASE}/${y}/${encodeURIComponent(p)}`;
}

const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours
let articleCache = [];
let lastRefresh = 0;

app.use(cors());
app.use(express.json());

const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Johnson-O-Matic/1.0 (+https://charges.github.io/Johnson-O-Matic/)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': BASE,
    'Referer': WORD_PAGE_URL,
  },
});

function normalizeText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function basename(path) {
  return String(path || '').split('/').pop();
}

function inferYear(filename, fallback = '') {
  const m = String(filename || fallback || '').match(/f(1755|1773)-/);
  return m ? m[1] : '1755';
}

function inferLetterDirectory(filenameWithPath, headword = '') {
  const s = String(filenameWithPath || '');
  const direct = s.match(/^([A-Z])\//i);
  if (direct) return direct[1].toUpperCase();

  const hw = String(headword || '').trim();
  if (hw) return hw[0].toUpperCase();

  return 'A';
}

function titleFromParts(label, displayHtml, year) {
  const $ = cheerio.load(displayHtml || '');
  const htmlTitle = normalizeText($('title').first().text());
  if (htmlTitle) return htmlTitle.replace(/\s*\((1755|1773)\)\s*$/, ', $1');

  const cleanLabel = normalizeText(label);
  if (cleanLabel && year && !cleanLabel.includes(year)) return `${cleanLabel}${year ? `, ${year}` : ''}`;
  return cleanLabel || 'Johnson Dictionary Entry';
}


function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanJohnsonWord(s) {
  return normalizeText(s)
    .replace(/\s*\.\s*$/g, '.')
    .replace(/\s+/g, ' ');
}

function stripChildText($, el, selector) {
  const clone = $(el).clone();
  clone.find(selector).remove();
  return normalizeText(clone.text());
}

function compactForCard(s, max = 900) {
  let text = normalizeText(s);
  if (text.length > max) text = text.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return text || 'Dictionary entry from Samuel Johnson\'s Dictionary.';
}

function extractStructuredEntry(displayHtml, meta) {
  const $ = cheerio.load(displayHtml || '', { xmlMode: false, lowerCaseTags: false });
  $('script, style, title').remove();

  const entryWord =
    cleanJohnsonWord($('headword').first().text()) ||
    cleanJohnsonWord(meta?.label || meta?.headword || 'Johnson Dictionary Entry');

  // Frontend displays the year as a small index next to the entry word.
  // Do not repeat the label here, or cards read like "vetch, n.s.vetch, n.s., 1755".
  const entryIndex = String(meta?.year || '').trim();

  const grammar = normalizeText($('.gramGrp').first().text());
  const derivation = normalizeText($('span.etym, etym').first().text());

  const definitions = [];
  const senses = $('sense').toArray();

  senses.forEach((senseEl) => {
    const $sense = $(senseEl);
    let definition = normalizeText($sense.find('sjddef').first().text());

    if (!definition) {
      const senseTextNoExamples = stripChildText($, senseEl, 'quote, cit, bibl');
      definition = senseTextNoExamples;
    }

    const examples = [];
    $sense.find('quote').each((_, quoteEl) => {
      const quote = normalizeText($(quoteEl).text());
      if (!quote) return;

      const $cit = $(quoteEl).closest('cit');
      let citation = '';
      if ($cit.length) {
        const citClone = $cit.clone();
        citClone.find('quote').remove();
        citation = normalizeText(citClone.text());
      }

      if (!citation) {
        const nextBibl = $(quoteEl).nextAll('bibl, author, title').first().text();
        citation = normalizeText(nextBibl);
      }

      examples.push({ quote, citation });
    });

    if (definition || examples.length) {
      definitions.push({ definition, examples });
    }
  });

  // Fallback for entries whose transformed HTML lacks the expected TEI-ish tags.
  // Some one-line entries arrive without <sense>/<sjddef> structure, but the useful
  // text is still present in the transformed display HTML. Preserve that text rather
  // than falling back to the generic placeholder.
  if (!definitions.length) {
    let full = normalizeText($('body').text() || $.root().text());
    const removals = [
      /^Johnson's Dictionary Online\s*/i,
      new RegExp(escapeRegex(normalizeText(meta?.label || '')), 'i'),
      new RegExp(escapeRegex(normalizeText(entryWord || '')), 'i'),
      new RegExp(escapeRegex(normalizeText(grammar || '')), 'i'),
      new RegExp(escapeRegex(normalizeText(derivation || '')), 'i'),
      new RegExp(String(meta?.year || ''), 'i'),
    ];
    for (const r of removals) {
      if (r && String(r) !== '/(?:)/i') full = full.replace(r, ' ');
    }
    full = normalizeText(full);

    // If the fallback still begins with the entry label, trim only the duplicate prefix.
    const labelWords = normalizeText(meta?.label || '').replace(/,?\s*(1755|1773)$/i, '').trim();
    if (labelWords && full.toLowerCase().startsWith(labelWords.toLowerCase())) {
      full = normalizeText(full.slice(labelWords.length));
    }

    if (full) definitions.push({ definition: compactForCard(full, 900), examples: [] });
  }

  const extractParts = [];
  if (derivation) extractParts.push(derivation);
  definitions.forEach((d) => {
    if (d.definition) extractParts.push(d.definition);
    d.examples.slice(0, 2).forEach((e) => {
      extractParts.push(e.citation ? `${e.quote} — ${e.citation}` : e.quote);
    });
  });

  return {
    entryWord,
    entryIndex,
    grammar,
    derivation,
    definitions,
    plainText: compactForCard(extractParts.join('\n\n')),
  };
}

function extractFromDisplayHtml(displayHtml, meta) {
  return extractStructuredEntry(displayHtml, meta).plainText;
}

async function postForm(url, form) {
  const body = new URLSearchParams(form).toString();
  const resp = await http.post(url, body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  return resp.data;
}

async function fetchRandomMeta() {
  const data = await postForm(RANDOM_URL, {
    searchterm: '',
    query: 'random',
    searchYear: '',
  });

  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  const filenameWithPath = parsed?.filenames?.[0];
  if (!filenameWithPath) throw new Error('Johnson random endpoint returned no filename');

  const filename = basename(filenameWithPath);
  const year = inferYear(filename);
  const letter = inferLetterDirectory(filenameWithPath, parsed?.headwords?.[0]);

  return {
    raw: parsed,
    filenameWithPath,
    filename,
    year,
    letter,
    label: parsed?.labels?.[0] || parsed?.headwords?.[0] || filename.replace(/\.xml$/i, ''),
    headword: parsed?.headwords?.[0] || '',
    permalink: parsed?.permalinks?.[0] || '',
    pageimage: parsed?.pageimages?.[0] || '',
  };
}

async function fetchDisplayWord(meta) {
  const directory = `/db/apps/sjd/data/${meta.year}/${meta.letter}`;
  return await postForm(DISPLAY_WORD_URL, {
    query: 'display-word.xq',
    directory,
    folio: meta.year,
    ip: '',
    filename: meta.filename,
  });
}

async function fetchJohnsonEntry(index = 0) {
  const meta = await fetchRandomMeta();
  const displayHtml = await fetchDisplayWord(meta);

  const title = titleFromParts(meta.label, displayHtml, meta.year);
  const structured = extractStructuredEntry(displayHtml, meta);
  const extract = structured.plainText;
  const imageBase = meta.filename.replace(/\.xml$/i, '.png');

  return {
    id: `johnson-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
    title,
    extract,
    structured,
    thumbnail: `${BASE}/img/words/${imageBase}`,
    pageImage: meta.pageimage ? `${BASE}/img/page-images/${meta.pageimage}` : null,
    url: buildEntryUrl(meta.year, meta.permalink),
    randomUrl: WORD_PAGE_URL,
    type: 'Dictionary Entry',
    readTime: Math.max(1, Math.ceil((extract.split(/\s+/).length || 100) / 200)),
    category: 'dictionary',
    source: "Johnson's Dictionary Online",
    johnson: {
      filename: meta.filename,
      year: meta.year,
      letter: meta.letter,
      headword: meta.headword,
      permalink: meta.permalink,
    },
  };
}

async function fetchJohnsonEntries(count = 5) {
  const entries = [];
  const seen = new Set();
  let attempts = 0;

  while (entries.length < count && attempts < count * 3) {
    attempts += 1;
    try {
      const entry = await fetchJohnsonEntry(entries.length);
      const key = entry?.johnson?.filename || entry.title;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push(entry);
      }
    } catch (err) {
      console.error('[Johnson] entry fetch failed:', err?.message || err);
    }
  }

  if (!entries.length) throw new Error('No Johnson entries could be fetched');
  return entries;
}

app.get('/api/articles', async (req, res) => {
  try {
    const now = Date.now();
    const force = ['1', 'true', 'yes'].includes(String(req.query.force || '').toLowerCase());

    if (!force && articleCache.length && (now - lastRefresh) < CACHE_DURATION) {
      return res.json({ articles: articleCache, cached: true, version: VERSION });
    }

    const articles = await fetchJohnsonEntries(5);
    articleCache = articles;
    lastRefresh = Date.now();

    return res.json({ articles, cached: false, version: VERSION });
  } catch (err) {
    console.error('[api/articles] error:', err?.message || err);
    if (articleCache.length) {
      return res.json({ articles: articleCache, cached: true, stale: true, version: VERSION });
    }
    return res.status(500).json({
      error: 'Failed to fetch Johnson Dictionary entries from direct AJAX endpoints.',
      detail: err?.message || String(err),
      version: VERSION,
    });
  }
});

app.get('/debug/johnson', async (req, res) => {
  const started = Date.now();
  try {
    const meta = await fetchRandomMeta();
    const displayHtml = await fetchDisplayWord(meta);
    const entry = await fetchJohnsonEntry(0);
    return res.json({
      ok: true,
      version: VERSION,
      elapsedMs: Date.now() - started,
      meta,
      displaySample: normalizeText(cheerio.load(displayHtml).text()).slice(0, 500),
      entry,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      version: VERSION,
      elapsedMs: Date.now() - started,
      error: err?.message || String(err),
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: VERSION,
    cacheSize: articleCache.length,
    lastRefresh,
    cacheAgeMs: lastRefresh ? Date.now() - lastRefresh : null,
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Johnson-O-Matic API is running', version: VERSION });
});

console.log(`[BOOT] Starting Johnson-O-Matic API ${VERSION}... (node ${process.version})`);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] Listening on 0.0.0.0:${PORT}`);
});
