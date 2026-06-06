/**
 * Floating "Tangent" popover. Lives in a Shadow DOM (isolated from claude.ai's
 * styles). Two modes:
 *   - compose: shows the quoted highlight + a question box.
 *   - conversation: embeds an iframe of /chat/{tangentConvUuid} (claude.ai's own
 *     UI, with chrome + the seed message stripped via injected CSS).
 */

import { SEL } from './selectors';

export interface PopoverHandlers {
  /** Create the tangent conversation for `question`; resolve to its conv UUID, or throw on failure. */
  createTangent: (question: string) => Promise<string>;
  onClose?: () => void;
}

export interface PopoverInit {
  highlight: string;
  anchorRect?: DOMRect | null;
  existingConvUuid?: string; // reopen mode (skip compose)
  title?: string;
}

const CSS = `
:host { all: initial; }
.card {
  position: fixed; z-index: 2147000000;
  width: 460px; max-width: calc(100vw - 24px);
  height: 560px; max-height: calc(100vh - 24px);
  display: flex; flex-direction: column;
  background: var(--bg, #fff); color: var(--fg, #1a1a1a);
  border: 1px solid rgba(0,0,0,.14); border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.22);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  overflow: hidden;
}
@media (prefers-color-scheme: dark) {
  .card { --bg:#2b2b2b; --fg:#ececec; border-color: rgba(255,255,255,.14); }
}
.head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; cursor: grab; user-select: none;
  border-bottom: 1px solid rgba(128,128,128,.2); flex: 0 0 auto;
}
.head.grab { cursor: grabbing; }
.brand { font-weight: 600; font-size: 12px; letter-spacing: .02em; opacity: .8; }
.brand b { color: #d97757; }
.spacer { flex: 1; }
.iconbtn {
  border: 0; background: transparent; color: inherit; cursor: pointer;
  font-size: 15px; line-height: 1; padding: 4px 7px; border-radius: 6px; opacity: .7;
}
.iconbtn:hover { background: rgba(128,128,128,.18); opacity: 1; }
.quote {
  margin: 10px 12px 8px; padding: 8px 10px; font-size: 13px;
  border-left: 3px solid #d97757; background: rgba(217,119,87,.08);
  border-radius: 8px; max-height: 90px; overflow: auto; white-space: pre-wrap;
}
.compose { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
textarea {
  flex: 1; min-height: 80px; resize: none; padding: 9px 10px; font: inherit;
  color: inherit; background: rgba(128,128,128,.08);
  border: 1px solid rgba(128,128,128,.28); border-radius: 8px; outline: none;
}
textarea:focus { border-color: #d97757; }
.row { display: flex; align-items: center; gap: 8px; }
.hint { font-size: 11px; opacity: .55; }
.err { color: #e06c5b; font-size: 12px; padding: 2px 2px 0; white-space: pre-wrap; }
.btn {
  margin-left: auto; border: 0; background: #d97757; color: #fff; cursor: pointer;
  font: 600 13px/1 inherit; padding: 9px 14px; border-radius: 8px;
}
.btn:disabled { opacity: .5; cursor: default; }
.body { flex: 1; min-height: 0; position: relative; background: var(--bg,#fff); }
.body iframe { width: 100%; height: 100%; border: 0; display: block; transition: opacity .15s ease; }
.status { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  flex-direction: column; gap: 10px; font-size: 13px; opacity: .9; background: var(--bg,#fff); }
.dot { width: 8px; height: 8px; border-radius: 50%; background:#d97757; animation: p 1s infinite; }
@keyframes p { 0%,100%{opacity:.3} 50%{opacity:1} }
.resize { position:absolute; right:2px; bottom:2px; width:14px; height:14px; cursor:nwse-resize;
  opacity:.4; }
`;

/** CSS injected into the tangent iframe to strip claude.ai's chrome (verified live). */
const STRIP_CSS = `
nav { display: none !important; }
[data-testid="page-header"] { display: none !important; }
[data-testid="wiggle-controls-actions"] { display: none !important; }
[data-testid^="action-bar"] { display: none !important; }
div:has(> div > button[data-testid^="action-bar"]) { display: none !important; }
main { max-width: 100% !important; margin-left: 0 !important; padding: 6px 14px !important; }
[data-tangent-seed="1"] { display: none !important; }
`;

export class TangentPopover {
  readonly host: HTMLDivElement;
  private shadow: ShadowRoot;
  private card!: HTMLDivElement;
  private body!: HTMLDivElement;
  private iframe: HTMLIFrameElement | null = null;
  private stripObserver: MutationObserver | null = null;
  private overlay: HTMLDivElement | null = null;
  private revealed = false;
  private closed = false;
  private pendingConvUuid: string | null = null;
  private generationDone = false;
  /** The tangent conversation this popover shows (for de-duping + close-on-delete). */
  convUuid: string | null = null;

  constructor(
    private init: PopoverInit,
    private handlers: PopoverHandlers,
  ) {
    this.host = document.createElement('div');
    this.host.setAttribute('data-tangent-popover', '');
    this.shadow = this.host.attachShadow({ mode: 'open' });
    // Shadow-DOM retargeting hides our inputs from claude.ai's global "type-anywhere"
    // key handler, which would otherwise steal focus to the main composer. Stop key/input
    // events from propagating out of the popover.
    for (const t of ['keydown', 'keypress', 'keyup', 'input', 'beforeinput']) {
      this.host.addEventListener(t, (e) => e.stopPropagation());
    }
    const style = document.createElement('style');
    style.textContent = CSS;
    this.shadow.appendChild(style);
    this.buildShell();
    if (init.existingConvUuid) {
      this.convUuid = init.existingConvUuid;
      this.mountIframe(init.existingConvUuid);
    } else {
      this.renderCompose();
    }
  }

  mount(parent: HTMLElement = document.body): this {
    parent.appendChild(this.host);
    // Now that the host lives in its final document, position + raise it relative to THAT
    // window (for a sub-tangent that's the top-level page, not the parent tangent's iframe).
    this.position(this.card);
    this.card.style.zIndex = String(this.bumpZ());
    if (this.convUuid) this.host.dataset.tangentConv = this.convUuid;
    return this;
  }

  /** The window of the document the host is mounted in (the top-level page for sub-tangents). */
  private ownerWin(): Window {
    return (this.host.ownerDocument?.defaultView as Window) ?? window;
  }

  /** A z-index above every other tangent popover, counted on the shared (top-level) window so
   *  popovers from different frames stack correctly against each other. */
  private bumpZ(): number {
    // kept below the dropdown/banner layer and far under the 32-bit z-index ceiling (no overflow)
    const w = this.ownerWin() as unknown as { __tangentZ?: number };
    w.__tangentZ = Math.min(2147400000, Math.max(w.__tangentZ || 0, 2147000000) + 1);
    return w.__tangentZ;
  }

  private buildShell() {
    const card = document.createElement('div');
    card.className = 'card';
    // position + z-index are set in mount(), once the host's final (top-level) document is known

    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = `<span class="brand"><b>↳</b> Tangent</span><span class="spacer"></span>`;
    const close = document.createElement('button');
    close.className = 'iconbtn';
    close.textContent = '✕';
    close.title = 'Close';
    close.onclick = () => this.close();
    head.appendChild(close);
    this.enableDrag(card, head);
    card.addEventListener('mousedown', () => (card.style.zIndex = String(this.bumpZ())), true);

    const quote = document.createElement('div');
    quote.className = 'quote';
    quote.textContent = this.init.highlight;

    this.body = document.createElement('div');
    this.body.className = 'body';

    const resize = document.createElement('div');
    resize.className = 'resize';
    resize.innerHTML = '<svg width="14" height="14"><path d="M2 12 L12 2 M6 12 L12 6 M10 12 L12 10" stroke="currentColor" fill="none"/></svg>';
    this.enableResize(card, resize);

    card.append(head, quote, this.body, resize);
    this.shadow.appendChild(card);
    this.card = card;
  }

  private renderCompose() {
    const wrap = document.createElement('div');
    wrap.className = 'compose';
    const ta = document.createElement('textarea');
    ta.placeholder = 'Ask a tangent about the quoted text…';
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="hint">Forks the chat up to here · ⌘/Ctrl+Enter</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Ask';
    btn.disabled = true; // enabled once there's a question (styled via .btn:disabled)
    ta.addEventListener('input', () => (btn.disabled = !ta.value.trim()));
    const err = document.createElement('div');
    err.className = 'err';
    const submit = async () => {
      const q = ta.value.trim();
      if (!q || this.closed) return;
      btn.disabled = true;
      ta.disabled = true;
      err.textContent = '';
      btn.textContent = 'Forking…';
      try {
        const convUuid = await this.handlers.createTangent(q);
        if (this.closed) return;
        this.beginGenerating(convUuid);
      } catch (e) {
        if (this.closed) return;
        err.textContent = e instanceof Error ? e.message : String(e);
        btn.disabled = false;
        ta.disabled = false;
        btn.textContent = 'Ask';
      }
    };
    btn.onclick = submit;
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
    });
    row.appendChild(btn);
    wrap.append(ta, row, err);
    this.body.replaceChildren(wrap);
    setTimeout(() => ta.focus(), 0);
  }

  private showStatus(msg: string) {
    const s = document.createElement('div');
    s.className = 'status';
    s.innerHTML = `<div class="dot"></div><div>${msg}</div>`;
    this.body.replaceChildren(s);
  }

  private mountIframe(convUuid: string) {
    this.revealed = false;
    const iframe = document.createElement('iframe');
    iframe.style.opacity = '0'; // keep hidden until the seed message is stripped (no flash)
    iframe.src = `https://claude.ai/chat/${convUuid}`;
    iframe.addEventListener('load', () => this.onIframeLoad(iframe));
    this.iframe = iframe;
    const overlay = document.createElement('div');
    overlay.className = 'status';
    overlay.innerHTML = `<div class="dot"></div><div>Loading the tangent…</div>`;
    this.overlay = overlay;
    this.body.replaceChildren(iframe, overlay);
    setTimeout(() => this.reveal(), 20000); // last-resort reveal so it can never spin forever
  }

  private reveal() {
    if (this.revealed || this.closed) return;
    this.revealed = true;
    if (this.iframe) this.iframe.style.opacity = '1';
    this.overlay?.remove();
    this.overlay = null;
  }

  private onIframeLoad(iframe: HTMLIFrameElement) {
    this.applyStrip(iframe);
    // claude.ai re-renders as it streams; keep the strip applied.
    try {
      const doc = iframe.contentDocument!;
      this.stripObserver?.disconnect();
      this.stripObserver = new MutationObserver(() => this.applyStrip(iframe));
      this.stripObserver.observe(doc.documentElement, { childList: true, subtree: true });
    } catch {
      /* cross-origin shouldn't happen (same-origin claude.ai) */
    }
  }

  private applyStrip(iframe: HTMLIFrameElement) {
    let doc: Document | null = null;
    try {
      doc = iframe.contentDocument;
    } catch {
      return;
    }
    if (!doc || !doc.head) return;
    if (!doc.getElementById('tangent-strip')) {
      const st = doc.createElement('style');
      st.id = 'tangent-strip';
      st.textContent = STRIP_CSS;
      doc.head.appendChild(st);
    }
    // mark the seed (first user message bubble) so STRIP_CSS hides it
    const firstUser = doc.querySelector(SEL.userMessage);
    if (firstUser) {
      const bubble = (firstUser.closest(SEL.userBubble) as HTMLElement) || (firstUser as HTMLElement);
      if (bubble.getAttribute('data-tangent-seed') !== '1') bubble.setAttribute('data-tangent-seed', '1');
    }
    // reveal only once Claude's answer is actually rendered — during external generation the
    // iframe sits on the "New chat" page, so revealing earlier would flash that.
    if (doc.querySelector(SEL.assistantMessage)) this.reveal();
  }

  /** Generation finished and the conversation is filed — render it now (on the finished conv,
   *  which loads reliably, unlike a conversation that is still generating externally). */
  notifyGenerationComplete() {
    this.generationDone = true;
    if (this.pendingConvUuid && !this.iframe && !this.closed) this.mountIframe(this.pendingConvUuid);
  }

  /** Show a "generating" state; the iframe is mounted only once generation completes. */
  private beginGenerating(convUuid: string) {
    this.pendingConvUuid = convUuid;
    this.convUuid = convUuid;
    this.host.dataset.tangentConv = convUuid;
    this.showStatus('Generating the tangent…');
    if (this.generationDone) this.mountIframe(convUuid);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const end of [...this.activeGestures]) end(); // tear down any in-progress drag/resize
    this.stripObserver?.disconnect();
    this.removeShield();
    this.host.remove();
    this.handlers.onClose?.();
  }

  // --- positioning / drag / resize ---

  private position(card: HTMLElement) {
    const win = this.ownerWin();
    const r = this.init.anchorRect;
    const w = 460,
      h = 560;
    // anchored next to the selection (top-level tangents) or centered (sub-tangents / reopens)
    let left = r ? Math.min(r.right + 12, win.innerWidth - w - 12) : Math.round((win.innerWidth - w) / 2);
    let top = r ? Math.min(Math.max(12, r.top), win.innerHeight - h - 12) : Math.round((win.innerHeight - h) / 2);
    if (left < 12) left = 12;
    if (top < 12) top = 12;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  private enableDrag(card: HTMLElement, handle: HTMLElement) {
    let sx = 0,
      sy = 0,
      ox = 0,
      oy = 0;
    const move = (e: MouseEvent) => {
      card.style.left = `${ox + e.clientX - sx}px`;
      card.style.top = `${oy + e.clientY - sy}px`;
    };
    const up = () => {
      handle.classList.remove('grab');
      const win = this.ownerWin();
      win.removeEventListener('mousemove', move);
      win.removeEventListener('mouseup', up);
      this.removeShield();
      this.activeGestures.delete(up);
    };
    handle.addEventListener('mousedown', (e) => {
      if (this.closed) return;
      if ((e.target as HTMLElement).closest('.iconbtn')) return;
      handle.classList.add('grab');
      sx = e.clientX;
      sy = e.clientY;
      ox = parseFloat(card.style.left);
      oy = parseFloat(card.style.top);
      e.preventDefault();
      // Listen on the document the card actually lives in (the top page for sub-tangents), and
      // shield iframes so the pointer keeps reporting to that window mid-drag.
      this.addShield();
      const win = this.ownerWin();
      win.addEventListener('mousemove', move);
      win.addEventListener('mouseup', up);
      this.activeGestures.add(up); // so close() mid-drag tears these down
    });
  }

  private enableResize(card: HTMLElement, handle: HTMLElement) {
    let sx = 0,
      sy = 0,
      ow = 0,
      oh = 0;
    const move = (e: MouseEvent) => {
      card.style.width = `${Math.max(320, ow + e.clientX - sx)}px`;
      card.style.height = `${Math.max(280, oh + e.clientY - sy)}px`;
    };
    const up = () => {
      const win = this.ownerWin();
      win.removeEventListener('mousemove', move);
      win.removeEventListener('mouseup', up);
      this.removeShield();
      this.activeGestures.delete(up);
    };
    handle.addEventListener('mousedown', (e) => {
      if (this.closed) return;
      sx = e.clientX;
      sy = e.clientY;
      ow = card.offsetWidth;
      oh = card.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
      this.addShield();
      const win = this.ownerWin();
      win.addEventListener('mousemove', move);
      win.addEventListener('mouseup', up);
      this.activeGestures.add(up);
    });
  }

  /** A transparent, full-window cover placed just under the card while dragging/resizing, so the
   *  pointer keeps reporting to the top window even when it passes over a (tangent) iframe. */
  private shield: HTMLElement | null = null;
  /** Teardowns for in-progress drag/resize gestures, so closing mid-gesture doesn't leak window
   *  listeners (a set, so an overlapping drag+resize can't lose one of them). */
  private activeGestures = new Set<() => void>();
  private addShield() {
    const doc = this.host.ownerDocument;
    if (!doc) return;
    const s = doc.createElement('div');
    const z = Math.max(0, parseInt(this.card.style.zIndex || '0', 10) - 1);
    s.style.cssText = `position:fixed;inset:0;z-index:${z};`;
    doc.body.appendChild(s);
    this.shield = s;
  }
  private removeShield() {
    this.shield?.remove();
    this.shield = null;
  }
}
