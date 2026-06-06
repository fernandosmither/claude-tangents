# Privacy Policy — Tangent

_Last updated: 2026-06-06_

Tangent is a browser extension that lets you fork side-conversations ("tangents") from a
Claude answer on **claude.ai**. This policy explains exactly what it does and doesn't do with
your data.

## Short version

**Tangent collects nothing. It has no servers, no analytics, and no telemetry.** It runs only on
`claude.ai`, talks only to `claude.ai` using your existing logged-in session, and stores a small
amount of data **locally on your device**.

## What Tangent stores, and where

The only data Tangent saves is a list of your tangents, kept in your browser's local extension
storage (`chrome.storage.local`) **on your device**. For each tangent this is:

- the text you highlighted and a little surrounding text (to re-locate the highlight),
- an identifier for the claude.ai conversation that backs the tangent, and
- a title and timestamp.

This never leaves your machine. It is not transmitted to the developer or to any third party.

## What Tangent sends, and to whom

To create and display a tangent, the extension makes requests **only to `claude.ai`** — the same
service you are already using — authenticated with **your own existing session**. It uses
claude.ai's own internal API to read the current conversation, create the forked conversation, and
render it. Tangent does not send your data anywhere else, and the developer never receives it.

## What Tangent does **not** do

- No data is sold or transferred to third parties.
- No data is used for advertising, profiling, creditworthiness, or any purpose unrelated to
  creating tangents.
- No remote code is loaded or executed; all extension code ships in the package.
- No tracking, analytics, fingerprinting, or external network calls of any kind.

## Permissions

- **`storage`** — to save your tangents locally (above).
- **Host access to `https://claude.ai/*`** — so the extension can run on claude.ai and use your
  session to read the conversation, inject the Tangent UI, and create the forked conversation.

## Removing your data

Delete individual tangents from the in-extension list (this also deletes the backing claude.ai
conversation), or remove all stored data by uninstalling the extension or clearing the
extension's storage in your browser.

## Contact

Questions: <anthropic@fdosmith.dev> · Source: <https://github.com/fernandosmither/claude-tangents>
