// RawMode: general-purpose extractor injected on-demand into ANY page (no
// manifest.content_scripts entry — popup.js calls chrome.scripting.executeScript).
//
// Tiered strategy:
//   1. Defuddle (vendored at lib/defuddle.js) — full-fidelity article extraction.
//   2. Semantic walker — first <main>/<article>/[role="main"] element.
//   3. document.body.textContent — absolute last resort.
//
// Defuddle mutates the DOM it parses, so we hand it a re-parsed clone of the
// current document and never touch the live tree.

(async () => {
  const { htmlToMarkdown } = await import(chrome.runtime.getURL('src/lib/markdown.js'));
  const { makeArticle } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  function cloneDocument() {
    const html = document.documentElement.outerHTML;
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function wordCount(text) {
    if (!text) return 0;
    const matches = text.match(/\S+/g);
    return matches ? matches.length : 0;
  }

  async function tierDefuddle() {
    const { Defuddle } = await import(chrome.runtime.getURL('src/lib/defuddle.js'));
    const docClone = cloneDocument();
    const result = new Defuddle(docClone, { url: location.href }).parse();
    if (!result || !result.content || result.content.length < 200) return null;

    const content = htmlToMarkdown(result.content);
    if (!content) return null;

    return makeArticle({
      url: location.href,
      hostname: location.hostname,
      title: result.title || document.title || '',
      byline: result.author || '',
      siteName: result.site || '',
      lang: result.language || '',
      publishedTime: result.published || '',
      excerpt: result.description || '',
      wordCount: result.wordCount || wordCount(content),
      contentLength: result.content.length,
      content,
      html: result.content,
      extractorTier: 'defuddle',
    });
  }

  function tierSemanticWalker() {
    const el = document.querySelector('main, article, [role="main"]');
    if (!el) return null;
    const clone = el.cloneNode(true);
    // Strip obvious chrome before conversion.
    clone.querySelectorAll('nav, aside, header, footer, script, style, noscript, [aria-hidden="true"]')
      .forEach(n => n.remove());
    const content = htmlToMarkdown(clone);
    if (!content || content.length < 50) return null;
    return makeArticle({
      url: location.href,
      hostname: location.hostname,
      title: document.title || '',
      wordCount: wordCount(content),
      contentLength: clone.innerHTML.length,
      content,
      html: clone.innerHTML,
      extractorTier: 'semantic-walker',
    });
  }

  function tierPlainText() {
    // textContent is cheaper than innerText (no style recalc) and good enough
    // for the last-ditch fallback.
    const text = (document.body?.textContent || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return null;
    return makeArticle({
      url: location.href,
      hostname: location.hostname,
      title: document.title || '',
      wordCount: wordCount(text),
      contentLength: text.length,
      content: text,
      extractorTier: 'plain-text',
    });
  }

  async function extract() {
    try {
      const a = await tierDefuddle();
      if (a) return a;
    } catch (err) {
      console.warn('[DOM Daddy/RawMode] Defuddle failed, falling back:', err);
    }
    return tierSemanticWalker() || tierPlainText();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      extract()
        .then(data => sendResponse({ ok: !!data, data, error: data ? null : 'No content found' }))
        .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
  });
})();
