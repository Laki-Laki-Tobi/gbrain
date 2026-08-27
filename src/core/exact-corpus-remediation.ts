import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { BrainEngine } from './engine.ts';

const POLICY_VERSION = 'gbrain-exact-corpus-remediation-v1-2026-08-27';
const BACKUP_SCHEMA = 'gbrain-purge-pages-exact-backup-v1';
const PLAN_SCHEMA = 'gbrain-purge-pages-exact-plan-v1';
const APPLY_SCHEMA = 'gbrain-purge-pages-exact-apply-v1';
const VERIFY_SCHEMA = 'gbrain-purge-pages-exact-verify-v1';
const ROLLBACK_SCHEMA = 'gbrain-purge-pages-exact-rollback-v1';

export interface PurgeAllowlistEntry {
  slug: string;
  deletedAt: string;
  contentHash: string;
}

export interface PurgePagesExactArgs {
  action: 'plan' | 'apply' | 'verify' | 'rollback';
  runId: string;
  sourceId: string;
  allowlist?: PurgeAllowlistEntry[];
  expectedFingerprint?: string;
  applyEnabled: boolean;
  acceptAmbiguousCommit: boolean;
}

type JsonRow = Record<string, unknown>;

interface PurgeBackup {
  schema_version: typeof BACKUP_SCHEMA;
  policy_version: typeof POLICY_VERSION;
  source_id: string;
  run_id: string;
  generated_at: string;
  allowlist_fingerprint: string;
  graph_fingerprint: string;
  rows: PurgeGraph;
}

interface PurgeGraph {
  pages: JsonRow[];
  content_chunks: JsonRow[];
  code_edges_chunk: JsonRow[];
  code_edges_symbol: JsonRow[];
  deleted_links: JsonRow[];
  origin_only_links: JsonRow[];
  tags: JsonRow[];
  raw_data: JsonRow[];
  timeline_entries: JsonRow[];
  page_versions: JsonRow[];
  takes: JsonRow[];
  synthesis_evidence: JsonRow[];
  files: JsonRow[];
  page_aliases: JsonRow[];
  slug_aliases: JsonRow[];
}

const EMPTY_GRAPH = (): PurgeGraph => ({
  pages: [],
  content_chunks: [],
  code_edges_chunk: [],
  code_edges_symbol: [],
  deleted_links: [],
  origin_only_links: [],
  tags: [],
  raw_data: [],
  timeline_entries: [],
  page_versions: [],
  takes: [],
  synthesis_evidence: [],
  files: [],
  page_aliases: [],
  slug_aliases: [],
});

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, normalize(item)]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprint(value: unknown): string {
  return sha256(stableJson(value));
}

function backupRoot(): string {
  const base = process.env.GBRAIN_HOME || path.join(process.env.HOME || homedir(), '.gbrain');
  return path.resolve(base, 'governance-backups', 'page-purge-exact');
}

function runDir(args: PurgePagesExactArgs): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(args.runId)) {
    throw new Error('run_id must be lowercase and path-safe');
  }
  return path.join(backupRoot(), args.runId);
}

function artifact(args: PurgePagesExactArgs, name: string): string {
  return path.join(runDir(args), name);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(file: string, bytes: string | Uint8Array, exclusive = false): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await chmod(temporary, 0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    if (exclusive) {
      await link(temporary, file);
      await unlink(temporary);
    } else {
      await rename(temporary, file);
    }
    await syncDirectory(directory);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch {}
    }
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

async function writeJson(file: string, value: unknown, exclusive = false): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(normalize(value), null, 2)}\n`, exclusive);
}

async function readJson(file: string): Promise<any> {
  const mode = (await stat(file)).mode & 0o777;
  if (mode !== 0o600) throw new Error(`purge artifact must have mode 0600: ${file}`);
  return JSON.parse(await readFile(file, 'utf8'));
}

async function tryReadJson(file: string): Promise<any | null> {
  try {
    return await readJson(file);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function policyShape(args: PurgePagesExactArgs): Record<string, unknown> {
  return {
    policy_version: POLICY_VERSION,
    source_id: args.sourceId,
    run_id: args.runId,
  };
}

function assertPolicy(value: any, args: PurgePagesExactArgs): void {
  const expected = stableJson(policyShape(args));
  const actual = stableJson(Object.fromEntries(Object.keys(policyShape(args)).map((key) => [key, value[key]])));
  if (actual !== expected) throw new Error('purge artifact policy mismatch');
}

function canonicalAllowlist(entries: PurgeAllowlistEntry[]): PurgeAllowlistEntry[] {
  if (entries.length === 0 || entries.length > 100) {
    throw new Error('allowlist must contain between 1 and 100 pages');
  }
  const canonical = entries.map((entry) => ({
    slug: entry.slug,
    deletedAt: new Date(entry.deletedAt).toISOString(),
    contentHash: entry.contentHash,
  })).sort((left, right) => left.slug.localeCompare(right.slug));
  if (canonical.some((entry) => !entry.slug || entry.slug !== entry.slug.toLowerCase())) {
    throw new Error('allowlist slugs must be lowercase');
  }
  if (new Set(canonical.map((entry) => entry.slug)).size !== canonical.length) {
    throw new Error('allowlist must not contain duplicate slugs');
  }
  if (canonical.some((entry) => !Number.isFinite(Date.parse(entry.deletedAt)))) {
    throw new Error('allowlist deleted_at values must be valid timestamps');
  }
  if (canonical.some((entry) => !/^[a-f0-9]{64}$/.test(entry.contentHash))) {
    throw new Error('allowlist content_hash values must be sha256 hex');
  }
  return canonical;
}

async function tableExists(engine: BrainEngine, table: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
     ) AS present`,
    [table],
  );
  return row?.present === true;
}

async function jsonRows(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<JsonRow[]> {
  const rows = await engine.executeRaw<{ row_json: JsonRow }>(sql, params);
  return rows.map((row) => normalize(row.row_json) as JsonRow);
}

async function optionalJsonRows(
  engine: BrainEngine,
  table: string,
  sql: string,
  params: unknown[] = [],
): Promise<JsonRow[]> {
  if (!(await tableExists(engine, table))) return [];
  return jsonRows(engine, sql, params);
}

function numericIds(rows: JsonRow[], key = 'id'): number[] {
  return rows.map((row) => Number(row[key])).filter(Number.isFinite);
}

async function pagesBySourceSlugs(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<JsonRow[]> {
  if (slugs.length === 0) return [];
  return jsonRows(engine, `
    SELECT to_jsonb(p) AS row_json
      FROM pages p
     WHERE p.source_id = $1 AND p.slug = ANY($2::text[])
     ORDER BY p.slug, p.id
  `, [sourceId, slugs]);
}

async function pagesByIds(engine: BrainEngine, ids: number[]): Promise<JsonRow[]> {
  if (ids.length === 0) return [];
  return jsonRows(engine, `
    SELECT to_jsonb(p) AS row_json
      FROM pages p
     WHERE p.id = ANY($1::int[])
     ORDER BY p.id
  `, [ids]);
}

async function captureGraph(engine: BrainEngine, pages: JsonRow[]): Promise<PurgeGraph> {
  const graph = EMPTY_GRAPH();
  graph.pages = pages.map((row) => normalize(row) as JsonRow);
  const pageIds = numericIds(graph.pages);
  if (pageIds.length === 0) return graph;

  graph.content_chunks = await jsonRows(engine, `
    SELECT to_jsonb(c) AS row_json FROM content_chunks c
     WHERE c.page_id = ANY($1::int[]) ORDER BY c.id
  `, [pageIds]);
  const chunkIds = numericIds(graph.content_chunks);
  graph.code_edges_chunk = chunkIds.length === 0 ? [] : await optionalJsonRows(engine, 'code_edges_chunk', `
    SELECT to_jsonb(e) AS row_json FROM code_edges_chunk e
     WHERE e.from_chunk_id = ANY($1::int[]) OR e.to_chunk_id = ANY($1::int[]) ORDER BY e.id
  `, [chunkIds]);
  graph.code_edges_symbol = chunkIds.length === 0 ? [] : await optionalJsonRows(engine, 'code_edges_symbol', `
    SELECT to_jsonb(e) AS row_json FROM code_edges_symbol e
     WHERE e.from_chunk_id = ANY($1::int[]) ORDER BY e.id
  `, [chunkIds]);
  graph.deleted_links = await jsonRows(engine, `
    SELECT to_jsonb(l) AS row_json FROM links l
     WHERE l.from_page_id = ANY($1::int[]) OR l.to_page_id = ANY($1::int[])
     ORDER BY l.id
  `, [pageIds]);
  graph.origin_only_links = await jsonRows(engine, `
    SELECT to_jsonb(l) AS row_json FROM links l
     WHERE l.origin_page_id = ANY($1::int[])
       AND NOT (l.from_page_id = ANY($1::int[]) OR l.to_page_id = ANY($1::int[]))
     ORDER BY l.id
  `, [pageIds]);
  graph.tags = await jsonRows(engine, `
    SELECT to_jsonb(t) AS row_json FROM tags t WHERE t.page_id = ANY($1::int[]) ORDER BY t.id
  `, [pageIds]);
  graph.raw_data = await jsonRows(engine, `
    SELECT to_jsonb(r) AS row_json FROM raw_data r WHERE r.page_id = ANY($1::int[]) ORDER BY r.id
  `, [pageIds]);
  graph.timeline_entries = await jsonRows(engine, `
    SELECT to_jsonb(t) AS row_json FROM timeline_entries t
     WHERE t.page_id = ANY($1::int[]) OR t.event_page_id = ANY($1::int[]) ORDER BY t.id
  `, [pageIds]);
  graph.page_versions = await jsonRows(engine, `
    SELECT to_jsonb(v) AS row_json FROM page_versions v WHERE v.page_id = ANY($1::int[]) ORDER BY v.id
  `, [pageIds]);
  graph.takes = await optionalJsonRows(engine, 'takes', `
    SELECT to_jsonb(t) AS row_json FROM takes t WHERE t.page_id = ANY($1::int[]) ORDER BY t.id
  `, [pageIds]);
  graph.synthesis_evidence = await optionalJsonRows(engine, 'synthesis_evidence', `
    SELECT to_jsonb(s) AS row_json FROM synthesis_evidence s
     WHERE s.synthesis_page_id = ANY($1::int[]) OR s.take_page_id = ANY($1::int[])
     ORDER BY s.synthesis_page_id, s.take_page_id, s.take_row_num
  `, [pageIds]);
  graph.files = await optionalJsonRows(engine, 'files', `
    SELECT to_jsonb(f) AS row_json FROM files f WHERE f.page_id = ANY($1::int[]) ORDER BY f.id
  `, [pageIds]);

  const sourceIds = [...new Set(graph.pages.map((row) => String(row.source_id)))];
  const slugs = graph.pages.map((row) => String(row.slug));
  if (sourceIds.length !== 1) throw new Error('purge graph contains multiple source identities');
  graph.page_aliases = await optionalJsonRows(engine, 'page_aliases', `
    SELECT to_jsonb(a) AS row_json FROM page_aliases a
     WHERE a.source_id = $1 AND a.slug = ANY($2::text[]) ORDER BY a.id
  `, [sourceIds[0], slugs]);
  graph.slug_aliases = await optionalJsonRows(engine, 'slug_aliases', `
    SELECT to_jsonb(a) AS row_json FROM slug_aliases a
     WHERE a.source_id = $1
       AND (a.alias_slug = ANY($2::text[]) OR a.canonical_slug = ANY($2::text[]))
     ORDER BY a.alias_slug
  `, [sourceIds[0], slugs]);
  return graph;
}

function assertAllowlistMatchesPages(entries: PurgeAllowlistEntry[], pages: JsonRow[], sourceId: string): void {
  if (pages.length !== entries.length) throw new Error('purge allowlist page set is missing or ambiguous');
  const bySlug = new Map(pages.map((page) => [String(page.slug), page]));
  for (const entry of entries) {
    const page = bySlug.get(entry.slug);
    if (!page) throw new Error(`purge target missing: ${entry.slug}`);
    if (page.source_id !== sourceId) throw new Error(`source identity drift for ${entry.slug}`);
    if (page.content_hash !== entry.contentHash) throw new Error(`content hash drift for ${entry.slug}`);
    if (!page.deleted_at || new Date(String(page.deleted_at)).toISOString() !== entry.deletedAt) {
      throw new Error(`deleted identity drift for ${entry.slug}`);
    }
  }
}

function assertPageIdentitiesMatchBackup(current: JsonRow[], expected: JsonRow[], sourceId: string): void {
  const byId = new Map(current.map((page) => [Number(page.id), page]));
  for (const backupPage of expected) {
    const page = byId.get(Number(backupPage.id));
    if (!page) throw new Error(`purge target missing by id: ${String(backupPage.slug)}`);
    if (page.source_id !== sourceId || page.source_id !== backupPage.source_id) {
      throw new Error(`source identity drift for ${String(backupPage.slug)}`);
    }
    if (page.slug !== backupPage.slug) throw new Error(`slug identity drift for page id ${String(backupPage.id)}`);
    if (page.content_hash !== backupPage.content_hash) throw new Error(`content hash drift for ${String(backupPage.slug)}`);
    if (!page.deleted_at
      || new Date(String(page.deleted_at)).toISOString() !== new Date(String(backupPage.deleted_at)).toISOString()) {
      throw new Error(`deleted identity drift for ${String(backupPage.slug)}`);
    }
  }
}

async function loadBackup(args: PurgePagesExactArgs): Promise<{ bytes: Buffer; payload: PurgeBackup }> {
  const file = artifact(args, 'backup.json.gz');
  const mode = (await stat(file)).mode & 0o777;
  if (mode !== 0o600) throw new Error('purge backup must have mode 0600');
  const bytes = await readFile(file);
  return { bytes, payload: JSON.parse(gunzipSync(bytes).toString('utf8')) as PurgeBackup };
}

function publicPlan(report: any): Record<string, unknown> {
  const { page_ids: _pageIds, ...result } = report;
  return result;
}

async function plan(engine: BrainEngine, args: PurgePagesExactArgs): Promise<Record<string, unknown>> {
  if (!args.allowlist) throw new Error('allowlist is required for plan');
  const entries = canonicalAllowlist(args.allowlist);
  const allowlistFingerprint = fingerprint(entries);
  const prior = await tryReadJson(artifact(args, 'plan.json'));
  if (prior) {
    assertPolicy(prior, args);
    if (prior.schema_version !== PLAN_SCHEMA || prior.status !== 'pass'
      || prior.allowlist_fingerprint !== allowlistFingerprint) {
      throw new Error('existing purge plan does not match requested allowlist');
    }
    const { bytes, payload } = await loadBackup(args);
    assertPolicy(payload, args);
    if (payload.schema_version !== BACKUP_SCHEMA
      || sha256(bytes) !== prior.backup_sha256
      || payload.allowlist_fingerprint !== prior.allowlist_fingerprint
      || fingerprint(payload.rows) !== prior.graph_fingerprint) {
      throw new Error('existing purge backup integrity mismatch');
    }
    return publicPlan(prior);
  }

  await mkdir(backupRoot(), { recursive: true, mode: 0o700 });
  await chmod(backupRoot(), 0o700);
  await syncDirectory(path.dirname(backupRoot()));
  await mkdir(runDir(args), { mode: 0o700 });
  await syncDirectory(backupRoot());

  const pages = await pagesBySourceSlugs(engine, args.sourceId, entries.map((entry) => entry.slug));
  assertAllowlistMatchesPages(entries, pages, args.sourceId);
  const graph = await captureGraph(engine, pages);
  const graphFingerprint = fingerprint(graph);
  const backup: PurgeBackup = {
    schema_version: BACKUP_SCHEMA,
    ...policyShape(args) as { policy_version: typeof POLICY_VERSION; source_id: string; run_id: string },
    generated_at: nowIso(),
    allowlist_fingerprint: allowlistFingerprint,
    graph_fingerprint: graphFingerprint,
    rows: graph,
  };
  const backupBytes = gzipSync(`${JSON.stringify(normalize(backup))}\n`, { level: 9 });
  const backupSha256 = sha256(backupBytes);
  await atomicWrite(artifact(args, 'backup.json.gz'), backupBytes, true);
  const report = {
    schema_version: PLAN_SCHEMA,
    ...policyShape(args),
    generated_at: nowIso(),
    status: 'pass',
    candidate_count: entries.length,
    allowlist_fingerprint: allowlistFingerprint,
    graph_fingerprint: graphFingerprint,
    backup_sha256: backupSha256,
    backup_row_counts: Object.fromEntries(Object.entries(graph).map(([key, rows]) => [key, rows.length])),
    page_ids: numericIds(pages),
  };
  await writeJson(artifact(args, 'plan.json'), report, true);
  return publicPlan(report);
}

function assertPlanAndBackup(planReport: any, backup: PurgeBackup, backupBytes: Buffer, args: PurgePagesExactArgs): void {
  assertPolicy(planReport, args);
  assertPolicy(backup, args);
  if (planReport.schema_version !== PLAN_SCHEMA || planReport.status !== 'pass'
    || backup.schema_version !== BACKUP_SCHEMA
    || planReport.allowlist_fingerprint !== backup.allowlist_fingerprint
    || planReport.graph_fingerprint !== backup.graph_fingerprint
    || planReport.graph_fingerprint !== fingerprint(backup.rows)
    || planReport.backup_sha256 !== sha256(backupBytes)) {
    throw new Error('purge plan or backup integrity mismatch');
  }
}

async function finishApply(
  args: PurgePagesExactArgs,
  planReport: any,
  purgedCount: number,
  recovered: boolean,
): Promise<Record<string, unknown>> {
  const result = {
    schema_version: APPLY_SCHEMA,
    ...policyShape(args),
    generated_at: nowIso(),
    status: 'pass',
    allowlist_fingerprint: planReport.allowlist_fingerprint,
    graph_fingerprint: planReport.graph_fingerprint,
    backup_sha256: planReport.backup_sha256,
    purged_count: purgedCount,
    recovered_after_ambiguous_commit: recovered,
  };
  try {
    await writeJson(artifact(args, 'apply.json'), result, true);
    return result;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readJson(artifact(args, 'apply.json'));
    assertPolicy(existing, args);
    if (existing.schema_version !== APPLY_SCHEMA || existing.status !== 'pass'
      || existing.allowlist_fingerprint !== result.allowlist_fingerprint
      || existing.graph_fingerprint !== result.graph_fingerprint
      || existing.backup_sha256 !== result.backup_sha256
      || Number(existing.purged_count) !== purgedCount) {
      throw new Error('concurrent purge apply artifact mismatch');
    }
    return existing;
  }
}

async function apply(engine: BrainEngine, args: PurgePagesExactArgs): Promise<Record<string, unknown>> {
  if (!args.applyEnabled) throw new Error('purge apply requires apply_enabled=true');
  if (!/^[a-f0-9]{64}$/.test(args.expectedFingerprint || '')) throw new Error('expected_fingerprint is required');
  const planReport = await readJson(artifact(args, 'plan.json'));
  const { bytes, payload: backup } = await loadBackup(args);
  assertPlanAndBackup(planReport, backup, bytes, args);
  if (planReport.allowlist_fingerprint !== args.expectedFingerprint) throw new Error('allowlist fingerprint mismatch');

  const prior = await tryReadJson(artifact(args, 'apply.json'));
  const pageIds = numericIds(backup.rows.pages);
  const slugs = backup.rows.pages.map((page) => String(page.slug));
  if (prior) {
    assertPolicy(prior, args);
    const byIds = await pagesByIds(engine, pageIds);
    const bySlugs = await pagesBySourceSlugs(engine, args.sourceId, slugs);
    if (prior.schema_version !== APPLY_SCHEMA || prior.status !== 'pass'
      || prior.allowlist_fingerprint !== planReport.allowlist_fingerprint
      || prior.graph_fingerprint !== planReport.graph_fingerprint
      || prior.backup_sha256 !== planReport.backup_sha256
      || Number(prior.purged_count) !== pageIds.length || byIds.length !== 0 || bySlugs.length !== 0) {
      throw new Error('existing purge apply artifact does not match database state');
    }
    return prior;
  }

  const currentPages = await pagesByIds(engine, pageIds);
  if (currentPages.length === 0) {
    const bySlugs = await pagesBySourceSlugs(engine, args.sourceId, slugs);
    if (bySlugs.length !== 0) throw new Error('purge targets were recreated with new identities');
    if (!args.acceptAmbiguousCommit) {
      throw new Error('all purge targets are absent without an apply artifact; retry with accept_ambiguous_commit=true after operator review');
    }
    return finishApply(args, planReport, pageIds.length, true);
  }
  if (currentPages.length !== pageIds.length) throw new Error('purge targets are partially absent');
  assertPageIdentitiesMatchBackup(currentPages, backup.rows.pages, args.sourceId);
  const currentGraph = await captureGraph(engine, currentPages);
  if (fingerprint(currentGraph) !== planReport.graph_fingerprint) throw new Error('purge target graph drifted after plan');

  await writeJson(artifact(args, 'apply-intent.json'), {
    schema_version: 'gbrain-purge-pages-exact-apply-intent-v1',
    ...policyShape(args),
    generated_at: nowIso(),
    allowlist_fingerprint: planReport.allowlist_fingerprint,
    graph_fingerprint: planReport.graph_fingerprint,
    backup_sha256: planReport.backup_sha256,
  }, true).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const intent = await readJson(artifact(args, 'apply-intent.json'));
    assertPolicy(intent, args);
    if (intent.allowlist_fingerprint !== planReport.allowlist_fingerprint
      || intent.graph_fingerprint !== planReport.graph_fingerprint
      || intent.backup_sha256 !== planReport.backup_sha256) {
      throw new Error('purge apply intent mismatch');
    }
  });

  try {
    await engine.transaction(async (tx) => {
      if (await tableExists(tx, 'page_aliases')) {
        await tx.executeRaw(`DELETE FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[])`, [args.sourceId, slugs]);
      }
      if (await tableExists(tx, 'slug_aliases')) {
        await tx.executeRaw(`DELETE FROM slug_aliases WHERE source_id = $1
          AND (alias_slug = ANY($2::text[]) OR canonical_slug = ANY($2::text[]))`, [args.sourceId, slugs]);
      }
      for (const page of backup.rows.pages) {
        const deleted = await tx.executeRaw<{ id: number | string }>(`
          DELETE FROM pages
           WHERE id = $1::int AND source_id = $2 AND slug = $3
             AND deleted_at = $4::timestamptz AND content_hash = $5
           RETURNING id
        `, [Number(page.id), args.sourceId, page.slug, page.deleted_at, page.content_hash]);
        if (deleted.length !== 1) throw new Error(`purge delete identity mismatch for ${String(page.slug)}`);
      }
    });
  } catch (error) {
    const remaining = await pagesByIds(engine, pageIds);
    if (remaining.length === 0) {
      if (!args.acceptAmbiguousCommit) {
        throw new Error('ambiguous purge commit requires accept_ambiguous_commit=true after operator review', { cause: error });
      }
      return finishApply(args, planReport, pageIds.length, true);
    }
    if (remaining.length !== pageIds.length) throw new Error('ambiguous partial purge state', { cause: error });
    throw error;
  }
  const remainingById = await pagesByIds(engine, pageIds);
  const remainingBySlug = await pagesBySourceSlugs(engine, args.sourceId, slugs);
  if (remainingById.length !== 0 || remainingBySlug.length !== 0) throw new Error('purge readback mismatch');
  return finishApply(args, planReport, pageIds.length, false);
}

async function verify(engine: BrainEngine, args: PurgePagesExactArgs): Promise<Record<string, unknown>> {
  const planReport = await readJson(artifact(args, 'plan.json'));
  const applyReport = await readJson(artifact(args, 'apply.json'));
  const { bytes, payload: backup } = await loadBackup(args);
  assertPlanAndBackup(planReport, backup, bytes, args);
  assertPolicy(applyReport, args);
  const pageIds = numericIds(backup.rows.pages);
  const slugs = backup.rows.pages.map((page) => String(page.slug));
  const byIds = await pagesByIds(engine, pageIds);
  const bySlugs = await pagesBySourceSlugs(engine, args.sourceId, slugs);
  const aliases = (await captureGraph(engine, backup.rows.pages.map((page) => ({ ...page, id: -Number(page.id) }))));
  const aliasCount = aliases.page_aliases.length + aliases.slug_aliases.length;
  if (applyReport.schema_version !== APPLY_SCHEMA || applyReport.status !== 'pass'
    || applyReport.allowlist_fingerprint !== planReport.allowlist_fingerprint
    || applyReport.graph_fingerprint !== planReport.graph_fingerprint
    || applyReport.backup_sha256 !== planReport.backup_sha256
    || Number(applyReport.purged_count) !== pageIds.length) {
    throw new Error('purge apply artifact mismatch');
  }
  const prior = await tryReadJson(artifact(args, 'verify.json'));
  if (prior) {
    assertPolicy(prior, args);
    if (prior.schema_version !== VERIFY_SCHEMA || prior.status !== 'pass'
      || byIds.length !== 0 || bySlugs.length !== 0 || aliasCount !== 0) {
      throw new Error('existing purge verify artifact does not match database state');
    }
    return prior;
  }
  const result = {
    schema_version: VERIFY_SCHEMA,
    ...policyShape(args),
    generated_at: nowIso(),
    status: byIds.length === 0 && bySlugs.length === 0 && aliasCount === 0 ? 'pass' : 'blocked',
    allowlist_fingerprint: planReport.allowlist_fingerprint,
    verified_absent_count: pageIds.length - byIds.length,
    recreated_slug_count: bySlugs.length,
    residual_alias_count: aliasCount,
  };
  await writeJson(artifact(args, 'verify.json'), result, true);
  if (result.status !== 'pass') throw new Error('purge verification failed');
  return result;
}

const INSERT_TABLES = [
  'pages', 'content_chunks', 'tags', 'raw_data', 'timeline_entries', 'page_versions',
  'takes', 'links', 'code_edges_chunk', 'code_edges_symbol', 'synthesis_evidence',
  'page_aliases', 'slug_aliases',
] as const;
type InsertTable = typeof INSERT_TABLES[number];

async function insertRows(engine: BrainEngine, table: InsertTable, rows: JsonRow[]): Promise<void> {
  if (rows.length === 0) return;
  if (!INSERT_TABLES.includes(table)) throw new Error(`unsupported purge restore table: ${table}`);
  if (!(await tableExists(engine, table))) throw new Error(`purge restore table missing: ${table}`);
  await engine.executeRaw(
    `INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::text::jsonb)`,
    [JSON.stringify(rows)],
  );
}

function without(row: JsonRow, key: string): JsonRow {
  const copy = { ...row };
  delete copy[key];
  return copy;
}

async function restoreSetNullRows(engine: BrainEngine, backup: PurgeBackup): Promise<void> {
  for (const file of backup.rows.files) {
    const current = await optionalJsonRows(engine, 'files', `
      SELECT to_jsonb(f) AS row_json FROM files f WHERE f.id = $1::int
    `, [Number(file.id)]);
    if (current.length !== 1 || current[0].page_id !== null
      || stableJson(without(current[0], 'page_id')) !== stableJson(without(file, 'page_id'))) {
      throw new Error(`file association drift for id ${String(file.id)}`);
    }
    await engine.executeRaw(`UPDATE files SET page_id = $1::int WHERE id = $2::int AND page_id IS NULL`, [Number(file.page_id), Number(file.id)]);
  }
  for (const link of backup.rows.origin_only_links) {
    const current = await jsonRows(engine, `SELECT to_jsonb(l) AS row_json FROM links l WHERE l.id = $1::int`, [Number(link.id)]);
    if (current.length !== 1 || current[0].origin_page_id !== null
      || stableJson(without(current[0], 'origin_page_id')) !== stableJson(without(link, 'origin_page_id'))) {
      throw new Error(`origin-only link drift for id ${String(link.id)}`);
    }
    await engine.executeRaw(`UPDATE links SET origin_page_id = $1::int WHERE id = $2::int AND origin_page_id IS NULL`, [Number(link.origin_page_id), Number(link.id)]);
  }
}

async function restoreGraph(engine: BrainEngine, backup: PurgeBackup): Promise<void> {
  await insertRows(engine, 'pages', backup.rows.pages);
  for (const page of backup.rows.pages) {
    await engine.executeRaw(`UPDATE pages SET generation = $1::bigint WHERE id = $2::int`, [page.generation, Number(page.id)]);
  }
  await insertRows(engine, 'content_chunks', backup.rows.content_chunks);
  await insertRows(engine, 'tags', backup.rows.tags);
  await insertRows(engine, 'raw_data', backup.rows.raw_data);
  await insertRows(engine, 'timeline_entries', backup.rows.timeline_entries);
  await insertRows(engine, 'page_versions', backup.rows.page_versions);
  await insertRows(engine, 'takes', backup.rows.takes);
  await insertRows(engine, 'links', backup.rows.deleted_links);
  await restoreSetNullRows(engine, backup);
  await insertRows(engine, 'code_edges_chunk', backup.rows.code_edges_chunk);
  await insertRows(engine, 'code_edges_symbol', backup.rows.code_edges_symbol);
  await insertRows(engine, 'synthesis_evidence', backup.rows.synthesis_evidence);
  await insertRows(engine, 'page_aliases', backup.rows.page_aliases);
  await insertRows(engine, 'slug_aliases', backup.rows.slug_aliases);
}

async function finishRollback(
  args: PurgePagesExactArgs,
  planReport: any,
  restoredCount: number,
  recovered: boolean,
): Promise<Record<string, unknown>> {
  const result = {
    schema_version: ROLLBACK_SCHEMA,
    ...policyShape(args),
    generated_at: nowIso(),
    status: 'pass',
    allowlist_fingerprint: planReport.allowlist_fingerprint,
    graph_fingerprint: planReport.graph_fingerprint,
    restored_count: restoredCount,
    recovered_after_ambiguous_commit: recovered,
  };
  try {
    await writeJson(artifact(args, 'rollback.json'), result, true);
    return result;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readJson(artifact(args, 'rollback.json'));
    assertPolicy(existing, args);
    if (existing.schema_version !== ROLLBACK_SCHEMA || existing.status !== 'pass'
      || existing.allowlist_fingerprint !== result.allowlist_fingerprint
      || existing.graph_fingerprint !== result.graph_fingerprint
      || Number(existing.restored_count) !== restoredCount) {
      throw new Error('concurrent purge rollback artifact mismatch');
    }
    return existing;
  }
}

async function rollback(engine: BrainEngine, args: PurgePagesExactArgs): Promise<Record<string, unknown>> {
  if (!args.applyEnabled) throw new Error('purge rollback requires apply_enabled=true');
  if (!/^[a-f0-9]{64}$/.test(args.expectedFingerprint || '')) throw new Error('expected_fingerprint is required');
  const planReport = await readJson(artifact(args, 'plan.json'));
  const applyReport = await readJson(artifact(args, 'apply.json'));
  const { bytes, payload: backup } = await loadBackup(args);
  assertPlanAndBackup(planReport, backup, bytes, args);
  assertPolicy(applyReport, args);
  if (planReport.allowlist_fingerprint !== args.expectedFingerprint) throw new Error('allowlist fingerprint mismatch');
  if (applyReport.schema_version !== APPLY_SCHEMA || applyReport.status !== 'pass'
    || applyReport.allowlist_fingerprint !== planReport.allowlist_fingerprint
    || applyReport.graph_fingerprint !== planReport.graph_fingerprint
    || applyReport.backup_sha256 !== planReport.backup_sha256
    || Number(applyReport.purged_count) !== backup.rows.pages.length) {
    throw new Error('purge apply artifact mismatch');
  }

  const prior = await tryReadJson(artifact(args, 'rollback.json'));
  const pageIds = numericIds(backup.rows.pages);
  const currentPages = await pagesByIds(engine, pageIds);
  if (prior) {
    assertPolicy(prior, args);
    const graph = await captureGraph(engine, currentPages);
    if (prior.schema_version !== ROLLBACK_SCHEMA || prior.status !== 'pass'
      || currentPages.length !== pageIds.length || fingerprint(graph) !== backup.graph_fingerprint) {
      throw new Error('existing purge rollback artifact does not match database state');
    }
    return prior;
  }
  if (currentPages.length > 0) {
    if (currentPages.length !== pageIds.length) throw new Error('rollback targets are partially present');
    const graph = await captureGraph(engine, currentPages);
    if (fingerprint(graph) !== backup.graph_fingerprint) throw new Error('rollback targets are present but graph differs from backup');
    if (!args.acceptAmbiguousCommit) {
      throw new Error('all rollback targets are present without a rollback artifact; retry with accept_ambiguous_commit=true after operator review');
    }
    return finishRollback(args, planReport, pageIds.length, true);
  }

  await writeJson(artifact(args, 'rollback-intent.json'), {
    schema_version: 'gbrain-purge-pages-exact-rollback-intent-v1',
    ...policyShape(args),
    generated_at: nowIso(),
    allowlist_fingerprint: planReport.allowlist_fingerprint,
    graph_fingerprint: planReport.graph_fingerprint,
  }, true).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const intent = await readJson(artifact(args, 'rollback-intent.json'));
    assertPolicy(intent, args);
    if (intent.allowlist_fingerprint !== planReport.allowlist_fingerprint
      || intent.graph_fingerprint !== planReport.graph_fingerprint) throw new Error('purge rollback intent mismatch');
  });

  try {
    await engine.transaction(async (tx) => restoreGraph(tx, backup));
  } catch (error) {
    const restoredPages = await pagesByIds(engine, pageIds);
    if (restoredPages.length === pageIds.length) {
      const graph = await captureGraph(engine, restoredPages);
      if (fingerprint(graph) === backup.graph_fingerprint) {
        if (!args.acceptAmbiguousCommit) {
          throw new Error('ambiguous purge rollback commit requires accept_ambiguous_commit=true after operator review', { cause: error });
        }
        return finishRollback(args, planReport, pageIds.length, true);
      }
      throw new Error('ambiguous purge rollback produced a non-exact graph', { cause: error });
    }
    if (restoredPages.length !== 0) throw new Error('ambiguous partial purge rollback state', { cause: error });
    throw error;
  }
  const restoredPages = await pagesByIds(engine, pageIds);
  const graph = await captureGraph(engine, restoredPages);
  if (restoredPages.length !== pageIds.length || fingerprint(graph) !== backup.graph_fingerprint) {
    throw new Error('purge rollback readback mismatch');
  }
  return finishRollback(args, planReport, pageIds.length, false);
}

export async function runPurgePagesExact(
  engine: BrainEngine,
  args: PurgePagesExactArgs,
): Promise<Record<string, unknown>> {
  if (args.action === 'plan') return plan(engine, args);
  if (args.action === 'apply') return apply(engine, args);
  if (args.action === 'verify') return verify(engine, args);
  if (args.action === 'rollback') return rollback(engine, args);
  throw new Error('unsupported purge-pages action');
}
