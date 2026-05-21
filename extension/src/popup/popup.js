import {
  exportMarkdown,
  exportText,
  exportJSON,
  exportCSV,
  exportProfileMarkdown,
  exportProfileText,
  exportProfileJSON,
  exportProfileCSV,
  exportArticleMarkdown,
  exportArticleText,
  exportArticleJSON,
  exportArticleCSV,
} from '../exporters/exporters.js';
import { prettySource } from '../lib/schema.js';

// Site registry: hostname → { source, kind, content script path, optional pageReady check }.
// pageReady gates extraction so we can show actionable hints (e.g. "open the
// experience details page first" for LinkedIn) instead of a generic error.
//
// Hosts NOT in this registry fall through to RawMode (generic extraction via
// vendored Defuddle + tiered fallbacks). RawMode treats the page as
// `kind: 'article'` and reuses the four format buttons.
const SITES = {
  'chatgpt.com':         { source: 'chatgpt',    kind: 'conversation', script: 'src/content/chatgpt.js' },
  'chat.openai.com':     { source: 'chatgpt',    kind: 'conversation', script: 'src/content/chatgpt.js' },
  'claude.ai':           { source: 'claude',     kind: 'conversation', script: 'src/content/claude.js' },
  'gemini.google.com':   { source: 'gemini',     kind: 'conversation', script: 'src/content/gemini.js' },
  'aistudio.google.com': { source: 'aistudio',   kind: 'conversation', script: 'src/content/aistudio.js', refreshOnExport: false },
  'www.perplexity.ai':   { source: 'perplexity', kind: 'conversation', script: 'src/content/perplexity.js' },
  'perplexity.ai':       { source: 'perplexity', kind: 'conversation', script: 'src/content/perplexity.js' },
  'www.linkedin.com':    {
    source: 'linkedin',
    kind: 'profile',
    script: 'src/content/linkedin.js',
    pageReady: (url) => /^\/in\/[^/]+\/details\/experience\/?$/.test(new URL(url).pathname),
    // pageHint is a function of `actionUrl` — when there's no slug in the URL
    // (e.g. /feed/) we can't build a "take me there" link, so the copy must
    // tell the user to navigate manually first.
    pageHint: (actionUrl) => actionUrl
      ? [
          { text: 'DOM Daddy only grabs the ' },
          { text: 'Experience details', italic: true },
          { text: ' page. Click below to navigate there.' },
        ]
      : [
          { text: 'DOM Daddy only grabs the ' },
          { text: 'Experience details', italic: true },
          { text: " page. Navigate to a person's profile page and re-open DOM Daddy to initiate an export." },
        ],
    pageHintAction: (url) => {
      const m = new URL(url).pathname.match(/^\/in\/([^/]+)/);
      return m ? `https://www.linkedin.com/in/${m[1]}/details/experience/` : null;
    },
  },
};

// Synthetic site entry for RawMode — used as `cachedSite` after Analyze.
const RAWMODE_SITE = {
  source: 'rawmode',
  kind: 'article',
  script: 'src/content/rawmode.js',
  refreshOnExport: false,
};

const els = {
  status:       document.getElementById('status'),
  metaTitle:    document.getElementById('meta-title'),
  metaSub:      document.getElementById('meta-sub'),
  options:      document.getElementById('options'),
  formats:      document.getElementById('formats'),
  optReasoning: document.getElementById('opt-reasoning'),
  defaultFmt:   document.getElementById('default-fmt'),
  analyzeBtn:   document.getElementById('analyze-btn'),
  fmtTxt:       document.querySelector('button.fmt[data-format="txt"]'),
  fmtJson:      document.querySelector('button.fmt[data-format="json"]'),
  fmtCsv:       document.querySelector('button.fmt[data-format="csv"]'),
  hint:         document.getElementById('hint'),
  hintAction:   document.getElementById('hint-action'),
};

let cachedData = null;
let cachedSite = null;
let cachedTab = null;

init();

async function init() {
  const tab = await getActiveTab();
  cachedTab = tab;
  if (!tab?.url) {
    setStatus('No active tab', 'error');
    return;
  }

  let host;
  try { host = new URL(tab.url).hostname; }
  catch { host = ''; }

  const site = SITES[host];

  if (!site) {
    // Unsupported host → RawMode.
    await initRawMode(tab);
    els.formats.addEventListener('click', onFormatClick);
    els.analyzeBtn?.addEventListener('click', onAnalyzeClick);
    return;
  }

  cachedSite = site;
  setStatus(`Detected: ${prettySource(site.source)}`, 'detect');

  if (site.pageReady && !site.pageReady(tab.url)) {
    // Wrong-page branch: force-hide formats + options so they can't bleed
    // through under the hint, and show the hint with action. pageHint can be
    // a function that adapts copy based on whether we have an actionable URL.
    hideExportUI();
    const actionUrl = site.pageHintAction?.(tab.url);
    const hint = typeof site.pageHint === 'function' ? site.pageHint(actionUrl) : site.pageHint;
    showHint(hint, actionUrl, site);
    els.formats.addEventListener('click', onFormatClick);
    return;
  }

  await runExtractionFlow(tab, site);
  els.formats.addEventListener('click', onFormatClick);
}

async function runExtractionFlow(tab, site) {
  try {
    // For profile pages (LinkedIn) the experience list hydrates AFTER the
    // page-load event, so a one-shot extraction can land on an empty DOM.
    // Poll with short retries until the entries appear or we time out.
    const data = site.kind === 'profile'
      ? await extractWithRetry(tab.id, site, { maxAttempts: 12, intervalMs: 500 })
      : await requestExtraction(tab.id, site);
    if (!isUseful(data, site.kind)) {
      setStatus('Nothing to export on this page', 'error');
      return;
    }
    cachedData = data;
    populateMeta(data, site);
    configureUI(site);
    revealFormatButtons();
    els.defaultFmt?.focus();
  } catch (err) {
    setStatus('Could not read this page', 'error');
    console.error(err);
  }
}

// ---------- RawMode ----------

async function initRawMode(tab) {
  setStatus('Unsupported site – RawMode Active', 'raw');
  cachedSite = RAWMODE_SITE;

  // Try to restore a cached analysis for this exact tab+url so re-opening the
  // popup on the same page skips the Analyze step.
  const cached = await sessionGet(rawmodeKey(tab));
  if (cached && isUseful(cached, 'article')) {
    cachedData = cached;
    populateMeta(cached, RAWMODE_SITE);
    configureUI(RAWMODE_SITE);
    revealFormatButtons();
    return;
  }

  // No cache → show the single Analyze Page button spanning both grid columns.
  els.formats.hidden = false;
  els.analyzeBtn.hidden = false;
}

async function onAnalyzeClick() {
  if (!cachedTab?.id) return;

  els.analyzeBtn.disabled = true;
  setStatus('Analyzing…');

  try {
    const data = await injectAndExtract(cachedTab.id, RAWMODE_SITE.script);
    if (!isUseful(data, 'article')) {
      setStatus('Nothing to extract on this page', 'error');
      els.analyzeBtn.disabled = false;
      return;
    }
    cachedData = data;
    await sessionSet(rawmodeKey(cachedTab), data);
    populateMeta(data, RAWMODE_SITE);
    configureUI(RAWMODE_SITE);
    els.analyzeBtn.hidden = true;
    revealFormatButtons();
    setStatus(`Detected: ${data.hostname || 'page'} · RawMode`, 'detect');
    els.defaultFmt?.focus();
  } catch (err) {
    const msg = String(err?.message || err);
    if (/cannot access|chrome:|chrome-extension:|edge:/i.test(msg)) {
      setStatus("Can't analyze this page", 'error');
    } else {
      setStatus('Analysis failed', 'error');
    }
    els.analyzeBtn.disabled = false;
    console.error(err);
  }
}

function rawmodeKey(tab) {
  return `rawmode:${tab.id}:${tab.url}`;
}

async function injectAndExtract(tabId, file) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  return await sendExtractMessage(tabId);
}

async function sessionGet(key) {
  try {
    const out = await chrome.storage.session.get(key);
    return out?.[key] || null;
  } catch { return null; }
}

async function sessionSet(key, value) {
  try { await chrome.storage.session.set({ [key]: value }); }
  catch { /* non-fatal */ }
}

// ---------- UI helpers ----------

function isUseful(data, kind) {
  if (!data) return false;
  if (kind === 'conversation') return !!data.messages?.length;
  if (kind === 'profile')      return !!data.experiences?.length;
  if (kind === 'article')      return !!data.content;
  return false;
}

function populateMeta(data, site) {
  if (site.kind === 'conversation') {
    els.metaTitle.textContent = data.title;
    els.metaTitle.title = data.title;
    const n = data.messages.length;
    els.metaSub.textContent = `${n} message${n === 1 ? '' : 's'} · ${prettySource(data.source)}`;
  } else if (site.kind === 'profile') {
    els.metaTitle.textContent = data.name || 'Profile';
    els.metaTitle.title = data.name || '';
    const companies = data.experiences.length;
    const roles = data.experiences.reduce((s, e) => s + (e.roles?.length || 0), 0);
    els.metaSub.textContent = `${companies} compan${companies === 1 ? 'y' : 'ies'} · ${roles} role${roles === 1 ? '' : 's'} · ${prettySource(data.source)}`;
  } else if (site.kind === 'article') {
    els.metaTitle.textContent = data.title || 'Untitled';
    els.metaTitle.title = data.title || '';
    const wc = data.wordCount || 0;
    const tierLabel = data.extractorTier ? ` (${data.extractorTier})` : '';
    els.metaSub.textContent = `${wc.toLocaleString()} words · ${data.hostname || ''} · ${prettySource(data.source)}${tierLabel}`;
  }
  els.metaTitle.hidden = false;
  els.metaSub.hidden = false;
}

function configureUI(site) {
  // Reasoning checkbox: only for conversations (chats with thinking blocks).
  // Hidden for both profile (LinkedIn) and article (RawMode).
  els.options.hidden = site.kind !== 'conversation';
}

function revealFormatButtons() {
  els.formats.hidden = false;
  if (els.analyzeBtn) els.analyzeBtn.hidden = true;
  if (els.defaultFmt) els.defaultFmt.hidden = false;
  if (els.fmtTxt)     els.fmtTxt.hidden = false;
  if (els.fmtJson)    els.fmtJson.hidden = false;
  if (els.fmtCsv)     els.fmtCsv.hidden = false;
}

function hideExportUI() {
  els.formats.hidden = true;
  els.options.hidden = true;
  if (els.analyzeBtn) els.analyzeBtn.hidden = true;
  if (els.defaultFmt) els.defaultFmt.hidden = true;
  if (els.fmtTxt)     els.fmtTxt.hidden = true;
  if (els.fmtJson)    els.fmtJson.hidden = true;
  if (els.fmtCsv)     els.fmtCsv.hidden = true;
}

function showHint(hint, actionUrl, site) {
  if (!els.hint) return;
  // Clear and rebuild — never set innerHTML from a string.
  els.hint.replaceChildren();
  if (!hint) {
    els.hint.hidden = true;
  } else if (Array.isArray(hint)) {
    for (const tok of hint) {
      if (tok.italic) {
        const em = document.createElement('em');
        em.textContent = tok.text || '';
        els.hint.appendChild(em);
      } else {
        els.hint.appendChild(document.createTextNode(tok.text || ''));
      }
    }
    els.hint.hidden = false;
  } else {
    els.hint.textContent = String(hint);
    els.hint.hidden = false;
  }

  if (els.hintAction) {
    if (actionUrl) {
      els.hintAction.hidden = false;
      // Chrome action popups close when the active tab navigates — a hard
      // platform constraint, no workaround. Background-tab + extract-then-
      // close fails because LinkedIn defers React hydration on inactive tabs.
      // So: just navigate. Popup closes; when the user re-opens it on the
      // loaded experience page, init() picks up automatically and (with the
      // hydration-retry below) reliably finds the experience entries.
      els.hintAction.onclick = () => chrome.tabs.update(cachedTab.id, { url: actionUrl });
    } else {
      els.hintAction.hidden = true;
    }
  }
}

async function extractWithRetry(tabId, site, { maxAttempts = 12, intervalMs = 500 } = {}) {
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const data = await requestExtraction(tabId, site);
      if (isUseful(data, site.kind)) return data;
      last = data;
    } catch (err) {
      // Content script may not yet be ready; requestExtraction's fallback
      // re-injects, but the SPA itself may still be hydrating. Keep retrying.
      console.debug('[DOM Daddy] extract attempt', i + 1, 'failed:', err);
    }
    if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return last;
}

// ---------- Format-click + downloads ----------

async function onFormatClick(e) {
  const btn = e.target.closest('button.fmt');
  if (!btn || !cachedData || !cachedSite) return;
  if (btn.id === 'analyze-btn') return; // analyze has its own handler

  const format = btn.dataset.format;

  if (cachedSite.refreshOnExport !== false) {
    try {
      const fresh = await requestExtraction(cachedTab.id, cachedSite);
      if (isUseful(fresh, cachedSite.kind)) cachedData = fresh;
    } catch { /* fall through with cached version */ }
  }

  const result = runExport(cachedData, cachedSite.kind, format);
  if (!result) return;

  const outcome = await downloadBlob(result.filename, result.blob);
  if (outcome.saved) {
    setStatus(`Saved ${outcome.filename || result.filename}`, 'ok');
  } else if (outcome.canceled) {
    setStatus('Canceled', 'ok');
  } else {
    setStatus('Download failed', 'error');
  }
}

function runExport(data, kind, format) {
  if (kind === 'conversation') {
    const opts = { includeReasoning: els.optReasoning?.checked };
    switch (format) {
      case 'md':   return exportMarkdown(data, opts);
      case 'txt':  return exportText(data);
      case 'json': return exportJSON(data);
      case 'csv':  return exportCSV(data);
    }
  } else if (kind === 'profile') {
    switch (format) {
      case 'md':   return exportProfileMarkdown(data);
      case 'txt':  return exportProfileText(data);
      case 'json': return exportProfileJSON(data);
      case 'csv':  return exportProfileCSV(data);
    }
  } else if (kind === 'article') {
    switch (format) {
      case 'md':   return exportArticleMarkdown(data);
      case 'txt':  return exportArticleText(data);
      case 'json': return exportArticleJSON(data);
      case 'csv':  return exportArticleCSV(data);
    }
  }
  return null;
}

async function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
    if (typeof downloadId !== 'number') {
      return { saved: false, canceled: true };
    }
    return await waitForDownload(downloadId);
  } catch (err) {
    const msg = String(err?.message || err).toLowerCase();
    if (msg.includes('cancel')) return { saved: false, canceled: true };
    console.error(err);
    return { saved: false, canceled: false };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function waitForDownload(downloadId) {
  return new Promise(resolve => {
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        chrome.downloads.search({ id: downloadId }, (items) => {
          const final = items?.[0]?.filename || '';
          const base = final.split(/[/\\]/).pop() || '';
          resolve({ saved: true, filename: base });
        });
      } else if (delta.state?.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        const reason = delta.error?.current || '';
        const canceled = /USER_CANCELED|CANCELED/i.test(reason);
        resolve({ saved: false, canceled });
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function requestExtraction(tabId, site) {
  try {
    return await sendExtractMessage(tabId);
  } catch (err) {
    // Likely the content script wasn't injected yet (extension installed
    // after the tab was already open). Inject programmatically and retry.
    if (!site?.script) throw err;
    await chrome.scripting.executeScript({ target: { tabId }, files: [site.script] });
    return await sendExtractMessage(tabId);
  }
}

function sendExtractMessage(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'EXTRACT' }, (resp) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) return reject(new Error(lastErr.message));
      if (!resp?.ok) return reject(new Error(resp?.error || 'extraction failed'));
      resolve(resp.data);
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = 'status' + (kind ? ` status--${kind}` : '');
  els.status.title = text; // tooltip in case it ellipsis-truncates
}
