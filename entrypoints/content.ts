import { TangentPopover } from '@/lib/popover';
import {
  createConversation,
  deleteConversation,
  drain,
  getChatOrgUuid,
  getOrCreateTangentsProject,
  getTree,
  moveToProject,
  sendCompletion,
} from '@/lib/claude';
import { findAnchorUuid, getSelectionInfo, type SelectionInfo } from '@/lib/anchor';
import { SEL, findSelectionToolbar } from '@/lib/selectors';
import { buildSeed } from '@/lib/seed';
import {
  addTangent,
  getTangents,
  isContextInvalidated,
  onTangentsChanged,
  removeTangent,
} from '@/lib/storage';
import type { TangentRecord } from '@/lib/types';

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  allFrames: true,
  runAt: 'document_idle',
  cssInjectionMode: 'manual',
  main() {
    if (location.pathname.startsWith('/login')) return;
    try {
      new TangentApp().start();
    } catch (e) {
      console.warn('[Tangent] failed to start', e);
    }
  },
});

function convUuidFromPath(): string | null {
  const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}


class TangentApp {
  private popovers = new Set<TangentPopover>();
  private indicator: HTMLButtonElement | null = null;
  private dropdown: HTMLDivElement | null = null;
  private tangentsCache: TangentRecord[] = [];
  private lastConv: string | null = null;
  private storageBannerShown = false;

  /** A storage op failed. If the extension was reloaded under this page, tell the user to
   *  reload it (the only fix); otherwise surface the real error. */
  private onStorageError(e: unknown) {
    if (isContextInvalidated(e)) this.showReloadBanner();
    else console.error('[Tangent] storage error', e);
  }

  private showReloadBanner() {
    if (this.storageBannerShown || document.querySelector('[data-tangent-reload-banner]')) return;
    this.storageBannerShown = true;
    const b = document.createElement('div');
    b.setAttribute('data-tangent-reload-banner', '');
    b.style.cssText =
      'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483646;' +
      'background:#d97757;color:#fff;font:600 13px/1.4 ui-sans-serif,system-ui,sans-serif;' +
      'padding:9px 14px;border-radius:9px;box-shadow:0 6px 20px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;';
    const msg = document.createElement('span');
    msg.textContent = '↳ Tangent was updated — reload this page (⌘R) to keep saving tangents.';
    const x = document.createElement('button');
    x.textContent = '✕';
    x.style.cssText = 'border:0;background:transparent;color:#fff;cursor:pointer;font-size:14px;opacity:.85;';
    x.onclick = () => b.remove();
    b.append(msg, x);
    document.body.appendChild(b);
  }

  start() {
    document.addEventListener('mouseup', (e) => {
      if ((e.target as HTMLElement)?.closest?.('[data-tangent-toolbar-pill]')) return; // our own button
      setTimeout(() => this.onSelection(), 0);
    });
    document.addEventListener('selectionchange', () => {
      if (window.getSelection()?.isCollapsed) this.removeToolbarPill();
    });
    // SPA navigation
    this.watchNavigation();
    this.watchToolbar();
    this.onNavigate();
    onTangentsChanged(() => this.refreshPill());
  }

  // --- selection → a "Tangent" pill directly under claude.ai's native Reply toolbar ---

  private onSelection() {
    try {
      this.removeToolbarPill();
      const info = getSelectionInfo();
      if (!info || !convUuidFromPath()) return;
      // claude.ai's native Reply toolbar appears a beat after mouseup; place ours once it's there.
      let tries = 0;
      const tick = () => {
        const wrapper = findSelectionToolbar();
        if (wrapper) return this.injectToolbarButton(wrapper, info);
        if (++tries < 18) setTimeout(tick, 60);
      };
      tick();
    } catch (e) {
      // Don't break the page on selector drift, but don't hide it either.
      console.warn('[Tangent] selection handler failed', e);
    }
  }

  private removeToolbarPill() {
    document.querySelector('[data-tangent-toolbar-pill]')?.remove();
  }

  private injectToolbarButton(wrapper: HTMLElement, info: SelectionInfo) {
    if (document.querySelector('[data-tangent-toolbar-pill]')) return;
    const reply = wrapper.querySelector('button');
    wrapper.style.transform = ''; // reset in case claude.ai is reusing the toolbar element
    const rect = wrapper.getBoundingClientRect();

    // a matching pill placed where the toolbar currently sits…
    const pill = document.createElement('div');
    pill.setAttribute('data-tangent-toolbar-pill', '');
    pill.className = wrapper.className; // clone the native pill (dark, rounded, shadow, blur)
    pill.style.position = 'fixed';
    pill.style.left = `${Math.round(rect.left)}px`;
    pill.style.top = `${Math.round(rect.top)}px`;
    pill.style.zIndex = '2147483640';
    const btn = document.createElement('button');
    if (reply) btn.className = reply.className; // match the native button's layout + hover
    btn.style.color = '#e8967a'; // our accent, legible on the dark toolbar
    btn.style.justifyContent = 'center';
    btn.innerHTML = '↳&nbsp;Tangent';
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection alive
    btn.addEventListener('click', () => {
      const sel = window.getSelection();
      const r =
        sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : pill.getBoundingClientRect();
      this.removeToolbarPill();
      window.getSelection()?.removeAllRanges();
      this.openCompose(info, r);
    });
    pill.appendChild(btn);
    document.body.appendChild(pill);

    // …and lift the native Reply toolbar up by our height, so Reply stacks *above* ours
    // and both stay clear of the selected text. (transform survives claude.ai's re-renders.)
    const ph = pill.getBoundingClientRect().height || 34;
    wrapper.style.transform = `translateY(${-(ph + 2)}px)`;
  }

  // --- compose + create tangent ---

  private openCompose(info: SelectionInfo, rect: DOMRect) {
    const mainConv = convUuidFromPath();
    if (!mainConv) return;
    let popover: TangentPopover;
    popover = new TangentPopover(
      { highlight: info.highlight, anchorRect: rect },
      {
        createTangent: (question) => this.createTangent(mainConv, info, question, () => popover),
        onClose: () => this.popovers.delete(popover),
      },
    ).mount();
    this.popovers.add(popover);
  }

  private async createTangent(
    mainConv: string,
    info: SelectionInfo,
    question: string,
    getPopover: () => TangentPopover,
  ): Promise<string> {
    try {
      const org = await getChatOrgUuid();
      const tree = await getTree(mainConv, org);
      const anchorUuid =
        findAnchorUuid(tree, info.highlight, info.prefix) ||
        [...tree.chat_messages].reverse().find((m) => m.sender === 'assistant')?.uuid;
      if (!anchorUuid) throw new Error('No Claude answer found to fork from.');
      const model = tree.model || 'claude-sonnet-4-5';
      const seed = buildSeed({ tree, anchorMessageUuid: anchorUuid, highlight: info.highlight, question });

      const title = `↳ ${info.highlight.slice(0, 48)}`;
      const tangentConv = await createConversation(title, org);
      const res = await sendCompletion({ convUuid: tangentConv, prompt: seed, model, org });
      if (!res.ok) {
        deleteConversation(tangentConv, org).catch(() => {}); // clean up the empty conversation
        throw new Error(`Claude rejected the request (HTTP ${res.status}).`);
      }

      // When generation finishes: file the tangent under the "↳ Tangents" project (AFTER
      // generation, so the move never disturbs the in-flight message), then tell the popover
      // to render the finished conversation. We render only when complete because claude.ai's
      // iframe shows "New chat" / "message wasn't sent" while a conversation generates externally.
      drain(res)
        .catch(() => {})
        .finally(async () => {
          await getOrCreateTangentsProject(org)
            .then((proj) => moveToProject(tangentConv, proj, org))
            .catch((e) => console.warn('[Tangent] could not file under the Tangents project', e));
          getPopover()?.notifyGenerationComplete();
        });

      const rec: TangentRecord = {
        tangentId: uid(),
        mainConvUuid: mainConv,
        anchorMessageUuid: anchorUuid,
        highlightText: info.highlight,
        prefix: info.prefix,
        suffix: info.suffix,
        tangentConvUuid: tangentConv,
        title,
        createdAt: Date.now(),
      };
      // Persistence is best-effort: if local storage is unavailable, the tangent still
      // opens (you just lose the pill + inline anchor) rather than failing outright.
      try {
        await addTangent(rec);
        this.refreshPill();
        this.decorateAnchors();
      } catch (e) {
        this.onStorageError(e); // tangent still created; prompt a reload if storage is dead
      }
      return tangentConv;
    } catch (err) {
      console.error('[Tangent] createTangent failed', err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private reopen(rec: TangentRecord) {
    let popover: TangentPopover;
    popover = new TangentPopover(
      { highlight: rec.highlightText, existingConvUuid: rec.tangentConvUuid, title: rec.title },
      { createTangent: async () => rec.tangentConvUuid, onClose: () => this.popovers.delete(popover) },
    ).mount();
    this.popovers.add(popover);
  }

  // --- top-bar tangent indicator + dropdown list ---

  private async refreshPill() {
    const conv = convUuidFromPath();
    if (!conv) {
      this.tangentsCache = [];
      return this.removeIndicator();
    }
    try {
      this.tangentsCache = await getTangents(conv);
    } catch (e) {
      return this.onStorageError(e);
    }
    this.renderIndicator();
  }

  /** Place/update the indicator as the leftmost item in claude.ai's top action bar
   *  (where the artifacts icon sits, just left of Share). */
  private renderIndicator() {
    if (!convUuidFromPath() || !this.tangentsCache.length) return this.removeIndicator();
    const toolbar = document.querySelector('[data-testid="wiggle-controls-actions"]');
    if (!toolbar) return; // top bar not rendered yet — the toolbar observer retries
    if (!this.indicator || !toolbar.contains(this.indicator)) {
      this.indicator?.remove();
      this.indicator = this.buildIndicator();
      toolbar.prepend(this.indicator); // leftmost
    }
    const n = this.tangentsCache.length;
    const count = this.indicator.querySelector('[data-count]');
    if (count) count.textContent = String(n);
    this.indicator.title = `${n} tangent${n > 1 ? 's' : ''}`;
  }

  private buildIndicator(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.setAttribute('data-tangent-indicator', '');
    btn.style.cssText =
      'display:inline-flex;align-items:center;gap:5px;height:34px;padding:0 9px;margin-right:6px;border:0;' +
      'border-radius:9px;background:transparent;cursor:pointer;font:600 12px/1 ui-sans-serif,system-ui,sans-serif;transition:background .12s;';
    btn.onmouseenter = () => (btn.style.background = 'rgba(255,255,255,.09)');
    btn.onmouseleave = () => (btn.style.background = 'transparent');
    btn.innerHTML =
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#d97757" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v8a4 4 0 0 0 4 4h6"/>' +
      '<path d="M14 13l3 3-3 3"/></svg><span data-count style="color:#d97757">0</span>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown(btn);
    });
    return btn;
  }

  private toggleDropdown(anchor: HTMLElement) {
    if (this.dropdown) return this.removeDropdown();
    const conv = convUuidFromPath();
    if (!conv) return;
    const list = document.createElement('div');
    list.setAttribute('data-tangent-dropdown', '');
    const r = anchor.getBoundingClientRect();
    list.style.cssText =
      `position:fixed;top:${Math.round(r.bottom + 6)}px;right:${Math.round(Math.max(8, window.innerWidth - r.right))}px;` +
      'z-index:2147483640;min-width:240px;max-width:360px;max-height:60vh;overflow:auto;border-radius:10px;' +
      'background:#2b2b2b;color:#ececec;border:1px solid rgba(128,128,128,.25);' +
      'box-shadow:0 12px 32px rgba(0,0,0,.32);font:13px/1.4 ui-sans-serif,system-ui,sans-serif;';
    for (const t of this.tangentsCache) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid rgba(128,128,128,.15);';
      const open = document.createElement('button');
      open.textContent = t.title;
      open.title = 'Reopen tangent';
      open.style.cssText =
        'flex:1;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;font:13px/1.3 inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      open.onclick = () => {
        this.removeDropdown();
        this.reopen(t);
      };
      const del = document.createElement('button');
      del.textContent = '🗑';
      del.title = 'Delete tangent';
      del.style.cssText = 'border:0;background:transparent;cursor:pointer;opacity:.6;';
      del.onclick = async () => {
        try {
          await removeTangent(conv, t.tangentId);
        } catch (e) {
          return this.onStorageError(e);
        }
        this.removeDropdown();
        this.refreshPill();
        this.decorateAnchors();
      };
      row.append(open, del);
      list.appendChild(row);
    }
    document.body.appendChild(list);
    this.dropdown = list;
    setTimeout(() => document.addEventListener('mousedown', this.onDocClick), 0);
  }

  private onDocClick = (e: MouseEvent) => {
    const t = e.target as Node;
    if (this.dropdown && !this.dropdown.contains(t) && !this.indicator?.contains(t)) this.removeDropdown();
  };

  private removeDropdown() {
    document.removeEventListener('mousedown', this.onDocClick);
    this.dropdown?.remove();
    this.dropdown = null;
  }

  private removeIndicator() {
    this.indicator?.remove();
    this.indicator = null;
    this.removeDropdown();
  }

  /** claude.ai re-renders the top bar + sidebar; re-apply our injections when it does. */
  private watchToolbar() {
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        if (this.tangentsCache.length) this.renderIndicator();
        this.hideSidebarTangents();
      }, 250);
    }).observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Hide tangent rows from claude.ai's sidebar Recents. claude.ai has no API to keep a
   * conversation out of Recents (project membership doesn't do it), so we hide the rows
   * client-side. Tangents stay reachable via the top-bar indicator and the "↳ Tangents"
   * project. Identified by our "↳" title prefix.
   */
  private hideSidebarTangents() {
    const nav = document.querySelector('nav');
    if (!nav) return;
    for (const a of nav.querySelectorAll<HTMLAnchorElement>('a[href*="/chat/"]')) {
      if (!(a.textContent || '').trim().startsWith('↳')) continue;
      const row = (a.closest('li') as HTMLElement) || a;
      row.style.display = 'none';
    }
  }

  // --- inline anchors (non-destructive, via CSS Custom Highlight API) ---

  private async decorateAnchors() {
    const conv = convUuidFromPath();
    if (!conv || !('highlights' in CSS)) return;
    let tangents: TangentRecord[];
    try {
      tangents = await getTangents(conv);
    } catch (e) {
      return this.onStorageError(e);
    }
    this.ensureHighlightStyle();
    const ranges: Range[] = [];
    for (const t of tangents) {
      const r = findTextRange(t.highlightText);
      if (r) ranges.push(r);
    }
    const hl = new Highlight(...ranges);
    CSS.highlights.set('tangent', hl);
  }

  private ensureHighlightStyle() {
    if (document.getElementById('tangent-hl-style')) return;
    const st = document.createElement('style');
    st.id = 'tangent-hl-style';
    st.textContent = `::highlight(tangent){ background: rgba(217,119,87,.22); text-decoration: underline; text-decoration-color:#d97757; text-underline-offset:2px; }`;
    document.head.appendChild(st);
  }

  // --- SPA navigation ---

  private watchNavigation() {
    const fire = () => this.onNavigate();
    const push = history.pushState;
    history.pushState = function (...a) {
      const r = push.apply(this, a as never);
      window.dispatchEvent(new Event('tangent:navigate'));
      return r;
    };
    const replace = history.replaceState;
    history.replaceState = function (...a) {
      const r = replace.apply(this, a as never);
      window.dispatchEvent(new Event('tangent:navigate'));
      return r;
    };
    window.addEventListener('popstate', fire);
    window.addEventListener('tangent:navigate', fire);
  }

  private onNavigate() {
    const conv = convUuidFromPath();
    if (conv === this.lastConv) return;
    this.lastConv = conv;
    this.refreshPill();
    // claude.ai renders the conversation async; retry decoration a few times.
    let n = 0;
    const tick = () => {
      this.decorateAnchors();
      if (++n < 6) setTimeout(tick, 700);
    };
    setTimeout(tick, 500);
  }
}

/** Build a Range spanning the first occurrence of `text` within the conversation. */
function findTextRange(text: string): Range | null {
  const needle = text.trim();
  if (needle.length < 3) return null;
  const roots = document.querySelectorAll(SEL.assistantMessage);
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    // single text-node fast path
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const idx = (node.textContent || '').indexOf(needle);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        return range;
      }
    }
  }
  return null;
}
