import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createUiServer } from '../../src/inbound/ui-server.mjs';
import { createStartFromItem } from '../../src/usecases/start-from-item.mjs';
import { SourceError } from '../../src/adapters/basecamp-cli.mjs';
import { createSyncConfig } from '../../src/usecases/sync-config.mjs';

const TOKEN = 'b'.repeat(48);
const ITEM = {
  type: 'todo',
  id: 1,
  projectId: 7,
  projectName: 'P',
  title: 'Real title',
  description: 'Real description',
  appUrl: 'https://app.basecamp.com/a/buckets/7/todos/1'
};

function setup({ sourceError, createError } = {}) {
  const sourceCalls = [];
  const orcaCalls = [];
  const links = new Map();
  const source = {
    list: async (q) => {
      sourceCalls.push(['list', q]);
      if (sourceError) throw sourceError;
      return { items: [ITEM], notice: 'capped' };
    },
    projects: async () => {
      sourceCalls.push(['projects']);
      return [{ id: 7, name: 'P' }];
    },
    get: async (q) => {
      sourceCalls.push(['get', q]);
      return ITEM;
    },
    complete: async () => assert.fail('the picker never completes items'),
    columns: async (q) => {
      sourceCalls.push(['columns', q]);
      if (sourceError) throw sourceError;
      return [{ id: '9', name: 'Review', type: 'Kanban::Column', mappable: true }];
    }
  };
  const configStore = new Map();
  const configCalls = [];
  const syncConfig = createSyncConfig({
    storage: {
      get: async (k) => {
        configCalls.push(['get', k]);
        return configStore.get(k) ?? null;
      },
      set: async (k, v) => {
        configCalls.push(['set', k]);
        configStore.set(k, v);
      }
    }
  });
  let saved = 0;
  const onConfigSaved = () => void (saved += 1);
  const orca = {
    listRepos: async () => {
      orcaCalls.push(['listRepos']);
      return [{ id: 'r1', name: 'Repo', path: '/r' }];
    },
    createWorktree: async (args) => {
      orcaCalls.push(['createWorktree', args]);
      if (createError) throw new Error(createError);
      return { worktreeId: 'r1::/w/x' };
    },
    findWorktree: async () => null
  };
  const storage = { set: async (k, v) => links.set(k, v) };
  const startFromItem = createStartFromItem({
    source,
    orca,
    storage,
    notify: async () => {},
    clock: { now: () => 1 }
  });
  return { source, orca, startFromItem, sourceCalls, orcaCalls, links, syncConfig, configStore, configCalls, onConfigSaved, saved: () => saved };
}

const servers = [];
async function start(opts = {}) {
  const s = opts.deps ?? setup();
  const server = createUiServer({ source: s.source, orca: s.orca, startFromItem: s.startFromItem, syncConfig: s.syncConfig, onConfigSaved: s.onConfigSaved, html: '<h1>picker</h1>', token: TOKEN, ...opts.server });
  servers.push(server);
  const info = await server.start();
  return { server, s, ...info };
}
test.afterEach(async () => {
  await Promise.all(servers.splice(0).map((x) => x.stop()));
});

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const json = (r) => JSON.parse(r.text);
const get = (port, path, headers = { 'X-Token': TOKEN }) => request(port, { path, headers });
const post = (port, body, headers = {}) =>
  request(port, {
    method: 'POST',
    path: '/api/start',
    headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
const VALID = { type: 'todo', id: 1, projectId: 7, repoId: 'r1' };

// ---- 4.1 Localhost UI security

test('start returns a loopback url with the token and reuses a running server', async () => {
  const { server, url, port } = await start();
  assert.equal(url, `http://127.0.0.1:${port}/?token=${TOKEN}`);
  assert.equal((await server.start()).port, port);
});

test('the default token is random hex of at least 24 bytes and differs per server', async () => {
  const s = setup();
  const a = createUiServer({ source: s.source, orca: s.orca, startFromItem: s.startFromItem, html: '' });
  const b = createUiServer({ source: s.source, orca: s.orca, startFromItem: s.startFromItem, html: '' });
  servers.push(a, b);
  const [x, y] = [await a.start(), await b.start()];
  assert.match(x.token, /^[0-9a-f]{48,}$/);
  assert.notEqual(x.token, y.token);
});

test('GET / needs the token and serves the page with no-store and a locked-down CSP', async () => {
  const { port } = await start();
  assert.equal((await request(port, { path: '/' })).status, 403);
  assert.equal((await request(port, { path: '/?token=nope' })).status, 403);
  const ok = await request(port, { path: `/?token=${TOKEN}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '<h1>picker</h1>');
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.match(ok.headers['content-security-policy'], /default-src 'none'/);
  assert.match(ok.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('wrong token, foreign Host and foreign Origin are 403 with no source or Orca call', async () => {
  const { port, s } = await start();
  assert.equal((await get(port, '/api/repos', {})).status, 403);
  assert.equal((await get(port, '/api/items?kind=todo', { 'X-Token': 'nope' })).status, 403);
  assert.equal((await get(port, '/api/projects', { 'X-Token': TOKEN, Host: 'evil.example' })).status, 403);
  assert.equal((await post(port, VALID, { 'X-Token': 'nope' })).status, 403);
  assert.equal((await post(port, VALID, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(port, VALID, { Host: 'evil.example' })).status, 403);
  assert.deepEqual(s.sourceCalls, []);
  assert.deepEqual(s.orcaCalls, []);
});

test('the picker server binds to the loopback address only (characterization)', async () => {
  const s = setup();
  const real = http.createServer;
  let bound;
  http.createServer = (...args) => (bound = real.apply(http, args));
  try {
    const ui = createUiServer({ source: s.source, orca: s.orca, startFromItem: s.startFromItem, syncConfig: s.syncConfig, html: '', token: TOKEN });
    servers.push(ui);
    await ui.start();
  } finally {
    http.createServer = real;
  }
  assert.equal(bound.address().address, '127.0.0.1');
});

test('GET with a foreign Origin is 403 on v1 and sync routes, with no CLI or storage call', async () => {
  const { port, s } = await start();
  const evil = { 'X-Token': TOKEN, Origin: 'http://evil.example' };
  for (const path of ['/api/repos', '/api/projects', '/api/items?kind=todo', '/api/columns?projectId=7', '/api/sync-config']) {
    assert.equal((await get(port, path, evil)).status, 403, path);
  }
  assert.deepEqual(s.sourceCalls, []);
  assert.deepEqual(s.orcaCalls, []);
  assert.deepEqual(s.configCalls, []);
  const same = { 'X-Token': TOKEN, Origin: `http://localhost:${port}` };
  assert.equal((await get(port, '/api/repos', same)).status, 200);
  assert.equal((await get(port, '/api/sync-config')).status, 200);
});

test('POST needs application/json (415) and a bounded body (413)', async () => {
  const { port, s } = await start();
  assert.equal((await post(port, VALID, { 'Content-Type': 'text/plain' })).status, 415);
  const big = await post(port, JSON.stringify({ ...VALID, pad: 'x'.repeat(300 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal(json(big).ok, false);
  assert.deepEqual(s.orcaCalls, []);
  assert.equal((await post(port, VALID, { Origin: `http://127.0.0.1:${port}` })).status, 200);
});

test('unknown routes are 404 and other methods 405', async () => {
  const { port } = await start();
  assert.equal((await get(port, '/nope')).status, 404);
  assert.equal((await request(port, { method: 'DELETE', path: '/api/repos', headers: { 'X-Token': TOKEN } })).status, 405);
});

test('shuts down after the idle timeout and can be started again', async () => {
  const { server, port } = await start({ server: { idleMs: 60 } });
  assert.equal(server.isRunning(), true);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(server.isRunning(), false);
  await assert.rejects(request(port, { path: '/' }));
  assert.match((await server.start()).url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
});

// ---- read routes

test('repos, projects and items are served from the ports, with the CLI notice', async () => {
  const { port, s } = await start();
  assert.deepEqual(json(await get(port, '/api/repos')).repos, [{ id: 'r1', name: 'Repo', path: '/r' }]);
  assert.deepEqual(json(await get(port, '/api/projects')).projects, [{ id: 7, name: 'P' }]);
  const items = json(await get(port, '/api/items?kind=todo'));
  assert.equal(items.items[0].title, 'Real title');
  assert.equal(items.notice, 'capped');
  json(await get(port, '/api/items?kind=card&projectId=7'));
  assert.deepEqual(s.sourceCalls.at(-1), ['list', { kind: 'card', mine: true }]);
});

test('mine defaults to 1: to-dos and cards are asked for my items, and a card projectId is ignored', async () => {
  const { port, s } = await start();
  json(await get(port, '/api/items?kind=todo'));
  assert.deepEqual(s.sourceCalls.at(-1), ['list', { kind: 'todo', mine: true }]);
  json(await get(port, '/api/items?kind=card'));
  assert.deepEqual(s.sourceCalls.at(-1), ['list', { kind: 'card', mine: true }]);
  json(await get(port, '/api/items?kind=card&mine=1&projectId=7'));
  assert.deepEqual(s.sourceCalls.at(-1), ['list', { kind: 'card', mine: true }]);
  json(await get(port, '/api/items?kind=card&projectId=7;rm'));
  assert.deepEqual(s.sourceCalls.at(-1), ['list', { kind: 'card', mine: true }]);
});

test('mine=0 asks for everything; cards then need a numeric projectId', async () => {
  const { port, s } = await start();
  json(await get(port, '/api/items?kind=todo&mine=0'));
  assert.deepEqual(s.sourceCalls.at(-1), ['list', { kind: 'todo', mine: false }]);
  json(await get(port, '/api/items?kind=card&mine=0&projectId=7'));
  assert.deepEqual(s.sourceCalls.at(-1), ['list', { kind: 'card', mine: false, projectId: '7' }]);
  const before = s.sourceCalls.length;
  assert.equal((await get(port, '/api/items?kind=card&mine=0')).status, 400);
  assert.equal((await get(port, '/api/items?kind=card&mine=0&projectId=7;rm')).status, 400);
  assert.equal(s.sourceCalls.length, before);
});

test('any other mine value is 400 and never reaches the source', async () => {
  const { port, s } = await start();
  for (const value of ['2', 'true', '', 'yes', '01']) {
    assert.equal((await get(port, `/api/items?kind=todo&mine=${value}`)).status, 400, `mine=${value}`);
  }
  assert.deepEqual(s.sourceCalls, []);
});

test('bad item queries are 400 and never reach the source', async () => {
  const { port, s } = await start();
  assert.equal((await get(port, '/api/items?kind=other')).status, 400);
  assert.deepEqual(s.sourceCalls, []);
});

test('a SourceError becomes a 502 carrying error, hint and retryable (not retried)', async () => {
  const sourceError = new SourceError({ code: 'auth', message: 'Not logged in', hint: 'run basecamp auth login', retryable: true });
  const deps = setup({ sourceError });
  const { port } = await start({ deps });
  const r = await get(port, '/api/items?kind=todo');
  assert.equal(r.status, 502);
  assert.deepEqual(json(r), { ok: false, error: 'Not logged in', hint: 'run basecamp auth login', code: 'auth', retryable: true });
  assert.equal(deps.sourceCalls.length, 1);
});

// ---- 4.2 /api/start validation and refetch

test('start refetches the item and ignores client title, prompt and comment', async () => {
  const { port, s } = await start();
  const r = await post(port, { ...VALID, agent: 'claude', title: 'EVIL', prompt: 'rm -rf', comment: 'EVIL', name: 'EVIL' });
  assert.equal(r.status, 200);
  assert.deepEqual(json(r), { ok: true, status: 'linked', worktreeId: 'r1::/w/x', name: 'bc-1-real-title' });
  assert.deepEqual(s.sourceCalls[0], ['get', { type: 'todo', id: '1', projectId: '7' }]);
  const [, created] = s.orcaCalls.find(([n]) => n === 'createWorktree');
  assert.equal(created.repoId, 'r1');
  assert.equal(created.agent, 'claude');
  assert.equal(created.comment, `Real title ${ITEM.appUrl}`);
  assert.ok(created.prompt.includes('Real description'));
  assert.ok(!JSON.stringify(created).includes('EVIL'));
  assert.ok(s.links.has('link:r1::/w/x'));
});

test('missing or unknown repoId, bad agent and bad ids are 400 and create nothing', async () => {
  const { port, s } = await start();
  const bad = [
    { ...VALID, repoId: undefined },
    { ...VALID, repoId: 'other' },
    { ...VALID, agent: 'a b' },
    { ...VALID, agent: 'x'.repeat(41) },
    { ...VALID, agent: '--flag;x' },
    { ...VALID, id: '1;2' },
    { ...VALID, projectId: 'abc' },
    { ...VALID, type: 'project' }
  ];
  for (const body of bad) assert.equal((await post(port, body)).status, 400, JSON.stringify(body));
  assert.equal((await post(port, '{nope')).status, 400);
  assert.equal(s.orcaCalls.filter(([n]) => n === 'createWorktree').length, 0);
  assert.equal(s.sourceCalls.length, 0);
  assert.equal(s.links.size, 0);
});

test('a failed start is a 502 with the error and stores no link', async () => {
  const deps = setup({ createError: 'orca down' });
  const { port } = await start({ deps });
  const r = await post(port, VALID);
  assert.equal(r.status, 502);
  assert.deepEqual(json(r), { ok: false, error: 'orca down' });
  assert.equal(deps.links.size, 0);
});

test('an unlinked start is 200 with status unlinked', async () => {
  const deps = setup();
  deps.orca.createWorktree = async () => ({});
  const { port } = await start({ deps });
  const r = await post(port, VALID);
  assert.equal(r.status, 200);
  assert.equal(json(r).status, 'unlinked');
});

// ---- sync routes

const postTo = (port, path, body, headers = {}) =>
  request(port, {
    method: 'POST',
    path,
    headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
const CONFIG = { enabled: true, conflictRule: 'basecamp-wins', statusToColumn: { 7: { 'in-review': ['9'] } } };

test('GET /api/columns returns the columns of a numeric project, no-store', async () => {
  const { port, s } = await start();
  const r = await get(port, '/api/columns?projectId=7');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(json(r).columns, [{ id: '9', name: 'Review', type: 'Kanban::Column', mappable: true }]);
  assert.deepEqual(s.sourceCalls.at(-1), ['columns', { projectId: '7' }]);
});

test('GET /api/columns rejects a missing or non-numeric projectId with 400 and no CLI call', async () => {
  const { port, s } = await start();
  for (const q of ['', '?projectId=', '?projectId=7;rm', '?projectId=-1', '?projectId=a']) {
    assert.equal((await get(port, `/api/columns${q}`)).status, 400, q);
  }
  assert.deepEqual(s.sourceCalls, []);
});

test('a columns CLI error (for example several card tables) is a 502 with hint and code', async () => {
  const sourceError = new SourceError({ code: 'ambiguous', message: 'Multiple card tables', hint: 'use --card-table' });
  const { port } = await start({ deps: setup({ sourceError }) });
  const r = await get(port, '/api/columns?projectId=7');
  assert.equal(r.status, 502);
  assert.equal(json(r).error, 'Multiple card tables');
  assert.equal(json(r).hint, 'use --card-table');
  assert.equal(json(r).code, 'ambiguous');
});

test('GET /api/sync-config returns the defaults when nothing is stored', async () => {
  const { port } = await start();
  const r = await get(port, '/api/sync-config');
  assert.equal(r.status, 200);
  assert.deepEqual(json(r).config, { enabled: true, conflictRule: 'orca-wins', statusToColumn: {} });
});

test('POST /api/sync-config stores the config, returns it and calls onConfigSaved', async () => {
  const { port, s } = await start();
  const r = await postTo(port, '/api/sync-config', CONFIG);
  assert.equal(r.status, 200);
  assert.deepEqual(json(r).config, CONFIG);
  assert.deepEqual(s.configStore.get('sync:config'), CONFIG);
  assert.equal(s.saved(), 1);
  assert.deepEqual(json(await get(port, '/api/sync-config')).config, CONFIG);
});

test('invalid sync configs are 400 and leave storage untouched', async () => {
  const { port, s } = await start();
  const bad = [
    { ...CONFIG, conflictRule: 'newest-wins' },
    { ...CONFIG, enabled: 'yes' },
    { ...CONFIG, statusToColumn: { 7: { completed: '9' } } },
    { ...CONFIG, statusToColumn: { 7: { 'in-review': 'Review' } } },
    { ...CONFIG, statusToColumn: { abc: { 'in-review': '9' } } },
    '{"enabled":true,"conflictRule":"orca-wins","statusToColumn":{"__proto__":{"a":"1"}}}',
    '{nope',
    '[]'
  ];
  for (const body of bad) assert.equal((await postTo(port, '/api/sync-config', body)).status, 400, JSON.stringify(body));
  assert.equal(s.configStore.size, 0);
  assert.equal(s.saved(), 0);
  assert.equal(Object.prototype.polluted, undefined);
});

test('sync routes: wrong token, Host or Origin are 403 with no CLI or storage call', async () => {
  const { port, s } = await start();
  assert.equal((await get(port, '/api/columns?projectId=7', {})).status, 403);
  assert.equal((await get(port, '/api/sync-config', { 'X-Token': 'nope' })).status, 403);
  assert.equal((await get(port, '/api/sync-config', { 'X-Token': TOKEN, Host: 'evil.example' })).status, 403);
  assert.equal((await postTo(port, '/api/sync-config', CONFIG, { 'X-Token': 'nope' })).status, 403);
  assert.equal((await postTo(port, '/api/sync-config', CONFIG, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await postTo(port, '/api/sync-config', CONFIG, { Host: 'evil.example' })).status, 403);
  assert.deepEqual(s.sourceCalls, []);
  assert.deepEqual(s.configCalls, []);
  assert.equal(s.saved(), 0);
});

test('POST /api/sync-config needs application/json (415), a bounded body (413) and the right method', async () => {
  const { port, s } = await start();
  assert.equal((await postTo(port, '/api/sync-config', CONFIG, { 'Content-Type': 'text/plain' })).status, 415);
  const big = await postTo(port, '/api/sync-config', JSON.stringify({ ...CONFIG, pad: 'x'.repeat(300 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal(json(big).ok, false);
  assert.equal((await request(port, { method: 'PUT', path: '/api/sync-config', headers: { 'X-Token': TOKEN } })).status, 405);
  assert.equal((await request(port, { method: 'POST', path: '/api/columns', headers: { 'X-Token': TOKEN } })).status, 405);
  assert.equal(s.configStore.size, 0);
});

test('a storage failure while saving is a 502 and onConfigSaved is not called', async () => {
  const deps = setup();
  deps.syncConfig.save = async () => {
    throw new Error('host gone');
  };
  const { port } = await start({ deps });
  const r = await postTo(port, '/api/sync-config', CONFIG);
  assert.equal(r.status, 502);
  assert.equal(deps.saved(), 0);
});

test('POST /api/sync-config accepts several columns per status and GET returns the arrays', async () => {
  const { port, s } = await start();
  const body = { ...CONFIG, statusToColumn: { 7: { todo: ['8', '12'], 'in-review': ['9'] } } };
  const r = await postTo(port, '/api/sync-config', body);
  assert.equal(r.status, 200);
  assert.deepEqual(s.configStore.get('sync:config'), body);
  assert.deepEqual(json(await get(port, '/api/sync-config')).config, body);
});

test('POST /api/sync-config normalizes the legacy string form to arrays', async () => {
  const { port, s } = await start();
  const r = await postTo(port, '/api/sync-config', { ...CONFIG, statusToColumn: { 7: { todo: '8' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(json(r).config.statusToColumn, { 7: { todo: ['8'] } });
  assert.deepEqual(s.configStore.get('sync:config').statusToColumn, { 7: { todo: ['8'] } });
});

test('POST /api/sync-config rejects bad column lists with 400 and leaves storage untouched', async () => {
  const { port, s } = await start();
  const twentyOne = Array.from({ length: 21 }, (_, i) => String(i + 1));
  for (const columns of [[], ['8', '8'], ['8', 'x'], twentyOne]) {
    const r = await postTo(port, '/api/sync-config', { ...CONFIG, statusToColumn: { 7: { todo: columns } } });
    assert.equal(r.status, 400, JSON.stringify(columns));
  }
  assert.equal(s.configStore.size, 0);
  assert.equal(s.saved(), 0);
});
