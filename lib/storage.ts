import type { TangentRecord } from './types';

// One storage key PER conversation (`tangents.v2.<convUuid>`) rather than a single blob holding
// every conversation. The content script runs in all frames, so the top page and a tangent iframe
// can write concurrently; with separate keys, writes to different conversations can't clobber each
// other. A per-frame write mutex serializes read-modify-write within a frame.
const PREFIX = 'tangents.v2.';
const LEGACY_KEY = 'tangents.byConversation'; // old single-blob format (Record<conv, list>)

type List = TangentRecord[];
type Bag = Record<string, unknown>;

interface LocalArea {
  get(keys: string | string[] | null): Promise<Bag>;
  set(items: Bag): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}
interface OnChanged {
  addListener(cb: (changes: Bag, area: string) => void): void;
  removeListener(cb: (changes: Bag, area: string) => void): void;
}

// Resolve the extension storage at call time, preferring `chrome.storage` — Chrome's
// `globalThis.browser` alias (which WXT's `browser` helper may select) can be incomplete
// and lack `.storage`, which surfaced as "Cannot read properties of undefined (reading 'get')".
function g(): {
  chrome?: { storage?: { local?: LocalArea; onChanged?: OnChanged } };
  browser?: { storage?: { local?: LocalArea; onChanged?: OnChanged } };
} {
  return globalThis as never;
}
function local(): LocalArea {
  const area = g().chrome?.storage?.local ?? g().browser?.storage?.local;
  if (!area) throw new Error('Tangent: extension storage is unavailable on this page.');
  return area;
}

const keyFor = (conv: string) => PREFIX + conv;

/**
 * True for the error an old content script throws after the extension is reloaded/updated.
 * It has a user-visible consequence (the page's script can't read/write storage anymore), so
 * callers should surface a "reload the page" prompt — NOT hide it.
 */
export function isContextInvalidated(e: unknown): boolean {
  return /context invalidated/i.test(String(e));
}

// --- one-time migration from the single-blob format to per-conversation keys ---
let migrated: Promise<void> | null = null;
function ensureMigrated(): Promise<void> {
  if (!migrated) migrated = migrate().catch(() => {}); // best-effort; never block reads forever
  return migrated;
}
async function migrate(): Promise<void> {
  const got = await local().get(LEGACY_KEY);
  const old = got[LEGACY_KEY] as Record<string, List> | undefined;
  if (!old) return;
  // Only seed conversations that don't already have a per-conversation key, so a migration or
  // write that already ran (here or in another frame) can't be clobbered by stale legacy data.
  const keys = Object.keys(old).filter((c) => old[c]?.length).map(keyFor);
  const existing = keys.length ? await local().get(keys) : {};
  const items: Bag = {};
  for (const [conv, list] of Object.entries(old)) {
    const k = keyFor(conv);
    if (list?.length && !(k in existing)) items[k] = list;
  }
  if (Object.keys(items).length) await local().set(items);
  await local().remove(LEGACY_KEY);
}

// --- per-frame write serialization (prevents intra-frame read-modify-write interleave) ---
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export async function getTangents(mainConvUuid: string): Promise<List> {
  await ensureMigrated();
  const k = keyFor(mainConvUuid);
  const got = await local().get(k);
  return (got[k] as List) || [];
}

export function addTangent(rec: TangentRecord): Promise<void> {
  return serialize(async () => {
    await ensureMigrated();
    const k = keyFor(rec.mainConvUuid);
    const got = await local().get(k);
    const list = ((got[k] as List) || []).slice();
    list.push(rec);
    await local().set({ [k]: list });
  });
}

export function removeTangent(mainConvUuid: string, tangentId: string): Promise<void> {
  return serialize(async () => {
    await ensureMigrated();
    const k = keyFor(mainConvUuid);
    const got = await local().get(k);
    const list = ((got[k] as List) || []).filter((t) => t.tangentId !== tangentId);
    if (list.length) await local().set({ [k]: list });
    else await local().remove(k);
  });
}

export function updateTangent(
  mainConvUuid: string,
  tangentId: string,
  patch: Partial<TangentRecord>,
): Promise<void> {
  return serialize(async () => {
    await ensureMigrated();
    const k = keyFor(mainConvUuid);
    const got = await local().get(k);
    const list = ((got[k] as List) || []).map((t) =>
      t.tangentId === tangentId ? { ...t, ...patch } : t,
    );
    await local().set({ [k]: list });
  });
}

/** Subscribe to changes to any tangent key (e.g. to refresh anchors/list across frames). */
export function onTangentsChanged(cb: () => void): () => void {
  const onChanged = g().chrome?.storage?.onChanged ?? g().browser?.storage?.onChanged;
  if (!onChanged) return () => {};
  const handler = (changes: Bag, area: string) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(PREFIX) || k === LEGACY_KEY))
      cb();
  };
  onChanged.addListener(handler);
  return () => onChanged.removeListener(handler);
}
