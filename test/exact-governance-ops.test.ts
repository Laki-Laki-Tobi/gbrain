import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeImportContentHash } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
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
    const content = `---\ntype: note\ntitle: After\ntags:\n  - exact-file\naliases:\n  - Exact File Alias\nrelated:\n  - projects/file-target\n---\n\n# After\n\n${marker}\n`;
    const fileSha = createHash('sha256').update(content).digest('hex');
    const postimageHash = canonicalPostimageHash(before.slug, content);
    const exactParams = {
      slug: before.slug,
      expected_content_hash: before.content_hash,
      expected_content_sha256: fileSha,
      expected_postimage_content_hash: postimageHash,
      file_path: filePath,
    };

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
      const result = await op.handler(ctx(), exactParams) as { status: string; slug: string; content_hash: string };
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
      expect(await engine.executeRaw(
        `SELECT alias_norm FROM page_aliases WHERE source_id = 'default' AND slug = $1`, [before.slug],
      )).toEqual([{ alias_norm: 'exact file alias' }]);
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
    const validContent = '---\ntype: note\ntitle: Valid draft\n---\n\nValid body.\n';
    const fileSha = createHash('sha256').update(validContent).digest('hex');
    const postimageHash = canonicalPostimageHash(before.slug, validContent);

    const params = (path: string) => ({
      slug: before.slug,
      expected_content_hash: before.content_hash,
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
});

describe('exact corpus page operations', () => {
  test('reject every remediation operation remotely before touching the engine', async () => {
    const explodingEngine = new Proxy({} as PGLiteEngine, {
      get() { throw new Error('engine must not be touched'); },
    });
    const remote = { ...ctx(), engine: explodingEngine, remote: true };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['create_page_file_exact', { slug: 'projects/new', expected_content_sha256: 'a'.repeat(64), file_path: '/tmp/nope' }],
      ['put_page_file_exact', {
        slug: 'projects/existing', expected_content_hash: 'a'.repeat(64),
        expected_content_sha256: 'b'.repeat(64), expected_postimage_content_hash: 'c'.repeat(64),
        file_path: '/tmp/nope',
      }],
      ['soft_delete_page_exact', { slug: 'projects/old', expected_content_hash: 'a'.repeat(64) }],
      ['restore_page_exact', { slug: 'projects/old', expected_content_hash: 'a'.repeat(64), expected_deleted_at: new Date().toISOString() }],
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

  test('creates an absent lowercase page from an exact private file and recovers only with an explicit ambiguity gate', async () => {
    const op = operationsByName.create_page_file_exact;
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-create-exact-'));
    const filePath = join(dir, 'summary.md');
    const content = '---\ntype: note\ntitle: Exact summary\ntags:\n  - governance\naliases:\n  - Exact Alias\n---\n\n# Exact summary\n\nBounded semantic content.\n';
    const fileSha = createHash('sha256').update(content).digest('hex');
    try {
      await writeFile(filePath, content, { mode: 0o600 });
      await expect(op.handler(ctx(), {
        slug: 'Projects/New-Summary', expected_content_sha256: fileSha, file_path: filePath,
      })).rejects.toThrow('lowercase');
      await expect(op.handler(ctx(), {
        slug: 'projects/new-summary', expected_content_sha256: '0'.repeat(64), file_path: filePath,
      })).rejects.toThrow('file sha256 changed');

      const created = await op.handler(ctx(), {
        slug: 'projects/new-summary', expected_content_sha256: fileSha, file_path: filePath,
      }) as any;
      expect(created.status).toBe('created');
      expect(created.recovered_after_ambiguous_commit).toBe(false);
      const page = await engine.getPage('projects/new-summary', { sourceId: 'default' });
      expect(page?.title).toBe('Exact summary');
      expect(page?.compiled_truth).toContain('Bounded semantic content.');
      expect(await engine.getTags('projects/new-summary', { sourceId: 'default' })).toContain('governance');
      expect(await engine.executeRaw(
        `SELECT alias_norm FROM page_aliases WHERE source_id = 'default' AND slug = $1`,
        ['projects/new-summary'],
      )).toEqual([{ alias_norm: 'exact alias' }]);

      await expect(op.handler(ctx(), {
        slug: 'projects/new-summary', expected_content_sha256: fileSha, file_path: filePath,
      })).rejects.toThrow('absence gate failed');
      const recovered = await op.handler(ctx(), {
        slug: 'projects/new-summary', expected_content_sha256: fileSha, file_path: filePath,
        accept_ambiguous_commit: true,
      }) as any;
      expect(recovered.recovered_after_ambiguous_commit).toBe(true);

      await engine.executeRaw(
        `DELETE FROM page_aliases WHERE source_id = 'default' AND slug = $1`,
        ['projects/new-summary'],
      );
      await expect(op.handler(ctx(), {
        slug: 'projects/new-summary', expected_content_sha256: fileSha, file_path: filePath,
        accept_ambiguous_commit: true,
      })).rejects.toThrow('absence gate failed');

      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
        ['other-source'],
      );
      const otherCtx = { ...ctx(), sourceId: 'other-source' };
      const other = await op.handler(otherCtx, {
        slug: 'projects/new-summary', expected_content_sha256: fileSha, file_path: filePath,
      }) as any;
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

    const soft = operationsByName.soft_delete_page_exact;
    await expect(soft.handler(ctx(), {
      slug: before.slug, expected_content_hash: '0'.repeat(64), require_zero_inbound: true,
    })).rejects.toThrow('content hash changed');
    await expect(soft.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash, require_zero_inbound: true,
    })).rejects.toThrow('zero-inbound gate failed');
    await engine.executeRaw(`DELETE FROM links WHERE to_page_id = $1::int`, [before.id]);

    const deleted = await soft.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash, require_zero_inbound: true,
    }) as any;
    expect(deleted.status).toBe('soft_deleted');
    expect((await engine.getPage(before.slug))).toBeNull();
    const tombstone = (await engine.getPage(before.slug, { includeDeleted: true }))!;
    expect(tombstone.deleted_at).toBeTruthy();
    await expect(soft.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash, require_zero_inbound: true,
    })).rejects.toThrow('accept_ambiguous_commit=true');
    expect((await soft.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash, require_zero_inbound: true,
      accept_ambiguous_commit: true,
    }) as any).recovered_after_ambiguous_commit).toBe(true);

    const restore = operationsByName.restore_page_exact;
    await expect(restore.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_deleted_at: new Date(tombstone.deleted_at!.getTime() + 1000).toISOString(),
    })).rejects.toThrow('deleted identity changed');
    const restored = await restore.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_deleted_at: tombstone.deleted_at!.toISOString(),
    }) as any;
    expect(restored.status).toBe('restored');
    expect((await engine.getPage(before.slug))?.content_hash).toBe(before.content_hash);
    await expect(restore.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_deleted_at: tombstone.deleted_at!.toISOString(),
    })).rejects.toThrow('already active');
    expect((await restore.handler(ctx(), {
      slug: before.slug, expected_content_hash: before.content_hash,
      expected_deleted_at: tombstone.deleted_at!.toISOString(), accept_ambiguous_commit: true,
    }) as any).recovered_after_ambiguous_commit).toBe(true);
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
    const outcomes = await Promise.allSettled([
      operationsByName.soft_delete_page_exact.handler(ctx(), {
        slug: target.slug, expected_content_hash: target.content_hash, require_zero_inbound: true,
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
      slug: target.slug, expected_content_hash: target.content_hash, require_zero_inbound: true,
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
