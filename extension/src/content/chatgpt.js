// ChatGPT message extractor.
//
// ChatGPT virtualizes the thread, and (as of Sep 2026) the [data-turn]
// anchors are NOT persistent any more. The thread list holds one child per
// turn ("slot"):
//
//   <div>                                                ← turn list
//     <div style="--last-known-height:…; --estimated-turn-height:…"></div>  ← off-screen turn: EMPTY placeholder
//     …
//     <div data-turn-id-container="…" data-is-intersecting="true">          ← mounted turn
//       <section data-turn="user|assistant" data-testid="conversation-turn-N">
//         <div data-message-author-role="…" data-message-id="…">…</div>
//       </section>
//     </div>
//   </div>
//
// Only the handful of turns near the viewport carry [data-turn]; everything
// else is a sized placeholder. Snapshotting [data-turn] therefore yields only
// the last few turns. Instead we walk the slots top→bottom, scroll each
// placeholder into view, wait for it to mount, harvest, and move on. Slots
// are re-fetched by index on every poll because React swaps the element.

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const SELECTORS = {
    turnAnchor: '[data-turn]',
    messageNode: '[data-message-author-role]',
    roleAttr: 'data-message-author-role',
    messageIdAttr: 'data-message-id',
    messageContent: '.markdown, [data-message-content], .text-message',
    activeChatTitle: 'nav a[data-active="true"], nav [aria-current="page"]',
    reasoningBlock: '[data-testid="reasoning"], [data-message-author-role="tool"]',
    turnContainer: '[data-turn-id-container]',
    scrollRoot: '[data-scroll-root]',
    fileChip: 'button',                        // filtered by FILENAME_RE below
  };

  const MOUNT_POLL_MS = 30;
  const MOUNT_TIMEOUT_MS = 4000;   // long turns (30k chars of markdown) measured at ~2.1s to mount
  const PLACEHOLDER_RE = /--(?:estimated-turn|last-known)-height/;
  const FILENAME_RE = /^[^\s/\\]+\.[a-z0-9]{1,8}$/i;   // "spec.md", "pkg-v1.0.zip"

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitFor(predicate, timeoutMs = MOUNT_TIMEOUT_MS, intervalMs = MOUNT_POLL_MS) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const v = predicate();
      if (v) return v;
      await sleep(intervalMs);
    }
    return predicate();
  }

  // The thread list: parent of the per-turn slots. Found via any mounted turn.
  function findTurnList() {
    const mounted = document.querySelector(SELECTORS.turnContainer)
                 || document.querySelector(SELECTORS.turnAnchor);
    if (!mounted) return null;
    const slot = mounted.closest(SELECTORS.turnContainer) || mounted;
    return slot.parentElement;
  }

  function findScrollRoot(fromEl) {
    const explicit = document.querySelector(SELECTORS.scrollRoot);
    if (explicit) return explicit;
    let el = fromEl;
    while (el) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // A slot is "live" if it's a mounted turn or a sized placeholder. Anything
  // else (the floating scroll button wrapper at slot 0, empty divs for
  // hidden/errored turns) is skipped without waiting on it.
  function slotIsLive(slot) {
    if (!slot) return false;
    if (slot.querySelector(SELECTORS.turnAnchor)) return true;
    return PLACEHOLDER_RE.test(slot.getAttribute('style') || '');
  }

  function turnIndexOf(anchor) {
    const m = (anchor?.getAttribute('data-testid') || '').match(/conversation-turn-(\d+)/);
    return m ? Number(m[1]) : null;
  }

  async function extractChatGPT() {
    const list = findTurnList();

    // Fallback: no recognisable thread list — use whatever message nodes are
    // mounted (older ChatGPT layouts, edge cases).
    if (!list) {
      const nodes = Array.from(document.querySelectorAll(SELECTORS.messageNode));
      const messages = nodes.map(extractMessage).filter(Boolean);
      return makeConversation({
        source: 'chatgpt',
        title: getTitle(),
        url: location.href,
        sessionId: getSessionId(),
        messages,
      });
    }

    const scrollRoot = findScrollRoot(list);
    const savedScroll = scrollRoot.scrollTop;
    const savedWindowScroll = window.scrollY;

    const byId = new Map();        // data-message-id -> { msg, sort }
    const byIndex = new Map();     // synthetic index -> { msg, sort }
    const order = [];              // insertion order { kind: 'id'|'idx', key }
    let syntheticIdx = 0;

    function collect(node, sort) {
      const msg = extractMessage(node);
      if (!msg) return;
      const id = node.getAttribute(SELECTORS.messageIdAttr);
      if (id) {
        if (byId.has(id)) return;
        byId.set(id, { msg, sort });
        order.push({ kind: 'id', key: id });
      } else {
        const key = `idx-${syntheticIdx++}`;
        byIndex.set(key, { msg, sort });
        order.push({ kind: 'idx', key });
      }
    }

    // Harvest every message node inside a slot. ChatGPT sometimes splits one
    // turn into multiple [data-message-author-role] nodes (preamble +
    // reasoning + final answer), so we take all of them.
    function harvestSlot(slot, slotIdx) {
      const anchor = slot.querySelector(SELECTORS.turnAnchor);
      if (!anchor) return false;
      const sortBase = turnIndexOf(anchor) ?? slotIdx;
      const nodes = anchor.querySelectorAll(SELECTORS.messageNode);
      nodes.forEach((n, j) => collect(n, sortBase + j / 1000));
      return nodes.length > 0;
    }

    // Harvest every currently-mounted turn in the list, whatever slot it is
    // in. Called before we scroll at all (so turns mounted at the start are
    // never lost when scrolling unmounts them) and after every mount wait
    // (so transiently-mounted neighbours are caught too).
    const harvested = new Set();   // slot indices already harvested
    function harvestAll() {
      const cur = findTurnList();
      if (!cur) return;
      Array.from(cur.children).forEach((slot, idx) => {
        if (harvested.has(idx)) return;
        if (harvestSlot(slot, idx)) harvested.add(idx);
      });
    }

    async function scrollSlotAndWait(i, block) {
      const slot = findTurnList()?.children[i];
      if (!slot) return false;
      slot.scrollIntoView({ block, behavior: 'auto' });
      // Nudge the scroll root so a scroll event fires even if scrollIntoView
      // was a no-op (e.g. already at the exact position).
      scrollRoot.scrollTop += 1;
      const mounted = await waitFor(() => {
        const cur = findTurnList()?.children[i];
        return cur && cur.querySelector(SELECTORS.turnAnchor);
      });
      harvestAll();
      return !!mounted;
    }

    harvestAll();

    const slotCount = list.children.length;
    for (let i = 0; i < slotCount; i++) {
      if (harvested.has(i)) continue;
      if (!slotIsLive(list.children[i])) continue;
      await scrollSlotAndWait(i, 'start');
    }

    // Retry pass: anything live that still hasn't mounted gets a second and
    // third chance with a centred scroll — ChatGPT's virtualizer occasionally
    // misses a placeholder that lands right at the top edge.
    for (const block of ['center', 'end']) {
      const missed = [];
      for (let i = 0; i < slotCount; i++) {
        const slot = findTurnList()?.children[i];
        if (!harvested.has(i) && slotIsLive(slot)) missed.push(i);
      }
      if (!missed.length) break;
      for (const i of missed) await scrollSlotAndWait(i, block);
    }

    let unmounted = 0;
    for (let i = 0; i < slotCount; i++) {
      if (!harvested.has(i) && slotIsLive(findTurnList()?.children[i])) unmounted++;
    }
    if (unmounted) {
      // Turns that never mounted (hidden tab? throttled rendering?) are lost —
      // say so loudly rather than silently exporting a shorter chat.
      console.warn(`[DOM Daddy] ChatGPT: ${unmounted} of ${slotCount} turn slots never mounted; export may be incomplete.`);
    }

    // Brute-force safety net: any message node we never reached (split shapes
    // we haven't seen, content outside the list, etc.) gets appended in DOM
    // order so the export is honest even when our slot walk misses.
    document.querySelectorAll(SELECTORS.messageNode).forEach(node => {
      const id = node.getAttribute(SELECTORS.messageIdAttr);
      if (id && byId.has(id)) return;
      collect(node, Number.MAX_SAFE_INTEGER);
    });

    // Restore the user's scroll position.
    scrollRoot.scrollTop = savedScroll;
    window.scrollTo({ top: savedWindowScroll, behavior: 'auto' });

    const entries = order
      .map(o => o.kind === 'id' ? byId.get(o.key) : byIndex.get(o.key))
      .filter(Boolean);
    // Stable sort by turn index (from data-testid="conversation-turn-N") so the
    // export is in conversation order even if the safety net appended extras.
    const messages = entries
      .map((e, i) => ({ ...e, i }))
      .sort((a, b) => (a.sort - b.sort) || (a.i - b.i))
      .map(e => e.msg);

    return makeConversation({
      source: 'chatgpt',
      title: getTitle(),
      url: location.href,
      sessionId: getSessionId(),
      messages,
    });
  }

  function getSessionId() {
    // /c/{uuid} or /g/g-xxx/c/{uuid}
    const m = location.pathname.match(/\/c\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function extractMessage(node) {
    const role = node.getAttribute(SELECTORS.roleAttr);
    if (!role || (role !== 'user' && role !== 'assistant' && role !== 'system')) return null;

    const id = node.getAttribute(SELECTORS.messageIdAttr) || undefined;
    const contentEl = node.querySelector(SELECTORS.messageContent) || node;

    const reasoningEl = node.querySelector(SELECTORS.reasoningBlock);
    let reasoning;
    if (reasoningEl && reasoningEl !== contentEl) {
      reasoning = htmlToMarkdown(reasoningEl.cloneNode(true));
    }

    const clone = contentEl.cloneNode(true);
    stripJunk(clone);
    if (reasoningEl) {
      clone.querySelectorAll(SELECTORS.reasoningBlock).forEach(el => el.remove());
    }

    const html = clone.innerHTML;
    const content = htmlToMarkdown(clone);
    const attachments = extractAttachments(node);

    return makeMessage({ id, role, content, html, reasoning, attachments });
  }

  function extractAttachments(node) {
    const out = [];
    node.querySelectorAll('[data-testid*="attachment"], [data-attachment]').forEach(el => {
      const name = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 100);
      if (name) out.push({ name, type: 'file' });
    });
    // Generated-file chips inside the prose (<p><button aria-label="file.md">
    // or <button>pkg.zip</button>) — the label is the filename.
    node.querySelectorAll(SELECTORS.fileChip).forEach(el => {
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (FILENAME_RE.test(name) && !out.some(a => a.name === name)) out.push({ name, type: 'file' });
    });
    node.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) return;
      if (img.closest('[data-message-author-role="user"]')) {
        out.push({ name: img.getAttribute('alt') || 'image', type: 'image', url: src });
      }
    });
    return out;
  }

  function stripJunk(root) {
    // Buttons are usually action chrome (copy / edit / feedback / code-block
    // copy) and get dropped. BUT ChatGPT also renders generated-file chips and
    // "Download the … package" links as <button> *inside* the prose
    // (<p><button aria-label="file.md">…</button></p>). Removing those blanked
    // whole assistant turns. Rule: a button inside a prose element is content
    // → unwrap it to its label; anything else is chrome → remove.
    const PROSE = 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote';
    root.querySelectorAll('button, [role="button"]').forEach(el => {
      if (!root.contains(el)) return;   // already removed with an ancestor
      const inProse = el.closest(PROSE) && root.contains(el.closest(PROSE));
      const isCodeCopy = !!el.closest('pre');
      if (!inProse || isCodeCopy) { el.remove(); return; }
      const label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) { el.remove(); return; }
      const span = root.ownerDocument.createElement('span');
      span.textContent = `\u{1F4CE} ${label}`;
      el.replaceWith(span);
    });
    [
      '[data-testid="copy-turn-action-button"]',
      '[aria-label="Copy"]',
      '[aria-label="Edit message"]',
    ].forEach(sel => root.querySelectorAll(sel).forEach(el => el.remove()));
  }

  function getTitle() {
    const active = document.querySelector(SELECTORS.activeChatTitle);
    if (active) {
      const t = active.textContent.trim();
      if (t) return t;
    }
    const docTitle = document.title.replace(/^ChatGPT\s*[-–|]\s*/, '').trim();
    return docTitle || 'ChatGPT conversation';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      extractChatGPT()
        .then(conv => sendResponse({ ok: true, data: conv }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // async
    }
  });
})();
