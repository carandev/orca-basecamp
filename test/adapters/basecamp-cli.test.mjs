import test from 'node:test';
import assert from 'node:assert/strict';
import { createBasecampSource, SourceError } from '../../src/adapters/basecamp-cli.mjs';

const CONFIG_FILE = '/cfg/orca-basecamp/config.json';
const APP_TODO = 'https://app.basecamp.com/999/buckets/7/todos/1';
const APP_CARD = 'https://app.basecamp.com/999/buckets/7/card_tables/cards/55';

const reply = (value, extra = {}) => ({
  stdout: typeof value === 'string' ? value : JSON.stringify(value),
  stderr: '',
  code: 0,
  timedOut: false,
  ...extra
});

/** Scripted spawner: replies in order (the last reply repeats) and records every call. */
function scripted(...replies) {
  const calls = [];
  return {
    calls,
    run: async (file, args, opts) => {
      calls.push({ file, args, opts });
      return replies[Math.min(calls.length, replies.length) - 1];
    }
  };
}

const source = (spawner, config = { basecampEnv: {} }, env = { PATH: '/bin', USERPROFILE: '/u' }) =>
  createBasecampSource({ spawner, config, env, configFile: CONFIG_FILE });

const todo = (over = {}) => ({
  id: 1,
  title: 'T',
  content: 'T',
  description: '<p>Fix <b>login</b></p>',
  app_url: APP_TODO,
  url: 'https://3.basecampapi.com/999/buckets/7/todos/1.json',
  completed: false,
  parent: { id: 3, title: 'List', type: 'Todolist', app_url: 'x', url: 'y' },
  bucket: { id: 7, name: 'P', type: 'Project' },
  type: 'Todo',
  ...over
});

const card = (over = {}) => ({
  id: 55,
  title: 'Card',
  app_url: APP_CARD,
  completed: false,
  parent: { id: 9, title: 'Col', type: 'Kanban::NotNowColumn', app_url: 'x', url: 'y' },
  bucket: { id: 7, name: 'P', type: 'Project' },
  type: 'Kanban::Card',
  ...over
});

// ---- 2.4: exact argv -------------------------------------------------------

test('argv: list to-dos account-wide', async () => {
  const sp = scripted(reply({ ok: true, data: [] }));
  await source(sp).list({ kind: 'todo' });
  assert.equal(sp.calls.length, 1);
  assert.equal(sp.calls[0].file, 'basecamp');
  assert.deepEqual(sp.calls[0].args, ['todos', 'list', '--all-projects', '--json']);
});

test('argv: list projects', async () => {
  const sp = scripted(reply({ ok: true, data: [] }));
  await source(sp).projects();
  assert.deepEqual(sp.calls[0].args, ['projects', 'list', '--json']);
});

test('argv: list cards has no --limit', async () => {
  const sp = scripted(reply({ ok: true, data: [] }));
  await source(sp).list({ kind: 'card', projectId: 7 });
  assert.deepEqual(sp.calls[0].args, ['cards', 'list', '--in', '7', '--json']);
});

test('argv: get to-do and card', async () => {
  const sp = scripted(reply({ ok: true, data: todo() }), reply({ ok: true, data: card() }));
  const s = source(sp);
  await s.get({ type: 'todo', id: 1, projectId: 7 });
  await s.get({ type: 'card', id: 1, projectId: 7 });
  assert.deepEqual(sp.calls[0].args, ['todos', 'show', '1', '--in', '7', '--json']);
  assert.deepEqual(sp.calls[1].args, ['cards', 'show', '1', '--in', '7', '--json']);
});

test('argv: complete to-do and card', async () => {
  const sp = scripted(reply({ ok: true, data: {} }));
  const s = source(sp);
  await s.complete({ type: 'todo', id: '123', projectId: '7' });
  await s.complete({ type: 'card', id: 123, projectId: 7 });
  assert.deepEqual(sp.calls[0].args, ['todos', 'complete', '123', '--in', '7', '--json']);
  assert.deepEqual(sp.calls[1].args, ['cards', 'done', '123', '--in', '7', '--json']);
});

test('non-numeric id or projectId is rejected before any spawn', async () => {
  const sp = scripted(reply({ ok: true, data: {} }));
  const s = source(sp);
  const bad = [
    () => s.get({ type: 'todo', id: '1; rm -rf /', projectId: 7 }),
    () => s.get({ type: 'todo', id: 1, projectId: '7 --evil' }),
    () => s.complete({ type: 'card', id: '--help', projectId: 7 }),
    () => s.complete({ type: 'todo', id: 1, projectId: undefined }),
    () => s.list({ kind: 'card', projectId: 'abc' })
  ];
  for (const call of bad) {
    await assert.rejects(call(), (e) => e instanceof SourceError && e.code === 'invalid_argument');
  }
  assert.equal(sp.calls.length, 0);
});

test('unknown type or kind is rejected before any spawn', async () => {
  const sp = scripted(reply({ ok: true, data: {} }));
  const s = source(sp);
  await assert.rejects(s.get({ type: 'doc', id: 1, projectId: 7 }), { code: 'invalid_argument' });
  await assert.rejects(s.list({ kind: 'doc' }), { code: 'invalid_argument' });
  assert.equal(sp.calls.length, 0);
});

test('appUrl never reaches the argv', async () => {
  const sp = scripted(reply({ ok: true, data: {} }));
  const s = source(sp);
  await s.complete({ type: 'todo', id: 1, projectId: 7, appUrl: APP_TODO });
  await assert.rejects(s.get({ type: 'todo', id: APP_TODO, projectId: 7 }), { code: 'invalid_argument' });
  assert.equal(sp.calls.length, 1);
  assert.equal(sp.calls[0].args.some((a) => a.includes('http')), false);
});

test('spawn options: binary from config, timeouts, env without BASECAMP_TOKEN', async () => {
  const sp = scripted(reply({ ok: true, data: [] }), reply({ ok: true, data: {} }));
  const s = source(
    sp,
    { basecampBin: 'C:/Users/me/bin/basecamp.exe', basecampEnv: { BASECAMP_PROFILE: 'work' } },
    { PATH: '/bin', USERPROFILE: '/u', BASECAMP_TOKEN: 'LEAK' }
  );
  await s.list({ kind: 'todo' });
  await s.complete({ type: 'todo', id: 1, projectId: 7 });
  assert.equal(sp.calls[0].file, 'C:/Users/me/bin/basecamp.exe');
  assert.equal(sp.calls[0].opts.timeoutMs, 20_000);
  assert.equal(sp.calls[1].opts.timeoutMs, 10_000);
  for (const call of sp.calls) {
    assert.equal(call.opts.env.BASECAMP_TOKEN, undefined);
    assert.equal(call.opts.env.BASECAMP_NONINTERACTIVE, '1');
    assert.equal(call.opts.env.BASECAMP_PROFILE, 'work');
  }
});

// ---- 2.5: normalization and errors ----------------------------------------

test('to-dos are flattened out of bucket groups', async () => {
  const data = [
    { bucket: { id: 7, name: 'P' }, todos: [todo(), todo({ id: 2, title: 'U', description: '', app_url: `${APP_TODO}2` })] },
    { bucket: { id: 8, name: 'Q' }, todos: [todo({ id: 3, title: 'V', bucket: { id: 8, name: 'Q' } })] }
  ];
  const { items, notice } = await source(scripted(reply({ ok: true, data }))).list({ kind: 'todo' });
  assert.deepEqual(items, [
    { type: 'todo', id: 1, projectId: 7, projectName: 'P', title: 'T', description: 'Fix login', appUrl: APP_TODO, state: 'open' },
    { type: 'todo', id: 2, projectId: 7, projectName: 'P', title: 'U', description: '', appUrl: `${APP_TODO}2`, state: 'open' },
    { type: 'todo', id: 3, projectId: 8, projectName: 'Q', title: 'V', description: 'Fix login', appUrl: APP_TODO, state: 'open' }
  ]);
  assert.equal(notice, undefined);
});

test('a capped list surfaces the CLI notice', async () => {
  const sp = scripted(reply({ ok: true, data: [{ bucket: { id: 7, name: 'P' }, todos: [todo()] }], notice: 'Showing 100 of 240' }));
  const { items, notice } = await source(sp).list({ kind: 'todo' });
  assert.equal(items.length, 1);
  assert.equal(notice, 'Showing 100 of 240');
});

test('cards come from a flat array, appUrl from app_url, description from description', async () => {
  const data = [
    card({ description: '<p>Do it</p>', content: '<div>different</div>' }),
    card({ id: 56, title: 'No body', app_url: `${APP_CARD}6` })
  ];
  const { items } = await source(scripted(reply({ ok: true, data, summary: 's', notice: 'n' }))).list({ kind: 'card', projectId: 7 });
  assert.deepEqual(items, [
    { type: 'card', id: 55, projectId: 7, projectName: 'P', title: 'Card', description: 'Do it', appUrl: APP_CARD, state: '9' },
    { type: 'card', id: 56, projectId: 7, projectName: 'P', title: 'No body', description: '', appUrl: `${APP_CARD}6`, state: '9' }
  ]);
});

test('get returns one normalized item', async () => {
  const item = await source(scripted(reply({ ok: true, data: card({ description: '<p>Hi</p>' }) }))).get({
    type: 'card', id: 55, projectId: 7
  });
  assert.deepEqual(item, {
    type: 'card', id: 55, projectId: 7, projectName: 'P', title: 'Card', description: 'Hi', appUrl: APP_CARD, state: '9'
  });
});

test('projects maps id and name only', async () => {
  const data = [{ id: 7, name: 'P', app_url: 'x', dock: [{ name: 'todoset' }] }, { id: 8, name: 'Q' }];
  assert.deepEqual(await source(scripted(reply({ ok: true, data }))).projects(), [
    { id: 7, name: 'P' },
    { id: 8, name: 'Q' }
  ]);
});

test('ok:false becomes a SourceError with code, hint and retryable', async () => {
  const env = { ok: false, error: 'x', code: 'auth', hint: 'run login', retryable: false };
  await assert.rejects(source(scripted(reply(env, { code: 1 }))).list({ kind: 'todo' }), (e) => {
    assert.ok(e instanceof SourceError);
    assert.equal(e.code, 'auth');
    assert.equal(e.hint, 'run login');
    assert.equal(e.retryable, false);
    assert.match(e.message, /x/);
    return true;
  });
});

test('the envelope is read from stderr when stdout is empty', async () => {
  const env = { ok: false, error: 'boom', code: 'api', hint: 'h', retryable: false };
  const r = { stdout: '', stderr: JSON.stringify(env), code: 1, timedOut: false };
  await assert.rejects(source(scripted(r)).projects(), { code: 'api', hint: 'h' });
});

test('empty or non-JSON output is bad_output', async () => {
  await assert.rejects(source(scripted(reply(''))).projects(), { code: 'bad_output' });
  await assert.rejects(source(scripted(reply('<html>oops</html>', { code: 2 }))).projects(), { code: 'bad_output' });
});

test('a malformed data shape is bad_output', async () => {
  await assert.rejects(source(scripted(reply({ ok: true, data: 'nope' }))).list({ kind: 'todo' }), { code: 'bad_output' });
  await assert.rejects(source(scripted(reply({ ok: true, data: [] }))).get({ type: 'todo', id: 1, projectId: 7 }), {
    code: 'bad_output'
  });
});

test('timeout maps to code timeout', async () => {
  const r = { stdout: '', stderr: '', code: null, timedOut: true };
  await assert.rejects(source(scripted(r)).list({ kind: 'todo' }), { code: 'timeout' });
});

test('ENOENT maps to cli_not_found naming the binary and the config path', async () => {
  const r = { stdout: '', stderr: '', code: null, timedOut: false, spawnError: { code: 'ENOENT' } };
  const s = source(scripted(r), { basecampBin: 'mybc', basecampEnv: {} });
  await assert.rejects(s.list({ kind: 'todo' }), (e) => {
    assert.equal(e.code, 'cli_not_found');
    assert.equal(e.retryable, false);
    assert.ok(e.message.includes('mybc'));
    assert.ok(e.message.includes(CONFIG_FILE));
    return true;
  });
});

test('other spawn errors map to spawn_failed', async () => {
  const r = { stdout: '', stderr: '', code: null, timedOut: false, spawnError: { code: 'EACCES' } };
  await assert.rejects(source(scripted(r)).projects(), { code: 'spawn_failed' });
});

test('retryable:true is shown but never retried', async () => {
  const env = { ok: false, error: 'busy', code: 'rate_limit', hint: 'wait', retryable: true };
  const sp = scripted(reply(env, { code: 1 }));
  await assert.rejects(source(sp).list({ kind: 'todo' }), { retryable: true, code: 'rate_limit' });
  assert.equal(sp.calls.length, 1);
  await assert.rejects(source(sp).complete({ type: 'todo', id: 1, projectId: 7 }), { retryable: true });
  assert.equal(sp.calls.length, 2);
});

test('complete: ok maps to completed', async () => {
  const sp = scripted(reply({ ok: true, data: {} }));
  assert.deepEqual(await source(sp).complete({ type: 'todo', id: 1, projectId: 7 }), { status: 'completed' });
});

test('complete: not found or forbidden maps to inaccessible', async () => {
  for (const env of [
    { ok: false, error: 'Todo not found', code: 'not_found', hint: '', retryable: false },
    { ok: false, error: 'HTTP 404', code: 'api', hint: '', retryable: false },
    { ok: false, error: 'forbidden', code: 'forbidden', hint: '', retryable: false },
    { ok: false, error: 'no permission', code: 'api_error', hint: '', retryable: false },
    { ok: false, error: 'HTTP 403', code: 'api', hint: '', retryable: false }
  ]) {
    const sp = scripted(reply(env, { code: 1 }));
    assert.deepEqual(await source(sp).complete({ type: 'card', id: 1, projectId: 7 }), { status: 'inaccessible' }, env.error);
  }
});

test('complete: already completed maps to already', async () => {
  const env = { ok: false, error: 'Todo is already completed', code: 'usage', hint: '', retryable: false };
  assert.deepEqual(await source(scripted(reply(env, { code: 1 }))).complete({ type: 'todo', id: 1, projectId: 7 }), {
    status: 'already'
  });
});

test('complete: any other failure is thrown as a SourceError, once', async () => {
  const env = { ok: false, error: 'server exploded', code: 'api', hint: 'later', retryable: true };
  const sp = scripted(reply(env, { code: 1 }));
  await assert.rejects(source(sp).complete({ type: 'todo', id: 1, projectId: 7 }), { code: 'api', hint: 'later' });
  assert.equal(sp.calls.length, 1);
});
