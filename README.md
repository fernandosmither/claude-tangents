# Tangent

A browser extension for **claude.ai** that lets you fork a side-conversation from any
point in a Claude answer — without muddying your main chat.

Select any text inside a Claude answer, click the injected **↳ Tangent** button, and a
floating popover opens with that text quoted and the full prior conversation as context.
Ask your tangential question, get a real streaming back-and-forth, and your main thread is
never touched. Each tangent is its own claude.ai conversation (labelled with a `↳` prefix),
so it uses your subscription, the model your main chat uses, and is re-openable later from an
inline highlight or the tangent list.

> Status: early v1. Chrome first; Firefox to follow (built on WXT, which targets both).

## Why

While reading a long answer you often get a mid-reading question about one paragraph — a
tangent that would derail the main thread if you asked it inline. Tangent gives those
questions their own space and keeps your main conversation clean.

## How it works

Tangent reuses claude.ai's own backend and UI rather than reimplementing them:

1. On **↳ Tangent** (injected just under claude.ai's native Reply toolbar), it reads the
   current conversation's message tree and builds a faithful transcript up to the highlighted
   answer, plus the quoted excerpt and your question. It also **carries the source thread's
   media — with no re-upload**: uploaded **images/files** are re-linked by their org-scoped
   `file_uuid`, **documents** are re-attached with their inline extracted text, and
   **Claude-generated artifacts/files** are embedded as text (all of this already lives in the
   conversation tree).
2. It creates a **new, separate conversation** (`POST …/chat_conversations`) and seeds it
   with that context via a single `…/completion` call (with the `files`/`attachments` arrays),
   using the same model as your main chat.
3. It files that conversation under an auto-created **"↳ Tangents" project**, grouping your
   tangents together. (claude.ai has no API to keep a conversation out of Recents, so they
   also stay in your sidebar, labelled with the `↳` prefix.)
4. It renders the tangent by embedding `https://claude.ai/chat/<id>` in a **same-origin
   iframe** inside the popover and injecting CSS to strip claude.ai's chrome and the seed
   message — so you get claude.ai's real markdown, code rendering, model picker, and
   **live-streaming follow-up turns** for free. (The seeded first answer renders when
   generation completes; claude.ai's iframe can't attach to an in-flight external stream.)
5. Tangents are remembered in local extension storage and surfaced as an inline highlight
   (CSS Custom Highlight API — no DOM mutation) plus an indicator in claude.ai's **top action
   bar** (left of Share) that opens the per-conversation list.

All claude.ai-internal DOM selectors live in `lib/selectors.ts`; if a claude.ai update breaks
something, that's the first place to look — and the content script fails quietly (it never
breaks the page).

This relies on claude.ai's **internal, undocumented API**, reverse-engineered from the live
app. It may break when claude.ai changes; see `lib/claude.ts` for the endpoints used.

## Develop

```bash
pnpm install
pnpm dev          # launches Chrome with the extension (HMR)
pnpm dev:firefox  # Firefox
pnpm build        # production build → .output/chrome-mv3
pnpm zip          # packaged zip for store submission
```

To load a production build manually: `chrome://extensions` → enable Developer mode → **Load
unpacked** → select `.output/chrome-mv3`.

## Privacy

No telemetry, no analytics, no external servers. Tangent only talks to `claude.ai` using
your existing logged-in session, and stores tangent references in local extension storage on
your machine. Requests the minimum permissions: the `claude.ai` host and `storage`.

## License

[MIT](./LICENSE)
