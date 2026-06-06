import { messageText, pathTo } from './claude';
import { SEL } from './selectors';
import type { ConversationTree } from './types';

const ASSISTANT_MATCH = `${SEL.assistantMessage}, [data-is-streaming]`;

export interface SelectionInfo {
  highlight: string;
  prefix: string;
  suffix: string;
  messageEl: HTMLElement;
}

export function closestAssistantMessage(node: Node | null): HTMLElement | null {
  let el: HTMLElement | null =
    node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el) {
    if (el.matches?.(ASSISTANT_MATCH)) return el;
    el = el.parentElement;
  }
  return null;
}

/** Info about the current text selection, if it sits inside a Claude (assistant) answer. */
export function getSelectionInfo(min = 3): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const highlight = sel.toString().trim();
  if (highlight.length < min) return null;

  const range = sel.getRangeAt(0);
  const messageEl = closestAssistantMessage(range.commonAncestorContainer);
  if (!messageEl) return null;

  const full = messageEl.textContent ?? '';
  const idx = full.indexOf(highlight);
  const prefix = idx >= 0 ? full.slice(Math.max(0, idx - 48), idx) : '';
  const suffix = idx >= 0 ? full.slice(idx + highlight.length, idx + highlight.length + 48) : '';
  return { highlight, prefix, suffix, messageEl };
}

/**
 * Resolve a highlight to the assistant message UUID that contains it, by matching
 * against the conversation tree (prefer the current path; prefer the latest match).
 */
const normWs = (s: string) => s.replace(/\s+/g, ' ').trim();

export function findAnchorUuid(
  tree: ConversationTree,
  highlight: string,
  _prefix = '',
): string | null {
  // Normalize whitespace: the DOM's textContent joins paragraphs differently than the
  // stored message text, so a raw substring match misses selections crossing a boundary.
  const needle = normWs(highlight);
  if (!needle) return null;
  const path = pathTo(tree).filter((m) => m.sender === 'assistant');
  const candidates = path.length ? path : tree.chat_messages.filter((m) => m.sender === 'assistant');
  // search from the most recent backwards
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (normWs(messageText(candidates[i])).includes(needle)) return candidates[i].uuid;
  }
  return null;
}
