// ChatGPT message extractor.
//
// Two layouts ship at once, chosen per account:
//
// Legacy (logged-out, and the pre-2026-09 app). The thread list holds one
// child per turn ("slot"). Off-screen slots are EMPTY placeholders styled
// with --last-known-height / --estimated-turn-height; only slots near the
// viewport mount as:
//
//   <div data-turn-id-container="…">
//     <section data-turn="user|assistant" data-testid="conversation-turn-N">
//       <div data-message-author-role="…" data-message-id="…">…</div>
//     </section>
//   </div>
//
// [data-turn] is NOT a persistent anchor. Walk the slots top→bottom, scroll
// each placeholder into view, wait for it to mount, and harvest. Re-fetch
// slots by index on every poll — React swaps the element.
//
// New (signed-in Chat/Work shell, verified live 2026-10-14 on chatgpt.com).
// None of the legacy attributes exist. Each exchange is [data-turn-key]; the
// messages inside it carry [data-chatgpt-search-unit-key] (duplicated as
// data-content-search-unit-key) shaped "fallback-turn-N:P:user|assistant".
// User text is [data-user-message-bubble]. Assistant text is a MarkdownRoot,
// [data-markdown-text-style="assistant-message"], rendered through DIL
// (data-d-component / data-d-text-flow="word") rather than <p>/<strong>/.markdown.
// Long threads still virtualize, so this path scrolls and harvests too.

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
    // New layout (2026-10). Both unit attributes are present on the live
    // tree and carry the same "fallback-turn-N:P:role" value; either one
    // can be the only copy on a nested node, so match both.
    turnKey: '[data-turn-key]',
    unit: '[data-chatgpt-search-unit-key], [data-content-search-unit-key]',
    userBubble: '[data-user-message-bubble]',
    assistantBody: '[data-markdown-text-style="assistant-message"], [class*="MarkdownRoot"]',
    generatedImage: '[data-testid="generated-image-preview"] img, [data-testid="generated-image-gallery"] img',
    composer: '[data-chatgpt-composer]',
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
      const oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 4) return el;
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

  // Signed-in Chat/Work shell. Legacy markers are absent, so the old slot
  // walk returns an empty conversation and the popup reports nothing to export.
  function isNewChatGPTLayout() {
    if (document.querySelector('[data-message-author-role], [data-testid^="conversation-turn-"]')) return false;
    return !!document.querySelector(`${SELECTORS.turnKey}, ${SELECTORS.unit}`);
  }

  function insideComposer(el) {
    const composer = el.closest(SELECTORS.composer);
    // The attribute sits on the composer form. If a future shell puts it on a
    // wrapper that also contains the thread, don't throw the thread away.
    return !!composer && !composer.querySelector(SELECTORS.turnKey);
  }

  function outermostUnits(root) {
    const all = [...root.querySelectorAll(SELECTORS.unit)];
    return all.filter(el => !insideComposer(el) && !el.closest('nav')
      && !all.some(other => other !== el && other.contains(el)));
  }

  function unitKey(unit) {
    return unit.getAttribute('data-chatgpt-search-unit-key')
      || unit.getAttribute('data-content-search-unit-key')
      || '';
  }

  function roleFromUnit(unit) {
    const m = unitKey(unit).match(/:(user|assistant|system|tool)$/);
    if (m) return m[1];
    if (unit.matches(SELECTORS.userBubble) || unit.querySelector(SELECTORS.userBubble)) return 'user';
    const labelled = unit.querySelector('[data-conversation-role]')?.getAttribute('data-conversation-role');
    if (labelled === 'user' || labelled === 'assistant' || labelled === 'system') return labelled;
    if (unit.querySelector(SELECTORS.assistantBody)) return 'assistant';
    return null;
  }

  function partIndex(unit) {
    const m = unitKey(unit).match(/:(\d+):(user|assistant|system|tool)$/);
    return m ? Number(m[1]) : 0;
  }

  // fallback-turn-N is the conversation index, not a viewport index (a
  // 3-turn thread mounted as fallback-turn-0..2). Prefer the turn wrapper's
  // own key over the unit key so a nested copy can't outrank it.
  function turnIndexOf(unit) {
    const turn = unit.closest(`${SELECTORS.turnKey}, [data-content-search-turn-key]`);
    const fromTurn = turn?.getAttribute('data-content-search-turn-key')
      || turn?.querySelector('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key')
      || '';
    let m = fromTurn.match(/(\d+)\s*$/);
    if (m) return Number(m[1]);
    m = unitKey(unit).match(/fallback-turn-(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function messageIdOf(unit, role) {
    const carrier = unit.matches('[data-chatgpt-search-message-ids], [data-dil-message-id], [data-chatgpt-selection-message-id]')
      ? unit
      : unit.querySelector('[data-dil-message-id], [data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]');
    const raw = carrier?.getAttribute('data-dil-message-id')
      || carrier?.getAttribute('data-chatgpt-selection-message-id')
      || carrier?.getAttribute('data-chatgpt-search-message-ids')
      || '';
    const id = raw.split(/\s+/).filter(Boolean)[0];
    if (id) return id;
    if (role === 'user') return unit.closest(SELECTORS.turnKey)?.getAttribute('data-turn-key') || undefined;
    return undefined;
  }

  function contentNodes(unit, role) {
    if (role === 'user') {
      const bubble = unit.matches(SELECTORS.userBubble) ? unit : unit.querySelector(SELECTORS.userBubble);
      if (bubble) return [bubble];
    }
    const bodies = [...unit.querySelectorAll(SELECTORS.assistantBody)];
    const outer = bodies.filter(el => !bodies.some(other => other !== el && other.contains(el)));
    const kept = outer.filter(el => {
      if (el.getAttribute('data-markdown-text-tone') !== 'tertiary') return true;
      return (el.innerText || '').trim().length > 40;
    });
    if (kept.length) return kept;
    const copies = [...unit.querySelectorAll('[data-markdown-copy="contents"]')];
    const outerCopies = copies.filter(el => !copies.some(other => other !== el && other.contains(el)));
    if (outerCopies.length) return outerCopies;
    return [unit];
  }

  function dropStructuralWhitespace(root) {
    const block = /^(P|UL|OL|LI|H[1-6]|PRE|DIV|BLOCKQUOTE|TABLE|SECTION)$/;
    const word = '[data-d-text-flow="word"], [data-d-stream-word]';
    const visit = (el) => {
      if (el.tagName === 'PRE' || el.tagName === 'CODE') return;
      [...el.children].forEach(visit);
      if (el.closest('pre, code')) return;
      [...el.childNodes].forEach(n => {
        if (n.nodeType !== 3 || !/^\s*$/.test(n.nodeValue || '')) return;
        const prev = n.previousElementSibling;
        const next = n.nextElementSibling;
        const besideWord = prev?.matches?.(word) || next?.matches?.(word);
        const besideBlock = (prev && block.test(prev.tagName)) || (next && block.test(next.tagName));
        if (besideWord || besideBlock) n.remove();
      });
    };
    visit(root);
  }

  function replaceTag(el, tag) {
    if (!tag || el.tagName.toLowerCase() === tag) return;
    const next = el.ownerDocument.createElement(tag);
    while (el.firstChild) next.appendChild(el.firstChild);
    el.replaceWith(next);
  }

  // DIL paints each word as its own element and bold as data-d-default-strong,
  // so a plain text walk either smashes words together or drops emphasis.
  // Tag the clone from the live box's display (block text → <p>, list → <ul>/<li>)
  // before htmlToMarkdown sees it. Never touch the live tree: React owns it.
  function prepareContent(liveRoot) {
    const clone = liveRoot.cloneNode(true);
    const liveEls = [liveRoot, ...liveRoot.querySelectorAll('*')];
    const cloneEls = [clone, ...clone.querySelectorAll('*')];
    if (liveEls.length === cloneEls.length) {
      for (let i = 0; i < liveEls.length; i++) {
        const live = liveEls[i];
        const copy = cloneEls[i];
        if (live.getAttribute('role') === 'heading') {
          const level = Math.min(6, Math.max(1, Number(live.getAttribute('aria-level')) || 1));
          copy.setAttribute('data-dd-block', 'h' + level);
          continue;
        }
        const comp = live.getAttribute('data-d-component');
        let display = '';
        try { display = getComputedStyle(live).display || ''; } catch { display = ''; }
        if (comp === 'list') copy.setAttribute('data-dd-block', 'ul');
        else if (comp === 'list-item') copy.setAttribute('data-dd-block', 'li');
        else if ((comp === 'text' || comp === 'paragraph')
          && display !== 'inline' && display !== 'inline-block' && display !== 'inline-flex' && display !== 'none') {
          copy.setAttribute('data-dd-block', 'p');
        }
        if (live.getAttribute('data-d-text-flow') === 'word' || live.hasAttribute('data-d-stream-word')) {
          let ws = '';
          try { ws = getComputedStyle(live).whiteSpace || ''; } catch { ws = ''; }
          if (ws.startsWith('pre')) copy.setAttribute('data-dd-no-space', '');
        }
      }
    }
    [...clone.querySelectorAll('[data-dd-block]')].reverse().forEach(el => replaceTag(el, el.getAttribute('data-dd-block')));
    // Source whitespace between DIL word nodes (and between the blocks we just
    // created) is indentation, not author spacing. Drop it and let separateWords
    // put a single space back — otherwise "word\\n." becomes "word ." .
    dropStructuralWhitespace(clone);
    clone.querySelectorAll('[data-markdown-copy="exclude"]').forEach(el => el.remove());
    clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
      if (/^(you said|chatgpt said):?$/i.test((el.textContent || '').trim())) el.remove();
    });
    // Role labels ("ChatGPT said:") are sometimes the only text in a
    // data-conversation-role node. A node that wraps the answer carries the
    // same attribute — only drop the label itself.
    clone.querySelectorAll('[data-conversation-role]').forEach(el => {
      if (/^(you said|chatgpt said):?$/i.test((el.textContent || '').trim())) el.remove();
    });
    clone.querySelectorAll('[data-d-default-strong]').forEach(el => {
      if (el.closest('strong, b')) return;
      const strong = clone.ownerDocument.createElement('strong');
      while (el.firstChild) strong.appendChild(el.firstChild);
      el.appendChild(strong);
    });
    clone.querySelectorAll('[data-d-text-flow="word"], [data-d-stream-word]').forEach(el => {
      if (el.hasAttribute('data-dd-no-space') || el.closest('pre, code')) return;
      const text = el.textContent || '';
      if (!text || /\s$/.test(text)) return;
      if (/^[,.;:!?()[\]"'“”‘’]+$/.test(text.trim())) return;
      const next = el.nextSibling;
      if (next && next.nodeType === 3 && /^\s/.test(next.nodeValue || '')) return;
      const nextText = (el.nextElementSibling?.textContent || '').trim();
      if (nextText && /^[,.;:!?()[\]"'“”‘’]+$/.test(nextText)) return;
      el.appendChild(clone.ownerDocument.createTextNode(' '));
    });
    stripJunk(clone);
    return clone;
  }

  function cleanRoleLabel(text, role) {
    if (role === 'user') return text.replace(/^(you said:\s*)+/i, '').trim();
    if (role === 'assistant') return text.replace(/^(chatgpt said:\s*)+/i, '').trim();
    return text.trim();
  }

  function messageFromUnit(unit, role) {
    const chunks = [];
    let html = '';
    for (const node of contentNodes(unit, role)) {
      const prepared = prepareContent(node);
      let md = htmlToMarkdown(prepared).trim();
      if (!md) md = (node.innerText || '').replace(/\s+\n/g, '\n').trim();
      md = cleanRoleLabel(md, role);
      if (md && !chunks.includes(md)) chunks.push(md);
      html += prepared.innerHTML;
    }
    const content = chunks.join('\n\n').trim();
    const attachments = extractAttachments(unit);
    if (!content && !attachments.length) return null;
    return makeMessage({
      id: messageIdOf(unit, role),
      role,
      content,
      html,
      attachments,
    });
  }

  // Parent of the turn slots: the tightest ancestor whose children each hold
  // at most one mounted turn (empty siblings are the virtualizer's placeholders).
  function findNewTurnList() {
    const turns = [...document.querySelectorAll(SELECTORS.turnKey)];
    if (!turns.length) return null;
    let node = turns[0];
    while (node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      const slots = [...parent.children];
      const keyed = slots.filter(child => child.matches(SELECTORS.turnKey) || child.querySelector(SELECTORS.turnKey));
      const oneEach = keyed.length >= turns.length && keyed.every(child => {
        if (child.matches(SELECTORS.turnKey)) return !child.querySelector(SELECTORS.turnKey);
        return child.querySelectorAll(SELECTORS.turnKey).length === 1;
      });
      if (oneEach) return parent;
      node = parent;
      if (parent.tagName === 'MAIN') break;
    }
    return turns[0].parentElement;
  }

  function slotNeedsMount(slot) {
    if (!slot) return false;
    if (slot.matches(SELECTORS.turnKey) || slot.querySelector(`${SELECTORS.turnKey}, ${SELECTORS.unit}`)) return false;
    const style = slot.getAttribute('style') || '';
    if (PLACEHOLDER_RE.test(style)) return true;
    const height = style.match(/(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px/);
    return !!height && Number(height[1]) >= 40 && slot.children.length === 0 && !(slot.innerText || '').trim();
  }

  async function extractNewLayout() {
    const anchor = document.querySelector(`${SELECTORS.turnKey}, ${SELECTORS.unit}`);
    const scrollRoot = findScrollRoot(anchor || document.body);
    const savedScroll = scrollRoot.scrollTop;
    const savedWindowScroll = window.scrollY;
    const byKey = new Map();
    let seenOrder = 0;

    function harvestNew() {
      const units = [];
      for (const unit of outermostUnits(document)) {
        const nested = [...unit.querySelectorAll(SELECTORS.unit)];
        if (nested.length) {
          const leaves = nested.filter(el => !nested.some(other => other !== el && other.contains(el)));
          leaves.forEach(el => units.push(el));
          // The wrapper itself can be the user bubble's unit, with the
          // assistant unit nested beside the bubble rather than around it.
          const role = roleFromUnit(unit);
          if (role === 'user' || role === 'assistant' || role === 'system') {
            const ownsContent = contentNodes(unit, role).some(node => !leaves.some(leaf => leaf === node || leaf.contains(node)));
            if (ownsContent) units.push(unit);
          }
        } else {
          units.push(unit);
        }
      }
      for (const unit of units) {
        const role = roleFromUnit(unit);
        if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
        const turnIdx = turnIndexOf(unit);
        const sort = (turnIdx == null ? 1_000_000 : turnIdx) * 1000 + partIndex(unit);
        const attrId = messageIdOf(unit, role);
        // Build the message before deciding the map key so a longer remount
        // (virtualizer recycled the node) replaces a shorter copy of the same id.
        const msg = messageFromUnit(unit, role);
        if (!msg) continue;
        const key = attrId || `${turnIdx}:${partIndex(unit)}:${role}`;
        const prev = byKey.get(key);
        if (!prev) byKey.set(key, { msg, sort, i: seenOrder++ });
        else if ((msg.content || '').length > (prev.msg.content || '').length) byKey.set(key, { ...prev, msg });
      }
    }

    function seenTurnKeys() {
      return [...document.querySelectorAll(`${SELECTORS.turnKey}, [data-content-search-turn-key]`)]
        .map(el => el.getAttribute('data-turn-key') || el.getAttribute('data-content-search-turn-key'))
        .join('|');
    }

    async function jumpTo(top) {
      const beforeTop = scrollRoot.scrollTop;
      const before = seenTurnKeys();
      scrollRoot.scrollTop = top;
      if (Math.abs(scrollRoot.scrollTop - beforeTop) < 2) return false;
      await waitFor(() => seenTurnKeys() !== before, 600);
      harvestNew();
      return true;
    }

    try {
      harvestNew();

      const list = findNewTurnList();
      if (list) {
        const count = list.children.length;
        for (let i = 0; i < count; i++) {
          const slot = list.children[i];
          if (!slotNeedsMount(slot)) continue;
          slot.scrollIntoView({ block: 'start', behavior: 'auto' });
          await waitFor(() => {
            const cur = list.children[i];
            return cur && (cur.matches(SELECTORS.turnKey) || cur.querySelector(`${SELECTORS.turnKey}, ${SELECTORS.unit}`));
          }, 1500);
          harvestNew();
        }
      }

      if (scrollRoot.scrollHeight > scrollRoot.clientHeight + 8) {
        await jumpTo(0);
        let stalls = 0;
        let last = -1;
        const started = performance.now();
        while (performance.now() - started < 90000 && stalls < 3) {
          harvestNew();
          const atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 8;
          if (byKey.size === last) stalls++;
          else stalls = 0;
          last = byKey.size;
          if (atBottom) break;
          const moved = await jumpTo(scrollRoot.scrollTop + Math.max(240, Math.round(scrollRoot.clientHeight * 0.7)));
          if (!moved) break;
        }
      }
    } finally {
      scrollRoot.scrollTop = savedScroll;
      window.scrollTo({ top: savedWindowScroll, behavior: 'auto' });
    }

    const entries = [...byKey.values()];
    const indexes = [...new Set(entries.map(e => Math.floor(e.sort / 1000)).filter(n => n < 1_000_000))].sort((a, b) => a - b);
    if (indexes.length) {
      let missing = 0;
      for (let i = indexes[0]; i <= indexes[indexes.length - 1]; i++) {
        if (!indexes.includes(i)) missing++;
      }
      if (missing) {
        console.warn(`[DOM Daddy] ChatGPT: ${missing} turn${missing === 1 ? '' : 's'} missing from the thread; export may be incomplete.`);
      }
    } else if (!entries.length) {
      console.warn('[DOM Daddy] ChatGPT: new layout had no extractable messages.');
    }

    const messages = entries
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

  async function extractChatGPT() {
    if (isNewChatGPTLayout()) return extractNewLayout();
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
    const pushImage = (img, name) => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) return;
      if (!out.some(a => a.url === src)) out.push({ name, type: 'image', url: src });
    };
    node.querySelectorAll('img').forEach(img => {
      if (img.closest('[data-message-author-role="user"]')) pushImage(img, img.getAttribute('alt') || 'image');
    });
    node.querySelectorAll(SELECTORS.generatedImage).forEach(img => {
      pushImage(img, img.getAttribute('alt') || 'generated image');
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
      // The new layout wraps the whole prompt in <button data-user-message-bubble>.
      // Deleting that button deletes the only copy of the prompt.
      if (el.matches('[data-user-message-bubble]')) {
        el.replaceWith(...el.childNodes);
        return;
      }
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
