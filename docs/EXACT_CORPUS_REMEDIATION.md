# Exact Corpus Remediation

These operations are owner-only maintenance primitives. They have `scope:
admin`, are `localOnly`, and are intentionally absent from HTTP MCP. Run them
through the local `gbrain call` surface with an explicit source selection.

## Page Operations

- `create_page_file_exact` creates only an absent lowercase slug. The input
  must be an absolute regular UTF-8 file with mode `0600`, and
  `expected_content_sha256` must match its bytes. Canonical ingestion runs
  without embedding and the resulting page, tags, and content hash are read
  back exactly.
- `soft_delete_page_exact` binds the mutation to source, slug, and
  `expected_content_hash`. Set `require_zero_inbound=true` to block while any
  database backlink exists. Verification uses an include-deleted readback.
- `restore_page_exact` additionally requires the exact tombstone timestamp in
  `expected_deleted_at`. It verifies the restored active row after clearing
  the tombstone.

Ambiguous create, soft-delete, or restore recovery is fail-closed. Set
`accept_ambiguous_commit=true` only after independently reviewing the current
row and confirming that a prior call committed but lost its response.

## Exact Physical Purge

`purge_pages_exact` accepts actions `plan`, `apply`, `verify`, and `rollback`.
The plan allowlist contains at most 100 entries, each with lowercase `slug`,
exact `deleted_at`, and exact `content_hash`. The generated fingerprint binds
the source and complete allowlist.

The plan writes mode-`0600` evidence under:

```text
$GBRAIN_HOME/governance-backups/page-purge-exact/<run_id>/
```

The gzip backup covers page rows and affected chunks, code edges, links,
origin-only links, tags, raw data, timeline entries, versions, takes,
synthesis evidence, file associations, and page/slug aliases. Files and
origin-only links that survive the purge through `ON DELETE SET NULL` are
drift-checked before rollback restores their associations.

Apply and rollback require `apply_enabled=true` plus the plan's
`allowlist_fingerprint` as `expected_fingerprint`. Missing artifacts,
partial presence, recreated slugs, source/hash/tombstone drift, backup damage,
or graph drift stop the operation. `accept_ambiguous_commit=true` is reserved
for an independently reviewed all-committed state after a lost response.

This protocol never invokes `purge_deleted_pages`, performs no migration, and
does not expose a remote endpoint.
