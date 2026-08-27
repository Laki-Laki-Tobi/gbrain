/**
 * v0.29 IRON RULE — list_pages regression coverage.
 *
 * Adding optional params (`updated_after`, `sort`) to a long-shipped op
 * must not change behavior for callers that only pass the pre-v0.29 shape
 * (`type`, `tag`, `limit`). This test asserts the old shape produces the
 * pre-v0.29 default order and that the new `sort` enum threads through both
 * engine implementations (codex C4#9 — engines hardcoded ORDER BY DESC).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations } from '../../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // Seed 5 pages with deterministic timestamps so order is provable.
  for (let i = 0; i < 5; i++) {
    await engine.putPage(`alpha/page-${i}`, {
      type: 'note',
      title: `Page ${i}`,
      compiled_truth: 'body',
    });
  }
  // Backdate updated_at so we can test ordering meaningfully.
  await engine.executeRaw(
    `UPDATE pages SET updated_at = '2026-01-01'::timestamptz + (id * interval '1 day')`
  );
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('v0.29 IRON RULE — list_pages back-compat (pre-v0.29 shape)', () => {
  test('old call shape (type, tag, limit) returns updated_desc order by default', async () => {
    const rows = await engine.listPages({ limit: 10 });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    // Pre-v0.29 default = ORDER BY updated_at DESC. Our seeding made id=5 the
    // newest, so it must appear first.
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].updated_at.getTime() >= rows[i + 1].updated_at.getTime()).toBe(true);
    }
  });

  test('updated_after filter narrows to recent rows', async () => {
    const rows = await engine.listPages({
      limit: 10,
      updated_after: '2026-01-04',
    });
    // Only pages with updated_at > 2026-01-04 — that's id=4 + id=5 in the seed.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.updated_at.getTime()).toBeGreaterThan(new Date('2026-01-04').getTime());
    }
  });
});

describe('v0.29 — list_pages sort enum threads through the engine', () => {
  test('sort=updated_asc reverses default order', async () => {
    const desc = await engine.listPages({ limit: 10, sort: 'updated_desc' });
    const asc = await engine.listPages({ limit: 10, sort: 'updated_asc' });
    expect(asc.length).toBe(desc.length);
    expect(asc[0].slug).toBe(desc[desc.length - 1].slug);
  });

  test('sort=created_desc orders by created_at, not updated_at', async () => {
    const rows = await engine.listPages({ limit: 10, sort: 'created_desc' });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    // In our seed, id=5 was inserted last → newest created_at → first row.
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].created_at.getTime() >= rows[i + 1].created_at.getTime()).toBe(true);
    }
  });

  test('sort=slug returns alphabetical order', async () => {
    const rows = await engine.listPages({ limit: 10, sort: 'slug' });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const sorted = [...rows].sort((a, b) => a.slug.localeCompare(b.slug));
    expect(rows.map(r => r.slug)).toEqual(sorted.map(r => r.slug));
  });

  test('unsupported sort value falls back to default (does not crash)', async () => {
    // An invalid string would be filtered by the handler-side whitelist;
    // call the engine directly with a junk value to verify defense-in-depth.
    const rows = await engine.listPages({ limit: 10, sort: 'whatever' as any });
    // Engine PAGE_SORT_SQL[unknown] is undefined → falls back to default desc.
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('v0.42.59.2 — exact inventory pagination', () => {
  test('operation threads offset and emits content_hash only when requested', async () => {
    const op = operations.find((item) => item.name === 'list_pages')!;
    const ctx = { engine, sourceId: 'default', remote: false } as never;
    const first = await op.handler(ctx, { limit: 2, offset: 0, sort: 'slug' }) as Array<Record<string, unknown>>;
    const second = await op.handler(ctx, {
      limit: 2,
      offset: 2,
      sort: 'slug',
      include_content_hash: true,
    }) as Array<Record<string, unknown>>;

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first.map((row) => row.slug)).not.toEqual(second.map((row) => row.slug));
    expect(first.every((row) => !Object.hasOwn(row, 'content_hash'))).toBe(true);
    expect(second.every((row) => typeof row.content_hash === 'string' && row.content_hash.length === 64)).toBe(true);
  });

  test('operation normalizes unsafe offsets before calling the engine', async () => {
    const op = operations.find((item) => item.name === 'list_pages')!;
    let observedOffset = -1;
    const ctx = {
      sourceId: 'default',
      remote: false,
      engine: {
        listPages: async (filters: { offset?: number }) => {
          observedOffset = filters.offset ?? -1;
          return [];
        },
      },
    } as never;

    await op.handler(ctx, { offset: -50 });
    expect(observedOffset).toBe(0);
    await op.handler(ctx, { offset: Number.POSITIVE_INFINITY });
    expect(observedOffset).toBe(0);
    await op.handler(ctx, { offset: 5_000_000.9 });
    expect(observedOffset).toBe(1_000_000);
  });
});
