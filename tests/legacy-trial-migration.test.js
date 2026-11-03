import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20261102000000_move_unused_legacy_workspaces_to_trial.sql', import.meta.url), 'utf8');
const preflight = await readFile(new URL('../supabase/diagnostics/legacy_trial_preflight.sql', import.meta.url), 'utf8');
const applyApproved = await readFile(new URL('../supabase/diagnostics/legacy_trial_apply_approved.sql', import.meta.url), 'utf8');
const rollback = await readFile(new URL('../supabase/diagnostics/legacy_trial_rollback.sql', import.meta.url), 'utf8');

function normalize(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function migrationFilters(sql) {
  const starts = [...sql.matchAll(/where subscription_row\.legacy_access/g)].map((match) => match.index);
  return starts.map((start) => {
    const conflict = sql.indexOf('\non conflict', start);
    const semicolon = sql.indexOf(';', start);
    const end = conflict >= 0 && conflict < semicolon ? conflict : semicolon;
    return normalize(sql.slice(start, end)).replace(
      / and exists \( select 1 from private\.grafiflow_legacy_trial_approvals_20261102 as approval where approval\.workspace_id = subscription_row\.workspace_id \)$/,
      '',
    );
  });
}

test('legacy trial migration uses the same candidate predicate for backup and update', () => {
  const filters = migrationFilters(migration);
  assert.equal(filters.length, 2);
  assert.equal(filters[0], filters[1]);
  assert.match(filters[0], /not exists[\s\S]*workspace_subscription_payments/);
  assert.match(filters[0], /not exists[\s\S]*asaas_billing_checkouts/);
  assert.equal((migration.match(/and exists \([\s\S]*?grafiflow_legacy_trial_approvals_20261102/g) || []).length, 2);
});

test('legacy trial migration snapshots private state and is idempotent', () => {
  assert.match(migration, /create table if not exists private\.grafiflow_legacy_trial_migration_backup_20261102/);
  assert.match(migration, /on conflict \(workspace_id\) do nothing/);
  assert.match(migration, /set legacy_access = false/);
  assert.match(migration, /trial_status = 'not_started'/);
  assert.match(migration, /paid_cycle_count, 0\) = 0/);
  assert.match(migration, /create table if not exists private\.grafiflow_legacy_trial_approvals_20261102/);
  assert.match(migration, /approval table is intentionally empty by default/i);
});

test('explicit approval and manual evidence are required before legacy access is removed', () => {
  assert.match(migration, /review_evidence text not null/);
  assert.match(migration, /length\(btrim\(review_evidence\)\) >= 20/);
  assert.match(applyApproved, /Do not approve a workspace based only on the absence of payment columns/i);
  assert.match(applyApproved, /grafiflow_legacy_trial_approvals_20261102/);
});

test('preflight is read-only and uses the migration eligibility filter', () => {
  assert.doesNotMatch(preflight, /\b(insert|update|delete|drop|alter)\s+(into|table)?\b/i);
  const [migrationFilter] = migrationFilters(migration);
  const [applyFilter] = migrationFilters(applyApproved);
  const preflightFilter = normalize(preflight.match(/where subscription_row\.legacy_access[\s\S]*?(?=\n\))/)?.[0] || '');
  assert.ok(preflightFilter);
  assert.equal(preflightFilter, migrationFilter);
  assert.equal(applyFilter, migrationFilter);
});

test('rollback restores only untouched candidates and keeps recovery snapshots', () => {
  assert.match(rollback, /\bbegin;[\s\S]*\bcommit;/i);
  assert.match(rollback, /trial_status = 'not_started'/);
  assert.match(rollback, /not exists[\s\S]*workspace_billing_periods/);
  assert.match(rollback, /not exists[\s\S]*workspace_subscription_payments/);
  assert.match(rollback, /Keep the private snapshots/);
  assert.doesNotMatch(rollback, /\bdelete\s+from\b/i);
});
