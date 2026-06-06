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
import { buildRootMaps, locateHighlight } from '@/lib/highlight';
import { SEL, findSelectionToolbar } from '@/lib/selectors';
import { buildSeed, collectMedia } from '@/lib/seed';
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

// --- top-level page helpers (popovers from inside a tangent iframe live in the same space) ---

function topWin(): Window {
  try {
    return window.top ?? window;
  } catch {
    return window;
  }
}
function topDoc(): Document {
  try {
    return topWin().document;
  } catch {
    return document;
  }
}
/** True when this content script is running inside a tangent's iframe rather than the page. */
function inSubframe(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}
// Popover stacking range, kept below the dropdown/banner layer (2147483640+) and far under the
// 32-bit CSS z-index ceiling (2147483647) so the monotonic counter can't overflow it.
const Z_BASE = 2147000000;
const Z_CAP = 2147400000;
function bumpTopZ(): number {
  const w = topWin() as unknown as { __tangentZ?: number };
  w.__tangentZ = Math.min(Z_CAP, Math.max(w.__tangentZ || 0, Z_BASE) + 1);
  return w.__tangentZ;
}
/** An open popover for `convUuid`, if any — found in the shared top-level document, so it works
 *  regardless of which frame opened it. */
function findPopoverHost(convUuid: string): HTMLElement | null {
  try {
    return topDoc().querySelector<HTMLElement>(`[data-tangent-popover][data-tangent-conv="${CSS.escape(convUuid)}"]`);
  } catch {
    return null;
  }
}
/** Raise + recenter an already-open popover (cross-frame, via its DOM). */
function focusPopoverHost(host: HTMLElement): void {
  const card = host.shadowRoot?.querySelector<HTMLElement>('.card');
  if (!card) return;
  const win = topWin();
  card.style.zIndex = String(bumpTopZ());
  const w = card.offsetWidth || 460;
  const h = card.offsetHeight || 560;
  card.style.left = `${Math.max(8, Math.round((win.innerWidth - w) / 2))}px`;
  card.style.top = `${Math.max(8, Math.round((win.innerHeight - h) / 2))}px`;
  card.animate?.([{ outline: '2px solid #d97757' }, { outline: '2px solid transparent' }], { duration: 700 });
}
/** Close an open popover for a tangent (cross-frame) by triggering its ✕. */
function closePopoverFor(convUuid: string): void {
  findPopoverHost(convUuid)?.shadowRoot?.querySelector<HTMLElement>('.iconbtn')?.click();
}

/** A tangent plus its sub-tangents (tangents created from inside it), built by walking each
 *  tangent's own conversation for child tangents. */
interface TangentNode extends TangentRecord {
  children: TangentNode[];
}
async function buildTangentTree(conv: string, seen = new Set<string>()): Promise<TangentNode[]> {
  if (seen.has(conv)) return []; // guard against any accidental cycle
  seen.add(conv);
  const list = await getTangents(conv);
  const out: TangentNode[] = [];
  for (const t of list) {
    out.push({ ...t, children: await buildTangentTree(t.tangentConvUuid, seen) });
  }
  return out;
}
function countTree(nodes: TangentNode[]): number {
  return nodes.reduce((n, t) => n + 1 + countTree(t.children), 0);
}

/** An outline trash-can, matching claude.ai's icon weight (their own is a private icon-font glyph,
 *  not an embeddable SVG). */
const TRASH_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
  '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
  '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';


class TangentApp {
  private popovers = new Set<TangentPopover>();
  private indicator: HTMLButtonElement | null = null;
  private dropdown: HTMLDivElement | null = null;
  private tangentsCache: TangentNode[] = [];
  private lastConv: string | null = null;
  private storageBannerShown = false;
  /** Live ranges for the inline highlights, so a click can be hit-tested back to its tangent
   *  (the CSS Custom Highlight API paints no element, so there's nothing to attach a handler to). */
  private anchors: { rec: TangentRecord; range: Range }[] = [];
  private cursorOn = false;
  private hoverScheduled = false;
  /** The tangent list + conversation the highlights were last read for, so a re-render can
   *  re-apply them without another storage round-trip (and against the right conversation). */
  private anchorTangents: TangentRecord[] = [];
  private anchorConv: string | null = null;
  private unsub: (() => void) | null = null;
  private toolbarObserver: MutationObserver | null = null;

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
    // click an underlined highlight to reopen its tangent; pointer cursor on hover to hint it
    document.addEventListener('click', this.onAnchorClick, true);
    document.addEventListener('mousemove', this.onAnchorHover, { passive: true });
    // sub-tangents created inside a tangent iframe ask the top page to open their window here
    if (!inSubframe()) window.addEventListener('message', (e) => this.onMessage(e));
    // SPA navigation
    this.watchNavigation();
    this.watchToolbar();
    this.onNavigate();
    this.unsub = onTangentsChanged(() => {
      this.refreshPill(); // top page: indicator + list (no-op inside an iframe)
      this.decorateAnchors(); // each frame re-marks its own conversation's highlights
    });
    // a tangent iframe is torn down when its popover closes; release this frame's subscriptions
    window.addEventListener('pagehide', this.destroy);
  }

  /** Release frame-level subscriptions/observers so they don't leak for the page's lifetime. */
  private destroy = (e?: PageTransitionEvent) => {
    if (e?.persisted) return; // bfcache: the page may be restored alive, so keep the wiring intact
    this.unsub?.();
    this.unsub = null;
    this.toolbarObserver?.disconnect();
    document.removeEventListener('click', this.onAnchorClick, true);
    document.removeEventListener('mousemove', this.onAnchorHover);
  };

  private onMessage(e: MessageEvent) {
    if (e.origin !== location.origin) return;
    const d = e.data as {
      source?: string;
      kind?: string;
      mainConv?: string;
      info?: { highlight: string; prefix: string; suffix: string };
      rec?: TangentRecord;
    } | null;
    if (!d || d.source !== 'claude-tangent') return;
    if (d.kind === 'open-compose' && d.mainConv && d.info) {
      // messageEl isn't needed downstream (createTangent uses highlight/prefix/suffix), and DOM
      // nodes can't cross the postMessage boundary anyway.
      const info = { highlight: d.info.highlight, prefix: d.info.prefix, suffix: d.info.suffix } as SelectionInfo;
      this.openCompose(info, null, d.mainConv);
    } else if (d.kind === 'reopen' && d.rec) {
      this.reopen(d.rec); // a sub-tangent highlight was clicked inside an iframe
    }
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
      if (inSubframe()) {
        // Inside a tangent iframe: hand off to the top-level page so the sub-tangent window opens
        // in the same space as everything else (and the top page owns/positions it natively).
        topWin().postMessage(
          {
            source: 'claude-tangent',
            kind: 'open-compose',
            mainConv: convUuidFromPath(),
            info: { highlight: info.highlight, prefix: info.prefix, suffix: info.suffix },
          },
          location.origin,
        );
      } else {
        this.openCompose(info, r);
      }
    });
    pill.appendChild(btn);
    document.body.appendChild(pill);

    // …and lift the native Reply toolbar up by our height, so Reply stacks *above* ours
    // and both stay clear of the selected text. (transform survives claude.ai's re-renders.)
    const ph = pill.getBoundingClientRect().height || 34;
    wrapper.style.transform = `translateY(${-(ph + 2)}px)`;
  }

  // --- compose + create tangent ---

  /** Open the compose popover. Always runs in the top-level page (sub-tangents are forwarded here
   *  from their iframe via postMessage), so the window lives in the same space as every tangent.
   *  `rect` anchors it to the selection for a top-level tangent, or is null (centered) for a
   *  sub-tangent, whose selection rect belongs to the iframe's coordinate space. */
  private openCompose(info: SelectionInfo, rect: DOMRect | null, mainConv = convUuidFromPath()) {
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
      // carry the source thread's media into the tangent without re-uploading: re-link uploaded
      // files by org-scoped file_uuid, re-attach documents with their inline extracted_content
      const media = collectMedia(tree, anchorUuid);

      const title = `↳ ${info.highlight.slice(0, 48)}`;
      const tangentConv = await createConversation(title, org);
      const res = await sendCompletion({
        convUuid: tangentConv,
        prompt: seed,
        model,
        org,
        files: media.files,
        attachments: media.attachments,
        syncSources: media.sync_sources,
      });
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
    // don't open a second window for the same tangent — focus + center the existing one (found in
    // the shared top document, so this holds even for a sub-tangent opened from another frame).
    const open = findPopoverHost(rec.tangentConvUuid);
    if (open) return focusPopoverHost(open);
    let popover: TangentPopover;
    popover = new TangentPopover(
      { highlight: rec.highlightText, existingConvUuid: rec.tangentConvUuid, title: rec.title },
      { createTangent: async () => rec.tangentConvUuid, onClose: () => this.popovers.delete(popover) },
    ).mount();
    this.popovers.add(popover);
  }

  // --- top-bar tangent indicator + dropdown list ---

  private async refreshPill() {
    if (inSubframe()) return; // the indicator + list live only in the top-level page
    const conv = convUuidFromPath();
    if (!conv) {
      this.tangentsCache = [];
      return this.removeIndicator();
    }
    try {
      // the whole tree for this conversation: top-level tangents and their sub-tangents
      this.tangentsCache = await buildTangentTree(conv);
    } catch (e) {
      return this.onStorageError(e);
    }
    this.renderIndicator();
  }

  /** Place/update the indicator as the leftmost item in claude.ai's top action bar
   *  (where the artifacts icon sits, just left of Share). */
  private renderIndicator() {
    if (inSubframe()) return this.removeIndicator();
    if (!convUuidFromPath() || !this.tangentsCache.length) return this.removeIndicator();
    const toolbar = document.querySelector('[data-testid="wiggle-controls-actions"]');
    if (!toolbar) return; // top bar not rendered yet — the toolbar observer retries
    if (!this.indicator || !toolbar.contains(this.indicator)) {
      this.indicator?.remove();
      this.indicator = this.buildIndicator();
      toolbar.prepend(this.indicator); // leftmost
    }
    const n = countTree(this.tangentsCache); // top-level tangents + every nested sub-tangent
    const count = this.indicator.querySelector('[data-count]');
    if (count) count.textContent = String(n);
    this.indicator.title = `${n} tangent${n !== 1 ? 's' : ''}`;
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
    if (!convUuidFromPath()) return;
    const list = document.createElement('div');
    list.setAttribute('data-tangent-dropdown', '');
    const r = anchor.getBoundingClientRect();
    // Raycast-style translucent "glass" panel: blurred, low-opacity dark fill, rounded, rows inset
    list.style.cssText =
      `position:fixed;top:${Math.round(r.bottom + 8)}px;right:${Math.round(Math.max(8, window.innerWidth - r.right))}px;` +
      'z-index:2147483640;min-width:252px;max-width:380px;max-height:62vh;overflow:auto;padding:6px;' +
      'border-radius:15px;background:rgba(34,34,36,.6);backdrop-filter:blur(22px) saturate(180%);' +
      '-webkit-backdrop-filter:blur(22px) saturate(180%);color:#ededed;' +
      'border:1px solid rgba(255,255,255,.1);box-shadow:0 18px 50px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);' +
      'font:13px/1.4 ui-sans-serif,system-ui,sans-serif;';
    // sub-tangents render indented under the tangent they came from
    const renderNodes = (nodes: TangentNode[], depth: number) => {
      for (const t of nodes) {
        list.appendChild(this.buildDropdownRow(t, depth));
        if (t.children.length) renderNodes(t.children, depth + 1);
      }
    };
    renderNodes(this.tangentsCache, 0);
    document.body.appendChild(list);
    this.dropdown = list;
    setTimeout(() => document.addEventListener('mousedown', this.onDocClick), 0);
  }

  private buildDropdownRow(t: TangentNode, depth: number): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      `display:flex;gap:8px;align-items:center;padding:8px 10px;padding-left:${10 + depth * 16}px;` +
      'border-radius:9px;transition:background .1s;';
    row.onmouseenter = () => (row.style.background = 'rgba(255,255,255,.08)');
    row.onmouseleave = () => (row.style.background = 'transparent');
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
    del.innerHTML = TRASH_SVG;
    del.title = 'Delete tangent';
    del.style.cssText =
      'display:flex;align-items:center;justify-content:center;border:0;background:transparent;cursor:pointer;' +
      'opacity:.55;padding:4px;border-radius:7px;color:inherit;transition:opacity .1s,background .1s;';
    del.onmouseenter = () => {
      del.style.opacity = '1';
      del.style.background = 'rgba(255,255,255,.12)';
    };
    del.onmouseleave = () => {
      del.style.opacity = '.55';
      del.style.background = 'transparent';
    };
    del.onclick = () => this.requestDelete(t, row);
    row.append(open, del);
    return row;
  }

  /** Trash click. Always confirm first (delete permanently removes the tangent's conversation);
   *  a parent's prompt also names how many sub-tangents go with it. */
  private requestDelete(t: TangentNode, row: HTMLElement) {
    const subs = countTree(t.children);
    row.replaceChildren();
    row.style.background = 'rgba(192,57,43,.15)';
    const msg = document.createElement('span');
    msg.style.cssText = 'flex:1;font-size:12px;line-height:1.3;padding-right:6px;';
    msg.textContent = subs
      ? `Delete this tangent and its ${subs} sub-tangent${subs > 1 ? 's' : ''}?`
      : 'Delete this tangent?';
    const yes = document.createElement('button');
    yes.textContent = subs ? 'Delete all' : 'Delete';
    yes.style.cssText =
      'border:0;background:#c0392b;color:#fff;cursor:pointer;font:600 12px/1 inherit;padding:6px 9px;border-radius:7px;';
    const no = document.createElement('button');
    no.textContent = 'Cancel';
    no.style.cssText =
      'border:0;background:rgba(255,255,255,.14);color:inherit;cursor:pointer;font:600 12px/1 inherit;padding:6px 9px;border-radius:7px;';
    yes.onclick = () => this.doDelete(t);
    no.onclick = () => {
      this.removeDropdown();
      if (this.indicator) this.toggleDropdown(this.indicator); // rebuild the list as it was
    };
    row.append(msg, yes, no);
  }

  private async doDelete(t: TangentNode) {
    const org = await getChatOrgUuid().catch(() => null);
    try {
      await this.cascadeDelete(t, org);
    } catch (e) {
      return this.onStorageError(e);
    }
    this.removeDropdown();
    this.refreshPill();
    this.decorateAnchors();
  }

  /**
   * Remove a tangent and all of its sub-tangents (depth-first), closing any open windows and
   * deleting each tangent's OWN claude.ai conversation (`tangentConvUuid`) — never the parent it
   * was forked from (`mainConvUuid`, which for a top-level tangent is the user's real chat). The
   * children are re-derived from LIVE storage, not the dropdown snapshot, so a sub-tangent added
   * after the list was built is still caught (otherwise its record would orphan forever).
   */
  private async cascadeDelete(node: TangentRecord, org: string | null, seen = new Set<string>()) {
    if (seen.has(node.tangentConvUuid)) return; // guard against cycles
    seen.add(node.tangentConvUuid);
    let children: TangentRecord[] = [];
    try {
      children = await getTangents(node.tangentConvUuid);
    } catch {
      /* can't read children — still delete this node below */
    }
    for (const child of children) await this.cascadeDelete(child, org, seen);
    closePopoverFor(node.tangentConvUuid);
    await removeTangent(node.mainConvUuid, node.tangentId);
    if (org) deleteConversation(node.tangentConvUuid, org).catch(() => {}); // delete the side-chat itself
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

  /** claude.ai re-renders the top bar per conversation; re-inject the indicator when it does. */
  private watchToolbar() {
    let scheduled = false;
    this.toolbarObserver = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        if (this.tangentsCache.length) this.renderIndicator();
        this.applyHighlights(); // claude.ai re-rendered; redraw underlines (from cache, no I/O)
      }, 250);
    });
    this.toolbarObserver.observe(document.body, { childList: true, subtree: true });
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
    this.anchorConv = conv;
    this.anchorTangents = tangents;
    this.ensureHighlightStyle();
    this.applyHighlights();
  }

  /** (Re)build the highlight ranges from the cached list against the live DOM, remembering each
   *  range so a click can be hit-tested back to its tangent. Safe to call on every re-render:
   *  claude.ai replaces message nodes (detaching old ranges), so we always rebuild. */
  private applyHighlights() {
    if (!('highlights' in CSS) || this.anchorConv !== convUuidFromPath()) return;
    this.anchors = [];
    const ranges: Range[] = [];
    if (this.anchorTangents.length) {
      const roots = buildRootMaps();
      const consumed = new Set<string>(); // occurrences already claimed by an earlier tangent
      for (const t of this.anchorTangents) {
        const range = locateHighlight(roots, t, consumed);
        if (range) {
          ranges.push(range);
          this.anchors.push({ rec: t, range });
        }
      }
    }
    if (!this.anchors.length && this.cursorOn) {
      this.cursorOn = false;
      document.documentElement.style.cursor = '';
    }
    CSS.highlights.set('tangent', new Highlight(...ranges));
  }

  /** Which tangent's highlight (if any) sits under a viewport point. */
  private anchorAt(x: number, y: number): TangentRecord | null {
    for (const a of this.anchors) {
      if (!a.range.startContainer.isConnected) continue; // stale range after a claude.ai re-render
      for (const r of a.range.getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return a.rec;
      }
    }
    return null;
  }

  private onAnchorClick = (e: MouseEvent) => {
    if (!this.anchors.length) return;
    if (!window.getSelection()?.isCollapsed) return; // mid drag-select, not a plain click
    // only ever intercept clicks inside an assistant answer, so we never shadow claude.ai's own
    // UI (buttons, links, citations) elsewhere on the page
    if (!(e.target as HTMLElement | null)?.closest?.(SEL.assistantMessage)) return;
    const rec = this.anchorAt(e.clientX, e.clientY);
    if (!rec) return;
    e.preventDefault();
    e.stopPropagation();
    this.reopenRecord(rec);
  };

  private onAnchorHover = (e: MouseEvent) => {
    if (!this.anchors.length) {
      if (this.cursorOn) {
        this.cursorOn = false;
        document.documentElement.style.cursor = '';
      }
      return;
    }
    if (this.hoverScheduled) return;
    this.hoverScheduled = true;
    const { clientX: x, clientY: y } = e;
    requestAnimationFrame(() => {
      this.hoverScheduled = false;
      const over = !!this.anchorAt(x, y);
      if (over === this.cursorOn) return;
      this.cursorOn = over;
      document.documentElement.style.cursor = over ? 'pointer' : '';
    });
  };

  /** Reopen a tangent. From inside an iframe (a sub-tangent's highlight) this hands off to the
   *  top page so the window opens in the same shared space as everything else. */
  private reopenRecord(rec: TangentRecord) {
    if (inSubframe()) {
      topWin().postMessage({ source: 'claude-tangent', kind: 'reopen', rec }, location.origin);
    } else {
      this.reopen(rec);
    }
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
