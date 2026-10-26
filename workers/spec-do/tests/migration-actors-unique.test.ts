/**
 * Stub for the future unique index on actors.github_user_id (m12 or later). Not implemented: the
 * migration does not exist yet, and this file only pins the maintainer's decision for when it does.
 *
 * Decision (maintainer, 2026-10-26): on duplicates the step REFUSES with a named error that lists the
 * duplicate values and actor ids; it never skips the index, never deletes, never merges.
 *
 * Plan: docs/MIGRATION-LEGACY-TEST-PLAN.md section 6. Lands with the m12 PR.
 */
import { describe, it } from 'vitest';

describe('migration: unique index on actors.github_user_id (m12, not implemented)', () => {
  it.todo('clean ledger with many NULL github_user_id values: creates the index, rows kept, rerun is a no-op');
  it.todo('duplicate github_user_id REFUSES with a named error listing the values and actor ids; version stays m11, rows intact, db unset');
  it.todo('two empty-string github_user_id values count as duplicates and refuse');
  it.todo('after a human resolves the duplicate, a retry reaches m12 and the index exists');
});
