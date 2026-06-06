import { SEL } from './selectors';
import type { TangentRecord } from './types';

/**
 * A whitespace-normalized, flattened view of one assistant message's text, mapping each char in
 * the flat string back to its source text node + offset. This lets a highlight be matched even
 * when it spans multiple text nodes (bold, links, paragraph breaks) or differs only in whitespace.
 */
export interface RootMap {
  flat: string;
  map: { node: Text; offset: number }[];
}

/** Build a RootMap for every assistant answer currently in the document. */
export function buildRootMaps(doc: Document = document): RootMap[] {
  const out: RootMap[] = [];
  for (const root of doc.querySelectorAll(SEL.assistantMessage)) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let flat = '';
    const map: { node: Text; offset: number }[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      const raw = t.textContent || '';
      for (let i = 0; i < raw.length; i++) {
        const ws = /\s/.test(raw[i]);
        if (ws && flat.endsWith(' ')) continue; // collapse runs of whitespace
        flat += ws ? ' ' : raw[i];
        map.push({ node: t, offset: i }); // map stays index-aligned with flat
      }
    }
    out.push({ flat, map });
  }
  return out;
}

export const normWs = (s: string) => s.replace(/\s+/g, ' ').trim();
// Collapse whitespace runs but DON'T trim — used for prefix/suffix, whose edge adjacent to the
// highlight must keep its space to line up with the flattened text (otherwise scoring is off by
// one and a word-boundary selection always scores 0).
export const collapseWs = (s: string) => s.replace(/\s+/g, ' ');
export const commonSuffixLen = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
export const commonPrefixLen = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * Locate a tangent's highlight across the prebuilt root maps. When the same text occurs more than
 * once, pick the occurrence whose surrounding text best matches the stored prefix/suffix, and skip
 * occurrences already claimed by an earlier tangent this pass — so repeated/identical phrases stay
 * mapped to the correct tangent instead of all collapsing onto the first hit.
 */
export function locateHighlight(
  roots: RootMap[],
  t: Pick<TangentRecord, 'highlightText' | 'prefix' | 'suffix'>,
  consumed: Set<string>,
  doc: Document = document,
): Range | null {
  const needle = normWs(t.highlightText);
  if (needle.length < 3) return null;
  const prefix = collapseWs(t.prefix || ''); // keep the highlight-adjacent space (see collapseWs)
  const suffix = collapseWs(t.suffix || '');
  let best: { ri: number; idx: number; score: number } | null = null;
  for (let ri = 0; ri < roots.length; ri++) {
    const flat = roots[ri].flat;
    let from = 0;
    let idx: number;
    while ((idx = flat.indexOf(needle, from)) >= 0) {
      from = idx + 1;
      if (consumed.has(ri + ':' + idx)) continue;
      const before = flat.slice(Math.max(0, idx - prefix.length), idx);
      const after = flat.slice(idx + needle.length, idx + needle.length + suffix.length);
      const score = commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix);
      if (!best || score > best.score) best = { ri, idx, score };
    }
  }
  if (!best) return null;
  consumed.add(best.ri + ':' + best.idx);
  const { map } = roots[best.ri];
  const start = map[best.idx];
  const end = map[best.idx + needle.length - 1];
  if (!start || !end) return null;
  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}
