import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from '../../src/inbound/poller.mjs';

const SECOND = 1000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Deterministic timers: `advance(ms)` fires due callbacks in time order and lets pending promises settle. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const make = (repeat) => (fn, ms) => {
    const handle = { id: nextId++, unrefd: false, unref() { this.unrefd = true; return this; } };
    timers.set(handle.id, { handle, fn, ms, due: now + ms, repeat });
    return handle;
  };
  const created = { interval: 0, timeout: 0 };
  const api = {
    setInterval: (fn, ms) => (created.interval += 1, make(true)(fn, ms)),
    setTimeout: (fn, ms) => (created.timeout += 1, make(false)(fn, ms)),
    clearInterval: (h) => void timers.delete(h?.id),
    clearTimeout: (h) => void timers.delete(h?.id)
  };
  return {
    api,
    created,
    clock: { now: () => now },
    active: () => timers.size,
    handles: () => [...timers.values()].map((t) => t.handle),
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.values()].filter((t) => t.due <= target).sort((a, b) => a.due - b.due)[0];
        if (!due) break;
        now = due.due;
        if (due.repeat) due.due += due.ms;
        else timers.delete(due.handle.id);
        due.fn();
        await flush();
      }
      now = target;
    }
  };
}

function setup({ results = [], ...options } = {}) {
  const t = fakeTimers();
  const log = { ticks: [], notices: [] };
  let gate = null;
  const state = { next: { status: 'ok', attempted: 1, failed: 0 } };
  const poller = createPoller({
    tick: async () => {
      log.ticks.push(t.clock.now() / SECOND);
      if (gate) await gate;
      const result = results.length > 0 ? results.shift() : state.next;
      if (result instanceof Error) throw result;
      return result;
    },
    onNotice: async (title, body) => void log.notices.push({ title, body }),
    timers: t.api,
    clock: t.clock,
    ...options
  });
  return {
    t,
    log,
    state,
    poller,
    hold: () => {
      let release;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    }
  };
}

const FAILED = { status: 'failed', attempted: 0, failed: 0 };
const FATAL = { status: 'ok', attempted: 1, failed: 1, fatal: { code: 'cli_not_found', message: 'basecamp is not installed' } };

test('ticks 5 s after start, then every 60 s, on unref\'d timers', async () => {
  const s = setup();
  s.poller.ensureStarted();
  assert.ok(s.t.handles().every((h) => h.unrefd));
  await s.t.advance(4_999);
  assert.deepEqual(s.log.ticks, []);
  await s.t.advance(1);
  await s.t.advance(55 * SECOND);
  await s.t.advance(60 * SECOND);
  assert.deepEqual(s.log.ticks, [5, 60, 120]);
});

test('a tick that is still running makes the next interval skip', async () => {
  const s = setup();
  const release = s.hold();
  s.poller.ensureStarted();
  await s.t.advance(5 * SECOND);
  await s.t.advance(60 * SECOND);
  assert.deepEqual(s.log.ticks, [5]);
  release();
  await flush();
  await s.t.advance(60 * SECOND);
  assert.deepEqual(s.log.ticks, [5, 120]);
});

test('ensureStarted is synchronous and idempotent', async () => {
  const s = setup();
  const first = s.poller.ensureStarted();
  const second = s.poller.ensureStarted();
  assert.equal(first instanceof Promise, false);
  assert.equal(second instanceof Promise, false);
  assert.equal(s.t.created.interval, 1);
  assert.equal(s.t.created.timeout, 1);
  assert.equal(s.poller.isRunning(), true);
  await s.t.advance(5 * SECOND);
  assert.deepEqual(s.log.ticks, [5]);
});

test('stop clears both timers and ticks stop', async () => {
  const s = setup();
  s.poller.ensureStarted();
  s.poller.stop();
  assert.equal(s.poller.isRunning(), false);
  assert.equal(s.t.active(), 0);
  await s.t.advance(300 * SECOND);
  assert.deepEqual(s.log.ticks, []);
  s.poller.ensureStarted();
  await s.t.advance(5 * SECOND);
  assert.deepEqual(s.log.ticks, [305]);
});

test('backoff: after 3 failed ticks skip 1 interval, from the 4th skip 3, and notify once', async () => {
  const s = setup();
  s.state.next = FAILED;
  s.poller.ensureStarted();
  await s.t.advance(480 * SECOND);
  assert.deepEqual(s.log.ticks, [5, 60, 120, 240, 480]);
  assert.equal(s.log.notices.length, 1);
});

test('a successful tick resets the backoff and re-arms the notice', async () => {
  const s = setup({ results: [FAILED, FAILED, FAILED] });
  s.poller.ensureStarted();
  await s.t.advance(120 * SECOND);
  assert.equal(s.log.notices.length, 1);
  await s.t.advance(120 * SECOND); // 180 is skipped, 240 runs and succeeds
  assert.deepEqual(s.log.ticks, [5, 60, 120, 240]);
  await s.t.advance(60 * SECOND);
  assert.deepEqual(s.log.ticks, [5, 60, 120, 240, 300]);
  s.state.next = FAILED;
  await s.t.advance(180 * SECOND);
  assert.equal(s.log.notices.length, 2);
});

test('only a tick where every attempted item failed counts as failed; a throwing tick counts too', async () => {
  const partial = setup();
  partial.state.next = { status: 'ok', attempted: 2, failed: 1 };
  partial.poller.ensureStarted();
  await partial.t.advance(240 * SECOND);
  assert.deepEqual(partial.log.ticks, [5, 60, 120, 180, 240]);
  assert.equal(partial.log.notices.length, 0);

  const allFailed = setup();
  allFailed.state.next = { status: 'ok', attempted: 2, failed: 2 };
  allFailed.poller.ensureStarted();
  await allFailed.t.advance(240 * SECOND);
  assert.deepEqual(allFailed.log.ticks, [5, 60, 120, 240]);

  const throwing = setup({ results: [new Error('x'), new Error('x'), new Error('x')] });
  throwing.poller.ensureStarted();
  await assert.doesNotReject(throwing.t.advance(240 * SECOND));
  assert.deepEqual(throwing.log.ticks, [5, 60, 120, 240]);
});

test('a fatal result stops the poller with one notice and blocks restarts for 10 minutes', async () => {
  const s = setup({ results: [FATAL] });
  s.poller.ensureStarted();
  await s.t.advance(5 * SECOND);
  assert.equal(s.poller.isRunning(), false);
  assert.equal(s.log.notices.length, 1);
  assert.match(s.log.notices[0].body, /basecamp is not installed/);
  s.poller.ensureStarted();
  assert.equal(s.poller.isRunning(), false);
  await s.t.advance(599 * SECOND);
  s.poller.ensureStarted();
  assert.equal(s.poller.isRunning(), false);
  await s.t.advance(1 * SECOND);
  s.poller.ensureStarted();
  assert.equal(s.poller.isRunning(), true);
  assert.equal(s.log.notices.length, 1);
});

test('runNow bypasses the fatal block and runs exactly one tick without a notice of its own', async () => {
  const s = setup({ results: [FATAL] });
  s.poller.ensureStarted();
  await s.t.advance(5 * SECOND);
  assert.equal(s.poller.isRunning(), false);
  const result = await s.poller.runNow();
  assert.equal(result.status, 'ok');
  assert.equal(s.poller.isRunning(), true);
  assert.deepEqual(s.log.ticks, [5, 5]);
  assert.equal(s.log.notices.length, 1);
});

test('runNow on a stopped poller runs one tick and cancels the pending initial tick', async () => {
  const s = setup();
  const result = await s.poller.runNow();
  assert.equal(result.status, 'ok');
  assert.deepEqual(s.log.ticks, [0]);
  await s.t.advance(5 * SECOND);
  assert.deepEqual(s.log.ticks, [0]);
  await s.t.advance(55 * SECOND);
  assert.deepEqual(s.log.ticks, [0, 60]);
  assert.equal(s.log.notices.length, 0);
});

test('runNow joins a tick that is already running instead of starting another', async () => {
  const s = setup();
  const release = s.hold();
  s.poller.ensureStarted();
  await s.t.advance(5 * SECOND);
  const pending = s.poller.runNow();
  release();
  await pending;
  assert.deepEqual(s.log.ticks, [5]);
});
