import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TangentRecord } from './types';

// An in-memory chrome.storage.local mock, mirroring the get/set/remove shape the module uses.
function makeChrome() {
  const store: Record<string, unknown> = {};
  const get = async (keys: string | string[] | null) => {
    if (keys == null) return { ...store };
    const arr = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of arr) if (k in store) out[k] = store[k];
    return out;
  };
  const set = async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  };
  const remove = async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
  };
  return {
    store,
    chrome: {
      storage: { local: { get, set, remove }, onChanged: { addListener() {}, removeListener() {} } },
    },
  };
}

const rec = (over: Partial<TangentRecord> = {}): TangentRecord => ({
  tangentId: 't1',
  mainConvUuid: 'A',
  anchorMessageUuid: 'm',
  highlightText: 'h',
  prefix: '',
  suffix: '',
  tangentConvUuid: 'C',
  title: 'x',
  createdAt: 1,
  ...over,
});

describe('storage', () => {
  let ctx: ReturnType<typeof makeChrome>;
  let storage: typeof import('./storage');

  beforeEach(async () => {
    ctx = makeChrome();
    (globalThis as unknown as { chrome: unknown }).chrome = ctx.chrome;
    vi.resetModules(); // fresh module-level migration/mutex state per test
    storage = await import('./storage');
  });

  it('round-trips a tangent, isolated per conversation', async () => {
    await storage.addTangent(rec({ mainConvUuid: 'A' }));
    expect(await storage.getTangents('A')).toHaveLength(1);
    expect(await storage.getTangents('B')).toHaveLength(0);
  });

  it('stores each conversation under its own key (no cross-conversation blob)', async () => {
    await storage.addTangent(rec({ tangentId: 'a', mainConvUuid: 'A' }));
    await storage.addTangent(rec({ tangentId: 'b', mainConvUuid: 'B' }));
    expect(Object.keys(ctx.store)).toEqual(
      expect.arrayContaining(['tangents.v2.A', 'tangents.v2.B']),
    );
  });

  it('removes the key entirely once its last tangent is gone', async () => {
    await storage.addTangent(rec({ tangentId: 't1', mainConvUuid: 'A' }));
    await storage.removeTangent('A', 't1');
    expect(await storage.getTangents('A')).toHaveLength(0);
    expect(Object.keys(ctx.store)).not.toContain('tangents.v2.A');
  });

  it('serializes concurrent writes to the same conversation (no lost update)', async () => {
    await Promise.all([
      storage.addTangent(rec({ tangentId: 'a' })),
      storage.addTangent(rec({ tangentId: 'b' })),
      storage.addTangent(rec({ tangentId: 'c' })),
    ]);
    const ids = (await storage.getTangents('A')).map((t) => t.tangentId).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('migrates the legacy single-blob format on first access', async () => {
    ctx.store['tangents.byConversation'] = { A: [rec({ tangentId: 'old', mainConvUuid: 'A' })] };
    const got = await storage.getTangents('A');
    expect(got.map((t) => t.tangentId)).toEqual(['old']);
    expect(Object.keys(ctx.store)).toContain('tangents.v2.A');
    expect(Object.keys(ctx.store)).not.toContain('tangents.byConversation');
  });

  it('migration never overwrites an already-migrated key', async () => {
    ctx.store['tangents.byConversation'] = { A: [rec({ tangentId: 'legacy', mainConvUuid: 'A' })] };
    ctx.store['tangents.v2.A'] = [rec({ tangentId: 'fresh', mainConvUuid: 'A' })];
    const got = await storage.getTangents('A');
    expect(got.map((t) => t.tangentId)).toEqual(['fresh']); // legacy did not clobber fresh
  });
});
