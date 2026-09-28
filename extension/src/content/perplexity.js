// Perplexity message extractor.
//
// As of late Sep 2026 a thread renders as one flat list with one wrapper
// slot per item — user query or answer:
//
//   <div class="flex flex-col gap-10 …">                           ← thread list
//     <div class="w-full"> …(unmounted: empty, fixed height)… </div>
//     <div class="w-full"><div class="w-full flex flex-col">
//       <div data-workflow-final-text class="group/final-text"> … <div class="prose">…</div>   ← answer
//     </div></div>
//     <div class="w-full"><div class="w-full flex flex-col">
//       <div class="group/partition" data-workflow-entry> <div data-workflow-items> <div>
//         <div class="contents"><div class="group/user-bubble">…</div></div>              ← user query
//     …
//   </div>
//
// Earlier layouts put the answer wrapper directly in the list (with query /
// steps / answer as sibling slots), which is why the list is located as the
// lowest common ancestor of every mounted query and answer rather than by a
// fixed number of parent hops. Hops broke once already: the answer's parent
// became a single-child wrapper and the extractor walked that instead,
// exporting one message.
//
// The list is virtualized: items away from the viewport are still present as
// slots but EMPTY. So we walk the list, scroll each empty slot into view,
// wait for it to mount, and harvest — the same approach as the ChatGPT
// extractor.
//
// Other quirks handled here:
//   - User bubbles carry a trailing timestamp ("1:43 PM") and Edit/Copy
//     buttons; long queries are CSS-clamped behind a "Read more" button but
//     the full text is in the DOM.
//   - Citations come in two shapes: <a href> (kept as links by markdown.js)
//     and <span data-pplx-citation data-pplx-citation-url> pills whose visible
//     text is "domain+1". We rewrite the pills to real links.

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const SELECTORS = {
    userBubble: '[class~="group/user-bubble"], [class~="group/query"]',
    answerWrap: '[data-workflow-final-text], [class~="group/final-text"]',
    answerBody: '.prose',
    citationPill: '[data-pplx-citation-url]',
    userTimestamp: '.absolute',                 // <span class="absolute right-0 top-full">1:43 PM</span>
    readMore: '[data-testid="toggle-query-expand-button"]',
  };

  const MOUNT_POLL_MS = 30;
  const MOUNT_TIMEOUT_MS = 4000;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function waitFor(predicate, timeoutMs = MOUNT_TIMEOUT_MS) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const v = predicate();
      if (v) return v;
      await sleep(MOUNT_POLL_MS);
    }
    return predicate();
  }

  function findThreadList() {
    const anchors = [
      ...document.querySelectorAll(SELECTORS.userBubble),
      ...document.querySelectorAll(SELECTORS.answerWrap),
    ];
    if (!anchors.length) return null;
    if (anchors.length > 1) {
      // Every query and answer lives in its own slot of the list, so the
      // lowest common ancestor of all of them is the list itself.
      let lca = anchors[0].parentElement;
      while (lca && !anchors.every(a => lca.contains(a))) lca = lca.parentElement;
      if (lca) return lca;
    }
    // A single mounted item (brand-new thread): climb out of the single-child
    // wrappers around it; the first ancestor with siblings is the slot, and
    // its parent is the list.
    let slot = anchors[0];
    while (slot.parentElement && slot.parentElement.children.length === 1 && slot.parentElement !== document.body) {
      slot = slot.parentElement;
    }
    return slot.parentElement;
  }

  function findScrollRoot(fromEl) {
    let el = fromEl;
    while (el) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Classify a list child. Returns 'user' | 'assistant' | 'steps' | 'empty'.
  function slotKind(slot) {
    if (!slot) return 'empty';
    if (slot.querySelector(SELECTORS.userBubble)) return 'user';
    if (slot.matches(SELECTORS.answerWrap) || slot.querySelector(SELECTORS.answerWrap)) {
      return slot.querySelector(SELECTORS.answerBody) ? 'assistant' : 'empty';
    }
    if (slot.classList.contains('contents') && !slot.querySelector(SELECTORS.userBubble)) return 'steps';
    return slot.textContent.trim() ? 'steps' : 'empty';
  }

  async function extractPerplexity() {
    const list = findThreadList();
    if (!list) {
      return makeConversation({ source: 'perplexity', title: getTitle(), url: location.href, sessionId: getSessionId(), messages: [] });
    }

    const currentList = () => (list.isConnected ? list : findThreadList() || list);
    const scrollRoot = findScrollRoot(list);
    const savedScroll = scrollRoot.scrollTop;
    const bySlot = new Map();   // slot index -> message

    function harvestAll() {
      const cur = currentList();
      Array.from(cur.children).forEach((slot, i) => {
        if (bySlot.has(i)) return;
        const kind = slotKind(slot);
        if (kind === 'user') {
          const msg = extractUser(slot.querySelector(SELECTORS.userBubble));
          if (msg) bySlot.set(i, msg);
        } else if (kind === 'assistant') {
          const msg = extractAssistant(slot.matches(SELECTORS.answerWrap) ? slot : slot.querySelector(SELECTORS.answerWrap));
          if (msg) bySlot.set(i, msg);
        }
      });
    }

    async function scrollSlotAndWait(i, block) {
      const slot = currentList().children[i];
      if (!slot) return false;
      slot.scrollIntoView({ block, behavior: 'auto' });
      scrollRoot.scrollTop += 1;
      const mounted = await waitFor(() => {
        const cur = currentList().children[i];
        const k = slotKind(cur);
        return k === 'user' || k === 'assistant' || k === 'steps';
      });
      harvestAll();
      return !!mounted;
    }

    harvestAll();

    const slotCount = list.children.length;
    const pending = i => !bySlot.has(i) && slotKind(currentList().children[i]) === 'empty';

    for (let i = 0; i < slotCount; i++) {
      if (pending(i)) await scrollSlotAndWait(i, 'start');
    }
    for (const block of ['center', 'end']) {
      const missed = [];
      for (let i = 0; i < slotCount; i++) if (pending(i)) missed.push(i);
      if (!missed.length) break;
      for (const i of missed) await scrollSlotAndWait(i, block);
    }

    let unmounted = 0;
    for (let i = 0; i < slotCount; i++) if (pending(i)) unmounted++;
    if (unmounted) {
      console.warn(`[DOM Daddy] Perplexity: ${unmounted} of ${slotCount} thread slots never mounted; export may be incomplete.`);
    }

    scrollRoot.scrollTop = savedScroll;

    const messages = [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);

    return makeConversation({
      source: 'perplexity',
      title: getTitle(),
      url: location.href,
      sessionId: getSessionId(),
      messages,
    });
  }

  function getSessionId() {
    // /search/{slug-or-uuid} — for slug threads this is "what-is-the-2QDzz06SQquIL5zD3uePgA"
    const m = location.pathname.match(/\/search\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function extractUser(bubble) {
    if (!bubble) return null;
    const clone = bubble.cloneNode(true);
    clone.querySelectorAll(`button, [role="button"], ${SELECTORS.readMore}, ${SELECTORS.userTimestamp}`).forEach(el => el.remove());
    const html = clone.innerHTML;
    // Queries are plain text rendered in whitespace-pre-line spans, so their
    // line breaks are literal newlines in textContent. markdown.js would
    // collapse them; take the text blocks directly instead. A quoted snippet
    // ("Qwen3.6-35B-A3B…" + "Find me this") renders as sibling blocks — join
    // them with a blank line.
    const BLOCK = '[class*="whitespace-pre"], [class*="pre-wrap"], [class*="border-l-"]';
    const blocks = [...clone.querySelectorAll(BLOCK)].filter(b => !b.parentElement.closest(BLOCK));
    let content = blocks.length
      ? blocks.map(b => {
          const text = b.textContent.replace(/[ \t]+\n/g, '\n').trim();
          if (!text) return '';
          // Quoted snippet (left-border block) → markdown blockquote.
          return /border-l-/.test(b.className) ? text.split('\n').map(l => `> ${l}`).join('\n') : text;
        }).filter(Boolean).join('\n\n')
      : htmlToMarkdown(clone);
    if (!content) content = (clone.textContent || '').trim();
    if (!content) return null;
    return makeMessage({ role: 'user', content, html });
  }

  function extractAssistant(wrap) {
    if (!wrap) return null;
    // Top-level .prose blocks only (never nested ones), joined in order.
    const bodies = [...wrap.querySelectorAll(SELECTORS.answerBody)].filter(p => !p.parentElement.closest(SELECTORS.answerBody));
    if (!bodies.length) return null;
    const clone = document.createElement('div');
    bodies.forEach(b => clone.appendChild(b.cloneNode(true)));
    stripJunk(clone);
    rewriteCitations(clone);
    const html = clone.innerHTML;
    const content = htmlToMarkdown(clone);
    if (!content) return null;
    return makeMessage({ role: 'assistant', content, html });
  }

  // <span data-pplx-citation-url="https://…">…qwen+1…</span>  →  <a href="https://…">qwen</a>
  function rewriteCitations(root) {
    root.querySelectorAll(SELECTORS.citationPill).forEach(pill => {
      const url = pill.getAttribute('data-pplx-citation-url');
      if (!url) return;
      let label = pill.textContent.replace(/\+\d+$/, '').trim();
      if (!label) { try { label = new URL(url).hostname.replace(/^www\./, ''); } catch { label = url; } }
      const a = root.ownerDocument.createElement('a');
      a.setAttribute('href', url);
      a.textContent = label;
      pill.replaceWith(a);
    });
  }

  function stripJunk(root) {
    // Code-block copy buttons, language indicators, and any other buttons
    // that sit inside .prose. Citation <a> tags are not buttons and survive.
    const junkSelectors = [
      '[data-testid="copy-code-button"]',
      '[data-testid="code-language-indicator"]',
      'button',
      '[role="button"]',
      'svg',
      // Tables carry an aria-hidden clone of their header row for the sticky
      // header; exporting it duplicates the header in Markdown.
      '[aria-hidden="true"]',
    ];
    junkSelectors.forEach(sel => {
      root.querySelectorAll(sel).forEach(el => el.remove());
    });
  }

  function getTitle() {
    const docTitle = document.title.replace(/\s*[-–|]\s*Perplexity\s*$/i, '').trim();
    return docTitle || 'Perplexity conversation';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      extractPerplexity()
        .then(conv => sendResponse({ ok: true, data: conv }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // async
    }
  });
})();
