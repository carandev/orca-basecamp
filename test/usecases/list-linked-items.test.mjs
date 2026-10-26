import test from 'node:test';
import assert from 'node:assert/strict';
import { listLinkedItems } from '../../src/usecases/list-linked-items.mjs';

function makeStorage(entries = {}) {
  return {
    keys: async () => Object.keys(entries),
    get: async (k) => entries[k] ?? null
  };
}

const LINK = { v: 1, type: 'todo', id: 1, projectId: 7, appUrl: 'https://a', title: 'T', createdAt: 1 };

test('returns an empty array when there are no link keys', async () => {
  const result = await listLinkedItems({ storage: makeStorage({ 'sync-config': { enabled: true } }) });
  assert.deepEqual(result, []);
});

test('returns {type, id} for each valid link record', async () => {
  const storage = makeStorage({
    'link:w1': LINK,
    'link:w2': { ...LINK, type: 'card', id: 2 }
  });
  const result = await listLinkedItems({ storage });
  assert.deepEqual(result.sort((a, b) => a.id - b.id), [
    { type: 'todo', id: 1 },
    { type: 'card', id: 2 }
  ]);
});

test('skips non-link keys', async () => {
  const storage = makeStorage({ 'sync-config': { enabled: true }, 'link:w1': LINK });
  const result = await listLinkedItems({ storage });
  assert.deepEqual(result, [{ type: 'todo', id: 1 }]);
});

test('skips invalid link records without throwing', async () => {
  const storage = makeStorage({ 'link:bad': { v: 99, type: 'todo' }, 'link:w1': LINK });
  const result = await listLinkedItems({ storage });
  assert.deepEqual(result, [{ type: 'todo', id: 1 }]);
});

test('returns empty array when storage.keys throws', async () => {
  const storage = { keys: async () => { throw new Error('fail'); }, get: async () => null };
  const result = await listLinkedItems({ storage });
  assert.deepEqual(result, []);
});

test('skips entries where storage.get throws', async () => {
  const storage = {
    keys: async () => ['link:w1', 'link:w2'],
    get: async (k) => { if (k === 'link:w1') throw new Error('fail'); return LINK; }
  };
  const result = await listLinkedItems({ storage });
  assert.deepEqual(result, [{ type: 'todo', id: 1 }]);
});
