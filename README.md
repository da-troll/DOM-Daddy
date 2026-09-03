<div align="center">

<pre>
██████╗░░█████╗░███╗░░░███╗░░██████╗░░█████╗░██████╗░██████╗░██╗░░░██╗
██╔══██╗██╔══██╗████╗░████║░░██╔══██╗██╔══██╗██╔══██╗██╔══██╗╚██╗░██╔╝
██║░░██║██║░░██║██╔████╔██║░░██║░░██║███████║██║░░██║██║░░██║░╚████╔╝░
██║░░██║██║░░██║██║╚██╔╝██║░░██║░░██║██╔══██║██║░░██║██║░░██║░░╚██╔╝░░
██████╔╝╚█████╔╝██║░╚═╝░██║░░██████╔╝██║░░██║██████╔╝██████╔╝░░░██║░░░
╚═════╝░░╚════╝░╚═╝░░░░░╚═╝░░╚═════╝░╚═╝░░╚═╝╚═════╝░╚═════╝░░░░╚═╝░░░
</pre>

**E X T R A C T &nbsp; A N Y T H I N G**

</div>

<p align="center">
  <img src="docs/hero.png" alt="DOM Daddy" width="320">
</p>

A Manifest V3 Chrome extension that extracts structured data from sites that fight scraping. Currently:

- **ChatGPT, Claude, Gemini, Google AI Mode, AI Studio, Perplexity** chats → Markdown / Text / JSON / CSV
- **LinkedIn** experience pages (`/in/{you}/details/experience/`) → Markdown / Text / JSON / CSV (one row per role)
- **Anything else** → **RawMode**, a two-step generic extractor for any site not in the list above

Pure client-side. No server, no build step at runtime, no analytics. One vendored dependency: [Defuddle](https://github.com/kepano/defuddle) (MIT, ~290 KB ESM bundle) powers RawMode's article parsing.

## Project structure

```
extension/
├── manifest.json
├── src/
│   ├── background/                   # Thin service worker (lifecycle hooks only)
│   ├── content/                      # One extractor per supported host
│   │   ├── chatgpt.js
│   │   ├── claude.js
│   │   ├── gemini.js
│   │   ├── aimode.js                 # Google AI Mode (google.com/search?udm=50)
│   │   ├── aistudio.js
│   │   ├── perplexity.js
│   │   ├── rawmode.js                # Generic extractor for unsupported sites (on-demand)
│   │   └── linkedin.js               # /in/{slug}/details/experience/
│   ├── lib/
│   │   ├── schema.js                 # Conversation / Profile / Article types (kind discriminator)
│   │   ├── markdown.js               # HTML → Markdown converter (no deps)
│   │   └── defuddle.js               # Vendored Defuddle bundle, powers RawMode
│   ├── exporters/
│   │   └── exporters.js              # export{Markdown,Text,JSON,CSV} for conversations
│   │                                 # export{ProfileMarkdown,ProfileText,ProfileJSON,ProfileCSV} for profiles
│   │                                 # export{ArticleMarkdown,ArticleText,ArticleJSON,ArticleCSV} for RawMode
│   └── popup/
│       └── popup.html / .css / .js   # User-facing UI; branches on result kind
└── icons/
```

## RawMode

On any site not in the registry the popup shows `Unknown site. Using RawMode...` and a single `Analyze Page` button. Clicking it injects a generic content script that runs a **tiered extraction pipeline**:

1. **Defuddle** — full-fidelity article parsing on a re-parsed DOM clone (Defuddle is destructive). Returns title, byline, siteName, language, publishedTime, excerpt, word count, plus cleaned HTML. Then `lib/markdown.js` converts the HTML to Markdown.
2. **Semantic walker** — first `<main>` / `<article>` / `[role="main"]` element, with nav/aside/header/footer/script stripped, run through `htmlToMarkdown`. Used when Defuddle returns no useful content.
3. **Plain text** — `document.body.textContent` as a last-ditch fallback. Always succeeds on a non-empty page.

The chosen tier is recorded in the export's `extractorTier` field so you can spot when a page fell back. The four format buttons (Markdown / Text / JSON / CSV) replace the Analyze button once analysis completes, and the result is cached in `chrome.storage.session` keyed by tab + URL — re-opening the popup on the same page skips Analyze entirely. Navigating away or restarting the browser clears it.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select the `extension/` directory in this repo.
4. Pin the extension to the toolbar.
5. Open a supported page, click the icon, choose a format. The Download / Copy toggle above the format buttons decides whether the result is saved as a file or copied to the clipboard; the choice is remembered.

For LinkedIn specifically: open your (or another user's) profile, click **Show all experience**, and run DOM Daddy on the resulting `…/details/experience/` page. The popup will offer a "Take me there" shortcut if you click it on the wrong sub-page.

Works on any Chromium browser (Chrome, Edge, Brave, Arc, etc.).

## Architecture

### Data flow

```
Popup opened
  -> popup.js sends { type: 'EXTRACT' } to the active tab
  -> matching content script returns { kind, ...data }
  -> popup branches on kind, runs the right exporter
  -> chrome.downloads delivers the file
```

The shared schema (`extension/src/lib/schema.js`) is the contract between extractors and exporters. Three shapes today: `Conversation` (`kind: 'conversation'`), `Profile` (`kind: 'profile'`) and `Article` (`kind: 'article'`, RawMode).

### Why dynamic `import()` in content scripts?

MV3 doesn't allow content scripts to be declared as ES modules. To still share `markdown.js` and `schema.js` across extractors, each content script does `await import(chrome.runtime.getURL('src/lib/...js'))`. The shared files are listed under `web_accessible_resources` so they're loadable from the page context.

## Known limitations

- **Selectors drift.** When a site reorganizes, only that site's content script needs to change. Stable anchors:
  - ChatGPT: `[data-message-author-role]` / `[data-message-id]` inside `section[data-turn]`. The thread is virtualized with per-turn placeholder slots (no `[data-turn]` until scrolled into view), so the extractor scrolls each slot into view top→bottom and harvests as turns mount. In-prose file chips / download buttons are kept as text.
  - Claude: `[data-testid="transcript-row"]` → `[role="article"][aria-posinset]`; user text in `[data-testid="user-message"]`, assistant in `[data-is-streaming]`. The transcript is a windowed virtual list, so the extractor scrolls top→bottom and harvests rows by position until it has `aria-setsize` messages.
  - Gemini: `user-query`, `model-response` (Angular component tags). Gemini lazy-loads older turns when scrolled to the top, so the extractor scrolls up repeatedly until the turn count stops growing.
  - Google AI Mode: `[data-scope-id="turn"]` per turn; the query is the turn's `<h2>` ("You said: …"), the answer is `[data-subtree="aimc"] [data-container-id="main-col"]`. Headings are `div[role=heading][aria-level]` and are rewritten to `<hN>`; the disclaimer/share footer block is dropped. Only `google.com/search` URLs with `udm=50` or an `mtid` count as AI Mode — every other Google page falls through to RawMode.
  - AI Studio: `ms-chat-turn` → `.user-prompt-container` / `.model-prompt-container` → `.turn-content`; reasoning in `<ms-thought-chunk>`. Uses CDK virtual scrolling, so the extractor scrolls the chat top→bottom and harvests each turn as it mounts.
  - Perplexity: `[class~="group/user-bubble"]` for user queries, `[data-workflow-final-text] .prose` for answers. The thread is virtualized (off-screen turns are empty placeholders), so the extractor scrolls each slot into view and harvests as it mounts; citation pills are rewritten to links.
  - LinkedIn: `[componentkey^="entity-collection-item-"]` per company entry; we parse `innerText` line-by-line and ignore hashed CSS classes entirely.
- **Extraction scrolls the page.** Every chat host virtualizes or lazy-loads its transcript, so the extractors scroll through the conversation themselves, wait for turns to mount, and restore your scroll position afterwards. A long thread can take 20–60 s; keep the tab in the foreground while it runs — a background tab renders no frames, so nothing mounts. If an export still comes up short, the browser console will show a `[DOM Daddy]` warning saying how many turns never mounted.
- **Collapsed UIs lose data.** "Show thinking" details and LinkedIn's `…see more` may collapse content. Expand before extracting. Claude's collapsed thinking is not in the DOM at all; only the "Thought for Ns" label is.
- **LinkedIn React hydration race.** The `entity-collection-item-*` entries on the experience page render after the load event fires. The popup polls for up to ~6 seconds while LinkedIn hydrates, so a fast re-open immediately after navigation will wait briefly rather than fail.
- **LinkedIn `+N skills`.** The "+N skills" overflow on roles can't be pulled without clicking the chip — we capture the visible skills and store the hidden count as `hiddenSkillCount`.
- **Canvas / Artifacts** (ChatGPT side panel, Claude artifacts) contents aren't captured. Generated-file chips, download links and artifact cards are recorded by name in the message's `attachments` and kept as text in the Markdown.
- **No real chat timestamps.** None of the chat hosts expose creation date or per-message timestamps in the DOM, so the date in the filename is the export date.

### Filenames and download-manager extensions

Conversations: `{source}-YYYYMMDD-{sessionId}.{ext}`. Profiles: `{source}-{slug}-YYYYMMDD.{ext}`.

If the Save As dialog shows a *different* filename than what we suggested, another installed extension is hooking `chrome.downloads.onDeterminingFilename` and overwriting our suggestion (Chrome only honors the most recently installed listener — there's no override). The popup's green "Saved …" status surfaces the *real* on-disk filename, so you can compare.

Known offender: **Suno Tracks Exporter**. Disable it (or any other download-manager extension) while exporting if you need the suggested filename to land.

## Extending

Agent-facing guidance (architecture, DOM anchors, how to validate against a saved page or a live tab) lives in [`AGENTS.md`](AGENTS.md); `CLAUDE.md` is a symlink to it.

### Add a new conversation host

1. Add the host to `manifest.json` (`host_permissions`, `content_scripts`, `web_accessible_resources`).
2. Add a `SITES` entry in `extension/src/popup/popup.js` with `kind: 'conversation'`.
3. Copy an existing chat extractor and rewrite its selector block.

### Add a new structured-data host (profile-style)

1. Same manifest updates, plus a `pageReady`/`pageHint` if the data lives on a sub-page.
2. New extractor returning `makeProfile(...)` (or a new schema shape if the data isn't profile-like).
3. New exporters in `exporters.js` if a new kind needs different output formats.

### Add a new format

Add an `exportXxx(data, opts)` function in `exporters.js` returning `{ filename, blob }`, then wire a button in `popup.html` and a case in `runExport()` in `popup.js`.

## License

Code is licensed under the **Apache License 2.0** (see [`LICENSE`](LICENSE)) — you can use, modify, and redistribute it commercially, subject to the usual Apache obligations.

The name **DOM Daddy**, the mascot, and all files under `extension/icons/` plus `favicon.ico` are © Trollefsen Labs and are **not** covered by the code license. Forks must rename and re-skin before publishing to the Chrome Web Store or any other distribution channel. Full carve-out in [`NOTICE`](NOTICE).

## Why this exists

A from-scratch alternative to closed-source export extensions, with the goal of (1) keeping all extracted data inside the browser and (2) being trivially auditable — no minified bundles, no server, no analytics.
