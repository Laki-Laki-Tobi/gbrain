import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { BrainEngine } from './engine.ts';

const POLICY_VERSION = 'gbrain-page-version-retention-exact-v1-2026-08-27';
const BACKUP_SCHEMA = 'gbrain-page-version-retention-backup-v1';
const PLAN_SCHEMA = 'gbrain-page-version-retention-plan-v1';
const APPLY_SCHEMA = 'gbrain-page-version-retention-apply-v1';
const VERIFY_SCHEMA = 'gbrain-page-version-retention-verify-v1';
const ROLLBACK_SCHEMA = 'gbrain-page-version-retention-rollback-v1';

export interface PageVersionRetentionArgs {
  action: 'plan' | 'apply' | 'verify' | 'rollback';
  runId: string;
  sourceId: string;
  retentionDays: number;
  keepLatest: number;
  deleteLimit: number;
  maxPayloadBytes: number;
  expectedFingerprint?: string;
  applyEnabled: boolean;
  acceptAmbiguousCommit: boolean;
}

interface VersionRow {
  id: number | string;
  page_id: number | string;
  slug: string;
  source_id?: string;
  snapshot_at: Date | string;
  compiled_truth: string;
  frontmatter: Record<string, unknown> | string;
  version_rank?: number | string;
  payload_bytes?: number | string;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortDeep(item)]));
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function frontmatter(value: VersionRow['frontmatter']): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value ?? {};
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function candidateDigest(row: VersionRow): string {
  return sha256(JSON.stringify([
    Number(row.id), Number(row.page_id), String(row.slug), iso(row.snapshot_at),
    Number(row.version_rank), String(row.compiled_truth), sortDeep(frontmatter(row.frontmatter)),
  ]));
}

function rowDigest(row: VersionRow): string {
  return sha256(JSON.stringify([
    Number(row.id), Number(row.page_id), String(row.slug), iso(row.snapshot_at),
    String(row.compiled_truth), sortDeep(frontmatter(row.frontmatter)),
  ]));
}

function fingerprint(rows: VersionRow[], digest: (row: VersionRow) => string): string {
  return sha256(rows.map((row) => `${Number(row.id)}:${digest(row)}`).sort().join('\n'));
}

function retentionRoot(): string {
  const base = process.env.GBRAIN_HOME || path.join(process.env.HOME || homedir(), '.gbrain');
  return path.resolve(base, 'governance-backups', 'page-versions');
}

function runDir(args: PageVersionRetentionArgs): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(args.runId)) {
    throw new Error('run_id must be lowercase and path-safe');
  }
  return path.join(retentionRoot(), args.runId);
}

function artifact(args: PageVersionRetentionArgs, name: string): string {
  return path.join(runDir(args), name);
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
      // link(2) publishes the prepared inode without rename's overwrite race.
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

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJson(file: string, value: unknown, exclusive = false): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, exclusive);
}

async function readJson(file: string): Promise<any> {
  const mode = (await stat(file)).mode & 0o777;
  if (mode !== 0o600) throw new Error(`retention artifact must have mode 0600: ${file}`);
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

async function inventory(engine: BrainEngine, sourceId: string): Promise<Record<string, number>> {
  const [row] = await engine.executeRaw<Record<string, number | string>>(`
    SELECT count(*)::bigint AS version_count,
           count(DISTINCT pv.page_id)::bigint AS versioned_page_count,
           coalesce(sum(octet_length(pv.compiled_truth) + octet_length(pv.frontmatter::text)), 0)::bigint AS payload_bytes
      FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
     WHERE p.source_id = $1
  `, [sourceId]);
  return {
    version_count: Number(row?.version_count || 0),
    versioned_page_count: Number(row?.versioned_page_count || 0),
    payload_bytes: Number(row?.payload_bytes || 0),
  };
}

async function candidates(
  engine: BrainEngine,
  args: PageVersionRetentionArgs,
  exactIds?: number[],
): Promise<VersionRow[]> {
  const exactFilter = exactIds ? 'AND id = ANY($4::int[])' : '';
  const limitClause = exactIds ? '' : 'LIMIT $4::int';
  const params = exactIds
    ? [args.sourceId, args.keepLatest, args.retentionDays, exactIds]
    : [args.sourceId, args.keepLatest, args.retentionDays, args.deleteLimit, args.maxPayloadBytes];
  return engine.executeRaw<VersionRow>(`
    WITH ranked AS (
      SELECT pv.id, pv.page_id, p.slug, pv.snapshot_at, pv.compiled_truth, pv.frontmatter,
             row_number() OVER (PARTITION BY pv.page_id ORDER BY pv.snapshot_at DESC, pv.id DESC)::int AS version_rank,
             (octet_length(pv.compiled_truth) + octet_length(pv.frontmatter::text))::bigint AS payload_bytes
        FROM page_versions pv
        JOIN pages p ON p.id = pv.page_id
       WHERE p.source_id = $1
    )
    SELECT id, page_id, slug, snapshot_at, compiled_truth, frontmatter, version_rank, payload_bytes
      FROM (
        SELECT eligible.*, sum(payload_bytes) OVER (ORDER BY snapshot_at ASC, id ASC) AS cumulative_payload_bytes
          FROM ranked eligible
         WHERE version_rank > $2::int
           AND snapshot_at < now() - ($3::int * interval '1 day')
           ${exactFilter}
      ) bounded
     WHERE ${exactIds ? 'true' : 'cumulative_payload_bytes <= $5::bigint'}
     ORDER BY snapshot_at ASC, id ASC
     ${limitClause}
  `, params);
}

async function rowsByIds(engine: BrainEngine, sourceId: string, ids: number[]): Promise<VersionRow[]> {
  if (ids.length === 0) return [];
  const rows = await engine.executeRaw<VersionRow>(`
    SELECT pv.id, pv.page_id, p.slug, p.source_id, pv.snapshot_at, pv.compiled_truth, pv.frontmatter
      FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
     WHERE pv.id = ANY($1::int[])
     ORDER BY pv.id ASC
  `, [ids]);
  const drifted = rows.find((row) => row.source_id !== sourceId);
  if (drifted) throw new Error(`source identity drift for page-version id ${Number(drifted.id)}`);
  return rows;
}

function policyShape(args: PageVersionRetentionArgs): Record<string, unknown> {
  return {
    policy_version: POLICY_VERSION,
    source_id: args.sourceId,
    run_id: args.runId,
    retention_days: args.retentionDays,
    keep_latest: args.keepLatest,
    delete_limit: args.deleteLimit,
    max_payload_bytes: args.maxPayloadBytes,
  };
}

function assertPolicy(value: any, args: PageVersionRetentionArgs): void {
  const expected = JSON.stringify(sortDeep(policyShape(args)));
  const actual = JSON.stringify(sortDeep(Object.fromEntries(Object.keys(policyShape(args)).map((key) => [key, value[key]]))));
  if (actual !== expected) throw new Error('retention artifact policy mismatch');
}

async function loadBackup(args: PageVersionRetentionArgs): Promise<{ bytes: Buffer; payload: any }> {
  const file = artifact(args, 'backup.json.gz');
  const mode = (await stat(file)).mode & 0o777;
  if (mode !== 0o600) throw new Error('retention backup must have mode 0600');
  const bytes = await readFile(file);
  return { bytes, payload: JSON.parse(gunzipSync(bytes).toString('utf8')) };
}

async function plan(engine: BrainEngine, args: PageVersionRetentionArgs): Promise<Record<string, unknown>> {
  await mkdir(retentionRoot(), { recursive: true, mode: 0o700 });
  await chmod(retentionRoot(), 0o700);
  await syncDirectory(path.dirname(retentionRoot()));
  await mkdir(runDir(args), { mode: 0o700 });
  await syncDirectory(retentionRoot());
  const before = await inventory(engine, args.sourceId);
  const rows = await candidates(engine, args);
  const candidateFingerprint = fingerprint(rows, candidateDigest);
  const backup = {
    schema_version: BACKUP_SCHEMA,
    ...policyShape(args),
    generated_at: nowIso(),
    candidate_fingerprint: candidateFingerprint,
    row_fingerprint: fingerprint(rows, rowDigest),
    rows: rows.map((row) => ({
      id: Number(row.id), page_id: Number(row.page_id), slug: row.slug,
      snapshot_at: iso(row.snapshot_at), compiled_truth: row.compiled_truth,
      frontmatter: frontmatter(row.frontmatter), version_rank: Number(row.version_rank),
      payload_bytes: Number(row.payload_bytes || 0),
    })),
  };
  const backupBytes = gzipSync(`${JSON.stringify(backup)}\n`, { level: 9 });
  const backupSha256 = sha256(backupBytes);
  await atomicWrite(artifact(args, 'backup.json.gz'), backupBytes, true);
  const report = {
    schema_version: PLAN_SCHEMA,
    ...policyShape(args),
    generated_at: nowIso(), status: 'pass', inventory_before: before,
    candidate_count: rows.length,
    candidate_payload_bytes: rows.reduce((sum, row) => sum + Number(row.payload_bytes || 0), 0),
    candidate_fingerprint: candidateFingerprint,
    row_fingerprint: backup.row_fingerprint,
    candidate_ids: rows.map((row) => Number(row.id)),
    backup_sha256: backupSha256,
  };
  await writeJson(artifact(args, 'plan.json'), report, true);
  const { candidate_ids: _candidateIds, ...publicReport } = report;
  return publicReport;
}

async function apply(engine: BrainEngine, args: PageVersionRetentionArgs): Promise<Record<string, unknown>> {
  if (!args.applyEnabled) throw new Error('retention apply requires apply_enabled=true');
  if (!/^[a-f0-9]{64}$/.test(args.expectedFingerprint || '')) throw new Error('expected_fingerprint is required');
  const report = await readJson(artifact(args, 'plan.json'));
  assertPolicy(report, args);
  if (report.candidate_fingerprint !== args.expectedFingerprint) throw new Error('candidate fingerprint mismatch');
  const { bytes, payload: backup } = await loadBackup(args);
  assertPolicy(backup, args);
  if (sha256(bytes) !== report.backup_sha256 || backup.candidate_fingerprint !== report.candidate_fingerprint) {
    throw new Error('retention backup integrity mismatch');
  }
  const ids = report.candidate_ids.map(Number) as number[];
  const priorResult = await tryReadJson(artifact(args, 'apply.json'));
  if (priorResult) {
    assertPolicy(priorResult, args);
    if (priorResult.schema_version !== APPLY_SCHEMA
      || priorResult.status !== 'pass'
      || priorResult.candidate_fingerprint !== report.candidate_fingerprint
      || priorResult.backup_sha256 !== report.backup_sha256
      || Number(priorResult.deleted_count) !== ids.length
      || (await rowsByIds(engine, args.sourceId, ids)).length !== 0) {
      throw new Error('existing retention apply artifact does not match database state');
    }
    return priorResult;
  }

  const current = await rowsByIds(engine, args.sourceId, ids);
  if (current.length === 0) {
    if (ids.length > 0 && !args.acceptAmbiguousCommit) {
      throw new Error('all retention candidates are absent without an apply artifact; retry with accept_ambiguous_commit=true after operator review');
    }
    return finishApply(args, report, ids.length, true);
  }
  if (current.length !== ids.length || fingerprint(current, rowDigest) !== report.row_fingerprint) {
    throw new Error('retention candidates are partially absent or changed');
  }
  const fresh = await candidates(engine, args, ids);
  if (fresh.length !== ids.length || fingerprint(fresh, candidateDigest) !== report.candidate_fingerprint) {
    throw new Error('retention candidates drifted after plan');
  }
  await writeJson(artifact(args, 'apply-intent.json'), {
    schema_version: 'gbrain-page-version-retention-apply-intent-v1',
    ...policyShape(args),
    generated_at: nowIso(),
    candidate_fingerprint: report.candidate_fingerprint,
    backup_sha256: report.backup_sha256,
  }, true).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const intent = await readJson(artifact(args, 'apply-intent.json'));
    assertPolicy(intent, args);
    if (intent.candidate_fingerprint !== report.candidate_fingerprint
      || intent.backup_sha256 !== report.backup_sha256) {
      throw new Error('retention apply intent mismatch');
    }
  });

  try {
    await engine.transaction(async (tx) => {
      const deleted = await tx.executeRaw<{ id: number | string }>(`
        DELETE FROM page_versions pv
         USING pages p
         WHERE pv.page_id = p.id
           AND p.source_id = $1
           AND pv.id = ANY($2::int[])
         RETURNING pv.id
      `, [args.sourceId, ids]);
      if (deleted.length !== ids.length) throw new Error('retention delete count mismatch');
    });
  } catch (error) {
    const remainingAfterError = await rowsByIds(engine, args.sourceId, ids);
    if (remainingAfterError.length === 0) {
      if (!args.acceptAmbiguousCommit) {
        throw new Error('ambiguous apply commit requires accept_ambiguous_commit=true after operator review', { cause: error });
      }
      return finishApply(args, report, ids.length, true);
    }
    throw error;
  }
  const remaining = await rowsByIds(engine, args.sourceId, ids);
  if (remaining.length !== 0) throw new Error('retention delete readback mismatch');
  return finishApply(args, report, ids.length, false);
}

async function finishApply(
  args: PageVersionRetentionArgs,
  report: any,
  deletedCount: number,
  recoveredAfterAmbiguousCommit: boolean,
): Promise<Record<string, unknown>> {
  const result = {
    schema_version: APPLY_SCHEMA,
    ...policyShape(args),
    generated_at: nowIso(), status: 'pass',
    candidate_fingerprint: report.candidate_fingerprint,
    backup_sha256: report.backup_sha256,
    deleted_count: deletedCount,
    recovered_after_ambiguous_commit: recoveredAfterAmbiguousCommit,
  };
  try {
    await writeJson(artifact(args, 'apply.json'), result, true);
    return result;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readJson(artifact(args, 'apply.json'));
    assertPolicy(existing, args);
    if (existing.schema_version !== APPLY_SCHEMA
      || existing.status !== 'pass'
      || existing.candidate_fingerprint !== result.candidate_fingerprint
      || existing.backup_sha256 !== result.backup_sha256
      || Number(existing.deleted_count) !== deletedCount) {
      throw new Error('concurrent retention apply artifact mismatch');
    }
    return existing;
  }
}

async function verify(engine: BrainEngine, args: PageVersionRetentionArgs): Promise<Record<string, unknown>> {
  const planReport = await readJson(artifact(args, 'plan.json'));
  const applyReport = await readJson(artifact(args, 'apply.json'));
  assertPolicy(planReport, args);
  assertPolicy(applyReport, args);
  const ids = planReport.candidate_ids.map(Number) as number[];
  const remaining = await rowsByIds(engine, args.sourceId, ids);
  const priorResult = await tryReadJson(artifact(args, 'verify.json'));
  if (priorResult) {
    assertPolicy(priorResult, args);
    if (priorResult.schema_version !== VERIFY_SCHEMA
      || priorResult.status !== 'pass'
      || priorResult.candidate_fingerprint !== planReport.candidate_fingerprint
      || remaining.length !== 0) {
      throw new Error('existing retention verify artifact does not match database state');
    }
    return priorResult;
  }
  const result = {
    schema_version: VERIFY_SCHEMA,
    ...policyShape(args),
    generated_at: nowIso(),
    status: remaining.length === 0 && applyReport.deleted_count === ids.length ? 'pass' : 'blocked',
    candidate_fingerprint: planReport.candidate_fingerprint,
    verified_absent_count: ids.length - remaining.length,
    remaining_count: remaining.length,
    inventory_after: await inventory(engine, args.sourceId),
  };
  await writeJson(artifact(args, 'verify.json'), result, true);
  if (result.status !== 'pass') throw new Error('retention verification failed');
  return result;
}

async function rollback(engine: BrainEngine, args: PageVersionRetentionArgs): Promise<Record<string, unknown>> {
  if (!args.applyEnabled) throw new Error('retention rollback requires apply_enabled=true');
  if (!/^[a-f0-9]{64}$/.test(args.expectedFingerprint || '')) throw new Error('expected_fingerprint is required');
  const planReport = await readJson(artifact(args, 'plan.json'));
  const applyReport = await readJson(artifact(args, 'apply.json'));
  assertPolicy(planReport, args);
  assertPolicy(applyReport, args);
  if (planReport.candidate_fingerprint !== args.expectedFingerprint) throw new Error('candidate fingerprint mismatch');
  const { bytes, payload: backup } = await loadBackup(args);
  assertPolicy(backup, args);
  if (sha256(bytes) !== planReport.backup_sha256 || backup.row_fingerprint !== fingerprint(backup.rows, rowDigest)) {
    throw new Error('retention backup integrity mismatch');
  }
  const ids = backup.rows.map((row: VersionRow) => Number(row.id));
  if (applyReport.schema_version !== APPLY_SCHEMA
    || applyReport.status !== 'pass'
    || applyReport.candidate_fingerprint !== planReport.candidate_fingerprint
    || applyReport.backup_sha256 !== planReport.backup_sha256
    || Number(applyReport.deleted_count) !== ids.length) {
    throw new Error('retention apply artifact mismatch');
  }
  const priorResult = await tryReadJson(artifact(args, 'rollback.json'));
  if (priorResult) {
    assertPolicy(priorResult, args);
    const restored = await rowsByIds(engine, args.sourceId, ids);
    if (priorResult.schema_version !== ROLLBACK_SCHEMA
      || priorResult.status !== 'pass'
      || priorResult.candidate_fingerprint !== planReport.candidate_fingerprint
      || Number(priorResult.restored_count) !== ids.length
      || restored.length !== ids.length
      || fingerprint(restored, rowDigest) !== backup.row_fingerprint) {
      throw new Error('existing retention rollback artifact does not match database state');
    }
    return priorResult;
  }
  const existing = await rowsByIds(engine, args.sourceId, ids);
  if (existing.length > 0) {
    if (existing.length !== ids.length || fingerprint(existing, rowDigest) !== backup.row_fingerprint) {
      throw new Error('rollback targets are partially present or changed');
    }
    if (!args.acceptAmbiguousCommit) {
      throw new Error('all rollback targets are present without a rollback artifact; retry with accept_ambiguous_commit=true after operator review');
    }
    return finishRollback(args, planReport, ids.length, true);
  }
  const pageIds = [...new Set(backup.rows.map((row: VersionRow) => Number(row.page_id)))];
  const pages = await engine.executeRaw<{ id: number | string; slug: string }>(
    `SELECT id, slug FROM pages WHERE source_id = $1 AND id = ANY($2::int[])`,
    [args.sourceId, pageIds],
  );
  const pageMap = new Map(pages.map((page) => [Number(page.id), page.slug]));
  for (const row of backup.rows as VersionRow[]) {
    if (pageMap.get(Number(row.page_id)) !== row.slug) throw new Error(`rollback page identity drift for ${row.slug}`);
  }
  try {
    await engine.transaction(async (tx) => {
      for (const row of backup.rows as VersionRow[]) {
        await tx.executeRaw(`
          INSERT INTO page_versions (id, page_id, compiled_truth, frontmatter, snapshot_at)
          VALUES ($1::int, $2::int, $3::text, $4::text::jsonb, $5::timestamptz)
        `, [Number(row.id), Number(row.page_id), row.compiled_truth, JSON.stringify(frontmatter(row.frontmatter)), iso(row.snapshot_at)]);
      }
    });
  } catch (error) {
    const restoredAfterError = await rowsByIds(engine, args.sourceId, ids);
    if (restoredAfterError.length === ids.length
      && fingerprint(restoredAfterError, rowDigest) === backup.row_fingerprint) {
      if (!args.acceptAmbiguousCommit) {
        throw new Error('ambiguous rollback commit requires accept_ambiguous_commit=true after operator review', { cause: error });
      }
      return finishRollback(args, planReport, ids.length, true);
    }
    throw error;
  }
  const restored = await rowsByIds(engine, args.sourceId, ids);
  if (restored.length !== ids.length || fingerprint(restored, rowDigest) !== backup.row_fingerprint) {
    throw new Error('retention rollback readback mismatch');
  }
  return finishRollback(args, planReport, restored.length, false);
}

async function finishRollback(
  args: PageVersionRetentionArgs,
  planReport: any,
  restoredCount: number,
  recoveredAfterAmbiguousCommit: boolean,
): Promise<Record<string, unknown>> {
  const result = {
    schema_version: ROLLBACK_SCHEMA,
    ...policyShape(args),
    generated_at: nowIso(), status: 'pass', restored_count: restoredCount,
    candidate_fingerprint: planReport.candidate_fingerprint,
    recovered_after_ambiguous_commit: recoveredAfterAmbiguousCommit,
  };
  try {
    await writeJson(artifact(args, 'rollback.json'), result, true);
    return result;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readJson(artifact(args, 'rollback.json'));
    assertPolicy(existing, args);
    if (existing.schema_version !== ROLLBACK_SCHEMA
      || existing.status !== 'pass'
      || existing.candidate_fingerprint !== result.candidate_fingerprint
      || Number(existing.restored_count) !== restoredCount) {
      throw new Error('concurrent retention rollback artifact mismatch');
    }
    return existing;
  }
}

export async function runPageVersionRetention(
  engine: BrainEngine,
  args: PageVersionRetentionArgs,
): Promise<Record<string, unknown>> {
  if (args.action === 'plan') return plan(engine, args);
  if (args.action === 'apply') return apply(engine, args);
  if (args.action === 'verify') return verify(engine, args);
  if (args.action === 'rollback') return rollback(engine, args);
  throw new Error('unsupported page-version retention action');
}
