import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartFromItem } from '../../src/usecases/start-from-item.mjs';

const APP_URL = 'https://app.basecamp.com/999/buckets/7/todos/1';
const ITEM = {
  type: 'todo', id: 1, projectId: 7, projectName: 'P', title: 'Fix: Login Bug', description: 'Steps "here" & more', appUrl: APP_URL, state: 'open'
};
const REQUEST = { type: 'todo', id: 1, projectId: 7, repoId: 'r1', agent: 'claude' };

const SYNC_OFF = { enabled: false, conflictRule: 'orca-wins', statusToColumn: {} };
const SYNC_ON = { enabled: true, conflictRule: 'orca-wins', statusToColumn: {} };

function setup({
  item = ITEM,
  created = { worktreeId: 'wt-1', path: '/w/1' },
  found = null,
  getError,
  createError,
  setError,
  syncConfig = SYNC_OFF,
  setStatusError,
  advance = {}
} = {}) {
  const log = { get: [], create: [], find: [], notices: [], statusSets: [] };
  const store = new Map();
  const time = { now: 1700000000000 };
  const deps = {
    source: {
      get: async (q) => {
        log.get.push(q);
        time.now += advance.get ?? 0;
        if (getError) throw getError;
        return item;
      }
    },
    orca: {
      createWorktree: async (a) => {
        log.create.push(a);
        time.now += advance.create ?? 0;
        if (createError) throw createError;
        return created;
      },
      setStatus: async (id, status, options) => {
        log.statusSets.push([id, status, options]);
        if (setStatusError) throw setStatusError;
      },
      findWorktree: async (a) => {
        log.find.push(a);
        return found;
      }
    },
    storage: {
      set: async (k, v) => {
        if (setError) throw setError;
        store.set(k, v);
      }
    },
    notify: async (title, body) => void log.notices.push({ title, body }),
    loadSyncConfig: async () => syncConfig,
    clock: { now: () => time.now }
  };
  return { deps, log, store, start: createStartFromItem(deps) };
}

test('creates the worktree with name, repo, comment, agent and prompt, then stores the link', async () => {
  const { start, log, store } = setup();
  const result = await start(REQUEST);
  assert.deepEqual(log.get, [{ type: 'todo', id: 1, projectId: 7 }]);
  assert.deepEqual(log.create, [
    {
      repoId: 'r1',
      name: 'bc-1-fix-login-bug',
      comment: `Fix: Login Bug ${APP_URL}`,
      agent: 'claude',
      prompt: 'Fix: Login Bug\n\nSteps "here" & more'
    }
  ]);
  assert.deepEqual(store.get('link:wt-1'), {
    v: 1, type: 'todo', id: 1, projectId: 7, appUrl: APP_URL, title: 'Fix: Login Bug', createdAt: 1700000000000
  });
  assert.deepEqual(result, { status: 'linked', worktreeId: 'wt-1', name: 'bc-1-fix-login-bug' });
  assert.equal(log.notices.length, 1);
});

test('the prompt is exactly the title when the description is empty', async () => {
  const { start, log } = setup({ item: { ...ITEM, description: '' } });
  await start({ ...REQUEST, agent: undefined });
  assert.equal(log.create[0].prompt, 'Fix: Login Bug');
  assert.equal(log.create[0].agent, undefined);
});

test('the item always comes from a refetch, never from the request', async () => {
  const { start, log } = setup();
  await start({ ...REQUEST, title: 'EVIL', prompt: 'rm -rf', description: 'x' });
  assert.equal(log.create[0].name, 'bc-1-fix-login-bug');
  assert.equal(log.create[0].prompt.includes('EVIL'), false);
  assert.equal(log.create[0].prompt.includes('rm -rf'), false);
});

test('without a worktree id in the create result it falls back to a worktree lookup', async () => {
  const { start, log, store } = setup({ created: { path: '/w/1' }, found: 'wt-found' });
  const result = await start(REQUEST);
  assert.deepEqual(log.find, [{ name: 'bc-1-fix-login-bug', path: '/w/1' }]);
  assert.equal(store.has('link:wt-found'), true);
  assert.equal(result.status, 'linked');
  assert.equal(result.worktreeId, 'wt-found');
});

test('created but not linked when the id cannot be found', async () => {
  const { start, log, store } = setup({ created: {}, found: null });
  const result = await start(REQUEST);
  assert.equal(result.status, 'unlinked');
  assert.equal(store.size, 0);
  assert.match(log.notices[0].body, /created but not linked/i);
  assert.ok(log.notices[0].body.includes(APP_URL));
});

test('a storage failure leaves the worktree created but not linked', async () => {
  const { start, log } = setup({ setError: new Error('quota') });
  const result = await start(REQUEST);
  assert.equal(result.status, 'unlinked');
  assert.match(log.notices[0].body, /created but not linked/i);
});

test('create failure stores no link, reports the error, touches nothing in Basecamp', async () => {
  const { start, log, store } = setup({ createError: new Error('orca refused') });
  const result = await start(REQUEST);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /orca refused/);
  assert.equal(store.size, 0);
  assert.equal(log.notices.length, 1);
  assert.match(log.notices[0].body, /orca refused/);
});

test('a Basecamp read failure creates nothing and carries the hint', async () => {
  const error = Object.assign(new Error('not signed in'), { code: 'auth', hint: 'run basecamp auth login' });
  const { start, log, store } = setup({ getError: error });
  const result = await start(REQUEST);
  assert.equal(result.status, 'failed');
  assert.equal(result.hint, 'run basecamp auth login');
  assert.equal(log.create.length, 0);
  assert.equal(store.size, 0);
});

test('a second start of the same item while one is running is refused, then allowed again', async () => {
  const { deps, log, store } = setup();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slowGet = deps.source.get;
  deps.source.get = async (q) => {
    await gate;
    return slowGet(q);
  };
  const start = createStartFromItem(deps);
  const first = start(REQUEST);
  const second = await start(REQUEST);
  assert.equal(second.status, 'in_flight');
  release();
  assert.equal((await first).status, 'linked');
  assert.equal(log.create.length, 1);
  assert.equal((await start(REQUEST)).status, 'linked');
  assert.equal(log.create.length, 2);
  assert.equal(store.size, 1);
});

test('the in-flight guard is released after a failure', async () => {
  const { deps } = setup({ createError: new Error('x') });
  const start = createStartFromItem(deps);
  assert.equal((await start(REQUEST)).status, 'failed');
  assert.equal((await start(REQUEST)).status, 'failed');
});

// ---- initial status (status sync) -------------------------------------------

const CREATED_AT = 1700000000000;

test('sync on: an open to-do is set to in-progress after create and the baseline is stored', async () => {
  const { start, log, store } = setup({ syncConfig: SYNC_ON });
  const result = await start(REQUEST);
  assert.deepEqual(log.statusSets, [['wt-1', 'in-progress', { timeoutMs: 10_000 }]]);
  assert.deepEqual(store.get('link:wt-1'), {
    v: 2, type: 'todo', id: 1, projectId: 7, appUrl: APP_URL, title: 'Fix: Login Bug', createdAt: CREATED_AT,
    sync: { orca: 'in-progress', bc: 'open', at: CREATED_AT, lastOpenOrca: 'in-progress' }
  });
  assert.equal(result.status, 'linked');
});

test('sync on: a completed to-do is set to completed', async () => {
  const { start, log, store } = setup({ syncConfig: SYNC_ON, item: { ...ITEM, state: 'completed' } });
  await start(REQUEST);
  assert.deepEqual(log.statusSets.map((c) => c.slice(0, 2)), [['wt-1', 'completed']]);
  assert.deepEqual(store.get('link:wt-1').sync, { orca: 'completed', bc: 'completed', at: CREATED_AT });
});

test('sync off: no worktree set and no baseline', async () => {
  const { start, log, store } = setup({ syncConfig: SYNC_OFF });
  await start(REQUEST);
  assert.deepEqual(log.statusSets, []);
  assert.equal(store.get('link:wt-1').v, 1);
  assert.equal('sync' in store.get('link:wt-1'), false);
});

test('a failing set notifies, stores the link without a baseline and still resolves linked', async () => {
  const { start, log, store } = setup({ syncConfig: SYNC_ON, setStatusError: new Error('orca timed out') });
  const result = await start(REQUEST);
  assert.equal(result.status, 'linked');
  assert.equal('sync' in store.get('link:wt-1'), false);
  assert.equal(log.notices.length, 2);
  assert.ok(log.notices.some((n) => /orca timed out/.test(n.body)));
});

test('the set gets min(10 s, 28 s - elapsed): 3 s left after 25 s of get and create', async () => {
  const { start, log } = setup({ syncConfig: SYNC_ON, advance: { get: 15_000, create: 10_000 } });
  await start(REQUEST);
  assert.deepEqual(log.statusSets, [['wt-1', 'in-progress', { timeoutMs: 3_000 }]]);
});

test('the set is skipped with a notice and no baseline when less than 2 s remain', async () => {
  const { start, log, store } = setup({ syncConfig: SYNC_ON, advance: { get: 15_000, create: 12_000 } });
  const result = await start(REQUEST);
  assert.deepEqual(log.statusSets, []);
  assert.equal(result.status, 'linked');
  assert.equal('sync' in store.get('link:wt-1'), false);
  assert.equal(log.notices.length, 2);
});

test('card: the first status mapped to its column is set, and a Done card is completed', async () => {
  const map = { 7: { todo: ['8'], 'in-review': ['9'], 'also-review': ['9'] } };
  const config = { ...SYNC_ON, statusToColumn: map };
  const mapped = setup({ syncConfig: config, item: { ...ITEM, type: 'card', state: '9' } });
  await mapped.start({ ...REQUEST, type: 'card' });
  assert.deepEqual(mapped.log.statusSets.map((c) => c.slice(0, 2)), [['wt-1', 'in-review']]);
  assert.deepEqual(mapped.store.get('link:wt-1').sync, { orca: 'in-review', bc: '9', at: CREATED_AT, lastOpenOrca: 'in-review' });

  const done = setup({ syncConfig: config, item: { ...ITEM, type: 'card', state: 'completed' } });
  await done.start({ ...REQUEST, type: 'card' });
  assert.deepEqual(done.log.statusSets.map((c) => c.slice(0, 2)), [['wt-1', 'completed']]);
});

test('card in an unmapped column: no set, no baseline', async () => {
  const config = { ...SYNC_ON, statusToColumn: { 7: { todo: ['8'] } } };
  const { start, log, store } = setup({ syncConfig: config, item: { ...ITEM, type: 'card', state: '5' } });
  const result = await start({ ...REQUEST, type: 'card' });
  assert.deepEqual(log.statusSets, []);
  assert.equal('sync' in store.get('link:wt-1'), false);
  assert.equal(result.status, 'linked');
});

test('card in the 2nd column of a status starts with that status', async () => {
  const config = { ...SYNC_ON, statusToColumn: { 7: { todo: ['8', '12'], 'in-review': ['9'] } } };
  const { start, log, store } = setup({ syncConfig: config, item: { ...ITEM, type: 'card', state: '12' } });
  await start({ ...REQUEST, type: 'card' });
  assert.deepEqual(log.statusSets.map((c) => c.slice(0, 2)), [['wt-1', 'todo']]);
  assert.equal(store.get('link:wt-1').sync.orca, 'todo');
});
