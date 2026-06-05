import type { TangentRecord } from './types';

const KEY = 'tangents.byConversation';

type Store = Record<string, TangentRecord[]>;

interface LocalArea {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
interface OnChanged {
  addListener(cb: (changes: Record<string, unknown>, area: string) => void): void;
  removeListener(cb: (changes: Record<string, unknown>, area: string) => void): void;
}

// Resolve the extension storage at call time, preferring `chrome.storage` — Chrome's
// `globalThis.browser` alias (which WXT's `browser` helper may select) can be incomplete
// and lack `.storage`, which surfaced as "Cannot read properties of undefined (reading 'get')".
function g(): { chrome?: { storage?: { local?: LocalArea; onChanged?: OnChanged } }; browser?: { storage?: { local?: LocalArea; onChanged?: OnChanged } } } {
  return globalThis as never;
}
function local(): LocalArea {
  const area = g().chrome?.storage?.local ?? g().browser?.storage?.local;
  if (!area) throw new Error('Tangent: extension storage is unavailable on this page.');
  return area;
}

/** True for the transient error thrown by an old content script after the extension reloads. */
function isContextInvalidated(e: unknown): boolean {
  return /context invalidated/i.test(String(e));
}

async function readAll(): Promise<Store> {
  try {
    const got = await local().get(KEY);
    return (got[KEY] as Store) || {};
  } catch (e) {
    // Suppress ONLY the expected "Extension context invalidated" (fires when the extension
    // is reloaded while this old content script is still alive). Surface everything else —
    // hiding real storage failures is how the chrome.storage-undefined bug stayed invisible.
    if (isContextInvalidated(e)) return {};
    throw e;
  }
}

async function writeAll(store: Store): Promise<void> {
  try {
    await local().set({ [KEY]: store });
  } catch (e) {
    // Swallow only the transient "Extension context invalidated"; re-throw genuine failures.
    if (!isContextInvalidated(e)) throw e;
  }
}

export async function getTangents(mainConvUuid: string): Promise<TangentRecord[]> {
  const all = await readAll();
  return all[mainConvUuid] || [];
}

export async function addTangent(rec: TangentRecord): Promise<void> {
  const all = await readAll();
  const list = all[rec.mainConvUuid] || [];
  list.push(rec);
  all[rec.mainConvUuid] = list;
  await writeAll(all);
}

export async function removeTangent(mainConvUuid: string, tangentId: string): Promise<void> {
  const all = await readAll();
  all[mainConvUuid] = (all[mainConvUuid] || []).filter((t) => t.tangentId !== tangentId);
  await writeAll(all);
}

export async function updateTangent(
  mainConvUuid: string,
  tangentId: string,
  patch: Partial<TangentRecord>,
): Promise<void> {
  const all = await readAll();
  all[mainConvUuid] = (all[mainConvUuid] || []).map((t) =>
    t.tangentId === tangentId ? { ...t, ...patch } : t,
  );
  await writeAll(all);
}

/** Subscribe to changes to the tangent store (e.g. to refresh anchors/list across frames). */
export function onTangentsChanged(cb: () => void): () => void {
  const onChanged = g().chrome?.storage?.onChanged ?? g().browser?.storage?.onChanged;
  if (!onChanged) return () => {};
  const handler = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && KEY in changes) cb();
  };
  onChanged.addListener(handler);
  return () => onChanged.removeListener(handler);
}
