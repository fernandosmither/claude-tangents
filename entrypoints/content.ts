import { TangentPopover } from '@/lib/popover';
import {
  createConversation,
  deleteConversation,
  drain,
  getChatOrgUuid,
  getTree,
  sendCompletion,
} from '@/lib/claude';
import { findAnchorUuid, getSelectionInfo, type SelectionInfo } from '@/lib/anchor';
import { buildSeed } from '@/lib/seed';
import { addTangent, getTangents, onTangentsChanged, removeTangent } from '@/lib/storage';
import type { TangentRecord } from '@/lib/types';

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  allFrames: true,
  runAt: 'document_idle',
  cssInjectionMode: 'manual',
  main() {
    if (location.pathname.startsWith('/login')) return;
    new TangentApp().start();
  },
});

function convUuidFromPath(): string | null {
  const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** claude.ai's floating selection toolbar (the dark pill containing "Reply"). Locale-independent. */
function findNativeToolbar(): HTMLElement | null {
  const toolbars = document.querySelectorAll<HTMLElement>('div[class*="bg-always-black"]');
  for (const d of toolbars) {
    const c = d.className.toString();
    if (c.includes('shadow-lg') && d.querySelector('button')) return d;
  }
  return null;
}

class TangentApp {
  private popovers = new Set<TangentPopover>();
  private pill: HTMLDivElement | null = null;
  private lastConv: string | null = null;

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
    this.onNavigate();
    onTangentsChanged(() => this.refreshPill());
  }

  // --- selection → a "Tangent" pill directly under claude.ai's native Reply toolbar ---

  private onSelection() {
    this.removeToolbarPill();
    const info = getSelectionInfo();
    if (!info || !convUuidFromPath()) return;
    // claude.ai's native Reply toolbar appears a beat after mouseup; place ours once it's there.
    let tries = 0;
    const tick = () => {
      const wrapper = findNativeToolbar();
      if (wrapper) return this.injectToolbarButton(wrapper, info);
      if (++tries < 18) setTimeout(tick, 60);
    };
    tick();
  }

  private removeToolbarPill() {
    document.querySelector('[data-tangent-toolbar-pill]')?.remove();
  }

  private injectToolbarButton(wrapper: HTMLElement, info: SelectionInfo) {
    if (document.querySelector('[data-tangent-toolbar-pill]')) return;
    const reply = wrapper.querySelector('button');
    const rect = wrapper.getBoundingClientRect();
    // a separate pill placed directly *under* the native Reply toolbar, matching its look
    const pill = document.createElement('div');
    pill.setAttribute('data-tangent-toolbar-pill', '');
    pill.className = wrapper.className; // clone the native pill (dark, rounded, shadow, blur)
    pill.style.position = 'fixed';
    pill.style.left = `${Math.round(rect.left)}px`;
    pill.style.top = `${Math.round(rect.bottom + 5)}px`;
    pill.style.zIndex = '2147483640';
    const btn = document.createElement('button');
    if (reply) btn.className = reply.className; // match the native button's layout + hover
    btn.style.color = '#e8967a'; // our accent, legible on the dark toolbar
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

      // generation runs in the background; reload the iframe once it's done so the
      // first answer is guaranteed to render even if mid-stream attach didn't work.
      drain(res)
        .catch(() => {})
        .finally(() => getPopover()?.notifyGenerationComplete());
      // NOTE: claude.ai has no per-conversation archive API, so tangents are labelled with a
      // "↳" title prefix instead of hidden (a future option is grouping them under a project).

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
      await addTangent(rec);
      this.refreshPill();
      this.decorateAnchors();
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

  // --- persistent tangent list (bottom-left pill) ---

  private async refreshPill() {
    const conv = convUuidFromPath();
    if (!conv) return this.removePill();
    const tangents = await getTangents(conv);
    if (!tangents.length) return this.removePill();
    if (!this.pill) {
      const p = document.createElement('div');
      p.setAttribute('data-tangent-pill', '');
      p.style.cssText =
        'position:fixed;left:14px;bottom:14px;z-index:2147483630;font:600 12px/1 ui-sans-serif,system-ui,sans-serif;';
      document.body.appendChild(p);
      this.pill = p;
    }
    this.pill.innerHTML = '';
    const badge = document.createElement('button');
    badge.textContent = `↳ ${tangents.length} tangent${tangents.length > 1 ? 's' : ''}`;
    badge.style.cssText =
      'padding:7px 11px;color:#fff;background:#d97757;border:0;border-radius:18px;box-shadow:0 3px 12px rgba(0,0,0,.25);cursor:pointer;';
    const list = document.createElement('div');
    list.style.cssText =
      'display:none;margin-bottom:8px;max-width:320px;max-height:50vh;overflow:auto;background:#fff;color:#1a1a1a;' +
      'border:1px solid rgba(0,0,0,.15);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.2);';
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      list.style.background = '#2b2b2b';
      list.style.color = '#ececec';
    }
    badge.onclick = () => (list.style.display = list.style.display === 'none' ? 'block' : 'none');
    for (const t of tangents) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid rgba(128,128,128,.15);';
      const open = document.createElement('button');
      open.textContent = t.title;
      open.title = 'Reopen tangent';
      open.style.cssText =
        'flex:1;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;font:13px/1.3 inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      open.onclick = () => {
        list.style.display = 'none';
        this.reopen(t);
      };
      const del = document.createElement('button');
      del.textContent = '🗑';
      del.title = 'Delete tangent';
      del.style.cssText = 'border:0;background:transparent;cursor:pointer;opacity:.6;';
      del.onclick = async () => {
        await removeTangent(conv, t.tangentId);
        this.refreshPill();
        this.decorateAnchors();
      };
      row.append(open, del);
      list.appendChild(row);
    }
    this.pill.append(list, badge);
  }

  private removePill() {
    this.pill?.remove();
    this.pill = null;
  }

  // --- inline anchors (non-destructive, via CSS Custom Highlight API) ---

  private async decorateAnchors() {
    const conv = convUuidFromPath();
    if (!conv || !('highlights' in CSS)) return;
    const tangents = await getTangents(conv);
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
  const roots = document.querySelectorAll('.font-claude-response, .font-claude-message');
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
