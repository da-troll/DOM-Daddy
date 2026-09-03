// Claude.ai message extractor.
//
// As of Sep 2026 the transcript is a windowed virtual list:
//
//   [data-testid="transcript-list"]
//     └ div (sizer, full conversation height)
//         ├ [data-testid="transcript-spacer"]            ← height of unmounted rows above
//         ├ [data-testid="transcript-row"]               ← only ~5 rows near the viewport
//         │   └ [role="article"][aria-posinset="27"][aria-setsize="30"]
//         │       ├ [data-cds="UserMessage"] > [data-testid="user-message"]      (user)
//         │       └ [data-is-streaming="false"]                                   (assistant)
//         │           ├ h2[data-find-omitted]  "Claude responded: …"  ← a11y heading, NOT content
//         │           ├ [data-cds="TurnStatus"] "Thought for 39s"     ← collapsed thinking chrome
//         │           ├ [data-cds="Prose"] …                          ← the actual answer
//         │           └ [data-cds="MessageActions"]                   ← copy/retry buttons
//         └ [data-testid="transcript-spacer"]
//
// Rows outside the window are unmounted entirely, so we scroll the transcript
// top→bottom, harvesting rows by aria-posinset until we hold aria-setsize of
// them (or reach the bottom). Older non-virtualized layouts fall back to a
// plain document-order walk.

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const SELECTORS = {
    transcriptList: '[data-testid="transcript-list"]',
    row: '[data-testid="transcript-row"]',
    article: '[role="article"][aria-posinset]',
    userMessage: '[data-testid="user-message"]',
    assistantMessage: '[data-is-streaming], .font-claude-message',
    // Non-content chrome inside an assistant node.
    a11yHeading: 'h2[data-find-omitted], [data-find-omitted]:is(h1,h2,h3)',
    turnStatus: '[data-cds="TurnStatus"]',
    messageActions: '[data-cds="MessageActions"]',
    // Thinking / extended-thinking blocks (when expanded).
    thinking: 'details[data-testid="thinking-block"], [data-testid="extended-thinking"], [data-cds="Thinking"]',
    fileCard: '[data-testid="file-thumbnail"], [data-testid*="attachment"]',
    // "Claude asked → you answered" card: <span>question</span><span>answer</span>…
    askUserCard: '[data-testid="ask-user-answers-card"]',
    // Inline artifact cards in assistant turns: "Taste profile · Document · MD".
    artifactCard: '[class~="group/artifact-block"], [data-sheet-kind]',
  };

  const POLL_MS = 40;
  const SETTLE_TIMEOUT_MS = 4000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function findScrollRoot(fromEl) {
    let el = fromEl;
    while (el) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function extractClaude() {
    const list = document.querySelector(SELECTORS.transcriptList);
    if (!list || !list.querySelector(SELECTORS.article)) return extractFlat();

    const scrollRoot = findScrollRoot(list);
    const savedScroll = scrollRoot.scrollTop;
    const byPos = new Map();   // aria-posinset -> message
    let setSize = 0;

    function harvest() {
      let added = 0;
      document.querySelectorAll(SELECTORS.article).forEach(art => {
        const pos = Number(art.getAttribute('aria-posinset'));
        setSize = Math.max(setSize, Number(art.getAttribute('aria-setsize')) || 0);
        if (!pos || byPos.has(pos)) return;
        const msg = extractFromArticle(art);
        // Genuinely empty rows (interrupted turns) are recorded as null so
        // they count as seen and don't trigger the "incomplete" warning.
        if (msg || !art.textContent.trim()) { byPos.set(pos, msg); added++; }
      });
      return added;
    }

    harvest();
    const step = Math.max(200, Math.floor(scrollRoot.clientHeight * 0.7));
    scrollRoot.scrollTop = 0;
    let stalled = 0;
    const signature = () => [...document.querySelectorAll(SELECTORS.article)].map(a => a.getAttribute('aria-posinset')).join(',');
    for (let guard = 0; guard < 2000; guard++) {
      // Wait for the window to settle at this position: stop as soon as new
      // rows arrive, or once the mounted row set has been stable for a few
      // polls (scrolling inside one very tall message mounts nothing new).
      const start = performance.now();
      let added = 0, prevSig = signature(), stable = 0;
      while (performance.now() - start < SETTLE_TIMEOUT_MS) {
        await sleep(POLL_MS);
        added += harvest();
        if (added) break;
        const sig = signature();
        stable = sig === prevSig ? stable + 1 : 0;
        prevSig = sig;
        if (stable >= 3) break;
      }
      const done = setSize && byPos.size >= setSize;
      const atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 2;
      if (done || (atBottom && stalled > 1)) break;
      stalled = atBottom ? stalled + 1 : 0;
      scrollRoot.scrollTop += step;
    }
    // One last look at the bottom.
    scrollRoot.scrollTop = scrollRoot.scrollHeight;
    await sleep(POLL_MS * 4);
    harvest();

    scrollRoot.scrollTop = savedScroll;

    if (setSize && byPos.size < setSize) {
      console.warn(`[DOM Daddy] Claude: harvested ${byPos.size} of ${setSize} messages; export may be incomplete.`);
    }

    const messages = [...byPos.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]).filter(Boolean);
    return makeConversation({ source: 'claude', title: getTitle(), url: location.href, sessionId: getSessionId(), messages });
  }

  // Older / non-virtualized layout: walk user + assistant nodes in DOM order.
  function extractFlat() {
    const candidates = Array.from(document.querySelectorAll(`${SELECTORS.userMessage}, ${SELECTORS.assistantMessage}`));
    const seen = new WeakSet();
    const messages = [];
    for (const node of candidates) {
      let skip = false;
      for (let a = node.parentElement; a; a = a.parentElement) if (seen.has(a)) { skip = true; break; }
      if (skip) continue;
      seen.add(node);
      const msg = node.matches(SELECTORS.userMessage) ? extractUser(node) : extractAssistant(node);
      if (msg) messages.push(msg);
    }
    return makeConversation({ source: 'claude', title: getTitle(), url: location.href, sessionId: getSessionId(), messages });
  }

  function extractFromArticle(art) {
    const user = art.querySelector(SELECTORS.userMessage);
    if (user) return extractUser(user, art);
    const asst = art.querySelector(SELECTORS.assistantMessage);
    if (asst) return extractAssistant(asst);
    const ask = art.querySelector(SELECTORS.askUserCard);
    if (ask) return extractAskUserCard(ask);
    // Unknown row shape (errored / interrupted / tool-only turn). Export its
    // cleaned text rather than silently dropping the position.
    const role = art.querySelector('[data-cds="UserMessage"]') ? 'user' : 'assistant';
    const msg = extractAssistant(art);
    return msg ? { ...msg, role } : null;
  }

  // Question/answer pairs render as sibling spans. Emit the question as a
  // blockquote and the chosen answer as the user's text.
  function extractAskUserCard(card) {
    const pairs = [];
    card.querySelectorAll('span').forEach(sp => {
      if (sp.children.length) return;
      const t = sp.textContent.trim();
      if (t) pairs.push(t);
    });
    if (!pairs.length) return null;
    const lines = [];
    for (let i = 0; i < pairs.length; i += 2) {
      lines.push(`> ${pairs[i]}`);
      if (pairs[i + 1] !== undefined) lines.push('', pairs[i + 1]);
      if (i + 2 < pairs.length) lines.push('');
    }
    return makeMessage({ role: 'user', content: lines.join('\n'), html: card.innerHTML });
  }

  function getSessionId() {
    // /chat/{uuid} or /project/{pid}/chat/{cid} — we want the chat id
    const m = location.pathname.match(/\/chat\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function extractUser(node, scope) {
    const clone = node.cloneNode(true);
    stripJunk(clone);
    const html = clone.innerHTML;
    const content = htmlToMarkdown(clone);
    // Attachments render as cards next to (not inside) the message text.
    const attachments = extractAttachments(scope || node.closest('[data-cds="UserMessage"]') || node);
    if (!content && !attachments.length) return null;
    return makeMessage({ role: 'user', content, html, attachments });
  }

  function extractAssistant(node) {
    let reasoning;
    const thinkingEl = node.querySelector(SELECTORS.thinking);
    if (thinkingEl) reasoning = htmlToMarkdown(thinkingEl.cloneNode(true));

    // Artifact / file cards ("Taste profile · Document · MD") sit inline in
    // the answer; record them as attachments and drop the card markup so
    // their labels don't run into the prose.
    const attachments = extractAttachments(node);

    const clone = node.cloneNode(true);
    clone.querySelectorAll([
      SELECTORS.a11yHeading,
      SELECTORS.turnStatus,
      SELECTORS.messageActions,
      SELECTORS.thinking,
      SELECTORS.fileCard,
      SELECTORS.artifactCard,
      '[role="status"]',
    ].join(', ')).forEach(el => el.remove());
    stripJunk(clone);

    const html = clone.innerHTML;
    const content = htmlToMarkdown(clone);
    if (!content && !attachments.length) return null;
    return makeMessage({ role: 'assistant', content, html, reasoning, attachments });
  }

  function extractAttachments(node) {
    const out = [];
    node.querySelectorAll(SELECTORS.fileCard).forEach(el => {
      const name = el.getAttribute('aria-label')
        || el.querySelector('[data-testid="file-name"]')?.textContent?.trim()
        || el.textContent.trim().slice(0, 100);
      if (name && !out.some(a => a.name === name)) out.push({ name, type: 'file' });
    });
    node.querySelectorAll(SELECTORS.artifactCard).forEach(el => {
      if (el.parentElement?.closest(SELECTORS.artifactCard)) return;   // nested match
      const name = (el.querySelector('.truncate') || el).textContent.trim().slice(0, 100);
      const kind = el.getAttribute('data-sheet-kind') || 'artifact';
      if (name && !out.some(a => a.name === name)) out.push({ name, type: 'artifact', kind });
    });
    return out;
  }

  function stripJunk(root) {
    [
      'button',
      '[role="button"]',
      '[aria-label="Copy"]',
      '[aria-label="Retry"]',
      '[data-testid="action-bar-copy"]',
      'svg',
    ].forEach(sel => root.querySelectorAll(sel).forEach(el => el.remove()));
  }

  function getTitle() {
    const header = document.querySelector('[data-testid="chat-title-split"], header [data-testid="chat-menu-trigger"], header h1, header button[aria-haspopup]');
    if (header) {
      const t = header.textContent.trim();
      if (t && t.toLowerCase() !== 'new chat') return t;
    }
    const docTitle = document.title.replace(/\s*[-–|]\s*Claude\s*$/, '').trim();
    return docTitle || 'Claude conversation';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      extractClaude()
        .then(conv => sendResponse({ ok: true, data: conv }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // async
    }
  });
})();
