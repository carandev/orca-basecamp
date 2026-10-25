import test from 'node:test';
import assert from 'node:assert/strict';
import { createBasecampSource, SourceError } from '../../src/adapters/basecamp-cli.mjs';

const APP_TODO = 'https://app.basecamp.com/999/buckets/7/todos/1';
const APP_CARD = 'https://app.basecamp.com/999/buckets/7/card_tables/cards/55';

const reply = (value, extra = {}) => ({ stdout: JSON.stringify(value), stderr: '', code: 0, timedOut: false, ...extra });

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

const source = (spawner) =>
  createBasecampSource({ spawner, config: { basecampEnv: {} }, env: { PATH: '/bin' }, configFile: '/cfg.json' });

const todo = (over = {}) => ({
  id: 1,
  title: 'T',
  app_url: APP_TODO,
  completed: false,
  parent: { id: 3, title: 'List', type: 'Todolist' },
  bucket: { id: 7, name: 'P' },
  ...over
});
const card = (parent, over = {}) => ({
  id: 55,
  title: 'Card',
  app_url: APP_CARD,
  completed: false,
  parent,
  bucket: { id: 7, name: 'P' },
  ...over
});
const column = { id: 42, title: 'Review', type: 'Kanban::Column' };

// ---- state -----------------------------------------------------------------

test('state: argv for to-do and card, 20 s timeout, --json', async () => {
  const sp = scripted(reply({ ok: true, data: todo() }), reply({ ok: true, data: card(column) }));
  const s = source(sp);
  await s.state({ type: 'todo', id: 1, projectId: 7 });
  await s.state({ type: 'card', id: 55, projectId: 7 });
  assert.deepEqual(sp.calls[0].args, ['todos', 'show', '1', '--in', '7', '--json']);
  assert.deepEqual(sp.calls[1].args, ['cards', 'show', '55', '--in', '7', '--json']);
  assert.equal(sp.calls[0].opts.timeoutMs, 20_000);
  assert.equal(sp.calls[1].opts.timeoutMs, 20_000);
});

test('state: to-do is open or completed', async () => {
  const open = source(scripted(reply({ ok: true, data: todo() })));
  assert.equal(await open.state({ type: 'todo', id: 1, projectId: 7 }), 'open');
  const done = source(scripted(reply({ ok: true, data: todo({ completed: true }) })));
  assert.equal(await done.state({ type: 'todo', id: 1, projectId: 7 }), 'completed');
});

test('state: card column is its numeric id as a string, never the name', async () => {
  const s = source(scripted(reply({ ok: true, data: card(column) })));
  assert.equal(await s.state({ type: 'card', id: 55, projectId: 7 }), '42');
});

test('state: a card in the DoneColumn or flagged completed is completed', async () => {
  const done = source(scripted(reply({ ok: true, data: card({ id: 5, title: 'Done', type: 'Kanban::DoneColumn' }) })));
  assert.equal(await done.state({ type: 'card', id: 55, projectId: 7 }), 'completed');
  const flagged = source(scripted(reply({ ok: true, data: card(column, { completed: true }) })));
  assert.equal(await flagged.state({ type: 'card', id: 55, projectId: 7 }), 'completed');
});

test('state: a card without a parent column is a bad_output error', async () => {
  const s = source(scripted(reply({ ok: true, data: card(undefined) })));
  await assert.rejects(s.state({ type: 'card', id: 55, projectId: 7 }), { code: 'bad_output' });
});

test('state: get() items also carry the state', async () => {
  const item = await source(scripted(reply({ ok: true, data: card(column) }))).get({ type: 'card', id: 55, projectId: 7 });
  assert.equal(item.state, '42');
});

test('state: invalid ids throw before any spawn', async () => {
  const sp = scripted(reply({ ok: true, data: todo() }));
  await assert.rejects(source(sp).state({ type: 'todo', id: '--help', projectId: 7 }), { code: 'invalid_argument' });
  await assert.rejects(source(sp).state({ type: 'todo', id: 1, projectId: '7 --foo' }), { code: 'invalid_argument' });
  assert.equal(sp.calls.length, 0);
});

// ---- reopen ----------------------------------------------------------------

test('reopen: todos uncomplete argv with a 10 s timeout', async () => {
  const sp = scripted(reply({ ok: true, data: {} }));
  assert.deepEqual(await source(sp).reopen({ id: 1, projectId: 7 }), { status: 'reopened' });
  assert.deepEqual(sp.calls[0].args, ['todos', 'uncomplete', '1', '--in', '7', '--json']);
  assert.equal(sp.calls[0].opts.timeoutMs, 10_000);
});

test('reopen: already open, inaccessible and other failures are typed', async () => {
  const fail = (error, code = 'api') => reply({ ok: false, error, code, hint: 'h', retryable: true }, { code: 1 });
  assert.deepEqual(await source(scripted(fail('Todo is already open'))).reopen({ id: 1, projectId: 7 }), { status: 'already' });
  assert.deepEqual(await source(scripted(fail('HTTP 404'))).reopen({ id: 1, projectId: 7 }), { status: 'inaccessible' });
  const sp = scripted(fail('boom'));
  await assert.rejects(source(sp).reopen({ id: 1, projectId: 7 }), (e) => e instanceof SourceError && e.retryable && e.hint === 'h');
  assert.equal(sp.calls.length, 1);
});

test('reopen: invalid ids throw with zero spawns', async () => {
  const sp = scripted(reply({ ok: true, data: {} }));
  await assert.rejects(source(sp).reopen({ id: '-1', projectId: 7 }), { code: 'invalid_argument' });
  assert.equal(sp.calls.length, 0);
});

// ---- columns ---------------------------------------------------------------

test('columns: argv, title -> name, mappable only for Kanban::Column', async () => {
  const sp = scripted(
    reply({
      ok: true,
      data: [
        { id: 1, title: 'Triage', type: 'Kanban::Triage', cards_count: 0 },
        { id: 42, title: 'Review', type: 'Kanban::Column', cards_count: 3 },
        { id: 3, title: 'Not now', type: 'Kanban::NotNowColumn' },
        { id: 4, title: 'Done', type: 'Kanban::DoneColumn' }
      ]
    })
  );
  const columns = await source(sp).columns({ projectId: 7 });
  assert.deepEqual(sp.calls[0].args, ['cards', 'columns', '--in', '7', '--json']);
  assert.equal(sp.calls[0].opts.timeoutMs, 20_000);
  assert.deepEqual(columns, [
    { id: '1', name: 'Triage', type: 'Kanban::Triage', mappable: false },
    { id: '42', name: 'Review', type: 'Kanban::Column', mappable: true },
    { id: '3', name: 'Not now', type: 'Kanban::NotNowColumn', mappable: false },
    { id: '4', name: 'Done', type: 'Kanban::DoneColumn', mappable: false }
  ]);
});

test('columns: falls back to name, rejects a non-list and surfaces CLI errors', async () => {
  const named = await source(scripted(reply({ ok: true, data: [{ id: 9, name: 'Doing', type: 'Kanban::Column' }] }))).columns({
    projectId: 7
  });
  assert.equal(named[0].name, 'Doing');
  await assert.rejects(source(scripted(reply({ ok: true, data: {} }))).columns({ projectId: 7 }), { code: 'bad_output' });
  const multi = reply({ ok: false, error: 'Multiple card tables found', code: 'usage', hint: 'use --card-table', retryable: false }, { code: 1 });
  await assert.rejects(source(scripted(multi)).columns({ projectId: 7 }), { code: 'usage', hint: 'use --card-table' });
});

test('columns: invalid project throws with zero spawns', async () => {
  const sp = scripted(reply({ ok: true, data: [] }));
  await assert.rejects(source(sp).columns({ projectId: 'x' }), { code: 'invalid_argument' });
  assert.equal(sp.calls.length, 0);
});

// ---- move ------------------------------------------------------------------

test('move: exact argv with a 10 s timeout', async () => {
  const sp = scripted(reply({ ok: true, data: {} }));
  assert.deepEqual(await source(sp).move({ id: 55, projectId: 7, columnId: '9' }), { status: 'moved' });
  assert.deepEqual(sp.calls[0].args, ['cards', 'move', '55', '--to', '9', '--in', '7', '--json']);
  assert.equal(sp.calls[0].opts.timeoutMs, 10_000);
});

test('move: already, inaccessible and other failures are typed', async () => {
  const fail = (error) => reply({ ok: false, error, code: 'api', hint: '', retryable: false }, { code: 1 });
  const args = { id: 55, projectId: 7, columnId: 9 };
  assert.deepEqual(await source(scripted(fail('card is already in that column'))).move(args), { status: 'already' });
  assert.deepEqual(await source(scripted(fail('forbidden'))).move(args), { status: 'inaccessible' });
  const sp = scripted(fail('boom'));
  await assert.rejects(source(sp).move(args), SourceError);
  assert.equal(sp.calls.length, 1);
});

test('move: --to must be a numeric id, never a flag, a pair or a name', async () => {
  for (const columnId of ['-1', '1 --foo', 'Review', '', undefined, null, '--help', -1]) {
    const sp = scripted(reply({ ok: true, data: {} }));
    await assert.rejects(source(sp).move({ id: 55, projectId: 7, columnId }), { code: 'invalid_argument' }, String(columnId));
    assert.equal(sp.calls.length, 0, String(columnId));
  }
});
