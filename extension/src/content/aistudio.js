// Google AI Studio (aistudio.google.com) chat extractor.
//
// AI Studio uses Angular Material + CDK virtual scrolling, which means most
// <ms-chat-turn> elements are NOT in the DOM at any given moment — only the
// few currently in viewport. To capture a full conversation we scroll through
// the chat ourselves, harvesting newly-mounted turns into a Map keyed by the
// stable turn id, then restore the user's scroll position.
//
// Structure of a rendered turn:
//   <ms-chat-turn id="turn-...">
//     <div class="chat-turn-container ... [user|model] render">
//       <div class="actions-container">...buttons...</div>
//       <div class="virtual-scroll-container [user|model]-prompt-container"
//            data-turn-role="User|Model">
//         <div style="height: Xpx"></div>           ← spacer when virtualized
//         <div class="turn-content">                ← body lives here when rendered
//           <div class="author-label">User|Model <span class="timestamp">…</span></div>
//           <ms-prompt-chunk class="text-chunk">
//             <ms-thought-chunk> … reasoning …      ← model only, optional
//             <ms-text-chunk> … response …          ← (for model) or the prompt (for user)
//           </ms-prompt-chunk>
//         </div>
//       </div>
//     </div>
//   </ms-chat-turn>

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  function findScrollViewport() {
    // Walk up from any turn to the nearest ancestor that actually scrolls.
    const turn = document.querySelector('ms-chat-turn');
    if (!turn) return null;
    let el = turn.parentElement;
    while (el) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
        return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement;
  }

  function extractMessageFromTurn(turn) {
    const userContainer = turn.querySelector('.user-prompt-container');
    const modelContainer = turn.querySelector('.model-prompt-container');
    const container = userContainer || modelContainer;
    if (!container) return null;
    const role = userContainer ? 'user' : 'assistant';

    const turnContent = container.querySelector('.turn-content');
    // Virtualized turns have an empty .turn-content; skip — they'll be
    // captured on a later harvest pass once scrolled into view.
    if (!turnContent || !turnContent.firstElementChild) return null;

    const clone = turnContent.cloneNode(true);

    // Strip metadata chrome (author label, action buttons, icon glyphs).
    clone.querySelectorAll(
      '.author-label, .actions-container, [role="button"], button, mat-icon, .material-symbols-outlined'
    ).forEach(el => el.remove());

    let reasoning;
    if (role === 'assistant') {
      // Pull thoughts out before removing them, so they go to the reasoning field.
      const thoughtChunk = clone.querySelector('ms-thought-chunk');
      if (thoughtChunk) {
        const body = thoughtChunk.querySelector('.mat-expansion-panel-body') || thoughtChunk;
        const reasoningText = htmlToMarkdown(body.cloneNode(true));
        if (reasoningText) reasoning = reasoningText;
        thoughtChunk.remove();
      }
      // Drop the "Google Search Suggestions" grounding block — required in the
      // live UI but noise in an exported transcript.
      clone.querySelectorAll(
        'ms-search-entry-point, [class*="search-entry-point"], [class*="grounded-search-suggestions"]'
      ).forEach(el => el.remove());
      clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
        if (/^\s*google search suggestions\s*$/i.test(h.textContent || '')) {
          let n = h;
          while (n) { const next = n.nextSibling; n.remove(); n = next; }
        }
      });
    }

    const html = clone.innerHTML;
    let content = htmlToMarkdown(clone);
    if (!content) content = (clone.innerText || clone.textContent || '').trim();
    if (!content) return null;

    return { role, content, html, reasoning };
  }

  async function harvestAllTurns() {
    const viewport = findScrollViewport();
    // id → { role, content, html, reasoning }
    const collected = new Map();
    // first-seen order (== document order, since we scroll top→bottom)
    const order = [];

    const harvest = () => {
      for (const turn of document.querySelectorAll('ms-chat-turn')) {
        const id = turn.id;
        if (!id || collected.has(id)) continue;
        const msg = extractMessageFromTurn(turn);
        if (msg) {
          collected.set(id, msg);
          order.push(id);
        }
      }
    };

    const canScroll = viewport && viewport.scrollHeight > viewport.clientHeight + 4;
    if (!canScroll) {
      harvest();
      return order.map(id => collected.get(id));
    }

    const originalScrollTop = viewport.scrollTop;
    viewport.scrollTop = 0;
    await wait(250);
    harvest();

    let prev = -1;
    let guard = 0;
    while (
      viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 2 &&
      guard++ < 200
    ) {
      prev = viewport.scrollTop;
      viewport.scrollTop = Math.min(
        viewport.scrollTop + viewport.clientHeight * 0.85,
        viewport.scrollHeight
      );
      await wait(180);
      harvest();
      if (viewport.scrollTop === prev) break; // can't advance further
    }
    // One final pass at the very bottom in case the last block needed extra paint time.
    await wait(150);
    harvest();

    viewport.scrollTop = originalScrollTop;
    return order.map(id => collected.get(id));
  }

  async function extractAIStudio() {
    const raw = await harvestAllTurns();
    const messages = raw.map(m => makeMessage({
      role: m.role, content: m.content, html: m.html, reasoning: m.reasoning,
    }));

    return makeConversation({
      source: 'aistudio',
      title: getTitle(),
      url: location.href,
      sessionId: getSessionId(),
      messages,
    });
  }

  function getSessionId() {
    const m = location.pathname.match(/\/prompts\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function getTitle() {
    const active = document.querySelector(
      '.prompt-title, [data-test-id="prompt-title"], .conversation-title.selected'
    );
    if (active) {
      const t = active.textContent.trim();
      if (t) return t;
    }
    const docTitle = document.title.replace(/\s*[-–|]\s*(Google\s+)?AI\s*Studio\s*$/i, '').trim();
    return docTitle || 'AI Studio conversation';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      extractAIStudio()
        .then(data => sendResponse({ ok: true, data }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // async response
    }
  });
})();
