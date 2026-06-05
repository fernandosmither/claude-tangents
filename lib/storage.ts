import { browser } from 'wxt/browser';
import type { TangentRecord } from './types';

const KEY = 'tangents.byConversation';

type Store = Record<string, TangentRecord[]>;

async function readAll(): Promise<Store> {
  const got = await browser.storage.local.get(KEY);
  return (got[KEY] as Store) || {};
}

async function writeAll(store: Store): Promise<void> {
  await browser.storage.local.set({ [KEY]: store });
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
  const handler = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && KEY in changes) cb();
  };
  browser.storage.onChanged.addListener(handler as Parameters<typeof browser.storage.onChanged.addListener>[0]);
  return () =>
    browser.storage.onChanged.removeListener(handler as Parameters<typeof browser.storage.onChanged.addListener>[0]);
}
