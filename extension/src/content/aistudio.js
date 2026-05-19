// Google AI Studio (aistudio.google.com) chat extractor.
// AI Studio uses Angular Material components (ms-* tags). Role is read from
// data-turn-role / class on ms-chat-turn; rendered model output lives inside
// ms-cmark-node (its KaTeX/markdown renderer).

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeMessage, makeConversation } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const SELECTORS = {
    turn: 'ms-chat-turn',
    // Model-side rendered markdown.
    modelContent: 'ms-cmark-node, .model-prompt-container, ms-text-chunk, .turn-content, .very-large-text-container',
    // User-side prompt. AI Studio has used several containers across revisions —
    // try the specific ones first, then fall back to anything bearing data-turn-role="user".
    userContent: '.user-prompt-container, .user-prompt, [data-turn-role="user" i] .turn-content, [data-turn-role="user" i], ms-prompt-chunk, ms-text-chunk',
    // Thinking / "thought" sections collapse by default; capture if expanded.
    thinking: 'ms-thought-chunk, [data-thought], details.thinking',
  };

  function extractAIStudio() {
    const turns = Array.from(document.querySelectorAll(SELECTORS.turn));
    const messages = turns.map(extractMessage).filter(Boolean);

    return makeConversation({
      source: 'aistudio',
      title: getTitle(),
      url: location.href,
      sessionId: getSessionId(),
      messages,
    });
  }

  function getRole(turn) {
    // 1. data-turn-role on the turn itself or any descendant (case-insensitive).
    const roleSelf = (turn.getAttribute && turn.getAttribute('data-turn-role') || '').toLowerCase();
    const roleChild = turn.querySelector('[data-turn-role]');
    const role = roleSelf || (roleChild && (roleChild.getAttribute('data-turn-role') || '').toLowerCase()) || '';
    if (role.includes('user')) return 'user';
    if (role.includes('model') || role.includes('assistant')) return 'assistant';
    // 2. Class-based markers (multiple AI Studio revisions).
    if (turn.querySelector('.user-prompt-container, .user-prompt')) return 'user';
    if (turn.querySelector('.model-prompt-container, .model-prompt, ms-cmark-node, ms-search-entry-point')) return 'assistant';
    // 3. Give up: default to user so the turn isn't silently dropped on misclassification.
    return 'user';
  }

  function extractMessage(turn) {
    const role = getRole(turn);

    let reasoning;
    const thinkingEl = turn.querySelector(SELECTORS.thinking);
    if (thinkingEl && role === 'assistant') {
      const tClone = thinkingEl.cloneNode(true);
      stripJunk(tClone);
      reasoning = htmlToMarkdown(tClone);
    }

    // Pick the best content container. For user turns prefer the user-side
    // selectors (the user prompt isn't always wrapped in ms-cmark-node); for
    // model turns prefer the rendered-markdown selectors.
    const primary = role === 'user' ? SELECTORS.userContent : SELECTORS.modelContent;
    const secondary = role === 'user' ? SELECTORS.modelContent : SELECTORS.userContent;
    let contentEl = turn.querySelector(primary) || turn.querySelector(secondary) || turn;

    const clone = contentEl.cloneNode(true);
    stripJunk(clone);
    clone.querySelectorAll(SELECTORS.thinking).forEach(el => el.remove());

    const html = clone.innerHTML;
    let content = htmlToMarkdown(clone);
    // Some user-prompt containers render text in contenteditable / textarea
    // shells that htmlToMarkdown can't see structure in — fall back to plain
    // text so the turn isn't silently dropped.
    if (!content) {
      const text = (clone.innerText || clone.textContent || '').trim();
      if (text) content = text;
    }
    if (!content) return null;

    return makeMessage({ role, content, html, reasoning });
  }

  function stripJunk(root) {
    const junk = [
      'button',
      '[role="button"]',
      'mat-icon',
      '.actions, .turn-actions, .action-buttons',
      '[aria-label="Copy"]',
      '[aria-label="More"]',
      // Grounding "Google Search Suggestions" block — Google requires it be
      // shown in the live UI, but it's noise in an exported transcript.
      'ms-search-entry-point, .search-entry-point',
      'ms-grounded-search-suggestions, .grounded-search-suggestions',
      '[class*="search-entry-point"]',
      '[class*="grounded-search-suggestions"]',
    ];
    junk.forEach(sel => root.querySelectorAll(sel).forEach(el => el.remove()));

    // Heading-based fallback: if a heading literally reads "Google Search
    // Suggestions", drop it and everything after it inside the same parent.
    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
      if (/^\s*google search suggestions\s*$/i.test(h.textContent || '')) {
        let n = h;
        while (n) {
          const next = n.nextSibling;
          n.remove();
          n = next;
        }
      }
    });
  }

  function getSessionId() {
    // /prompts/{id} or /app/prompts/{id}
    const m = location.pathname.match(/\/prompts\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function getTitle() {
    // AI Studio shows the prompt title in the side rail; falls back to document.title.
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
      try {
        sendResponse({ ok: true, data: extractAIStudio() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
  });
})();
