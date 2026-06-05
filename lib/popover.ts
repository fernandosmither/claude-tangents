/**
 * Floating "Tangent" popover. Lives in a Shadow DOM (isolated from claude.ai's
 * styles). Two modes:
 *   - compose: shows the quoted highlight + a question box.
 *   - conversation: embeds an iframe of /chat/{tangentConvUuid} (claude.ai's own
 *     UI, with chrome + the seed message stripped via injected CSS).
 */

export interface PopoverHandlers {
  /** Create the tangent conversation for `question`; resolve to its conv UUID (or null on failure). */
  createTangent: (question: string) => Promise<string | null>;
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
  position: fixed; z-index: 2147483600;
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
  margin: 10px 12px 0; padding: 8px 10px; font-size: 13px;
  border-left: 3px solid #d97757; background: rgba(217,119,87,.08);
  border-radius: 0 6px 6px 0; max-height: 90px; overflow: auto; white-space: pre-wrap;
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
main { max-width: 100% !important; margin-left: 0 !important; padding: 6px 14px !important; }
[data-tangent-seed="1"] { display: none !important; }
`;

let zCounter = 2147483600;

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
      this.mountIframe(init.existingConvUuid);
    } else {
      this.renderCompose();
    }
  }

  mount(parent: HTMLElement = document.body): this {
    parent.appendChild(this.host);
    return this;
  }

  private buildShell() {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.zIndex = String(++zCounter);
    this.position(card);

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
    card.addEventListener('mousedown', () => (card.style.zIndex = String(++zCounter)), true);

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
    const submit = async () => {
      const q = ta.value.trim();
      if (!q || this.closed) return;
      btn.disabled = true;
      ta.disabled = true;
      this.showStatus('Forking the conversation…');
      const convUuid = await this.handlers.createTangent(q);
      if (this.closed) return;
      if (!convUuid) {
        this.showStatus('Could not create the tangent. Check the console.');
        return;
      }
      this.mountIframe(convUuid);
    };
    btn.onclick = submit;
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
    });
    row.appendChild(btn);
    wrap.append(ta, row);
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
    setTimeout(() => this.reveal(), 4000); // safety: reveal even if the seed marker never appears
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
    // mark the seed (first user message bubble) so STRIP_CSS hides it, then reveal
    const firstUser = doc.querySelector('[data-testid="user-message"]');
    if (firstUser) {
      const bubble = (firstUser.closest('[data-user-message-bubble]') as HTMLElement) || (firstUser as HTMLElement);
      if (bubble.getAttribute('data-tangent-seed') !== '1') bubble.setAttribute('data-tangent-seed', '1');
      this.reveal();
    }
  }

  /** Called when the seed generation has finished; ensures the answer is rendered. */
  notifyGenerationComplete() {
    const iframe = this.iframe;
    if (!iframe || this.closed) return;
    try {
      const doc = iframe.contentDocument;
      const hasAnswer = doc?.querySelector('.font-claude-response, .font-claude-message');
      if (!hasAnswer) iframe.contentWindow?.location.reload();
    } catch {
      /* ignore */
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stripObserver?.disconnect();
    this.host.remove();
    this.handlers.onClose?.();
  }

  // --- positioning / drag / resize ---

  private position(card: HTMLElement) {
    const r = this.init.anchorRect;
    const w = 460,
      h = 560;
    let left = r ? Math.min(r.right + 12, window.innerWidth - w - 12) : window.innerWidth - w - 24;
    let top = r ? Math.min(Math.max(12, r.top), window.innerHeight - h - 12) : 80;
    if (left < 12) left = 12;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  private enableDrag(card: HTMLElement, handle: HTMLElement) {
    let sx = 0,
      sy = 0,
      ox = 0,
      oy = 0,
      dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.iconbtn')) return;
      dragging = true;
      handle.classList.add('grab');
      sx = e.clientX;
      sy = e.clientY;
      ox = parseFloat(card.style.left);
      oy = parseFloat(card.style.top);
      e.preventDefault();
    });
    const move = (e: MouseEvent) => {
      if (!dragging) return;
      card.style.left = `${ox + e.clientX - sx}px`;
      card.style.top = `${oy + e.clientY - sy}px`;
    };
    const up = () => {
      dragging = false;
      handle.classList.remove('grab');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private enableResize(card: HTMLElement, handle: HTMLElement) {
    let sx = 0,
      sy = 0,
      ow = 0,
      oh = 0,
      rz = false;
    handle.addEventListener('mousedown', (e) => {
      rz = true;
      sx = e.clientX;
      sy = e.clientY;
      ow = card.offsetWidth;
      oh = card.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!rz) return;
      card.style.width = `${Math.max(320, ow + e.clientX - sx)}px`;
      card.style.height = `${Math.max(280, oh + e.clientY - sy)}px`;
    });
    window.addEventListener('mouseup', () => (rz = false));
  }
}
