import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSyncConfig, normalizeSyncConfig, DEFAULT_SYNC_CONFIG } from '../../src/domain/mapping.mjs';

const valid = { enabled: true, conflictRule: 'orca-wins', statusToColumn: { 7: { 'in-review': ['9'], 'in-progress': ['8'] } } };

test('defaults: enabled, orca-wins, empty map', () => {
  assert.deepEqual(normalizeSyncConfig(undefined), { enabled: true, conflictRule: 'orca-wins', statusToColumn: {} });
  assert.deepEqual(DEFAULT_SYNC_CONFIG, { enabled: true, conflictRule: 'orca-wins', statusToColumn: {} });
});

test('defaults are not shared between calls', () => {
  const a = normalizeSyncConfig(null);
  a.statusToColumn.x = {};
  assert.deepEqual(normalizeSyncConfig(null).statusToColumn, {});
});

test('normalize keeps a valid stored config and applies defaults per field', () => {
  assert.deepEqual(normalizeSyncConfig(valid), valid);
  assert.deepEqual(normalizeSyncConfig({ enabled: false }), { enabled: false, conflictRule: 'orca-wins', statusToColumn: {} });
  assert.equal(normalizeSyncConfig({ conflictRule: 'basecamp-wins' }).conflictRule, 'basecamp-wins');
});

test('normalize never throws and drops invalid parts', () => {
  for (const bad of [42, 'x', [], () => 1, { enabled: 'yes', conflictRule: 'newest-wins', statusToColumn: 5 }]) {
    assert.deepEqual(normalizeSyncConfig(bad), { enabled: true, conflictRule: 'orca-wins', statusToColumn: {} });
  }
  const mixed = normalizeSyncConfig({
    statusToColumn: { 7: { 'in-review': '9', '--read': '1', completed: '3', ok: 'abc' }, abc: { a: '1' } }
  });
  assert.deepEqual(mixed.statusToColumn, { 7: { 'in-review': ['9'] } });
});

test('validate accepts a full valid config and returns a clean copy', () => {
  const r = validateSyncConfig(valid);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, valid);
  assert.notEqual(r.value, valid);
});

test('validate preserves status order inside a project', () => {
  const r = validateSyncConfig({ ...valid, statusToColumn: { 7: { b: ['2'], a: ['1'] } } });
  assert.deepEqual(Object.keys(r.value.statusToColumn[7]), ['b', 'a']);
});

test('validate rejects a bad conflictRule and a non-boolean enabled', () => {
  assert.equal(validateSyncConfig({ ...valid, conflictRule: 'newest-wins' }).ok, false);
  assert.equal(validateSyncConfig({ ...valid, enabled: 'true' }).ok, false);
  assert.match(validateSyncConfig({ ...valid, enabled: 1 }).error, /enabled/);
});

test('validate rejects non-object bodies and missing fields', () => {
  for (const bad of [null, 'x', [], 5, {}, { enabled: true }, { ...valid, statusToColumn: [] }]) {
    assert.equal(validateSyncConfig(bad).ok, false);
  }
});

test('validate rejects the completed key, __proto__ and malformed status names', () => {
  const withStatus = (status) =>
    JSON.parse(`{"enabled":true,"conflictRule":"orca-wins","statusToColumn":{"7":{${JSON.stringify(status)}:"9"}}}`);
  for (const status of ['completed', '__proto__', '--read', '-x', 'a b', 'a'.repeat(41), '', 'a\nb']) {
    assert.equal(validateSyncConfig(withStatus(status)).ok, false, status);
  }
  assert.equal(validateSyncConfig(withStatus('a'.repeat(40))).ok, true);
  assert.equal(validateSyncConfig(withStatus('my.custom_1-x')).ok, true);
});

test('validate rejects all-digit status keys (JS would reorder them)', () => {
  const withStatus = (status) => ({ enabled: true, conflictRule: 'orca-wins', statusToColumn: { 7: { [status]: '9' } } });
  for (const status of ['1', '0', '007']) assert.equal(validateSyncConfig(withStatus(status)).ok, false, status);
  assert.equal(validateSyncConfig(withStatus('1a')).ok, true);
});

test('validate rejects a __proto__ project key', () => {
  const body = JSON.parse('{"enabled":true,"conflictRule":"orca-wins","statusToColumn":{"__proto__":{"a":"1"}}}');
  assert.equal(validateSyncConfig(body).ok, false);
});

test('validate rejects non-numeric project and column ids', () => {
  assert.equal(validateSyncConfig({ ...valid, statusToColumn: { abc: { a: '1' } } }).ok, false);
  assert.equal(validateSyncConfig({ ...valid, statusToColumn: { 7: { a: 'x1' } } }).ok, false);
  assert.equal(validateSyncConfig({ ...valid, statusToColumn: { 7: { a: '-1' } } }).ok, false);
  assert.equal(validateSyncConfig({ ...valid, statusToColumn: { 7: { a: '1 --foo' } } }).ok, false);
  assert.equal(validateSyncConfig({ ...valid, statusToColumn: { 7: { a: 12 } } }).ok, false);
});

test('validate enforces 50 projects and 30 statuses', () => {
  const projects = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), { a: '1' }]));
  const statuses = (n) => ({ 7: Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, '1'])) });
  assert.equal(validateSyncConfig({ ...valid, statusToColumn: projects(50) }).ok, true);
  assert.equal(validateSyncConfig({ ...valid, statusToColumn: projects(51) }).ok, false);
  assert.equal(validateSyncConfig({ ...valid, statusToColumn: statuses(30) }).ok, true);
  assert.equal(validateSyncConfig({ ...valid, statusToColumn: statuses(31) }).ok, false);
});

test('validate drops unknown top-level keys', () => {
  assert.deepEqual(validateSyncConfig({ ...valid, extra: 1 }).value, valid);
});

// ---- several columns per status ----

test('legacy single-string columns are normalized to one-element arrays (stored and POSTed)', () => {
  const legacy = { enabled: true, conflictRule: 'orca-wins', statusToColumn: { 7: { todo: '8', 'in-review': ['9', '10'] } } };
  const expected = { 7: { todo: ['8'], 'in-review': ['9', '10'] } };
  assert.deepEqual(normalizeSyncConfig(legacy).statusToColumn, expected);
  const checked = validateSyncConfig(legacy);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.value.statusToColumn, expected);
});

test('validate keeps the column order and allows a column in several statuses', () => {
  const r = validateSyncConfig({ ...valid, statusToColumn: { 7: { a: ['3', '1', '2'], b: ['1'] } } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.statusToColumn[7], { a: ['3', '1', '2'], b: ['1'] });
});

test('validate rejects empty arrays, duplicates, non-numeric ids and more than 20 ids', () => {
  const tooMany = Array.from({ length: 21 }, (_, i) => String(i + 1));
  const twenty = tooMany.slice(0, 20);
  const bad = [[], ['1', '1'], ['1', 'x'], ['1', 2], [''], tooMany, {}, null];
  for (const columns of bad) {
    assert.equal(validateSyncConfig({ ...valid, statusToColumn: { 7: { a: columns } } }).ok, false, JSON.stringify(columns));
  }
  assert.equal(validateSyncConfig({ ...valid, statusToColumn: { 7: { a: twenty } } }).ok, true);
});

test('normalize drops invalid column lists but keeps the valid ones', () => {
  const r = normalizeSyncConfig({ statusToColumn: { 7: { a: [], b: ['1', '1'], c: ['x'], d: ['4', '5'] } } });
  assert.deepEqual(r.statusToColumn, { 7: { d: ['4', '5'] } });
});
