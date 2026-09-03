// Google AI Mode extractor (google.com/search?udm=50 — the conversational
// follow-on to an AI Overview, "Dive deeper in AI Mode").
//
// Structure of a thread (verified live 2026-09-03):
//
//   [data-xid="aim-mars-turn-root"] … [data-streaming-container]
//     └ div                                   ← turn list (turns + <script>s + empty divs)
//         ├ [data-scope-id="turn"]
//         │   ├ div                           ← user block
//         │   │   ├ h2  "You said: <query>"    ← a11y heading; the most stable query source
//         │   │   └ … Copy/Edit buttons, <span jsname>query</span>, "22:15" timestamp
//         │   └ [data-subtree="aimc"]
//         │       ├ h3  "AI Mode reply for <query>"   ← a11y heading, not content
//         │       └ [data-container-id="main-col"]
//         │           ├ [data-container-id="N"]       ← the answer body
//         │           │   ├ div[data-processed] …     ← paragraphs, [role=heading][aria-level=N],
//         │           │   │                              ul/ol, table, citation chips
//         │           └ div                            ← "Learn more / Privacy" footer
//         └ [data-scope-id="turn"] …
//
// Google's class names and most jsname/data-* values are obfuscated and churn;
// only the attributes shown above are relied on. Headings are
// <div role="heading" aria-level="N"> rather than <hN>, so we rewrite them
// before conversion. The page scrolls with the document (no inner scroller),
// and a two-turn thread shows no virtualization — a scroll pass is still done
// so a long thread that lazy-loads turns is picked up.

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const SELECTORS = {
    turn: '[data-scope-id="turn"]',
    userHeading: 'h2',
    querySpan: '[aria-label^="Query preview"]',   // its previousElementSibling holds the query text
    answerRoot: '[data-subtree="aimc"]',
    mainCol: '[data-container-id="main-col"]',
    answerBody: '[data-container-id]:not([data-container-id="main-col"])',
    chrome: 'button, [role="button"], svg, [aria-hidden="true"], [role="progressbar"], [role="dialog"]',
  };

  const YOU_SAID = /^\s*You said:\s*/i;
  const FOOTER_RE = /^AI responses may include mistakes/i;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function turns() {
    return Array.from(document.querySelectorAll(SELECTORS.turn))
      .filter(t => !t.parentElement?.closest(SELECTORS.turn));
  }

  // Scroll through the page once so any lazy-loaded turns mount; stop when
  // the turn count is stable across a full pass.
  async function loadAllTurns() {
    const root = document.scrollingElement || document.documentElement;
    const saved = root.scrollTop;
    let prev = -1, cur = turns().length, rounds = 0;
    while (cur !== prev && rounds < 8) {
      prev = cur;
      for (let y = 0; y <= root.scrollHeight; y += Math.max(300, Math.floor(root.clientHeight * 0.8))) {
        root.scrollTop = y;
        await sleep(60);
      }
      root.scrollTop = 0;
      await sleep(200);
      cur = turns().length;
      rounds++;
    }
    root.scrollTop = saved;
  }

  async function extractAIMode() {
    await loadAllTurns();
    const messages = [];
    for (const turn of turns()) {
      const user = extractUser(turn);
      if (user) messages.push(user);
      const answer = extractAnswer(turn);
      if (answer) messages.push(answer);
    }
    return makeConversation({
      source: 'aimode',
      title: getTitle(),
      url: location.href,
      sessionId: getSessionId(),
      messages,
    });
  }

  function extractUser(turn) {
    // The a11y heading carries the full query with a "You said: " prefix.
    const h2 = turn.querySelector(SELECTORS.userHeading);
    let content = h2 && YOU_SAID.test(h2.textContent) ? h2.textContent.replace(YOU_SAID, '').trim() : '';
    let html = h2 ? h2.innerHTML : '';
    if (!content) {
      const preview = turn.querySelector(SELECTORS.querySpan);
      const span = preview?.previousElementSibling;
      if (span) { content = span.textContent.trim(); html = span.innerHTML; }
    }
    if (!content) return null;
    return makeMessage({ role: 'user', content, html });
  }

  function extractAnswer(turn) {
    const root = turn.querySelector(SELECTORS.answerRoot) || turn;
    const mainCol = root.querySelector(SELECTORS.mainCol);
    if (!mainCol) return null;
    const body = mainCol.querySelector(SELECTORS.answerBody) || mainCol;

    const clone = body.cloneNode(true);
    // The last top-level block is the disclaimer/share footer ("AI responses
    // may include mistakes… Privacy Policy… legal removal request") with an
    // embedded share dialog. Its data-xid churns, so match on content.
    Array.from(clone.children).forEach(c => {
      if (FOOTER_RE.test(c.textContent.trim()) || c.querySelector('[role="dialog"]')) c.remove();
    });
    clone.querySelectorAll(SELECTORS.chrome).forEach(el => el.remove());
    // <div role="heading" aria-level="3"> → <h3> so markdown.js emits "### ".
    clone.querySelectorAll('[role="heading"][aria-level]').forEach(el => {
      if (el.querySelector('[role="heading"]')) { el.replaceWith(...el.childNodes); return; } // outer wrapper
      const lvl = Math.min(6, Math.max(1, Number(el.getAttribute('aria-level')) || 3));
      const h = document.createElement(`h${lvl}`);
      h.innerHTML = el.innerHTML;
      el.replaceWith(h);
    });
    // Citation chips are icon-only inline elements with no text; drop them so
    // they don't leave stray whitespace/brackets. Real <a href> text survives.
    clone.querySelectorAll('span, div').forEach(el => {
      if (!el.isConnected) return;
      if (!el.textContent.trim() && !el.querySelector('img, table, pre, code')) el.remove();
    });

    const html = clone.innerHTML;
    const content = htmlToMarkdown(clone);
    if (!content) return null;
    return makeMessage({ role: 'assistant', content, html });
  }

  function getSessionId() {
    // ?mtid=<thread id> identifies the AI Mode thread.
    const mtid = new URL(location.href).searchParams.get('mtid');
    if (mtid) return mtid;
    const q = new URL(location.href).searchParams.get('q') || '';
    return q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }

  function getTitle() {
    const h1 = [...document.querySelectorAll('h1')].find(h => /AI Mode conversation:/i.test(h.textContent));
    if (h1) return h1.textContent.replace(/^\s*AI Mode conversation:\s*/i, '').trim();
    const docTitle = document.title.replace(/\s*-\s*Google Search\s*$/i, '').trim();
    return docTitle || 'Google AI Mode conversation';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      extractAIMode()
        .then(conv => sendResponse({ ok: true, data: conv }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // async
    }
  });
})();
