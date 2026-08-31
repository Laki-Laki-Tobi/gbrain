import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeImportContentHash } from '../src/core/import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { inventoryDeletedPagesExact } from '../src/core/exact-corpus-remediation.ts';
import { withEnv } from './helpers/with-env.ts';

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

async function seedDeletedInventoryPage(slug: string, body: string, hoursAgo: number, sourceId = 'default') {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId });
  await engine.softDeletePage(slug, { sourceId });
  await engine.executeRaw(
    `UPDATE pages
        SET deleted_at = now() - ($1::int * interval '1 hour')
      WHERE source_id = $2 AND slug = $3`,
    [hoursAgo, sourceId, slug],
  );
  return (await engine.getPage(slug, { sourceId, includeDeleted: true }))!;
}

function canonicalPostimageHash(slug: string, content: string): string {
  const parsed = parseMarkdown(content, `${slug}.md`);
  return computeImportContentHash({
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline || '',
    frontmatter: parsed.frontmatter,
    tags: parsed.tags,
  });
}

async function renderedMarkdownSha256(slug: string): Promise<string> {
  const page = await engine.getPage(slug, { sourceId: 'default', includeDeleted: true });
  if (!page) throw new Error(`missing page: ${slug}`);
  const tags = await engine.getTags(slug, { sourceId: 'default' });
  return createHash('sha256').update(serializePageToMarkdown(page, tags)).digest('hex');
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

describe('page_version_retention_exact', () => {
  test('plans, applies, verifies, and rolls back a bounded source-scoped batch', async () => {
    const op = operationsByName.page_version_retention_exact;
    expect(op.localOnly).toBe(true);
    expect(op.scope).toBe('admin');
    expect(op.mutating).toBe(true);

    await engine.putPage('projects/version-retention', {
      type: 'note', title: 'Version retention', compiled_truth: 'current body', timeline: '', frontmatter: {},
    });
    const [page] = await engine.executeRaw<{ id: number | string }>(
      `SELECT id FROM pages WHERE source_id = $1 AND slug = $2`,
      ['default', 'projects/version-retention'],
    );
    for (let index = 0; index < 5; index += 1) {
      await engine.executeRaw(`
        INSERT INTO page_versions (page_id, compiled_truth, frontmatter, snapshot_at)
        VALUES ($1::int, $2::text, $3::jsonb, now() - ($4::int * interval '1 day'))
      `, [Number(page.id), `private-version-${index}`, JSON.stringify({ index }), 30 + index]);
    }

    const home = await mkdtemp(join(tmpdir(), 'gbrain-retention-home-'));
    const params = {
      action: 'plan', run_id: 'retention-test', retention_days: 7,
      keep_latest: 2, delete_limit: 5000, max_payload_bytes: 1024 * 1024,
    };
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await expect(op.handler({ ...ctx(), remote: true }, params)).rejects.toThrow('local-only');
        const plan = await op.handler(ctx(), params) as any;
        expect(plan.status).toBe('pass');
        expect(plan.candidate_count).toBe(3);
        expect(plan).not.toHaveProperty('candidate_ids');
        expect(JSON.stringify(plan)).not.toContain('private-version');

        const dir = join(home, 'governance-backups', 'page-versions', 'retention-test');
        expect((await stat(join(dir, 'plan.json'))).mode & 0o777).toBe(0o600);
        expect((await stat(join(dir, 'backup.json.gz'))).mode & 0o777).toBe(0o600);

        await expect(op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.candidate_fingerprint,
        })).rejects.toThrow('apply_enabled=true');
        const applied = await op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.candidate_fingerprint, apply_enabled: true,
        }) as any;
        expect(applied.status).toBe('pass');
        expect(applied.deleted_count).toBe(3);
        expect((await op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.candidate_fingerprint, apply_enabled: true,
        }) as any).deleted_count).toBe(3);

        const verified = await op.handler(ctx(), { ...params, action: 'verify' }) as any;
        expect(verified.status).toBe('pass');
        expect(verified.remaining_count).toBe(0);
        expect((await op.handler(ctx(), { ...params, action: 'verify' }) as any).status).toBe('pass');
        expect((await counts()).versions).toBe(2);

        const rolledBack = await op.handler(ctx(), {
          ...params, action: 'rollback', expected_fingerprint: plan.candidate_fingerprint, apply_enabled: true,
        }) as any;
        expect(rolledBack.status).toBe('pass');
        expect(rolledBack.restored_count).toBe(3);
        expect((await counts()).versions).toBe(5);
        expect((await op.handler(ctx(), {
          ...params, action: 'rollback', expected_fingerprint: plan.candidate_fingerprint, apply_enabled: true,
        }) as any).restored_count).toBe(3);
        await expect(op.handler(ctx(), { ...params, action: 'verify' })).rejects.toThrow('does not match database state');
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('requires an explicit gate to recover a missing apply artifact after an ambiguous commit', async () => {
    const op = operationsByName.page_version_retention_exact;
    await engine.putPage('projects/version-retention-recovery', {
      type: 'note', title: 'Version retention recovery', compiled_truth: 'current body', timeline: '', frontmatter: {},
    });
    const [page] = await engine.executeRaw<{ id: number | string }>(
      `SELECT id FROM pages WHERE source_id = $1 AND slug = $2`,
      ['default', 'projects/version-retention-recovery'],
    );
    for (let index = 0; index < 4; index += 1) {
      await engine.executeRaw(`
        INSERT INTO page_versions (page_id, compiled_truth, frontmatter, snapshot_at)
        VALUES ($1::int, $2::text, $3::jsonb, now() - ($4::int * interval '1 day'))
      `, [Number(page.id), `recovery-version-${index}`, JSON.stringify({ index }), 30 + index]);
    }

    const home = await mkdtemp(join(tmpdir(), 'gbrain-retention-recovery-home-'));
    const params = {
      action: 'plan', run_id: 'retention-recovery-test', retention_days: 7,
      keep_latest: 2, delete_limit: 5000, max_payload_bytes: 1024 * 1024,
    };
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const plan = await op.handler(ctx(), params) as any;
        const planFile = join(home, 'governance-backups', 'page-versions', 'retention-recovery-test', 'plan.json');
        const privatePlan = JSON.parse(await readFile(planFile, 'utf8'));
        await engine.executeRaw(
          `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
          ['retention-other'],
        );
        await engine.executeRaw('UPDATE pages SET source_id = $1 WHERE id = $2::int', ['retention-other', Number(page.id)]);
        await expect(op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.candidate_fingerprint,
          apply_enabled: true, accept_ambiguous_commit: true,
        })).rejects.toThrow('source identity drift');
        await engine.executeRaw('UPDATE pages SET source_id = $1 WHERE id = $2::int', ['default', Number(page.id)]);
        await engine.executeRaw('DELETE FROM page_versions WHERE id = ANY($1::int[])', [privatePlan.candidate_ids]);

        await expect(op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.candidate_fingerprint, apply_enabled: true,
        })).rejects.toThrow('accept_ambiguous_commit=true');
        const recovered = await op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.candidate_fingerprint,
          apply_enabled: true, accept_ambiguous_commit: true,
        }) as any;
        expect(recovered.status).toBe('pass');
        expect(recovered.recovered_after_ambiguous_commit).toBe(true);
        expect((await op.handler(ctx(), { ...params, action: 'verify' }) as any).status).toBe('pass');
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('put_page_file_exact', () => {
  test('is local-only admin, gates stale/mode, and bypasses ordinary put_page post-hooks', async () => {
    const op = operationsByName.put_page_file_exact;
    expect(op.localOnly).toBe(true);
    expect(op.scope).toBe('admin');
    expect(op.mutating).toBe(true);
    expect(op.params.expected_preimage_markdown_sha256).toMatchObject({ required: true });

    await engine.putPage('projects/file-target', {
      type: 'note', title: 'Target', compiled_truth: 'target', timeline: '', frontmatter: {},
    });
    await engine.putPage('src-core-sync-ts', {
      type: 'code', title: 'src/core/sync.ts', compiled_truth: 'code target', timeline: '', frontmatter: {},
    });
    await engine.putPage('projects/exact-file', {
      type: 'note', title: 'Before', compiled_truth: 'old body', timeline: '', frontmatter: {},
    });
    await engine.addTag('projects/exact-file', 'stale-enrichment');
    const before = (await engine.getPage('projects/exact-file'))!;
    const baselineCounts = await counts();
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-exact-file-'));
    const filePath = join(dir, 'page.md');
    const marker = 'private-file-content-marker';
    const content = `---\ntype: note\ntitle: After\ntags:\n  - exact-file\naliases:\n  - Exact File Alias\nrelated:\n  - projects/file-target\n---\n\n# After\n\n${marker}. See src/core/sync.ts:42.\n`;
    const fileSha = createHash('sha256').update(content).digest('hex');
    const postimageHash = canonicalPostimageHash(before.slug, content);
    const exactParams = {
      slug: before.slug,
      expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: await renderedMarkdownSha256(before.slug),
      expected_content_sha256: fileSha,
      expected_postimage_content_hash: postimageHash,
      file_path: filePath,
    };
    const ordinaryPutHandler = operationsByName.put_page.handler;
    let ordinaryPutCalls = 0;

    try {
      await writeFile(filePath, content, { mode: 0o600 });

      await expect(op.handler(ctx(), {
        ...exactParams,
        slug: 'Projects/Exact-File',
      })).rejects.toThrow('slug must be lowercase');
      await expect(op.handler(ctx(), {
        ...exactParams,
        expected_content_hash: '0'.repeat(64),
      })).rejects.toThrow('preimage hash drift');
      expect(await counts()).toEqual(baselineCounts);

      await chmod(filePath, 0o640);
      await expect(op.handler(ctx(), exactParams)).rejects.toThrow('mode must be exactly 0600');
      expect(await counts()).toEqual(baselineCounts);

      await chmod(filePath, 0o600);
      operationsByName.put_page.handler = async () => {
        ordinaryPutCalls += 1;
        throw new Error('ordinary put_page handler must not run');
      };
      const result = await op.handler(ctx(), exactParams) as { status: string; slug: string; content_hash: string };
      const after = (await engine.getPage(before.slug))!;
      const afterCounts = await counts();
      const tags = await engine.getTags(before.slug, { sourceId: 'default' });
      const links = await engine.getLinks(before.slug, { sourceId: 'default' });
      const chunkEmbeddings = await engine.executeRaw<{ embedding_present: boolean }>(
        `SELECT (cc.embedding IS NOT NULL) AS embedding_present
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
          WHERE p.source_id = $1 AND p.slug = $2`,
        ['default', before.slug],
      );
      const provenance = await engine.executeRaw<{
        source_kind: string | null;
        source_uri: string | null;
        ingested_via: string | null;
      }>(
        `SELECT source_kind, source_uri, ingested_via
           FROM pages WHERE source_id = $1 AND slug = $2`,
        ['default', before.slug],
      );
      const projectedRead = await operationsByName.get_page.handler(ctx(), {
        slug: before.slug,
      }) as { aliases: string[] };

      expect(after.title).toBe('After');
      expect(after.compiled_truth).toContain(marker);
      expect(after.content_hash).toBe(result.content_hash);
      expect(afterCounts.versions).toBe(baselineCounts.versions + 1);
      expect(afterCounts.chunks).toBeGreaterThan(0);
      expect(tags).toEqual(['exact-file']);
      expect(links.some((link) => link.to_slug === 'projects/file-target')).toBe(false);
      expect(await engine.executeRaw(`SELECT id FROM links`)).toEqual([]);
      expect(chunkEmbeddings.length).toBeGreaterThan(0);
      expect(chunkEmbeddings.every((row) => row.embedding_present === false)).toBe(true);
      expect(ordinaryPutCalls).toBe(0);
      expect(await engine.executeRaw(
        `SELECT alias_norm FROM page_aliases WHERE source_id = 'default' AND slug = $1`, [before.slug],
      )).toEqual([{ alias_norm: 'exact file alias' }]);
      expect(projectedRead.aliases).toEqual(['exact file alias']);
      expect(provenance[0]).toEqual({ source_kind: null, source_uri: null, ingested_via: null });
      expect(result).toEqual({ status: 'written', slug: before.slug!, content_hash: after.content_hash! });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(result).not.toHaveProperty('content');
      expect(result).not.toHaveProperty('file_path');
    } finally {
      operationsByName.put_page.handler = ordinaryPutHandler;
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
    const validContent = '---\ntype: note\ntitle: Valid draft\n---\n\nValid body.\n';
    const fileSha = createHash('sha256').update(validContent).digest('hex');
    const postimageHash = canonicalPostimageHash(before.slug, validContent);
    const renderedPreimageSha = await renderedMarkdownSha256(before.slug);

    const params = (path: string) => ({
      slug: before.slug,
      expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: renderedPreimageSha,
      expected_content_sha256: fileSha,
      expected_postimage_content_hash: postimageHash,
      file_path: path,
    });
    try {
      await writeFile(filePath, validContent, { mode: 0o600 });
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

  test('rejects unapproved file bytes and canonical postimages before any write', async () => {
    const op = operationsByName.put_page_file_exact;
    await engine.putPage('projects/exact-draft-gates', {
      type: 'note', title: 'Baseline', compiled_truth: 'baseline', timeline: '', frontmatter: {},
    });
    const before = (await engine.getPage('projects/exact-draft-gates'))!;
    const baselineCounts = await counts();
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-exact-draft-gates-'));
    const filePath = join(dir, 'draft.md');
    const content = '---\ntype: note\ntitle: Approved draft\n---\n\nApproved body.\n';
    const fileSha = createHash('sha256').update(content).digest('hex');
    const postimageHash = canonicalPostimageHash(before.slug, content);
    const params = {
      slug: before.slug,
      expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: await renderedMarkdownSha256(before.slug),
      expected_content_sha256: fileSha,
      expected_postimage_content_hash: postimageHash,
      file_path: filePath,
    };
    try {
      await writeFile(filePath, content, { mode: 0o600 });
      await expect(op.handler(ctx(), {
        ...params, expected_content_sha256: '0'.repeat(64),
      })).rejects.toThrow('file sha256 changed');
      await expect(op.handler(ctx(), {
        ...params, expected_postimage_content_hash: '0'.repeat(64),
      })).rejects.toThrow('postimage hash mismatch');
      const after = (await engine.getPage(before.slug))!;
      expect(after.content_hash).toBe(before.content_hash);
      expect(after.title).toBe('Baseline');
      expect(await counts()).toEqual(baselineCounts);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rechecks the preimage under lock and never writes a draft that lost the CAS race', async () => {
    const op = operationsByName.put_page_file_exact;
    await engine.putPage('projects/exact-preimage-race', {
      type: 'note', title: 'Initial', compiled_truth: 'initial body', timeline: '', frontmatter: {},
    });
    const before = (await engine.getPage('projects/exact-preimage-race'))!;
    const baselineCounts = await counts();
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-exact-preimage-race-'));
    const filePath = join(dir, 'approved.md');
    const marker = 'approved-draft-must-not-land';
    const content = `---\ntype: note\ntitle: Approved\naliases:\n  - Must Not Land\n---\n\n${marker}\n`;
    const originalTransaction = engine.transaction;
    let injected = false;
    try {
      await writeFile(filePath, content, { mode: 0o600 });
      engine.transaction = async function <T>(fn: (tx: import('../src/core/engine.ts').BrainEngine) => Promise<T>): Promise<T> {
        if (!injected) {
          injected = true;
          await engine.putPage(before.slug, {
            type: 'note', title: 'Concurrent winner', compiled_truth: 'concurrent body', timeline: '', frontmatter: {},
          });
        }
        return originalTransaction.call(engine, fn) as Promise<T>;
      };
      await expect(op.handler(ctx(), {
        slug: before.slug,
        expected_content_hash: before.content_hash,
        expected_preimage_markdown_sha256: await renderedMarkdownSha256(before.slug),
        expected_content_sha256: createHash('sha256').update(content).digest('hex'),
        expected_postimage_content_hash: canonicalPostimageHash(before.slug, content),
        file_path: filePath,
      })).rejects.toThrow('preimage hash drift');
      const after = (await engine.getPage(before.slug))!;
      expect(after.title).toBe('Concurrent winner');
      expect(after.compiled_truth).toBe('concurrent body');
      expect(after.compiled_truth).not.toContain(marker);
      expect((await counts()).versions).toBe(baselineCounts.versions);
      expect(await engine.executeRaw(
        `SELECT alias_norm FROM page_aliases WHERE source_id = 'default' AND slug = $1`, [before.slug],
      )).toEqual([]);
    } finally {
      engine.transaction = originalTransaction;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects a raw-only preimage race under the same locked DB content hash', async () => {
    const op = operationsByName.put_page_file_exact;
    await engine.putPage('projects/exact-raw-preimage-race', {
      type: 'note', title: 'Initial', compiled_truth: 'initial body', timeline: '',
      frontmatter: { captured_at: '2026-08-28T00:00:00Z' },
    });
    const before = (await engine.getPage('projects/exact-raw-preimage-race'))!;
    const beforeMarkdownSha256 = await renderedMarkdownSha256(before.slug);
    const baselineCounts = await counts();
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-exact-raw-preimage-race-'));
    const filePath = join(dir, 'approved.md');
    const marker = 'raw-race-approved-draft-must-not-land';
    const content = `---\ntype: note\ntitle: Approved\n---\n\n${marker}\n`;
    const originalTransaction = engine.transaction;
    let injected = false;
    try {
      await writeFile(filePath, content, { mode: 0o600 });
      engine.transaction = async function <T>(fn: (tx: import('../src/core/engine.ts').BrainEngine) => Promise<T>): Promise<T> {
        if (!injected) {
          injected = true;
          await engine.putPage(before.slug, {
            type: before.type,
            title: before.title,
            compiled_truth: before.compiled_truth,
            timeline: before.timeline,
            frontmatter: { captured_at: '2026-08-28T00:00:01Z' },
            content_hash: before.content_hash,
          });
        }
        return originalTransaction.call(engine, fn) as Promise<T>;
      };
      await expect(op.handler(ctx(), {
        slug: before.slug,
        expected_content_hash: before.content_hash,
        expected_preimage_markdown_sha256: beforeMarkdownSha256,
        expected_content_sha256: createHash('sha256').update(content).digest('hex'),
        expected_postimage_content_hash: canonicalPostimageHash(before.slug, content),
        file_path: filePath,
      })).rejects.toThrow('preimage markdown drift');
      const after = (await engine.getPage(before.slug))!;
      expect(after.content_hash).toBe(before.content_hash);
      expect(after.frontmatter).toMatchObject({ captured_at: '2026-08-28T00:00:01Z' });
      expect(after.compiled_truth).not.toContain(marker);
      expect((await counts()).versions).toBe(baselineCounts.versions);
    } finally {
      engine.transaction = originalTransaction;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('serializes a concurrent tag writer behind the exact page-row lock', async () => {
    const op = operationsByName.put_page_file_exact;
    const slug = 'projects/exact-tag-race';
    await engine.putPage(slug, {
      type: 'note', title: 'Initial', compiled_truth: 'initial body', timeline: '', frontmatter: {},
    });
    await engine.addTag(slug, 'baseline-tag');
    const before = (await engine.getPage(slug))!;
    const beforeMarkdownSha256 = await renderedMarkdownSha256(slug);
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-exact-tag-race-'));
    const filePath = join(dir, 'approved.md');
    const content = '---\ntype: note\ntitle: Approved\ntags:\n  - approved-tag\n---\n\nApproved body.\n';
    const originalTransaction = engine.transaction;
    let concurrentTagWrite: Promise<unknown> = Promise.resolve();
    let scheduled = false;
    try {
      await writeFile(filePath, content, { mode: 0o600 });
      engine.transaction = async function <T>(fn: (tx: import('../src/core/engine.ts').BrainEngine) => Promise<T>): Promise<T> {
        return originalTransaction.call(engine, async (tx) => {
          const originalGetTags = tx.getTags.bind(tx);
          tx.getTags = async (...args: Parameters<typeof tx.getTags>) => {
            const tags = await originalGetTags(...args);
            if (!scheduled) {
              scheduled = true;
              concurrentTagWrite = originalTransaction.call(engine, async (concurrentTx) => {
                await concurrentTx.addTag(slug, 'concurrent-tag');
              });
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            return tags;
          };
          return fn(tx);
        }) as Promise<T>;
      };
      await expect(op.handler(ctx(), {
        slug,
        expected_content_hash: before.content_hash,
        expected_preimage_markdown_sha256: beforeMarkdownSha256,
        expected_content_sha256: createHash('sha256').update(content).digest('hex'),
        expected_postimage_content_hash: canonicalPostimageHash(slug, content),
        file_path: filePath,
      })).rejects.toThrow('readback mismatch');
      await concurrentTagWrite;
      expect((await engine.getPage(slug))?.title).toBe('Approved');
      expect(await engine.getTags(slug)).toEqual(['approved-tag', 'concurrent-tag']);
    } finally {
      engine.transaction = originalTransaction;
      await concurrentTagWrite.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('reindex_page_links_exact', () => {
  test('indexes an exact wikilink in a custom namespace without rewriting the page', async () => {
    const op = operationsByName.reindex_page_links_exact;
    const origin = 'codex/checkpoints/sprint-2';
    const target = 'codex/canonical-summaries/astro7-kintsugi-backlink-rewire-consolidation';
    await engine.putPage(target, {
      type: 'note', title: 'Canonical summary', compiled_truth: 'summary', timeline: '', frontmatter: {},
    });
    await engine.putPage(origin, {
      type: 'note', title: 'Sprint checkpoint',
      compiled_truth: `Durable state: [[${target}]]`, timeline: '', frontmatter: {},
    });
    const before = (await engine.getPage(origin))!;
    const beforeMarkdownSha256 = await renderedMarkdownSha256(origin);
    const beforeCounts = await counts();

    const result = await op.handler(ctx(), {
      slug: origin,
      expected_content_hash: before.content_hash,
      expected_markdown_sha256: beforeMarkdownSha256,
    }) as any;
    const after = (await engine.getPage(origin))!;
    const links = await engine.getLinks(origin, { sourceId: 'default' });

    expect(result).toMatchObject({
      status: 'reindexed', slug: origin, content_hash: before.content_hash, created: 1, removed: 0,
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      from_slug: origin,
      to_slug: target,
      link_source: 'markdown',
    });
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(await renderedMarkdownSha256(origin)).toBe(beforeMarkdownSha256);
    expect(await counts()).toEqual(beforeCounts);
  });

  test('repairs a fuzzy same-basename frontmatter edge without rewriting the page or creating a version', async () => {
    const op = operationsByName.reindex_page_links_exact;
    expect(op.localOnly).toBe(true);
    expect(op.scope).toBe('admin');
    expect(op.mutating).toBe(true);

    const origin = 'memphis/reviews/source';
    const exactTarget = 'memphis/reports/shared-artifact';
    const wrongTarget = 'memphis/manifests/shared-artifact';
    await engine.putPage(exactTarget, {
      type: 'note', title: 'Report artifact', compiled_truth: 'report', timeline: '', frontmatter: {},
    });
    await engine.putPage(wrongTarget, {
      type: 'note', title: 'Manifest artifact', compiled_truth: 'manifest', timeline: '', frontmatter: {},
    });
    await engine.putPage(origin, {
      type: 'note', title: 'Source', compiled_truth: 'source body', timeline: '',
      frontmatter: { related: [`[[${exactTarget}]]`] },
    });
    await engine.addLink(
      origin, wrongTarget, `frontmatter.related: [[${exactTarget}]]`, 'related_to',
      'frontmatter', origin, 'related',
      { fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default' },
    );
    const before = (await engine.getPage(origin))!;
    const beforeMarkdownSha256 = await renderedMarkdownSha256(origin);
    const beforeCounts = await counts();

    const result = await op.handler(ctx(), {
      slug: origin,
      expected_content_hash: before.content_hash,
      expected_markdown_sha256: beforeMarkdownSha256,
    }) as any;
    const after = (await engine.getPage(origin))!;
    const links = await engine.getLinks(origin, { sourceId: 'default' });

    expect(result).toMatchObject({ status: 'reindexed', slug: origin, content_hash: before.content_hash, created: 1, removed: 1 });
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(await renderedMarkdownSha256(origin)).toBe(beforeMarkdownSha256);
    expect(await counts()).toEqual(beforeCounts);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      from_slug: origin,
      to_slug: exactTarget,
      link_type: 'related_to',
      link_source: 'frontmatter',
      origin_slug: origin,
      origin_field: 'related',
      context: `frontmatter.related: [[${exactTarget}]]`,
    });
    expect(JSON.stringify(result)).not.toContain('source body');
  });

  test('fails before mutation on remote, stale preimage, or unresolved frontmatter', async () => {
    const op = operationsByName.reindex_page_links_exact;
    const origin = 'projects/reindex-gates';
    await engine.putPage(origin, {
      type: 'note', title: 'Gates', compiled_truth: 'unchanged', timeline: '',
      frontmatter: { related: ['[[missing/nested/page]]'] },
    });
    const page = (await engine.getPage(origin))!;
    const markdownSha256 = await renderedMarkdownSha256(origin);
    const baseline = await counts();
    const params = { slug: origin, expected_content_hash: page.content_hash, expected_markdown_sha256: markdownSha256 };

    await expect(op.handler({ ...ctx(), remote: true }, params)).rejects.toThrow('local-only');
    await expect(op.handler(ctx(), { ...params, expected_content_hash: '0'.repeat(64) })).rejects.toThrow('preimage hash drift');
    await expect(op.handler(ctx(), { ...params, expected_markdown_sha256: '0'.repeat(64) })).rejects.toThrow('markdown drift');
    await expect(op.handler(ctx(), params)).rejects.toThrow('unresolved frontmatter');
    expect(await engine.getLinks(origin, { sourceId: 'default' })).toEqual([]);
    expect(await counts()).toEqual(baseline);
  });

  test('resolves fuzzy frontmatter only inside the requested source', async () => {
    const origin = 'projects/source-scoped-reindex';
    const localTarget = 'z/local-artifact';
    const foreignTarget = 'a/foreign-artifact';
    await engine.putPage(localTarget, {
      type: 'note', title: 'Shared artifact', compiled_truth: 'local', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      ['foreign', 'Foreign test source'],
    );
    await engine.putPage(foreignTarget, {
      type: 'note', title: 'Shared artifact', compiled_truth: 'foreign', timeline: '', frontmatter: {},
    }, { sourceId: 'foreign' });
    await engine.putPage(origin, {
      type: 'note', title: 'Scoped source', compiled_truth: 'body', timeline: '',
      frontmatter: { related: ['Shared artifact'] },
    }, { sourceId: 'default' });
    const page = (await engine.getPage(origin, { sourceId: 'default' }))!;

    await operationsByName.reindex_page_links_exact.handler(ctx(), {
      slug: origin,
      expected_content_hash: page.content_hash,
      expected_markdown_sha256: await renderedMarkdownSha256(origin),
    });

    const links = await engine.getLinks(origin, { sourceId: 'default' });
    expect(links.map(link => link.to_slug)).toEqual([localTarget]);
    expect(links.map(link => link.to_slug)).not.toContain(foreignTarget);
  });

  test('uses the in-transaction target inventory when a target disappears before the lock', async () => {
    const origin = 'projects/transactional-target-inventory';
    const target = 'projects/disappearing-target';
    await engine.putPage(target, {
      type: 'note', title: 'Target', compiled_truth: 'target', timeline: '', frontmatter: {},
    });
    await engine.putPage(origin, {
      type: 'note', title: 'Origin', compiled_truth: `[[${target}]]`, timeline: '', frontmatter: {},
    });
    await engine.addLink(origin, target, `[[${target}]]`, 'related_to', 'markdown', origin, undefined, {
      fromSourceId: 'default', toSourceId: 'default', originSourceId: 'default',
    });
    const page = (await engine.getPage(origin))!;
    const params = {
      slug: origin,
      expected_content_hash: page.content_hash,
      expected_markdown_sha256: await renderedMarkdownSha256(origin),
    };
    const originalTransaction = engine.transaction.bind(engine);
    let injected = false;
    (engine as any).transaction = async (fn: any) => {
      if (!injected) {
        injected = true;
        await engine.softDeletePage(target, { sourceId: 'default' });
      }
      return originalTransaction(fn);
    };
    try {
      const result = await operationsByName.reindex_page_links_exact.handler(ctx(), params) as any;
      expect(result.created).toBe(0);
    } finally {
      delete (engine as any).transaction;
    }
    expect(await engine.getLinks(origin, { sourceId: 'default' })).toEqual([]);
  });

  test('rolls back the complete reconciliation when a later link mutation fails', async () => {
    const origin = 'projects/reindex-rollback';
    const targets = ['projects/reindex-target-a', 'projects/reindex-target-b'];
    for (const target of targets) {
      await engine.putPage(target, {
        type: 'note', title: target, compiled_truth: target, timeline: '', frontmatter: {},
      });
    }
    await engine.putPage(origin, {
      type: 'note', title: 'Rollback', compiled_truth: targets.map(target => `[[${target}]]`).join('\n'),
      timeline: '', frontmatter: {},
    });
    const page = (await engine.getPage(origin))!;
    const originalTransaction = engine.transaction.bind(engine);
    let addCalls = 0;
    (engine as any).transaction = async (fn: any) => originalTransaction(async (tx) => {
      const originalAddLink = tx.addLink.bind(tx);
      (tx as any).addLink = async (...args: any[]) => {
        addCalls++;
        if (addCalls === 2) throw new Error('injected second-link failure');
        return (originalAddLink as any)(...args);
      };
      return fn(tx);
    });
    try {
      await expect(operationsByName.reindex_page_links_exact.handler(ctx(), {
        slug: origin,
        expected_content_hash: page.content_hash,
        expected_markdown_sha256: await renderedMarkdownSha256(origin),
      })).rejects.toThrow('injected second-link failure');
    } finally {
      delete (engine as any).transaction;
    }
    expect(addCalls).toBe(2);
    expect(await engine.getLinks(origin, { sourceId: 'default' })).toEqual([]);
  });

  test('does not report a false failure for a page mutation committed after reconciliation', async () => {
    const origin = 'projects/post-commit-concurrency';
    const target = 'projects/post-commit-target';
    await engine.putPage(target, {
      type: 'note', title: 'Target', compiled_truth: 'target', timeline: '', frontmatter: {},
    });
    await engine.putPage(origin, {
      type: 'note', title: 'Before', compiled_truth: `[[${target}]]`, timeline: '', frontmatter: {},
    });
    const page = (await engine.getPage(origin))!;
    const originalTransaction = engine.transaction.bind(engine);
    (engine as any).transaction = async (fn: any) => {
      const result = await originalTransaction(fn);
      await engine.executeRaw(
        `UPDATE pages SET title = 'Concurrent update' WHERE source_id = $1 AND slug = $2`,
        ['default', origin],
      );
      return result;
    };
    try {
      await expect(operationsByName.reindex_page_links_exact.handler(ctx(), {
        slug: origin,
        expected_content_hash: page.content_hash,
        expected_markdown_sha256: await renderedMarkdownSha256(origin),
      })).resolves.toMatchObject({ status: 'reindexed', slug: origin });
    } finally {
      delete (engine as any).transaction;
    }
    expect((await engine.getPage(origin))?.title).toBe('Concurrent update');
  });
});

describe('put_page auto-link concurrency', () => {
  test('an older post-hook cannot overwrite links from a newer page write', async () => {
    const origin = 'projects/ordinary-auto-link-race';
    const targetA = 'projects/ordinary-race-target-a';
    const targetB = 'projects/ordinary-race-target-b';
    for (const target of [targetA, targetB]) {
      await engine.putPage(target, {
        type: 'note', title: target, compiled_truth: target, timeline: '', frontmatter: {},
      });
    }

    const originalTransaction = engine.transaction.bind(engine);
    let transactionCalls = 0;
    let signalPaused!: () => void;
    let releasePaused!: () => void;
    const paused = new Promise<void>((resolve) => { signalPaused = resolve; });
    const released = new Promise<void>((resolve) => { releasePaused = resolve; });
    (engine as any).transaction = async (fn: any) => {
      transactionCalls++;
      if (transactionCalls === 2) {
        signalPaused();
        await released;
      }
      return originalTransaction(fn);
    };

    try {
      const older = operationsByName.put_page.handler(ctx(), {
        slug: origin,
        content: `# Older\n\n[[${targetA}]]`,
        no_embed: true,
      }) as Promise<any>;
      await paused;
      const newer = await operationsByName.put_page.handler(ctx(), {
        slug: origin,
        content: `# Newer\n\n[[${targetB}]]`,
        no_embed: true,
      }) as any;
      releasePaused();
      const olderResult = await older;

      expect(newer.auto_links).toMatchObject({ created: 1, errors: 0 });
      expect(olderResult.auto_links.error).toContain('locked preimage drift');
    } finally {
      releasePaused();
      delete (engine as any).transaction;
    }

    const page = await engine.getPage(origin, { sourceId: 'default' });
    const links = await engine.getLinks(origin, { sourceId: 'default' });
    expect(page?.compiled_truth).toContain(targetB);
    expect(page?.compiled_truth).not.toContain(targetA);
    expect(links.map(link => link.to_slug)).toEqual([targetB]);
  });
});

describe('exact corpus page operations', () => {
  test('reject every remediation operation remotely before touching the engine', async () => {
    const explodingEngine = new Proxy({} as PGLiteEngine, {
      get() { throw new Error('engine must not be touched'); },
    });
    const remote = { ...ctx(), engine: explodingEngine, remote: true };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['create_page_file_exact', {
        slug: 'projects/new', expected_content_sha256: 'a'.repeat(64),
        expected_postimage_content_hash: 'b'.repeat(64), file_path: '/tmp/nope',
      }],
      ['put_page_file_exact', {
        slug: 'projects/existing', expected_content_hash: 'a'.repeat(64),
        expected_preimage_markdown_sha256: 'b'.repeat(64),
        expected_content_sha256: 'c'.repeat(64), expected_postimage_content_hash: 'd'.repeat(64),
        file_path: '/tmp/nope',
      }],
      ['reindex_page_links_exact', {
        slug: 'projects/existing', expected_content_hash: 'a'.repeat(64),
        expected_markdown_sha256: 'b'.repeat(64),
      }],
      ['soft_delete_page_exact', {
        slug: 'projects/old', expected_content_hash: 'a'.repeat(64),
        expected_preimage_markdown_sha256: 'b'.repeat(64),
      }],
      ['restore_page_exact', {
        slug: 'projects/old', expected_content_hash: 'a'.repeat(64),
        expected_preimage_markdown_sha256: 'b'.repeat(64),
        expected_deleted_at: new Date().toISOString(),
      }],
      ['purge_pages_exact', { action: 'plan', run_id: 'remote-test', allowlist: [] }],
    ];
    for (const [name, params] of cases) {
      const op = operationsByName[name];
      expect(op.localOnly).toBe(true);
      expect(op.scope).toBe('admin');
      expect(op.mutating).toBe(true);
      await expect(op.handler(remote, params)).rejects.toThrow('local-only');
    }
  });

  test('create requires an approved lowercase postimage hash before any write', async () => {
    const op = operationsByName.create_page_file_exact;
    expect(op.params.expected_postimage_content_hash).toMatchObject({ required: true });
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-create-postimage-gate-'));
    const filePath = join(dir, 'summary.md');
    const content = '---\ntype: note\ntitle: Rejected summary\ntags:\n  - rejected\naliases:\n  - Rejected Alias\n---\n\nRejected body.\n';
    const baselineCounts = await counts();
    try {
      await writeFile(filePath, content, { mode: 0o600 });
      const params = {
        slug: 'projects/rejected-summary',
        expected_content_sha256: createHash('sha256').update(content).digest('hex'),
        expected_postimage_content_hash: canonicalPostimageHash('projects/rejected-summary', content),
        file_path: filePath,
      };
      await expect(op.handler(ctx(), {
        ...params, expected_postimage_content_hash: 'A'.repeat(64),
      })).rejects.toThrow('must be lowercase sha256 hex');
      await expect(op.handler(ctx(), {
        ...params, expected_postimage_content_hash: '0'.repeat(64),
      })).rejects.toThrow('postimage hash mismatch');

      expect(await engine.getPage(params.slug, { includeDeleted: true })).toBeNull();
      expect(await counts()).toEqual(baselineCounts);
      expect(await engine.executeRaw(
        `SELECT alias_norm FROM page_aliases WHERE source_id = 'default' AND slug = $1`, [params.slug],
      )).toEqual([]);
      expect(await engine.executeRaw(`SELECT id FROM links`)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('creates an absent lowercase page from an exact private file and recovers only with an explicit ambiguity gate', async () => {
    const op = operationsByName.create_page_file_exact;
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-create-exact-'));
    const filePath = join(dir, 'summary.md');
    const content = '---\ntype: note\ntitle: Exact summary\ntags:\n  - governance\naliases:\n  - Exact Alias\n---\n\n# Exact summary\n\nBounded semantic content. See src/core/sync.ts:42.\n';
    const fileSha = createHash('sha256').update(content).digest('hex');
    const exactParams = {
      slug: 'projects/new-summary',
      expected_content_sha256: fileSha,
      expected_postimage_content_hash: canonicalPostimageHash('projects/new-summary', content),
      file_path: filePath,
    };
    try {
      await engine.putPage('src-core-sync-ts', {
        type: 'code', title: 'src/core/sync.ts', compiled_truth: 'code target', timeline: '', frontmatter: {},
      });
      await writeFile(filePath, content, { mode: 0o600 });
      await expect(op.handler(ctx(), {
        ...exactParams, slug: 'Projects/New-Summary',
      })).rejects.toThrow('lowercase');
      await expect(op.handler(ctx(), {
        ...exactParams, expected_content_sha256: '0'.repeat(64),
      })).rejects.toThrow('file sha256 changed');

      const created = await op.handler(ctx(), exactParams) as any;
      expect(created.status).toBe('created');
      expect(created.recovered_after_ambiguous_commit).toBe(false);
      expect(created.content_hash).toBe(exactParams.expected_postimage_content_hash);
      const page = await engine.getPage('projects/new-summary', { sourceId: 'default' });
      expect(page?.title).toBe('Exact summary');
      expect(page?.compiled_truth).toContain('Bounded semantic content.');
      expect(await engine.getTags('projects/new-summary', { sourceId: 'default' })).toContain('governance');
      expect(await engine.executeRaw(
        `SELECT alias_norm FROM page_aliases WHERE source_id = 'default' AND slug = $1`,
        ['projects/new-summary'],
      )).toEqual([{ alias_norm: 'exact alias' }]);
      expect(await engine.executeRaw(`SELECT id FROM links`)).toEqual([]);

      await expect(op.handler(ctx(), exactParams)).rejects.toThrow('absence gate failed');
      const recovered = await op.handler(ctx(), {
        ...exactParams, accept_ambiguous_commit: true,
      }) as any;
      expect(recovered.recovered_after_ambiguous_commit).toBe(true);

      await engine.executeRaw(
        `DELETE FROM page_aliases WHERE source_id = 'default' AND slug = $1`,
        ['projects/new-summary'],
      );
      await expect(op.handler(ctx(), {
        ...exactParams, accept_ambiguous_commit: true,
      })).rejects.toThrow('absence gate failed');

      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
        ['other-source'],
      );
      const otherCtx = { ...ctx(), sourceId: 'other-source' };
      const other = await op.handler(otherCtx, exactParams) as any;
      expect(other.status).toBe('created');
      expect((await engine.getPage('projects/new-summary', { sourceId: 'other-source' }))?.source_id).toBe('other-source');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('soft-delete gates hash and inbound links, then restore gates the exact deleted identity', async () => {
    await engine.putPage('projects/exact-delete', {
      type: 'note', title: 'Delete me', compiled_truth: 'exact body', timeline: '', frontmatter: {},
    });
    await engine.putPage('projects/referrer', {
      type: 'note', title: 'Referrer', compiled_truth: 'referrer', timeline: '', frontmatter: {},
    });
    await engine.addLink('projects/referrer', 'projects/exact-delete', 'context', 'related', 'manual');
    const before = (await engine.getPage('projects/exact-delete'))!;
    const beforeMarkdownSha256 = await renderedMarkdownSha256(before.slug);

    const soft = operationsByName.soft_delete_page_exact;
    await expect(soft.handler(ctx(), {
      slug: before.slug, expected_content_hash: '0'.repeat(64),
      expected_preimage_markdown_sha256: beforeMarkdownSha256, require_zero_inbound: true,
    })).rejects.toThrow('content hash changed');
    await expect(soft.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: beforeMarkdownSha256, require_zero_inbound: true,
    })).rejects.toThrow('zero-inbound gate failed');
    await engine.executeRaw(`DELETE FROM links WHERE to_page_id = $1::int`, [before.id]);

    const deleted = await soft.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: beforeMarkdownSha256, require_zero_inbound: true,
    }) as any;
    expect(deleted.status).toBe('soft_deleted');
    expect((await engine.getPage(before.slug))).toBeNull();
    const tombstone = (await engine.getPage(before.slug, { includeDeleted: true }))!;
    expect(tombstone.deleted_at).toBeTruthy();
    await expect(soft.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: beforeMarkdownSha256, require_zero_inbound: true,
    })).rejects.toThrow('accept_ambiguous_commit=true');
    expect((await soft.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: beforeMarkdownSha256, require_zero_inbound: true,
      accept_ambiguous_commit: true,
    }) as any).recovered_after_ambiguous_commit).toBe(true);

    const restore = operationsByName.restore_page_exact;
    await expect(restore.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: beforeMarkdownSha256,
      expected_deleted_at: new Date(tombstone.deleted_at!.getTime() + 1000).toISOString(),
    })).rejects.toThrow('deleted identity changed');
    const restored = await restore.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: beforeMarkdownSha256,
      expected_deleted_at: tombstone.deleted_at!.toISOString(),
    }) as any;
    expect(restored.status).toBe('restored');
    expect((await engine.getPage(before.slug))?.content_hash).toBe(before.content_hash);
    await expect(restore.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: beforeMarkdownSha256,
      expected_deleted_at: tombstone.deleted_at!.toISOString(),
    })).rejects.toThrow('already active');
    expect((await restore.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_preimage_markdown_sha256: beforeMarkdownSha256,
      expected_deleted_at: tombstone.deleted_at!.toISOString(), accept_ambiguous_commit: true,
    }) as any).recovered_after_ambiguous_commit).toBe(true);
  });

  test('soft-delete and restore reject rendered-markdown drift inside the exact identity', async () => {
    await engine.putPage('projects/rendered-drift', {
      type: 'note', title: 'Rendered drift', compiled_truth: 'stable body', timeline: '', frontmatter: {},
    });
    const page = (await engine.getPage('projects/rendered-drift'))!;
    const approvedMarkdownSha256 = await renderedMarkdownSha256(page.slug);
    await engine.executeRaw(
      `UPDATE pages SET title = $1 WHERE source_id = 'default' AND slug = $2`,
      ['Unapproved title', page.slug],
    );
    await expect(operationsByName.soft_delete_page_exact.handler(ctx(), {
      slug: page.slug,
      expected_content_hash: page.content_hash,
      expected_preimage_markdown_sha256: approvedMarkdownSha256,
      require_zero_inbound: true,
    })).rejects.toThrow('rendered markdown changed');
    expect((await engine.getPage(page.slug))?.deleted_at).toBeNull();

    const driftedMarkdownSha256 = await renderedMarkdownSha256(page.slug);
    await operationsByName.soft_delete_page_exact.handler(ctx(), {
      slug: page.slug,
      expected_content_hash: page.content_hash,
      expected_preimage_markdown_sha256: driftedMarkdownSha256,
      require_zero_inbound: true,
    });
    const tombstone = (await engine.getPage(page.slug, { includeDeleted: true }))!;
    await engine.executeRaw(
      `UPDATE pages SET title = $1 WHERE source_id = 'default' AND slug = $2`,
      ['Changed while deleted', page.slug],
    );
    await expect(operationsByName.restore_page_exact.handler(ctx(), {
      slug: page.slug,
      expected_content_hash: page.content_hash,
      expected_preimage_markdown_sha256: driftedMarkdownSha256,
      expected_deleted_at: tombstone.deleted_at!.toISOString(),
    })).rejects.toThrow('rendered markdown changed');
    expect((await engine.getPage(page.slug, { includeDeleted: true }))?.deleted_at).toBeTruthy();
  });

  test('create-only atomically preserves exactly one concurrent creator', async () => {
    const op = operationsByName.create_page_file_exact;
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-create-race-'));
    const contents = [
      '---\ntype: note\ntitle: Concurrent alpha\n---\n\n# Concurrent alpha\n\nAlpha body.\n',
      '---\ntype: note\ntitle: Concurrent beta\n---\n\n# Concurrent beta\n\nBeta body.\n',
    ];
    try {
      const paths = [join(dir, 'alpha.md'), join(dir, 'beta.md')];
      await Promise.all(paths.map((file, index) => writeFile(file, contents[index], { mode: 0o600 })));
      const outcomes = await Promise.allSettled(paths.map((file, index) => op.handler(ctx(), {
        slug: 'projects/concurrent-create',
        expected_content_sha256: createHash('sha256').update(contents[index]).digest('hex'),
        expected_postimage_content_hash: canonicalPostimageHash('projects/concurrent-create', contents[index]),
        file_path: file,
      })));
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      const stored = await engine.getPage('projects/concurrent-create');
      if (!stored) throw new Error('concurrent create produced no page');
      expect(['Concurrent alpha', 'Concurrent beta']).toContain(stored.title);
      expect(stored.compiled_truth).toBe(stored.title === 'Concurrent alpha' ? '# Concurrent alpha\n\nAlpha body.' : '# Concurrent beta\n\nBeta body.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('create-only rolls back the page when exact alias projection fails', async () => {
    const op = operationsByName.create_page_file_exact;
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-create-alias-fail-'));
    const file = join(dir, 'alias-fail.md');
    const content = '---\ntype: note\ntitle: Alias failure\naliases:\n  - Required Alias\n---\n\n# Alias failure\n';
    const original = engine.setPageAliases;
    try {
      await writeFile(file, content, { mode: 0o600 });
      engine.setPageAliases = async () => { throw new Error('injected alias projection failure'); };
      await expect(op.handler(ctx(), {
        slug: 'projects/alias-failure',
        expected_content_sha256: createHash('sha256').update(content).digest('hex'),
        expected_postimage_content_hash: canonicalPostimageHash('projects/alias-failure', content),
        file_path: file,
      })).rejects.toThrow('injected alias projection failure');
      expect(await engine.getPage('projects/alias-failure', { includeDeleted: true })).toBeNull();
    } finally {
      engine.setPageAliases = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('zero-inbound soft-delete serializes with a concurrent link insert', async () => {
    await engine.putPage('projects/race-target', {
      type: 'note', title: 'Race target', compiled_truth: 'target', timeline: '', frontmatter: {},
    });
    await engine.putPage('projects/race-referrer', {
      type: 'note', title: 'Race referrer', compiled_truth: 'referrer', timeline: '', frontmatter: {},
    });
    const target = (await engine.getPage('projects/race-target'))!;
    const targetMarkdownSha256 = await renderedMarkdownSha256(target.slug);
    const outcomes = await Promise.allSettled([
      operationsByName.soft_delete_page_exact.handler(ctx(), {
        slug: target.slug, expected_content_hash: target.content_hash,
        expected_preimage_markdown_sha256: targetMarkdownSha256, require_zero_inbound: true,
      }),
      engine.addLink('projects/race-referrer', target.slug, 'racing link', 'related', 'manual'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const after = await engine.getPage(target.slug, { includeDeleted: true });
    const links = await engine.executeRaw<{ count: number | string }>(
      `SELECT count(*)::int AS count FROM links WHERE to_page_id = $1::int`, [target.id],
    );
    if (after?.deleted_at) expect(Number(links[0].count)).toBe(0);
    else expect(Number(links[0].count)).toBe(1);
  });

  test('zero-inbound soft-delete serializes with exact rollback link restore across deleted endpoints', async () => {
    await engine.putPage('projects/restore-race-target', {
      type: 'note', title: 'Restore race target', compiled_truth: 'target', timeline: '', frontmatter: {},
    });
    await engine.putPage('projects/restore-race-referrer', {
      type: 'note', title: 'Restore race referrer', compiled_truth: 'referrer', timeline: '', frontmatter: {},
    });
    await engine.softDeletePage('projects/restore-race-referrer');
    const target = (await engine.getPage('projects/restore-race-target'))!;
    const targetMarkdownSha256 = await renderedMarkdownSha256(target.slug);
    const edge = {
      from_slug: 'projects/restore-race-referrer',
      to_slug: target.slug,
      link_type: 'related',
      context: 'rollback restore race',
      link_source: 'manual',
      origin_slug: null,
      origin_field: null,
      resolution_type: null,
    };
    const restore = engine.restoreLinkExact(edge, { sourceId: 'default' });
    const deletion = operationsByName.soft_delete_page_exact.handler(ctx(), {
      slug: target.slug, expected_content_hash: target.content_hash,
      expected_preimage_markdown_sha256: targetMarkdownSha256, require_zero_inbound: true,
    });
    const outcomes = await Promise.allSettled([restore, deletion]);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1].status).toBe('rejected');
    if (outcomes[1].status === 'rejected') {
      expect(String(outcomes[1].reason)).toContain('zero-inbound gate failed');
    }
    expect((await engine.getPage(target.slug, { includeDeleted: true }))?.deleted_at).toBeNull();
    const links = await engine.getLinks(edge.from_slug, { includeDeleted: true });
    expect(links.some((link) => link.to_slug === target.slug && link.context === edge.context)).toBe(true);
  });
});

describe('purge_pages_exact', () => {
  async function seedPurgePage(slug: string, body: string, daysAgo: number): Promise<any> {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: {} });
    const page = (await engine.getPage(slug))!;
    await engine.addTag(slug, 'purge-test', { sourceId: 'default' });
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { sourceId: 'default' });
    await engine.createVersion(slug, { sourceId: 'default' });
    await engine.softDeletePage(slug, { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() - ($1::int * interval '1 day') WHERE id = $2::int`,
      [daysAgo, page.id],
    );
    return (await engine.getPage(slug, { sourceId: 'default', includeDeleted: true }))!;
  }

  function entry(page: any): Record<string, string> {
    return { slug: page.slug, deleted_at: page.deleted_at.toISOString(), content_hash: page.content_hash };
  }

  test('rejects an empty or over-100 allowlist before any purge plan can be created', async () => {
    const op = operationsByName.purge_pages_exact;
    const timestamp = new Date().toISOString();
    await expect(op.handler(ctx(), {
      action: 'plan', run_id: 'empty-allowlist', allowlist: [],
    })).rejects.toThrow('between 1 and 100');
    await expect(op.handler(ctx(), {
      action: 'plan', run_id: 'large-allowlist',
      allowlist: Array.from({ length: 101 }, (_, index) => ({
        slug: `archive/page-${index}`,
        deleted_at: timestamp,
        content_hash: 'a'.repeat(64),
      })),
    })).rejects.toThrow('between 1 and 100');
  });

  test('blocks targets younger than three days and active inbound referrers', async () => {
    const op = operationsByName.purge_pages_exact;
    const young = await seedPurgePage('archive/too-young', 'young body', 2);
    const old = await seedPurgePage('archive/active-ref-target', 'old body', 10);
    await engine.putPage('projects/active-referrer', {
      type: 'note', title: 'Active referrer', compiled_truth: 'active', timeline: '', frontmatter: {},
    });
    const referrer = (await engine.getPage('projects/active-referrer'))!;
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
       VALUES ($1::int, $2::int, 'related', 'active dependency', 'manual')`,
      [referrer.id, old.id],
    );
    const home = await mkdtemp(join(tmpdir(), 'gbrain-purge-gates-home-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await expect(op.handler(ctx(), {
          action: 'plan', run_id: 'young-age-gate', allowlist: [entry(young)],
        })).rejects.toThrow('younger than 3 days');
        await expect(op.handler(ctx(), {
          action: 'plan', run_id: 'active-inbound-gate', allowlist: [entry(old)],
        })).rejects.toThrow('active dependency gate failed');
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('atomically rechecks active dependencies at apply time', async () => {
    const op = operationsByName.purge_pages_exact;
    const page = await seedPurgePage('archive/apply-ref-race', 'apply race', 10);
    await engine.putPage('projects/apply-referrer', {
      type: 'note', title: 'Apply referrer', compiled_truth: 'active', timeline: '', frontmatter: {},
    });
    const referrer = (await engine.getPage('projects/apply-referrer'))!;
    const home = await mkdtemp(join(tmpdir(), 'gbrain-purge-apply-ref-home-'));
    const params = { action: 'plan', run_id: 'apply-active-ref', allowlist: [entry(page)] };
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const plan = await op.handler(ctx(), params) as any;
        await engine.executeRaw(
          `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
           VALUES ($1::int, $2::int, 'related', 'late dependency', 'manual')`,
          [referrer.id, page.id],
        );
        await expect(op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        })).rejects.toThrow('active dependency gate failed');
        expect(await engine.getPage(page.slug, { includeDeleted: true })).not.toBeNull();
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('blocks a surviving redirect whose canonical slug is a purge target', async () => {
    const op = operationsByName.purge_pages_exact;
    const page = await seedPurgePage('archive/canonical-target', 'canonical target', 10);
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
       VALUES ('default', 'archive/surviving-alias', $1, 'must survive')`,
      [page.slug],
    );
    const home = await mkdtemp(join(tmpdir(), 'gbrain-purge-canonical-alias-home-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await expect(op.handler(ctx(), {
          action: 'plan', run_id: 'canonical-alias-gate', allowlist: [entry(page)],
        })).rejects.toThrow('active dependency gate failed');
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('preserves an alias-page redirect to a live canonical page through apply, verify, and rollback', async () => {
    const op = operationsByName.purge_pages_exact;
    const aliasPage = await seedPurgePage('archive/durable-alias-page', 'obsolete redirect page', 10);
    await engine.putPage('projects/live-canonical-page', {
      type: 'note', title: 'Live canonical page', compiled_truth: 'canonical', timeline: '', frontmatter: {},
    });
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
       VALUES ('default', $1, 'projects/live-canonical-page', 'durable replacement')`,
      [aliasPage.slug],
    );
    const [redirectBefore] = await engine.executeRaw<Record<string, unknown>>(
      `SELECT * FROM slug_aliases WHERE source_id = 'default' AND alias_slug = $1`, [aliasPage.slug],
    );
    const home = await mkdtemp(join(tmpdir(), 'gbrain-purge-preserved-redirect-home-'));
    const params = { action: 'plan', run_id: 'preserved-slug-redirect', allowlist: [entry(aliasPage)] };
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const plan = await op.handler(ctx(), params) as any;
        expect(plan.backup_row_counts.preserved_slug_redirects).toBe(1);
        expect(plan.backup_row_counts.slug_aliases).toBe(0);

        await op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        });
        expect(await engine.getPage(aliasPage.slug, { includeDeleted: true })).toBeNull();
        expect(await engine.resolveSlugWithAlias(aliasPage.slug, 'default'))
          .toBe('projects/live-canonical-page');
        const [redirectAfterApply] = await engine.executeRaw<Record<string, unknown>>(
          `SELECT * FROM slug_aliases WHERE source_id = 'default' AND alias_slug = $1`, [aliasPage.slug],
        );
        expect(redirectAfterApply).toEqual(redirectBefore);
        const verified = await op.handler(ctx(), { ...params, action: 'verify' }) as any;
        expect(verified.preserved_redirect_expected_count).toBe(1);
        expect(verified.preserved_redirect_verified_count).toBe(1);
        expect(verified.preserved_redirect_drift_count).toBe(0);

        await op.handler(ctx(), {
          ...params, action: 'rollback', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        });
        const [redirectAfterRollback] = await engine.executeRaw<Record<string, unknown>>(
          `SELECT * FROM slug_aliases WHERE source_id = 'default' AND alias_slug = $1`, [aliasPage.slug],
        );
        expect(redirectAfterRollback).toEqual(redirectBefore);
        expect((await engine.getPage(aliasPage.slug, { includeDeleted: true }))?.content_hash)
          .toBe(aliasPage.content_hash);
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('verify fails closed when an expected SET NULL dependency drifts after apply', async () => {
    const op = operationsByName.purge_pages_exact;
    const page = await seedPurgePage('archive/set-null-verify', 'set null verify', 10);
    await engine.putPage('projects/set-null-drift', {
      type: 'note', title: 'Set null drift', compiled_truth: 'active', timeline: '', frontmatter: {},
    });
    const drift = (await engine.getPage('projects/set-null-drift'))!;
    await engine.executeRaw(
      `INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, content_hash, metadata)
       VALUES ('default', $1, $2::int, 'verify.txt', 'purge-test/verify.txt', $3, '{}'::jsonb)`,
      [page.slug, page.id, 'e'.repeat(64)],
    );
    const home = await mkdtemp(join(tmpdir(), 'gbrain-purge-verify-graph-home-'));
    const params = { action: 'plan', run_id: 'verify-full-graph', allowlist: [entry(page)] };
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const plan = await op.handler(ctx(), params) as any;
        await op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        });
        await engine.executeRaw(
          `UPDATE files SET page_id = $1::int WHERE storage_path = 'purge-test/verify.txt'`, [drift.id],
        );
        await expect(op.handler(ctx(), { ...params, action: 'verify' }))
          .rejects.toThrow('purge verification failed');
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('plans, purges, verifies, and restores a bounded exact graph from a private backup', async () => {
    const op = operationsByName.purge_pages_exact;
    const first = await seedPurgePage('archive/purge-one', 'private purge body one', 10);
    const second = await seedPurgePage('archive/purge-two', 'private purge body two', 11);
    await engine.putPage('projects/purge-referrer', {
      type: 'note', title: 'Referrer', compiled_truth: 'active', timeline: '', frontmatter: {},
    });
    const referrer = (await engine.getPage('projects/purge-referrer'))!;
    await engine.softDeletePage(referrer.slug);
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
       VALUES ($1::int, $2::int, 'related', 'delete with target', 'manual')`,
      [referrer.id, first.id],
    );
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
       VALUES ($1::int, $1::int, 'origin-only', 'origin only', 'frontmatter', $2::int, 'related')`,
      [referrer.id, second.id],
    );
    await engine.executeRaw(
      `INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ('default', 'purge one alias', $1)`,
      [first.slug],
    );
    await engine.executeRaw(
      `INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, content_hash, metadata)
       VALUES ('default', $1, $2::int, 'purge.txt', 'purge-test/roundtrip.txt', $3, '{}'::jsonb)`,
      [first.slug, first.id, 'f'.repeat(64)],
    );
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight)
       VALUES ($1::int, 0, 'bounded evidence', 'fact', 'world', 0.5)`,
      [first.id],
    );
    await engine.executeRaw(
      `INSERT INTO synthesis_evidence (synthesis_page_id, take_page_id, take_row_num, citation_index)
       VALUES ($1::int, $2::int, 0, 0)`,
      [referrer.id, first.id],
    );

    const home = await mkdtemp(join(tmpdir(), 'gbrain-purge-exact-home-'));
    const params = {
      action: 'plan', run_id: 'purge-roundtrip', allowlist: [entry(first), entry(second)],
    };
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const plan = await op.handler(ctx(), params) as any;
        expect(plan.status).toBe('pass');
        expect(plan.candidate_count).toBe(2);
        expect(plan).not.toHaveProperty('page_ids');
        expect(JSON.stringify(plan)).not.toContain('private purge body');
        const dir = join(home, 'governance-backups', 'page-purge-exact', 'purge-roundtrip');
        expect((await stat(join(dir, 'plan.json'))).mode & 0o777).toBe(0o600);
        expect((await stat(join(dir, 'backup.json.gz'))).mode & 0o777).toBe(0o600);

        await expect(op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint,
        })).rejects.toThrow('apply_enabled=true');
        const applied = await op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        }) as any;
        expect(applied.status).toBe('pass');
        expect(applied.purged_count).toBe(2);
        expect(await engine.getPage(first.slug, { includeDeleted: true })).toBeNull();
        expect((await op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        }) as any).purged_count).toBe(2);

        const verified = await op.handler(ctx(), { ...params, action: 'verify' }) as any;
        expect(verified.status).toBe('pass');
        expect(verified.verified_absent_count).toBe(2);
        expect((await engine.executeRaw(`SELECT count(*)::int AS count FROM page_aliases WHERE slug = $1`, [first.slug]))[0].count).toBe(0);
        expect((await engine.executeRaw(`SELECT page_id FROM files WHERE storage_path = 'purge-test/roundtrip.txt'`))[0].page_id).toBeNull();
        expect((await engine.executeRaw(`SELECT count(*)::int AS count FROM synthesis_evidence`))[0].count).toBe(0);

        const rolledBack = await op.handler(ctx(), {
          ...params, action: 'rollback', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        }) as any;
        expect(rolledBack.status).toBe('pass');
        expect(rolledBack.restored_count).toBe(2);
        const restored = await engine.getPage(first.slug, { includeDeleted: true });
        expect(restored?.content_hash).toBe(first.content_hash);
        expect(restored?.deleted_at?.toISOString()).toBe(first.deleted_at.toISOString());
        expect(await engine.getTags(first.slug, { sourceId: 'default' })).toContain('purge-test');
        expect((await engine.getChunks(first.slug, { sourceId: 'default' })).length).toBe(1);
        expect((await engine.getLinks('projects/purge-referrer', { includeDeleted: true })).some((link) => link.to_slug === first.slug)).toBe(true);
        expect((await engine.executeRaw(`SELECT count(*)::int AS count FROM page_aliases WHERE slug = $1`, [first.slug]))[0].count).toBe(1);
        expect(Number((await engine.executeRaw(`SELECT page_id FROM files WHERE storage_path = 'purge-test/roundtrip.txt'`))[0].page_id)).toBe(first.id);
        expect((await engine.executeRaw(`SELECT count(*)::int AS count FROM synthesis_evidence`))[0].count).toBe(1);
        expect(Number((await engine.executeRaw(`SELECT origin_page_id FROM links WHERE link_type = 'origin-only'`))[0].origin_page_id)).toBe(second.id);
        expect((await op.handler(ctx(), {
          ...params, action: 'rollback', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        }) as any).restored_count).toBe(2);
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('rejects stale hashes at plan time and source identity drift before apply', async () => {
    const op = operationsByName.purge_pages_exact;
    const page = await seedPurgePage('archive/source-drift', 'source drift', 10);
    const home = await mkdtemp(join(tmpdir(), 'gbrain-purge-source-drift-home-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await expect(op.handler(ctx(), {
          action: 'plan', run_id: 'hash-drift',
          allowlist: [{ ...entry(page), content_hash: '0'.repeat(64) }],
        })).rejects.toThrow('content hash drift');

        const params = { action: 'plan', run_id: 'source-drift', allowlist: [entry(page)] };
        const plan = await op.handler(ctx(), params) as any;
        await engine.executeRaw(
          `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
          ['drift-source'],
        );
        await engine.executeRaw(`UPDATE pages SET source_id = 'drift-source' WHERE id = $1::int`, [page.id]);
        await expect(op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        })).rejects.toThrow('source identity drift');
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('fails closed on source/hash/partial drift and requires a gate for an artifact-less committed state', async () => {
    const op = operationsByName.purge_pages_exact;
    const first = await seedPurgePage('archive/drift-one', 'drift one', 10);
    const second = await seedPurgePage('archive/drift-two', 'drift two', 10);
    const home = await mkdtemp(join(tmpdir(), 'gbrain-purge-drift-home-'));
    const params = { action: 'plan', run_id: 'purge-drift', allowlist: [entry(first), entry(second)] };
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const plan = await op.handler(ctx(), params) as any;
        await engine.executeRaw('DELETE FROM pages WHERE id = $1::int', [first.id]);
        await expect(op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        })).rejects.toThrow('partially absent');
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }

    const ambiguous = await seedPurgePage('archive/ambiguous', 'ambiguous', 10);
    const ambiguousHome = await mkdtemp(join(tmpdir(), 'gbrain-purge-ambiguous-home-'));
    const ambiguousParams = { action: 'plan', run_id: 'purge-ambiguous', allowlist: [entry(ambiguous)] };
    try {
      await withEnv({ GBRAIN_HOME: ambiguousHome }, async () => {
        const plan = await op.handler(ctx(), ambiguousParams) as any;
        await engine.executeRaw('DELETE FROM pages WHERE id = $1::int', [ambiguous.id]);
        await expect(op.handler(ctx(), {
          ...ambiguousParams, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        })).rejects.toThrow('accept_ambiguous_commit=true');
        const recovered = await op.handler(ctx(), {
          ...ambiguousParams, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint,
          apply_enabled: true, accept_ambiguous_commit: true,
        }) as any;
        expect(recovered.recovered_after_ambiguous_commit).toBe(true);
        const rollback = await op.handler(ctx(), {
          ...ambiguousParams, action: 'rollback', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        }) as any;
        expect(rollback.status).toBe('pass');
      });
    } finally {
      await rm(ambiguousHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('rejects a backup whose bytes changed even when its private mode is preserved', async () => {
    const op = operationsByName.purge_pages_exact;
    const page = await seedPurgePage('archive/backup-integrity', 'backup integrity', 10);
    const home = await mkdtemp(join(tmpdir(), 'gbrain-purge-integrity-home-'));
    const params = { action: 'plan', run_id: 'purge-integrity', allowlist: [entry(page)] };
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const plan = await op.handler(ctx(), params) as any;
        const backup = join(home, 'governance-backups', 'page-purge-exact', 'purge-integrity', 'backup.json.gz');
        await appendFile(backup, Buffer.from([0]));
        await chmod(backup, 0o600);
        await expect(op.handler(ctx(), {
          ...params, action: 'apply', expected_fingerprint: plan.allowlist_fingerprint, apply_enabled: true,
        })).rejects.toThrow('integrity mismatch');
        expect(await engine.getPage(page.slug, { includeDeleted: true })).not.toBeNull();
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('inventory_deleted_pages_exact', () => {
  test('is local-only read-only and rejects remote callers before touching the engine', async () => {
    const op = operationsByName.inventory_deleted_pages_exact;
    expect(op.localOnly).toBe(true);
    expect(op.scope).toBe('admin');
    expect(op.mutating).toBe(false);
    const explodingEngine = new Proxy({} as PGLiteEngine, { get() { throw new Error('engine must not be touched'); } });
    await expect(op.handler({ ...ctx(), engine: explodingEngine, remote: true }, {})).rejects.toThrow('local-only');
  });

  test('returns sorted exact reviewed states without leaking page content and source-scopes the lookup', async () => {
    const op = operationsByName.inventory_deleted_pages_exact;
    const deleted = await seedDeletedInventoryPage('archive/inventory-deleted', 'private inventory body', 100);
    await engine.putPage('archive/inventory-restored', {
      type: 'note', title: 'Restored', compiled_truth: 'restored private body', timeline: '', frontmatter: {},
    });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      ['inventory-other'],
    );
    await seedDeletedInventoryPage('archive/inventory-deleted', 'foreign private body', 100, 'inventory-other');
    await engine.putPage('projects/inventory-foreign-referrer', {
      type: 'note', title: 'Foreign referrer', compiled_truth: 'foreign active', timeline: '', frontmatter: {},
    }, { sourceId: 'inventory-other' });
    const foreignReferrer = (await engine.getPage('projects/inventory-foreign-referrer', { sourceId: 'inventory-other' }))!;
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
       VALUES ($1::int, $2::int, 'related', 'foreign dependency', 'manual')`,
      [foreignReferrer.id, deleted.id],
    );

    const result = await op.handler(ctx(), {
      slugs: ['archive/inventory-restored', 'archive/inventory-missing', 'archive/inventory-deleted'],
      limit: 3,
    }) as any;
    expect(result.source_id).toBe('default');
    expect(result.rows.map((row: any) => row.slug)).toEqual([
      'archive/inventory-deleted', 'archive/inventory-missing', 'archive/inventory-restored',
    ]);
    expect(result.rows.find((row: any) => row.slug === deleted.slug)).toMatchObject({ reason: 'active_inbound', active_inbound_count: 1, age_eligible: true });
    expect(result.rows.find((row: any) => row.slug === 'archive/inventory-missing')).toMatchObject({ reason: 'missing', deleted_at: null, content_hash: null });
    expect(result.rows.find((row: any) => row.slug === 'archive/inventory-restored')).toMatchObject({ reason: 'restored', deleted_at: null, content_hash: null });
    expect(Object.keys(result.rows[0]).sort()).toEqual([
      'active_inbound_count', 'age_eligible', 'content_hash', 'deleted_at', 'reason', 'slug',
    ]);
    expect(JSON.stringify(result)).not.toContain('private inventory body');
    expect(JSON.stringify(result)).not.toContain('foreign private body');
    expect(result.counts).toMatchObject({ requested: 3, deleted: 1, missing: 1, restored: 1 });
  });

  test('fails closed on an invalid active inbound count', async () => {
    await expect(inventoryDeletedPagesExact({
      executeRaw: async () => [{
        slug: 'archive/inventory-invalid-count', state: 'deleted', deleted_at: new Date(), content_hash: 'a'.repeat(64),
        active_inbound_count: 'NaN', age_eligible: true,
      }],
    } as any, {
      sourceId: 'default', limit: 1, minAgeHours: 72,
    })).rejects.toThrow('active inbound count is invalid');
  });

  test('reports age and active inbound gates, validates reviewed input, and paginates source-wide rows', async () => {
    const op = operationsByName.inventory_deleted_pages_exact;
    await seedDeletedInventoryPage('archive/inventory-boundary', 'boundary', 72);
    await seedDeletedInventoryPage('archive/inventory-young', 'young', 71);
    const blocked = await seedDeletedInventoryPage('archive/inventory-blocked', 'blocked', 100);
    await engine.putPage('projects/inventory-active-referrer', {
      type: 'note', title: 'Referrer', compiled_truth: 'active', timeline: '', frontmatter: {},
    });
    const referrer = (await engine.getPage('projects/inventory-active-referrer'))!;
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
       VALUES ($1::int, $2::int, 'related', 'active dependency', 'manual')`,
      [referrer.id, blocked.id],
    );
    const reviewed = await op.handler(ctx(), {
      slugs: ['archive/inventory-young', 'archive/inventory-blocked', 'archive/inventory-boundary'], limit: 3,
    }) as any;
    expect(reviewed.rows.find((row: any) => row.slug === 'archive/inventory-boundary')).toMatchObject({ reason: 'eligible', age_eligible: true });
    expect(reviewed.rows.find((row: any) => row.slug === 'archive/inventory-young')).toMatchObject({ reason: 'too_young', age_eligible: false });
    expect(reviewed.rows.find((row: any) => row.slug === 'archive/inventory-blocked')).toMatchObject({ reason: 'active_inbound', active_inbound_count: 1 });

    await expect(op.handler(ctx(), { slugs: ['Archive/Upper'], limit: 1 })).rejects.toThrow('lowercase');
    await expect(op.handler(ctx(), { slugs: ['archive/a', 'archive/a'], limit: 2 })).rejects.toThrow('duplicates');
    await expect(op.handler(ctx(), { slugs: Array.from({ length: 501 }, (_, i) => `archive/${i}`), limit: 500 })).rejects.toThrow('between 1 and 500');
    await expect(op.handler(ctx(), { limit: 0 })).rejects.toThrow('between 1 and 500');
    await expect(op.handler(ctx(), { min_age_hours: 71 })).rejects.toThrow('between 72 and 8760');

    await engine.executeRaw(`DELETE FROM links`);
    await engine.executeRaw(`DELETE FROM pages`);
    for (const slug of ['archive/inventory-page-a', 'archive/inventory-page-b', 'archive/inventory-page-c']) {
      await seedDeletedInventoryPage(slug, slug, 100);
    }
    const first = await op.handler(ctx(), { limit: 2 }) as any;
    expect(first.rows.map((row: any) => row.slug)).toEqual(['archive/inventory-page-a', 'archive/inventory-page-b']);
    expect(first.next_cursor).toBe('archive/inventory-page-b');
    const second = await op.handler(ctx(), { limit: 2, after_slug: first.next_cursor }) as any;
    expect(second.rows.map((row: any) => row.slug)).toEqual(['archive/inventory-page-c']);
    expect(second.next_cursor).toBeNull();
    expect(typeof first.fingerprint).toBe('string');
  });
});
