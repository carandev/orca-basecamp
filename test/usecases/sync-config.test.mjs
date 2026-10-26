import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncConfig, SYNC_CONFIG_KEY } from '../../src/usecases/sync-config.mjs';

function setup(initial) {
  const store = new Map(initial === undefined ? [] : [[SYNC_CONFIG_KEY, initial]]);
  const sets = [];
  const storage = {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      sets.push(k);
      store.set(k, v);
    }
  };
  return { store, sets, config: createSyncConfig({ storage }) };
}

test('the key is sync:config', () => {
  assert.equal(SYNC_CONFIG_KEY, 'sync:config');
});

test('get returns the defaults when nothing is stored', async () => {
  const { config } = setup();
  assert.deepEqual(await config.get(), { enabled: true, conflictRule: 'orca-wins', removeOnComplete: false, statusToColumn: {} });
});

test('get returns a stored config and repairs a damaged one', async () => {
  const good = { enabled: false, conflictRule: 'basecamp-wins', removeOnComplete: false, statusToColumn: { 7: { 'in-review': ['9'] } } };
  assert.deepEqual(await setup(good).config.get(), good);
  assert.deepEqual(await setup({ enabled: 'yes', conflictRule: 'x' }).config.get(), {
    enabled: true,
    conflictRule: 'orca-wins',
    removeOnComplete: false,
    statusToColumn: {}
  });
});

test('save stores a valid config under sync:config and get reads it back', async () => {
  const { config, store } = setup();
  const body = { enabled: false, conflictRule: 'basecamp-wins', removeOnComplete: false, statusToColumn: { 7: { 'in-review': ['9'] } } };
  const result = await config.save(body);
  assert.deepEqual(result, { ok: true, value: body });
  assert.deepEqual(store.get('sync:config'), body);
  assert.deepEqual(await config.get(), body);
});

test('save rejects invalid values and leaves storage untouched', async () => {
  for (const body of [
    { enabled: true, conflictRule: 'newest-wins', statusToColumn: {} },
    { enabled: 'true', conflictRule: 'orca-wins', statusToColumn: {} },
    { enabled: true, conflictRule: 'orca-wins', statusToColumn: { 7: { completed: '9' } } }
  ]) {
    const { config, sets } = setup();
    const result = await config.save(body);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(sets, []);
  }
});
