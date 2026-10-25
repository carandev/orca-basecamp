import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnRemoved } from '../../src/usecases/on-removed.mjs';
import { listItems, listProjects } from '../../src/usecases/list-items.mjs';

const APP_URL = 'https://app.basecamp.com/999/buckets/7/todos/1';
const LINK = { v: 1, type: 'todo', id: 1, projectId: 7, appUrl: APP_URL, title: 'Fix login', createdAt: 1 };

function setup({ links = { 'link:wt-1': LINK }, complete, getError, deleteError, notifyError } = {}) {
  const log = { completes: [], notices: [], deletes: [], reads: [] };
  const store = new Map(Object.entries(links));
  const deps = {
    storage: {
      get: async (k) => {
        log.reads.push(k);
        if (getError) throw getError;
        return store.get(k) ?? null;
      },
      delete: async (k) => {
        log.deletes.push(k);
        if (deleteError) throw deleteError;
        store.delete(k);
      }
    },
    source: {
      complete: async (q) => {
        log.completes.push(q);
        if (typeof complete === 'function') return complete(q);
        return complete ?? { status: 'completed' };
      }
    },
    notify: async (title, body) => {
      log.notices.push({ title, body });
      if (notifyError) throw notifyError;
    }
  };
  return { deps, log, store, handle: createOnRemoved(deps) };
}

test('a linked removal completes the item once and deletes the link', async () => {
  const { handle, log, store } = setup();
  await handle({ worktreeId: 'wt-1', path: '/w/1' });
  assert.deepEqual(log.completes, [{ type: 'todo', id: 1, projectId: 7 }]);
  assert.equal(store.has('link:wt-1'), false);
  assert.equal(log.notices.length, 1);
});

test('removal with sync disabled still completes the item once and deletes the link, ignoring the sync config', async () => {
  const synced = { ...LINK, v: 2, sync: { orca: 'in-progress', bc: 'open', at: 5 } };
  const { handle, log, store } = setup({
    links: { 'link:wt-1': synced, 'sync:config': { enabled: false, conflictRule: 'orca-wins', statusToColumn: {} } }
  });
  await handle({ worktreeId: 'wt-1', path: '/w/1' });
  assert.deepEqual(log.completes, [{ type: 'todo', id: 1, projectId: 7 }]);
  assert.deepEqual(log.reads, ['link:wt-1']);
  assert.equal(store.has('link:wt-1'), false);
  assert.equal(log.notices.length, 1);
});

test('a removed link stays removed when a sync pass runs afterwards', async () => {
  const { createSyncLinks } = await import('../../src/usecases/sync-links.mjs');
  const { deps, store, handle } = setup();
  await handle({ worktreeId: 'wt-1' });
  const sync = createSyncLinks({
    storage: { ...deps.storage, keys: async () => [...store.keys()], set: async (k, v) => void store.set(k, v) },
    source: { state: async () => 'completed' },
    orca: { listWorktreeStatuses: async () => ({ statuses: new Map([['wt-1', 'in-progress']]), truncated: false }) },
    notify: deps.notify,
    clock: { now: () => 1 }
  });
  await sync.tick();
  assert.equal(store.has('link:wt-1'), false);
});

test('an unlinked removal does nothing: no spawn, no notice, no delete', async () => {
  const { handle, log } = setup({ links: {} });
  await handle({ worktreeId: 'wt-9', path: '/w/9' });
  assert.deepEqual(log.completes, []);
  assert.deepEqual(log.notices, []);
  assert.deepEqual(log.deletes, []);
});

test('a corrupt link record is treated as unlinked', async () => {
  const { handle, log } = setup({ links: { 'link:wt-1': { v: 7 } } });
  await handle({ worktreeId: 'wt-1' });
  assert.deepEqual(log.completes, []);
  assert.deepEqual(log.notices, []);
});

test('already completed and inaccessible notify, delete the link and never throw', async () => {
  for (const status of ['already', 'inaccessible']) {
    const { handle, log, store } = setup({ complete: { status } });
    await handle({ worktreeId: 'wt-1' });
    assert.equal(log.completes.length, 1);
    assert.equal(log.notices.length, 1);
    assert.equal(store.has('link:wt-1'), false);
  }
});

test('a retryable failure is spawned once, notified with title and appUrl, and the link is still deleted', async () => {
  const error = Object.assign(new Error('busy'), { code: 'rate_limit', hint: 'later', retryable: true });
  const { handle, log, store } = setup({
    complete: () => {
      throw error;
    }
  });
  await handle({ worktreeId: 'wt-1' });
  assert.equal(log.completes.length, 1);
  assert.equal(store.has('link:wt-1'), false);
  const body = log.notices[0].body;
  assert.match(body, /busy/);
  assert.match(body, /later/);
  assert.ok(body.includes('Fix login'));
  assert.ok(body.includes(APP_URL));
});

test('the handler never throws, even when storage and notifications fail', async () => {
  const a = setup({ getError: new Error('storage down') });
  await assert.doesNotReject(a.handle({ worktreeId: 'wt-1' }));
  const b = setup({ deleteError: new Error('cannot delete'), notifyError: new Error('no ui') });
  await assert.doesNotReject(b.handle({ worktreeId: 'wt-1' }));
  assert.equal(b.log.completes.length, 1);
});

test('a missing worktreeId is ignored', async () => {
  const { handle, log } = setup();
  await handle({});
  await handle(undefined);
  assert.deepEqual(log.completes, []);
});

// ---- list-items ------------------------------------------------------------

test('listItems asks for the account-wide to-dos and ignores a stray projectId', async () => {
  const calls = [];
  const source = { list: async (q) => (calls.push(q), { items: [{ id: 1 }], notice: 'capped' }) };
  assert.deepEqual(await listItems({ source, kind: 'todo', projectId: 7 }), { items: [{ id: 1 }], notice: 'capped' });
  assert.deepEqual(calls, [{ kind: 'todo' }]);
});

test('listItems passes the project for cards and rejects a missing one without calling the source', async () => {
  const calls = [];
  const source = { list: async (q) => (calls.push(q), { items: [] }) };
  await listItems({ source, kind: 'card', projectId: '7' });
  assert.deepEqual(calls, [{ kind: 'card', projectId: '7' }]);
  await assert.rejects(listItems({ source, kind: 'card' }), /projectId/);
  await assert.rejects(listItems({ source, kind: 'doc' }), /kind/);
  assert.equal(calls.length, 1);
});

test('listProjects delegates to the source', async () => {
  const source = { projects: async () => [{ id: 7, name: 'P' }] };
  assert.deepEqual(await listProjects({ source }), [{ id: 7, name: 'P' }]);
});
