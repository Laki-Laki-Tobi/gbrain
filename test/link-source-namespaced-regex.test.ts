/**
 * v114 (#1941): link_source opened from a closed allowlist to a kebab-case
 * regex + length cap, provenance exposed on the link ops with a managed-
 * built-in guard, a new `list_link_sources` read op, and `link-add`/`link-rm`
 * CLI aliases.
 *
 * Coverage:
 *   - Migration v114 shape (two engine branches, transaction:false, idempotent)
 *   - DB CHECK boundary: kebab accepted (incl. all 5 built-ins), garbage rejected
 *   - Upgrade-path: existing built-in row survives the constraint swap (re-run)
 *   - add_link op: provenance threaded, default 'manual', managed-built-in guard
 *   - remove_link op: link_type / link_source / both filters
 *   - list_link_sources op: counts, deterministic order, scalar + federated scope
 *   - CLI aliases resolve; printOpHelp shows the invoked alias name; no collisions
 *
 * Hermetic via PGLite. No DATABASE_URL needed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';
import {
  operations,
  operationsByName,
  MANAGED_LINK_SOURCES,
} from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { cliAliases, printOpHelp } from '../src/cli.ts';

const V = 114;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    remote: false,
    config: {},
    logger: console,
    dryRun: false,
    ...overrides,
  } as unknown as OperationContext;
}

// Two pages every link test reuses.
async function seedPages() {
  await engine.putPage('lsrc-a', { type: 'note', title: 'A', compiled_truth: 'a', timeline: '', frontmatter: {} });
  await engine.putPage('lsrc-b', { type: 'note', title: 'B', compiled_truth: 'b', timeline: '', frontmatter: {} });
}

describe('migration v114 — links_link_source_check_kebab_regex', () => {
  test('registered with expected version + name', () => {
    const m = MIGRATIONS.find(m => m.version === V);
    expect(m).toBeDefined();
    expect(m!.name).toBe('links_link_source_check_kebab_regex');
  });

  test('LATEST_VERSION >= 114', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(V);
  });

  test('both engine branches present; transaction:false; idempotent', () => {
    const m = MIGRATIONS.find(m => m.version === V)!;
    expect(m.transaction).toBe(false);
    expect(m.idempotent).toBe(true);
    expect(m.sqlFor?.postgres).toBeTruthy();
    expect(m.sqlFor?.pglite).toBeTruthy();
  });

  test('postgres branch uses NOT VALID + VALIDATE (lock-friendly)', () => {
    const m = MIGRATIONS.find(m => m.version === V)!;
    const pg = m.sqlFor!.postgres!;
    expect(pg).toMatch(/DROP CONSTRAINT IF EXISTS links_link_source_check/i);
    expect(pg).toContain('NOT VALID');
    expect(pg).toMatch(/VALIDATE CONSTRAINT links_link_source_check/i);
    expect(pg).toContain("'^[a-z][a-z0-9]*(-[a-z0-9]+)*$'");
    expect(pg).toContain('char_length(link_source) <= 64');
  });

  test('pglite branch is plain DROP+ADD with the same regex', () => {
    const m = MIGRATIONS.find(m => m.version === V)!;
    const pl = m.sqlFor!.pglite!;
    expect(pl).toMatch(/DROP CONSTRAINT IF EXISTS links_link_source_check/i);
    expect(pl).not.toContain('NOT VALID');
    expect(pl).toContain("'^[a-z][a-z0-9]*(-[a-z0-9]+)*$'");
  });
});

describe('DB CHECK — kebab format gate', () => {
  beforeAll(seedPages);

  const ACCEPTED = [
    'citation-graph', 'derived', 'a',
    // OV7 — all 5 reconciliation-managed built-ins must stay DB-valid
    'markdown', 'frontmatter', 'manual', 'mentions', 'wikilink-resolved',
  ];
  const REJECTED: Array<[string, string]> = [
    ['UPPER', 'uppercase'],
    ['has_underscore', 'underscore'],
    ['has space', 'space'],
    ['2bad', 'leading digit'],
    ['-lead', 'leading dash'],
    ['trail-', 'trailing dash'],
    ['a--b', 'double dash'],
    ['', 'empty'],
    ['a'.repeat(65), '65 chars (over cap)'],
  ];

  for (const v of ACCEPTED) {
    test(`accepts '${v}'`, async () => {
      // engine.addLink writes link_source straight through (no op guard) — this
      // is the DB CHECK under test, not the op layer.
      await expect(
        engine.addLink('lsrc-a', 'lsrc-b', '', `t-${v}`, v),
      ).resolves.toBeUndefined();
    });
  }

  for (const [v, why] of REJECTED) {
    test(`rejects '${v}' (${why})`, async () => {
      await expect(
        engine.addLink('lsrc-a', 'lsrc-b', '', `t-rej-${why}`, v),
      ).rejects.toThrow();
    });
  }
});

describe('upgrade-path — existing rows survive the constraint swap', () => {
  test('built-in row present, re-running v114 succeeds, new kebab tag inserts', async () => {
    await seedPages();
    // A row tagged with a pre-existing built-in value (would have been valid
    // under the old allowlist too).
    await engine.addLink('lsrc-a', 'lsrc-b', '', 't-upgrade', 'markdown');
    const m = MIGRATIONS.find(m => m.version === V)!;
    // Re-apply the migration against the table that now holds data: ADD/VALIDATE
    // must not fail on the existing row.
    await expect(engine.runMigration(V, m.sqlFor!.pglite!)).resolves.toBeUndefined();
    // And a brand-new external provenance still inserts afterward.
    await expect(
      engine.addLink('lsrc-a', 'lsrc-b', '', 't-upgrade', 'citation-graph'),
    ).resolves.toBeUndefined();
  });
});

describe('add_link op — provenance + managed-built-in guard (OV4A)', () => {
  beforeAll(seedPages);

  test('threads custom provenance through to the row', async () => {
    const op = operationsByName['add_link'];
    await op.handler(makeCtx(), { from: 'lsrc-a', to: 'lsrc-b', link_type: 'cites', link_source: 'citation-graph' });
    const links = await engine.getLinks('lsrc-a');
    expect(links.some(l => (l as any).to_slug === 'lsrc-b' && (l as any).link_source === 'citation-graph' && (l as any).link_type === 'cites')).toBe(true);
  });

  test("omitted link_source defaults to 'manual' (not 'markdown')", async () => {
    const op = operationsByName['add_link'];
    await op.handler(makeCtx(), { from: 'lsrc-a', to: 'lsrc-b', link_type: 'default-prov' });
    const links = await engine.getLinks('lsrc-a');
    const row = links.find(l => (l as any).link_type === 'default-prov');
    expect((row as any)?.link_source).toBe('manual');
  });

  for (const managed of MANAGED_LINK_SOURCES) {
    test(`rejects managed built-in '${managed}'`, async () => {
      const op = operationsByName['add_link'];
      await expect(
        op.handler(makeCtx(), { from: 'lsrc-a', to: 'lsrc-b', link_type: 'g', link_source: managed }),
      ).rejects.toThrow(/reconciliation-managed/);
    });
  }

  test("'manual' is allowed (not in the managed set)", async () => {
    const op = operationsByName['add_link'];
    await expect(
      op.handler(makeCtx(), { from: 'lsrc-a', to: 'lsrc-b', link_type: 'man', link_source: 'manual' }),
    ).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('remove_link op — type/source filters', () => {
  async function seedTwoProvenances() {
    await engine.putPage('rm-a', { type: 'note', title: 'A', compiled_truth: 'a', timeline: '', frontmatter: {} });
    await engine.putPage('rm-b', { type: 'note', title: 'B', compiled_truth: 'b', timeline: '', frontmatter: {} });
    await engine.addLink('rm-a', 'rm-b', '', 'cites', 'manual');
    await engine.addLink('rm-a', 'rm-b', '', 'cites', 'citation-graph');
  }

  test('--link-source filter deletes only that provenance', async () => {
    await seedTwoProvenances();
    const op = operationsByName['remove_link'];
    await op.handler(makeCtx(), { from: 'rm-a', to: 'rm-b', link_source: 'citation-graph' });
    const links = await engine.getLinks('rm-a');
    const sources = links.filter(l => (l as any).to_slug === 'rm-b').map(l => (l as any).link_source);
    expect(sources).toContain('manual');
    expect(sources).not.toContain('citation-graph');
  });

  test('--link-type-only filter deletes every provenance of that type', async () => {
    await seedTwoProvenances();
    const op = operationsByName['remove_link'];
    await op.handler(makeCtx(), { from: 'rm-a', to: 'rm-b', link_type: 'cites' });
    const links = await engine.getLinks('rm-a');
    expect(links.filter(l => (l as any).to_slug === 'rm-b' && (l as any).link_type === 'cites').length).toBe(0);
  });

  test('both filters delete only the type+source match', async () => {
    await seedTwoProvenances();
    const op = operationsByName['remove_link'];
    await op.handler(makeCtx(), { from: 'rm-a', to: 'rm-b', link_type: 'cites', link_source: 'manual' });
    const links = await engine.getLinks('rm-a');
    const sources = links.filter(l => (l as any).to_slug === 'rm-b').map(l => (l as any).link_source);
    expect(sources).toContain('citation-graph');
    expect(sources).not.toContain('manual');
  });

  test('exact provenance filters delete one edge without touching its semantic sibling', async () => {
    await engine.putPage('rm-exact-from', { type: 'note', title: 'From', compiled_truth: 'from', timeline: '', frontmatter: {} });
    await engine.putPage('rm-exact-to', { type: 'note', title: 'To', compiled_truth: 'to', timeline: '', frontmatter: {} });
    await engine.putPage('rm-exact-origin', { type: 'note', title: 'Origin', compiled_truth: 'origin', timeline: '', frontmatter: {} });
    await engine.addLink(
      'rm-exact-from', 'rm-exact-to', 'generated telemetry', 'recall_surface', 'manual',
      'rm-exact-from', 'governance', { resolutionType: 'qualified' },
    );
    await engine.addLink(
      'rm-exact-from', 'rm-exact-to', 'durable semantic relation', 'recall_surface', 'manual',
      'rm-exact-origin', 'related', { resolutionType: 'qualified' },
    );

    const before = await engine.getLinks('rm-exact-from');
    expect(before.filter(link => link.to_slug === 'rm-exact-to')).toHaveLength(2);
    expect(before.every(link => link.resolution_type === 'qualified')).toBe(true);

    await operationsByName.remove_link.handler(makeCtx(), {
      from: 'rm-exact-from',
      to: 'rm-exact-to',
      link_type: 'recall_surface',
      link_source: 'manual',
      origin_slug: 'rm-exact-from',
      origin_field: 'governance',
      context: 'generated telemetry',
      resolution_type: 'qualified',
    });

    const after = (await engine.getLinks('rm-exact-from')).filter(link => link.to_slug === 'rm-exact-to');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      context: 'durable semantic relation',
      origin_slug: 'rm-exact-origin',
      origin_field: 'related',
      resolution_type: 'qualified',
    });
  });

  test('exact NULL provenance filters remove one legacy edge only', async () => {
    await engine.putPage('rm-null-from', { type: 'note', title: 'From', compiled_truth: 'from', timeline: '', frontmatter: {} });
    await engine.putPage('rm-null-to', { type: 'note', title: 'To', compiled_truth: 'to', timeline: '', frontmatter: {} });
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field, resolution_type)
       SELECT f.id, t.id, 'proposal_autopilot_item', '', NULL, NULL, NULL, NULL
       FROM pages f, pages t
       WHERE f.slug = 'rm-null-from' AND t.slug = 'rm-null-to'`,
    );
    await engine.addLink(
      'rm-null-from', 'rm-null-to', 'durable semantic relation', 'proposal_autopilot_item', 'manual',
      'rm-null-from', 'related', { resolutionType: 'qualified' },
    );

    await operationsByName.remove_link.handler(makeCtx(), {
      from: 'rm-null-from',
      to: 'rm-null-to',
      link_type: 'proposal_autopilot_item',
      context: '',
      link_source_is_null: true,
      origin_slug_is_null: true,
      origin_field_is_null: true,
      resolution_type_is_null: true,
    });

    const remaining = (await engine.getLinks('rm-null-from')).filter(link => link.to_slug === 'rm-null-to');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      link_source: 'manual',
      context: 'durable semantic relation',
      origin_field: 'related',
      resolution_type: 'qualified',
    });
  });

  test('restore_link_exact is local-only admin and restores exact NULL provenance', async () => {
    const op = operationsByName.restore_link_exact;
    expect(op.localOnly).toBe(true);
    expect(op.scope).toBe('admin');
    expect(op.mutating).toBe(true);
    await engine.putPage('restore-null-from', { type: 'note', title: 'From', compiled_truth: 'from', timeline: '', frontmatter: {} });
    await engine.putPage('restore-null-to', { type: 'note', title: 'To', compiled_truth: 'to', timeline: '', frontmatter: {} });
    await engine.softDeletePage('restore-null-to');

    await op.handler(makeCtx(), {
      from: 'restore-null-from',
      to: 'restore-null-to',
      link_type: 'legacy_ref',
      context: '',
      link_source_is_null: true,
      origin_slug_is_null: true,
      origin_field_is_null: true,
      resolution_type_is_null: true,
    });

    expect(await engine.getLinks('restore-null-from')).toEqual([]);
    const [restored] = await engine.getLinks('restore-null-from', { includeDeleted: true });
    expect(restored).toEqual({
      from_slug: 'restore-null-from',
      to_slug: 'restore-null-to',
      link_type: 'legacy_ref',
      context: '',
      link_source: null,
      origin_slug: null,
      origin_field: null,
      resolution_type: null,
    });
  });

  test('read -> exact unlink -> exact restore preserves managed provenance identity', async () => {
    await engine.putPage('restore-managed-from', { type: 'note', title: 'From', compiled_truth: 'from', timeline: '', frontmatter: {} });
    await engine.putPage('restore-managed-to', { type: 'note', title: 'To', compiled_truth: 'to', timeline: '', frontmatter: {} });
    await engine.putPage('restore-managed-origin', { type: 'note', title: 'Origin', compiled_truth: 'origin', timeline: '', frontmatter: {} });
    await engine.addLink(
      'restore-managed-from', 'restore-managed-to', 'managed context', 'related',
      'frontmatter', 'restore-managed-origin', 'related', { resolutionType: 'unqualified' },
    );
    const [snapshot] = await engine.getLinks('restore-managed-from', { includeDeleted: true });

    await operationsByName.remove_link.handler(makeCtx(), {
      from: snapshot.from_slug,
      to: snapshot.to_slug,
      link_type: snapshot.link_type,
      context: snapshot.context,
      link_source: snapshot.link_source,
      origin_slug: snapshot.origin_slug,
      origin_field: snapshot.origin_field,
      resolution_type: snapshot.resolution_type,
    });
    expect(await engine.getLinks('restore-managed-from', { includeDeleted: true })).toEqual([]);

    await operationsByName.restore_link_exact.handler(makeCtx(), {
      from: snapshot.from_slug,
      to: snapshot.to_slug,
      link_type: snapshot.link_type,
      context: snapshot.context,
      link_source: snapshot.link_source,
      origin_slug: snapshot.origin_slug,
      origin_field: snapshot.origin_field,
      resolution_type: snapshot.resolution_type,
    });
    expect(await engine.getLinks('restore-managed-from', { includeDeleted: true })).toEqual([snapshot]);
  });

  test('restore_link_exact rejects incomplete identity and missing origin before insert', async () => {
    await engine.putPage('restore-fail-from', { type: 'note', title: 'From', compiled_truth: 'from', timeline: '', frontmatter: {} });
    await engine.putPage('restore-fail-to', { type: 'note', title: 'To', compiled_truth: 'to', timeline: '', frontmatter: {} });
    const base = {
      from: 'restore-fail-from',
      to: 'restore-fail-to',
      link_type: 'related',
      context: '',
      link_source: 'frontmatter',
      origin_field: 'related',
      resolution_type: 'qualified',
    };
    await expect(operationsByName.restore_link_exact.handler(makeCtx(), base)).rejects.toThrow('origin_slug');
    await expect(operationsByName.restore_link_exact.handler(makeCtx(), {
      ...base,
      origin_slug: 'restore-fail-missing-origin',
    })).rejects.toThrow('not found');
    expect(await engine.getLinks('restore-fail-from', { includeDeleted: true })).toEqual([]);
  });
});

describe('list_link_sources op (B4 + OV8 + OV9)', () => {
  test('op declaration: read scope, link-sources CLI name, not localOnly', () => {
    const op = operationsByName['list_link_sources'];
    expect(op).toBeDefined();
    expect(op.scope).toBe('read');
    expect(op.localOnly).not.toBe(true);
    expect(op.cliHints?.name).toBe('link-sources');
  });

  test('returns distinct provenances with counts, ordered count DESC then name ASC', async () => {
    await engine.putPage('ls-a', { type: 'note', title: 'A', compiled_truth: 'a', timeline: '', frontmatter: {} });
    await engine.putPage('ls-b', { type: 'note', title: 'B', compiled_truth: 'b', timeline: '', frontmatter: {} });
    await engine.putPage('ls-c', { type: 'note', title: 'C', compiled_truth: 'c', timeline: '', frontmatter: {} });
    // zeta:1, alpha:2 — alpha sorts first by count; within ties, name ASC.
    await engine.addLink('ls-a', 'ls-b', '', 'r1', 'alpha-src');
    await engine.addLink('ls-a', 'ls-c', '', 'r2', 'alpha-src');
    await engine.addLink('ls-b', 'ls-c', '', 'r3', 'zeta-src');

    const op = operationsByName['list_link_sources'];
    const rows = (await op.handler(makeCtx(), {})) as Array<{ link_source: string | null; count: number }>;
    const map = new Map(rows.map(r => [r.link_source, r.count]));
    expect(map.get('alpha-src')).toBe(2);
    expect(map.get('zeta-src')).toBe(1);
    // Deterministic order: counts non-increasing.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].count >= rows[i].count).toBe(true);
    }
  });

  test('scalar ctx.sourceId scopes; a non-matching source returns nothing', async () => {
    const op = operationsByName['list_link_sources'];
    // Pages above were written to the 'default' source.
    const inDefault = (await op.handler(makeCtx({ sourceId: 'default' } as any), {})) as unknown[];
    expect(inDefault.length).toBeGreaterThan(0);
    const inOther = (await op.handler(makeCtx({ sourceId: 'no-such-source' } as any), {})) as unknown[];
    expect(inOther.length).toBe(0);
  });

  test('federated allowedSources ({sourceIds}) scopes (OV8)', async () => {
    const op = operationsByName['list_link_sources'];
    const inDefault = (await op.handler(makeCtx({ auth: { allowedSources: ['default'] } } as any), {})) as unknown[];
    expect(inDefault.length).toBeGreaterThan(0);
    const inOther = (await op.handler(makeCtx({ auth: { allowedSources: ['no-such-source'] } } as any), {})) as unknown[];
    expect(inOther.length).toBe(0);
  });
});

describe('CLI aliases + help (OV10 + OV11)', () => {
  test('link-add resolves to add_link, link-rm to remove_link', () => {
    expect(cliAliases.get('link-add')?.name).toBe('add_link');
    expect(cliAliases.get('link-rm')?.name).toBe('remove_link');
  });

  test('no alias collides with any primary CLI name or another alias', () => {
    const primaries = new Set(operations.map(o => o.cliHints?.name).filter(Boolean) as string[]);
    const seen = new Set<string>();
    for (const op of operations) {
      for (const alias of op.cliHints?.aliases ?? []) {
        expect(primaries.has(alias)).toBe(false);
        expect(seen.has(alias)).toBe(false);
        seen.add(alias);
      }
    }
  });

  test('printOpHelp shows the invoked alias name, not the primary (OV10)', () => {
    const op = operationsByName['add_link'];
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      printOpHelp(op, 'link-add');
    } finally {
      console.log = orig;
    }
    const out = lines.join('\n');
    expect(out).toContain('Usage: gbrain link-add');
    expect(out).not.toContain('Usage: gbrain link ');
  });
});
