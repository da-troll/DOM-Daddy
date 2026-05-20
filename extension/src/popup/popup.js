import {
  exportMarkdown,
  exportText,
  exportJSON,
  exportCSV,
  exportProfileMarkdown,
  exportProfileJSON,
  exportProfileCSV,
} from '../exporters/exporters.js';
import { prettySource } from '../lib/schema.js';

// Site registry: hostname → { source, kind, content script path, optional pageReady check }.
// pageReady gates extraction so we can show actionable hints (e.g. "open the
// experience details page first" for LinkedIn) instead of a generic error.
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
    pageHint: 'Open the Experience details page (Profile → Show all experience).',
    pageHintAction: (url) => {
      const m = new URL(url).pathname.match(/^\/in\/([^/]+)/);
      return m ? `https://www.linkedin.com/in/${m[1]}/details/experience/` : null;
    },
  },
};

const els = {
  status: document.getElementById('status'),
  metaTitle: document.getElementById('meta-title'),
  metaSub: document.getElementById('meta-sub'),
  options: document.getElementById('options'),
  formats: document.getElementById('formats'),
  optReasoning: document.getElementById('opt-reasoning'),
  defaultFmt: document.getElementById('default-fmt'),
  fmtTxt: document.querySelector('button.fmt[data-format="txt"]'),
  hint: document.getElementById('hint'),
  hintAction: document.getElementById('hint-action'),
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
    setStatus('Open a supported site (ChatGPT, Claude, Gemini, AI Studio, Perplexity, LinkedIn).', 'ok');
    return;
  }
  cachedSite = site;

  if (site.pageReady && !site.pageReady(tab.url)) {
    setStatus('Wrong page', 'error');
    showHint(site.pageHint, site.pageHintAction?.(tab.url));
    return;
  }

  setStatus(site.kind === 'profile' ? 'Reading profile…' : 'Reading conversation…');

  try {
    const data = await requestExtraction(tab.id, site);
    if (!isUseful(data, site.kind)) {
      setStatus('Nothing to export on this page.', 'error');
      return;
    }
    cachedData = data;
    populateMeta(data, site);
    configureUI(site);
    els.formats.hidden = false;
    setStatus('Ready', 'ok');
    els.defaultFmt?.focus();
  } catch (err) {
    setStatus('Could not read this page. Reload and try again.', 'error');
    console.error(err);
  }

  els.formats.addEventListener('click', onFormatClick);
}

function isUseful(data, kind) {
  if (!data) return false;
  if (kind === 'conversation') return !!data.messages?.length;
  if (kind === 'profile') return !!data.experiences?.length;
  return false;
}

function populateMeta(data, site) {
  if (site.kind === 'conversation') {
    els.metaTitle.textContent = data.title;
    els.metaTitle.title = data.title;
    const n = data.messages.length;
    els.metaSub.textContent = `${n} message${n === 1 ? '' : 's'} · ${prettySource(data.source)}`;
  } else {
    els.metaTitle.textContent = data.name || 'Profile';
    els.metaTitle.title = data.name || '';
    const companies = data.experiences.length;
    const roles = data.experiences.reduce((s, e) => s + (e.roles?.length || 0), 0);
    els.metaSub.textContent = `${companies} compan${companies === 1 ? 'y' : 'ies'} · ${roles} role${roles === 1 ? '' : 's'} · ${prettySource(data.source)}`;
  }
  els.metaTitle.hidden = false;
  els.metaSub.hidden = false;
}

function configureUI(site) {
  if (site.kind === 'profile') {
    // No "reasoning" toggle and no Text format for profiles.
    els.options.hidden = true;
    if (els.fmtTxt) els.fmtTxt.hidden = true;
  } else {
    els.options.hidden = false;
    if (els.fmtTxt) els.fmtTxt.hidden = false;
  }
}

function showHint(text, actionUrl) {
  if (!els.hint) return;
  els.hint.textContent = text || '';
  els.hint.hidden = !text;
  if (els.hintAction) {
    if (actionUrl) {
      els.hintAction.hidden = false;
      els.hintAction.onclick = () => chrome.tabs.update(cachedTab.id, { url: actionUrl });
    } else {
      els.hintAction.hidden = true;
    }
  }
}

async function onFormatClick(e) {
  const btn = e.target.closest('button.fmt');
  if (!btn || !cachedData || !cachedSite) return;

  const format = btn.dataset.format;

  // Re-extract on each export so users get the live state, not a stale snapshot.
  // Sites whose extraction is destructive to the page (e.g. AI Studio, where
  // we must scroll the chat top→bottom to defeat virtualization) opt out via
  // `refreshOnExport: false` and reuse the snapshot taken when the popup opened.
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
      case 'json': return exportProfileJSON(data);
      case 'csv':  return exportProfileCSV(data);
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
}
