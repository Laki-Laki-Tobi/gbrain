# Exact Corpus Remediation

These operations are owner-only maintenance primitives. They have `scope:
admin`, are `localOnly`, and are intentionally absent from HTTP MCP. Run them
through the local `gbrain call` surface with an explicit source selection.

## Page Operations

- `create_page_file_exact` creates only an absent lowercase slug. The input
  must be an absolute regular UTF-8 file with mode `0600`, and
  `expected_content_sha256` must match its bytes. The required lowercase
  `expected_postimage_content_hash` must match the canonical parsed page before
  any write. Canonical ingestion runs without embedding or automatic
  doc-to-code relations. The page row uses a plain insert, so the database
  unique constraint atomically rejects a concurrent creator instead of
  entering an upsert path. The resulting page, tags, aliases, and approved
  content hash are read back exactly.
- `put_page_file_exact` merges an approved private-file draft into one active
  lowercase source/slug. `expected_content_hash` binds the active preimage,
  `expected_preimage_markdown_sha256` independently binds its exact rendered
  Markdown bytes, `expected_content_sha256` binds the file bytes, and
  `expected_postimage_content_hash` binds the canonical parsed postimage. The
  importer locks and rechecks both active preimage hashes inside the write
  transaction before version, page, tag, alias, or chunk writes. Tag and alias
  projection is exact and transactional. All canonical tag add/remove writers
  take the same page-row lock, so concurrent tag mutations serialize after the
  exact projection instead of being lost. This operation calls the canonical
  importer directly with embedding disabled; it does not run ordinary `put_page` repository
  write-through, auto-link, timeline, facts, chronicle, or post-write lint
  hooks, and importer doc-to-code relation extraction is disabled. Readback
  strictly verifies page fields, type, tags, aliases, source, and canonical
  content hash.
- `soft_delete_page_exact` binds the mutation to source, slug, and
  `expected_content_hash`. Set `require_zero_inbound=true` to block while any
  database backlink exists. Endpoint row locks serialize this gate with both
  single and batch link writers. Verification uses an include-deleted readback.
- `restore_page_exact` additionally requires the exact tombstone timestamp in
  `expected_deleted_at`. It verifies the restored active row after clearing
  the tombstone.
- `restore_link_exact` locks all exact endpoint rows in its write transaction,
  including deleted endpoints used during rollback. It therefore serializes
  with `soft_delete_page_exact`'s zero-inbound gate before restoring provenance.

Ambiguous create, soft-delete, or restore recovery is fail-closed. Set
`accept_ambiguous_commit=true` only after independently reviewing the current
row and confirming that a prior call committed but lost its response.
An already-soft-deleted row has no operation-local durable evidence by itself
and therefore also requires this explicit gate.

## Exact Physical Purge

`inventory_deleted_pages_exact` is the local CLI-only, read-only candidate
inventory. It never returns page bodies, frontmatter, tags, or other private
content. It is scoped to the caller's source and returns only a sorted slug,
tombstone timestamp, content hash, active inbound-link count from any source, age
eligibility, and a reason. Source-wide mode paginates with `after_slug`; exact
reviewed `slugs` are bounded to 500 and always return a record for every
requested slug. Missing and restored slugs are explicit non-candidates rather
than silently omitted. `min_age_hours` defaults to 72 and is bounded to
72-8760. The response fingerprint binds the reviewed/enumerated rows and
request scope for the subsequent `purge_pages_exact` review.

`purge_pages_exact` accepts actions `plan`, `apply`, `verify`, and `rollback`.
The plan allowlist contains at most 100 entries, each with lowercase `slug`,
exact `deleted_at`, and exact `content_hash`. The generated fingerprint binds
the source and complete allowlist. Every target must have been soft-deleted for
at least three days and must have zero active inbound links or dependent
references. Both conditions are checked during planning and again while the
target rows are locked in the apply transaction.

The plan writes mode-`0600` evidence under:

```text
$GBRAIN_HOME/governance-backups/page-purge-exact/<run_id>/
```

The gzip backup covers page rows and affected chunks, code edges, links,
origin-only links, tags, raw data, timeline entries, versions, takes,
synthesis evidence, file associations, and page/slug aliases. Files and
origin-only links that survive the purge through `ON DELETE SET NULL` are
drift-checked before rollback restores their associations.

A `slug_aliases` row whose `alias_slug` is the purged page slug and whose
`canonical_slug` names a live page is the durable replacement for that page,
so apply preserves it. The backup records this preserved projection and both
verify and rollback require it to remain exact. Conversely, a surviving alias
whose `canonical_slug` is a purge target remains an active dependency and
blocks the purge.

Plan capture uses one transaction (`REPEATABLE READ` on Postgres), and apply
uses a serializable transaction plus target row locks and an exact graph
fingerprint recheck. Both compressed and uncompressed backup payloads are
bounded to 64 MiB. The protocol stops before writing a backup if either bound
is exceeded. Writers outside the engine's canonical link methods are not part
of the shared endpoint-lock protocol; target row locks, foreign keys, the
serializable apply, and the final full-graph readback provide the fail-closed
backstop for that residual case.

Apply and rollback require `apply_enabled=true` plus the plan's
`allowlist_fingerprint` as `expected_fingerprint`. Missing artifacts,
partial presence, recreated slugs, source/hash/tombstone drift, backup damage,
graph drift, residual cascade rows, or incorrect `SET NULL` projections stop
the operation. `accept_ambiguous_commit=true` is reserved
for an independently reviewed all-committed state after a lost response.

This protocol never invokes `purge_deleted_pages`, performs no migration, and
does not expose a remote endpoint.
