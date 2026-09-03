# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, etc.) when working with code in this repository.

## Project

Manifest V3 Chrome extension (DOM Daddy) that extracts structured data from sites that fight scraping. Today it covers five LLM chat hosts (ChatGPT / Claude / Gemini / Google AI Studio / Perplexity), LinkedIn experience pages, and a generic "RawMode" article extractor that can be injected into any page on demand. Pure client-side, no build step, no dependencies. PDF export is descoped — `exportPrintableHTML` in `exporters.js` is left as scaffolding but is not wired into the popup.

`CLAUDE.md` is a symlink to this file so Claude Code and other agents read the same guidance. Edit `AGENTS.md`, never the symlink.

## Running / testing

There is no build, no test suite, no linter. The loadable extension lives in `extension/` — point "Load unpacked" at that folder, not the repo root. Reload the extension after edits; content-script changes also require reloading the target tab.

**Offline regression against a saved page.** Chrome's "Save page as → Webpage, Complete" captures the live DOM of a chat, which is enough to run a content script under jsdom: stub `chrome.runtime.getURL` to return `file://` paths into `extension/`, stub `chrome.runtime.onMessage.addListener` to capture the listener, stub `Element.prototype.scrollIntoView` / `window.scrollTo`, evaluate the script, then invoke the listener with `{ type: 'EXTRACT' }`. Lower the extractor's `MOUNT_TIMEOUT_MS` first, otherwise every unmountable placeholder waits the full timeout. This validates selectors and clean-up but *not* virtualization — a saved page never mounts anything new.

**Live validation.** Virtualization can only be checked on a foreground tab: a hidden/background tab renders almost no frames and `IntersectionObserver` callbacks never fire, so nothing ever mounts (this also means browser-automation tools driving a background window will report every turn as "never mounted"). The fastest check is a DevTools console dry run that mirrors the extractor's walk and prints one row per turn; compare its count with the real conversation length. Every extractor also `console.warn`s with a `[DOM Daddy]` prefix when it knows the export is incomplete.

## Architecture

The contract between every layer is the schema in `extension/src/lib/schema.js`. There are two shapes today, discriminated by `kind`:

- `Conversation` (`kind: 'conversation'`) — for the five chat hosts. Has `messages[]`; a message may carry `attachments[]` (`{ name, type }`, where `type` is `file`, `image` or `artifact`) and `reasoning`.
- `Profile` (`kind: 'profile'`) — for LinkedIn (and future profile-style hosts). Has `experiences[].roles[]`.
- `Article` (`kind: 'article'`) — for RawMode.

Extractors produce one; exporters consume one. Keep that boundary clean — extractor-specific quirks should not leak into exporters, and vice versa.

**Message flow:** popup → `chrome.tabs.sendMessage({ type: 'EXTRACT' })` → site-specific content script walks the DOM → returns `{ ok: true, data: <Conversation | Profile> }` → popup branches on `data.kind` and runs the right exporter → `chrome.downloads`.

**Three layers:**
- `extension/src/content/{chatgpt,claude,gemini,aistudio,perplexity,linkedin}.js` — one extractor per host; `rawmode.js` is injected via `chrome.scripting.executeScript` and has no manifest entry.
- `extension/src/lib/{schema,markdown}.js` — shared. `markdown.js` is a hand-rolled HTML→Markdown converter with site-aware branches (e.g. KaTeX math source extraction).
- `extension/src/exporters/exporters.js` — pure functions `(data, opts) => { filename, blob }`. Conversation: `exportMarkdown / Text / JSON / CSV`. Profile: `exportProfileMarkdown / JSON / CSV`. Both branches share the `filename()` helper, which keys off `data.kind`.

**Extraction is async.** Every chat extractor's `EXTRACT` handler returns `true` and calls `sendResponse` from a promise, because the virtualized hosts require scrolling and waiting. A long ChatGPT/Claude thread can take 20–60 s; the popup shows "Extracting…" for the duration. Extractors save and restore the scroll position of the real scroll container (never assume `window` scrolls — every host uses an inner `overflow-y: auto` div).

**Popup** (`extension/src/popup/popup.js`) holds the host registry (`SITES`). Each entry declares `source`, `kind`, content-script path, and optional `pageReady`/`pageHint`/`pageHintAction` for sub-page-only extractors (LinkedIn). The popup branches its UI off `kind` — profiles hide the Text format and the reasoning toggle.

**MV3 module sharing constraint:** Content scripts in MV3 cannot be declared as ES modules. All extractors share `lib/*.js` via runtime `await import(chrome.runtime.getURL('src/lib/...js'))`. That's why `extension/src/lib/*.js` is listed under `web_accessible_resources` in `manifest.json`. The popup and service worker are real ES modules.

**Service worker** (`extension/src/background/service-worker.js`) is intentionally thin — lifecycle hooks only. Don't put extraction or export logic there; the popup drives both.

## Adding things

- **New conversation host:** update `manifest.json` (host_permissions, content_scripts, web_accessible_resources), add a `SITES` entry in `popup.js` with `kind: 'conversation'`, copy an existing chat extractor and rewrite its `SELECTORS`.
- **New profile-style host:** same manifest updates plus a `SITES` entry with `kind: 'profile'` and (if the data lives on a sub-page) `pageReady` / `pageHint` / `pageHintAction`. Extractor calls `makeProfile(...)`. If the new host's data isn't profile-shaped, define a new schema shape with its own `kind` and add matching exporters.
- **New format:** add `exportXxx` in `exporters.js` returning `{filename, blob}`, then wire a button in `popup.html` and a case in `runExport()` in `popup.js`.

## Known DOM fragility

Selectors drift; this is expected. All four of the big chat hosts virtualize their transcripts as of Sep 2026, each differently, and every one of them broke the original "query all message nodes" approach at once — expect the same to happen again. The pattern that works: find the persistent list container, treat each child as a slot, scroll empty slots into view, wait for content to mount (poll, don't sleep a fixed time — mount latency ranged from 50 ms to 2.1 s), harvest everything mounted after every wait (not just the target slot, since neighbours mount and unmount as you go), retry misses with a different `scrollIntoView` block, and order by the host's own index attribute rather than DOM order.

Stable anchors currently relied on (verified live 2026-09-03):

- ChatGPT: `[data-message-author-role]`, `[data-message-id]`. The thread list has one child ("slot") per turn; only turns near the viewport are mounted as `[data-turn-id-container] > section[data-turn][data-testid="conversation-turn-N"]`, the rest are empty placeholder divs styled with `--last-known-height` / `--estimated-turn-height`. `[data-turn]` is therefore *not* a persistent anchor — the extractor walks the slots top→bottom, scrolls each placeholder into view, waits for it to mount, and harvests. Generated-file chips and download links are `<button>`s *inside* the prose; `stripJunk` unwraps in-prose buttons to text instead of deleting them.
- Claude: `[data-testid="transcript-list"]` → `[data-testid="transcript-row"]` → `[role="article"][aria-posinset][aria-setsize]`; user text in `[data-testid="user-message"]`, assistant in `[data-is-streaming]` (`.font-claude-message` is gone). The transcript is a windowed virtual list (only ~5 rows mounted, spacers above/below), so the extractor scrolls top→bottom harvesting rows by `aria-posinset` until it holds `aria-setsize` messages. Inside assistant nodes, strip `h2[data-find-omitted]` ("Claude responded: …" a11y heading), `[data-cds="TurnStatus"]` ("Thought for 39s"), `[data-cds="MessageActions"]`; artifact cards are `[class~="group/artifact-block"][data-sheet-kind]` and are exported as attachments. A row can also be an `[data-testid="ask-user-answers-card"]` (Claude asked a question, the user picked an answer — exported as a user message with the question as a blockquote) or completely empty (interrupted turn — skipped without a warning). Collapsed thinking is *not* in the DOM; only the "Thought for Ns" label is.
- Google AI Studio: `ms-chat-turn` → `.user-prompt-container` / `.model-prompt-container` → `.turn-content`; reasoning in `<ms-thought-chunk>`. CDK virtual scrolling — the extractor scrolls top→bottom harvesting turns by id.
- Gemini: `user-query`, `model-response` (Angular component tags); user text in `.query-text`, answer in `model-response .markdown`. Gemini does not virtualize but *lazy-loads* older turns when the conversation is scrolled to the top (a 34-turn chat opens with 20 in the DOM), so the extractor scrolls to the top repeatedly until the turn count stops growing.
- Perplexity: `[class~="group/user-bubble"]` for user queries (timestamp in a trailing `.absolute` span, quoted snippet in a `border-l-` span, long queries CSS-clamped behind a "Read more" button but fully present in the DOM), `[data-workflow-final-text] .prose` for answers. The thread list is one flat container of (query, steps, answer) children; off-screen turns are present but *empty* placeholders, so the extractor scrolls each empty slot into view and harvests as it mounts. Citation pills `[data-pplx-citation-url]` are rewritten to links.
- LinkedIn: `[componentkey^="entity-collection-item-"]` for one entry per company. The hashed CSS classes (e.g. `cf1bc804 d85601f3 ...`) churn weekly — **don't write CSS-class-based selectors**. The new SDUI framework also renders text only once (no `aria-hidden`/`visually-hidden` duplication), so the linkedin extractor parses `innerText` line-by-line into a small state machine. Two text shapes (grouped multi-role at one company vs. flat single role) are documented at the top of `linkedin.js`.

Collapsed "Show thinking" details and LinkedIn `…see more` are the remaining reasons an extraction returns partial data — expand before exporting. Canvas/Artifacts panel *contents* are not captured; only the card name is recorded as an attachment. LinkedIn's `+N skills` overflow can't be read without clicking the chip; we record `hiddenSkillCount` so the export is honest about the gap.

## Releases and versioning

Every functional change ships as a tagged release; docs/chore commits do not. The convention, which has been followed for every version so far:

1. **Bump `extension/manifest.json` `version`** in the same commit as the change (semver: patch for fixes and selector repairs to one host, minor for new hosts/formats or rewrites that touch several hosts, major reserved for schema breaks).
2. **Commit subject `vX.Y.Z: <lowercase summary>`**, body with grouped bullets explaining *why* (see `git log v0.4.0` for the shape). Use `docs:` / `chore:` prefixes without a version for non-functional commits.
3. **Annotated tag `vX.Y.Z`** on that commit, tag message = the commit subject (`git tag -a vX.Y.Z -m "vX.Y.Z: <summary>"`).
4. **GitHub release** on the tag: title `vX.Y.Z — <Capitalized summary>`, body = the commit body's bullets followed by `**Full Changelog**: https://github.com/da-troll/DOM-Daddy/compare/vPREV...vX.Y.Z`. No build artifacts are attached — users load `extension/` unpacked.

`gh release create vX.Y.Z --title "vX.Y.Z — …" --notes-file <file>` after `git push --follow-tags`. Check `git tag -l --sort=-v:refname | head -1` and `gh release list` before choosing the next number.

## Filenames and other download-manager extensions

- Conversations: `{source}-YYYYMMDD-{sessionId}.{ext}`. Date is `exportedAt` (export moment) — none of the chat hosts expose chat creation date or per-message timestamps in the DOM. `sessionId` is parsed from `location.pathname` per extractor (`/c/{id}`, `/chat/{id}`, `/app/{id}`, `/search/{id}`).
- Profiles: `{source}-{slug}-YYYYMMDD.{ext}`. `slug` is the `/in/{slug}/` URL slug.

Both branches live in `filename()` in `exporters.js`, switched on `obj.kind`.

If a user reports that the Save As dialog shows a *different* filename than what we suggested, it is almost always another installed extension hooking `chrome.downloads.onDeterminingFilename` (e.g. download managers; "Suno Tracks Exporter" was the confirmed culprit once). Chrome only honors the most recently installed listener and exposes no override — there is no fix on our side. The popup waits for `chrome.downloads.onChanged` to report `complete` and surfaces the *actual* on-disk filename in the "Saved …" status, so you can tell whether a rewrite happened by comparing dialog-suggestion vs. status-line.
