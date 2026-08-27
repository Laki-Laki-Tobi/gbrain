import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

function ctx(): OperationContext {
  return {
    engine,
    config: {},
    logger: console,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as unknown as OperationContext;
}

async function counts(): Promise<{ versions: number; chunks: number }> {
  const [row] = await engine.executeRaw<{ versions: number | string; chunks: number | string }>(
    `SELECT (SELECT count(*) FROM page_versions) AS versions,
            (SELECT count(*) FROM content_chunks) AS chunks`,
  );
  return { versions: Number(row.versions), chunks: Number(row.chunks) };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  for (const table of ['content_chunks', 'page_versions', 'links', 'tags', 'timeline_entries', 'pages']) {
    await engine.executeRaw(`DELETE FROM ${table}`);
  }
});

describe('patch_page_metadata_exact', () => {
  test('is local-only admin and patches/unsets metadata without retrieval side effects', async () => {
    const op = operationsByName.patch_page_metadata_exact;
    expect(op.localOnly).toBe(true);
    expect(op.scope).toBe('admin');
    expect(op.mutating).toBe(true);

    await engine.putPage('projects/exact-metadata', {
      type: 'note',
      title: 'Exact metadata',
      compiled_truth: 'Semantic body stays byte-identical.',
      timeline: '2026-08-27: baseline',
      frontmatter: { status: 'working', related: ['projects/keep-link'] },
    });
    await engine.createVersion('projects/exact-metadata');
    await engine.upsertChunks('projects/exact-metadata', [
      { chunk_index: 0, chunk_text: 'Semantic body stays byte-identical.', chunk_source: 'compiled_truth' },
    ]);
    const baselineCounts = await counts();
    const before = (await engine.getPage('projects/exact-metadata'))!;

    const first = await op.handler(ctx(), {
      slug: before.slug,
      expected_content_hash: before.content_hash,
      patch: {
        status: 'archived',
        memory_tier: 'cold',
        governance_reason: 'solo-founder-retention',
        governance_mutation_log: [{ action: 'archive', policy: 'test' }],
      },
      unset: [],
    }) as { content_hash: string };
    const archived = (await engine.getPage(before.slug))!;
    expect(archived.frontmatter).toMatchObject({
      status: 'archived',
      memory_tier: 'cold',
      governance_reason: 'solo-founder-retention',
      related: ['projects/keep-link'],
    });
    expect(archived.type).toBe(before.type);
    expect(archived.title).toBe(before.title);
    expect(archived.compiled_truth).toBe(before.compiled_truth);
    expect(archived.timeline).toBe(before.timeline);
    expect(archived.content_hash).toBe(first.content_hash);
    expect(await counts()).toEqual(baselineCounts);

    await op.handler(ctx(), {
      slug: archived.slug,
      expected_content_hash: archived.content_hash,
      patch: { status: 'working' },
      unset: ['memory_tier', 'governance_reason', 'governance_mutation_log'],
    });
    const rolledBack = (await engine.getPage(before.slug))!;
    expect(rolledBack.frontmatter.status).toBe('working');
    expect(Object.hasOwn(rolledBack.frontmatter, 'memory_tier')).toBe(false);
    expect(Object.hasOwn(rolledBack.frontmatter, 'governance_reason')).toBe(false);
    expect(Object.hasOwn(rolledBack.frontmatter, 'governance_mutation_log')).toBe(false);
    expect(rolledBack.frontmatter.related).toEqual(['projects/keep-link']);
    expect(await counts()).toEqual(baselineCounts);
  });

  test('rejects stale hash and forbidden/null/overlapping keys before write', async () => {
    await engine.putPage('projects/metadata-drift', {
      type: 'note', title: 'Drift', compiled_truth: 'body', timeline: '',
      frontmatter: { status: 'working' },
    });
    const before = (await engine.getPage('projects/metadata-drift'))!;
    const baselineCounts = await counts();

    await expect(operationsByName.patch_page_metadata_exact.handler(ctx(), {
      slug: before.slug,
      expected_content_hash: 'stale-hash',
      patch: { status: 'archived' },
      unset: [],
    })).rejects.toThrow('content hash changed');
    await expect(operationsByName.patch_page_metadata_exact.handler(ctx(), {
      slug: before.slug,
      expected_content_hash: before.content_hash,
      patch: { title: 'forbidden' },
      unset: [],
    })).rejects.toThrow('not allowed');
    await expect(operationsByName.patch_page_metadata_exact.handler(ctx(), {
      slug: before.slug,
      expected_content_hash: before.content_hash,
      patch: { status: null },
      unset: [],
    })).rejects.toThrow('use unset');
    await expect(operationsByName.patch_page_metadata_exact.handler(ctx(), {
      slug: before.slug,
      expected_content_hash: before.content_hash,
      patch: { status: 'archived' },
      unset: ['status'],
    })).rejects.toThrow('set and unset');

    const after = (await engine.getPage(before.slug))!;
    expect(after.frontmatter).toEqual(before.frontmatter);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(await counts()).toEqual(baselineCounts);
  });
});

describe('put_page_file_exact', () => {
  test('is local-only admin, gates stale/mode, and uses canonical ingestion without capture provenance', async () => {
    const op = operationsByName.put_page_file_exact;
    expect(op.localOnly).toBe(true);
    expect(op.scope).toBe('admin');
    expect(op.mutating).toBe(true);

    await engine.putPage('projects/file-target', {
      type: 'note', title: 'Target', compiled_truth: 'target', timeline: '', frontmatter: {},
    });
    await engine.putPage('projects/exact-file', {
      type: 'note', title: 'Before', compiled_truth: 'old body', timeline: '', frontmatter: {},
    });
    const before = (await engine.getPage('projects/exact-file'))!;
    const baselineCounts = await counts();
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-exact-file-'));
    const filePath = join(dir, 'page.md');
    const marker = 'private-file-content-marker';
    const content = `---\ntype: note\ntitle: After\ntags:\n  - exact-file\nrelated:\n  - projects/file-target\n---\n\n# After\n\n${marker}\n`;

    try {
      await writeFile(filePath, content, { mode: 0o600 });

      await expect(op.handler(ctx(), {
        slug: before.slug,
        expected_content_hash: 'stale-hash',
        file_path: filePath,
      })).rejects.toThrow('content hash changed');
      expect(await counts()).toEqual(baselineCounts);

      await chmod(filePath, 0o640);
      await expect(op.handler(ctx(), {
        slug: before.slug,
        expected_content_hash: before.content_hash,
        file_path: filePath,
      })).rejects.toThrow('mode must be exactly 0600');
      expect(await counts()).toEqual(baselineCounts);

      await chmod(filePath, 0o600);
      const result = await op.handler(ctx(), {
        slug: before.slug,
        expected_content_hash: before.content_hash,
        file_path: filePath,
      }) as { status: string; slug: string; content_hash: string };
      const after = (await engine.getPage(before.slug))!;
      const afterCounts = await counts();
      const tags = await engine.getTags(before.slug, { sourceId: 'default' });
      const links = await engine.getLinks(before.slug, { sourceId: 'default' });
      const provenance = await engine.executeRaw<{
        source_kind: string | null;
        source_uri: string | null;
        ingested_via: string | null;
      }>(
        `SELECT source_kind, source_uri, ingested_via
           FROM pages WHERE source_id = $1 AND slug = $2`,
        ['default', before.slug],
      );

      expect(after.title).toBe('After');
      expect(after.compiled_truth).toContain(marker);
      expect(after.content_hash).toBe(result.content_hash);
      expect(afterCounts.versions).toBe(baselineCounts.versions + 1);
      expect(afterCounts.chunks).toBeGreaterThan(0);
      expect(tags).toContain('exact-file');
      expect(links.some((link) => link.to_slug === 'projects/file-target')).toBe(true);
      expect(provenance[0]).toEqual({ source_kind: null, source_uri: null, ingested_via: null });
      expect(result).toEqual({ status: 'written', slug: before.slug!, content_hash: after.content_hash! });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(result).not.toHaveProperty('content');
      expect(result).not.toHaveProperty('file_path');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('rejects remote, non-regular, oversized, NUL, and invalid UTF-8 input before write', async () => {
    const op = operationsByName.put_page_file_exact;
    await engine.putPage('projects/file-validation', {
      type: 'note', title: 'Unchanged', compiled_truth: 'baseline', timeline: '', frontmatter: {},
    });
    const before = (await engine.getPage('projects/file-validation'))!;
    const baselineCounts = await counts();
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-exact-validation-'));
    const filePath = join(dir, 'page.md');
    const symlinkPath = join(dir, 'page-link.md');

    const params = (path: string) => ({
      slug: before.slug,
      expected_content_hash: before.content_hash,
      file_path: path,
    });
    try {
      await writeFile(filePath, 'valid', { mode: 0o600 });
      await expect(op.handler({ ...ctx(), remote: true }, params(filePath))).rejects.toThrow('local-only');
      await expect(op.handler(ctx(), params('relative.md'))).rejects.toThrow('must be absolute');
      await expect(op.handler(ctx(), params(dir))).rejects.toThrow('regular file');
      await symlink(filePath, symlinkPath);
      await expect(op.handler(ctx(), params(symlinkPath))).rejects.toThrow('regular file');

      await writeFile(filePath, Buffer.from([0x61, 0x00, 0x62]), { mode: 0o600 });
      await expect(op.handler(ctx(), params(filePath))).rejects.toThrow('without NUL');
      await writeFile(filePath, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
      await expect(op.handler(ctx(), params(filePath))).rejects.toThrow('valid UTF-8');
      await truncate(filePath, 16 * 1024 * 1024 + 1);
      await expect(op.handler(ctx(), params(filePath))).rejects.toThrow('16 MiB');

      const after = (await engine.getPage(before.slug))!;
      expect(after.content_hash).toBe(before.content_hash);
      expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
      expect(await counts()).toEqual(baselineCounts);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
