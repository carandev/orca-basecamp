import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkExisting } from '../../src/usecases/link-existing.mjs';
import { resolveLinked } from '../../src/usecases/resolve-linked.mjs';
import { parseLink } from '../../src/domain/link.mjs';

const ITEM = {
  type: 'todo',
  id: 5,
  projectId: 7,
  title: 'Fix login',
  state: 'open',
  appUrl: 'https://app.basecamp.com/a/buckets/7/todos/5'
};
const REQUEST = { worktreeId: 'wt-1', displayName: 'my-tree', type: 'todo', id: '5', projectId: '7' };

function setup({ links = {}, getError, setError, statusCalls = [] } = {}) {
  const store = new Map(Object.entries(links));
  const notes = [];
  const gets = [];
  const writes = [];
  const linkExisting = createLinkExisting({
    source: {
      get: async (q) => {
        gets.push(q);
        if (getError) throw getError;
        return ITEM;
      }
    },
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => {
        if (setError) throw setError;
        writes.push([k, v]);
        store.set(k, v);
      }
    },
    notify: async (title, body) => notes.push([title, body]),
    clock: { now: () => 42 }
  });
  return { linkExisting, store, notes, gets, writes };
}

test('links the refetched item as a v2 record without a sync baseline and notifies', async () => {
  const s = setup();
  const result = await s.linkExisting(REQUEST);
  assert.deepEqual(result, { status: 'linked', title: 'Fix login' });
  assert.deepEqual(s.gets, [{ type: 'todo', id: '5', projectId: '7' }]);
  assert.deepEqual(s.writes, [
    ['link:wt-1', { v: 2, type: 'todo', id: 5, projectId: 7, appUrl: ITEM.appUrl, title: 'Fix login', createdAt: 42 }]
  ]);
  assert.equal('sync' in s.writes[0][1], false);
  assert.deepEqual(s.notes.at(-1)[1], 'Linked Fix login to my-tree');
});

test('replacing an existing link notifies the replaced item first', async () => {
  const old = { v: 1, type: 'card', id: 3, projectId: 7, appUrl: 'https://x/3', title: 'Old card', createdAt: 1 };
  const s = setup({ links: { 'link:wt-1': old } });
  assert.equal((await s.linkExisting(REQUEST)).status, 'linked');
  assert.equal(s.notes.length, 2);
  assert.match(s.notes[0][1], /Old card/);
  assert.equal(s.store.get('link:wt-1').title, 'Fix login');
});

test('a source failure writes nothing and reports the failure', async () => {
  const error = Object.assign(new Error('nope'), { hint: 'try later' });
  const s = setup({ getError: error });
  assert.deepEqual(await s.linkExisting(REQUEST), { status: 'failed', error: 'nope', hint: 'try later' });
  assert.equal(s.writes.length, 0);
  assert.equal(s.notes.length, 1);
});

test('a storage failure is reported as a failure', async () => {
  const s = setup({ setError: new Error('disk') });
  const result = await s.linkExisting(REQUEST);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /disk/);
});

test('a worktree linked this way resolves through resolveLinked, as a v2 link with no baseline', async () => {
  const s = setup();
  await s.linkExisting(REQUEST);
  const resolved = await resolveLinked({
    orca: { resolveActiveWorktree: async () => ({ worktreeId: 'wt-1', worktreePath: '/w' }) },
    storage: { get: async (k) => s.store.get(k) ?? null }
  });
  assert.equal(resolved.worktreeId, 'wt-1');
  assert.equal(resolved.link.title, 'Fix login');
  assert.deepEqual(resolved.link, parseLink(resolved.link));
  assert.equal(resolved.link.sync, undefined);
});
