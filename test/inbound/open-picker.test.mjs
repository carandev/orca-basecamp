import test from 'node:test';
import assert from 'node:assert/strict';
import { openPicker } from '../../src/inbound/open-picker.mjs';

const URL_ = 'http://127.0.0.1:5555/?token=t';

function setup({ active = { worktreeId: 'w1', worktreePath: '/w' }, tabFails = false, openFails = false, resolveFails = false } = {}) {
  const tabs = [];
  const opened = [];
  const notes = [];
  const logs = [];
  return {
    tabs,
    opened,
    notes,
    logs,
    deps: {
      server: { start: async () => ({ url: URL_ }) },
      orca: {
        resolveActiveWorktree: async () => {
          if (resolveFails) throw new Error('no context');
          return active;
        },
        openTab: async (args) => {
          tabs.push(args);
          if (tabFails) throw new Error('tab failed');
        }
      },
      openExternal: async (url) => {
        opened.push(url);
        if (openFails) throw new Error('no browser');
      },
      notify: async (title, body) => notes.push([title, body]),
      log: (m) => logs.push(m)
    }
  };
}

test('opens the picker in an Orca tab of the active worktree and notifies the url', async () => {
  const s = setup();
  const r = await openPicker(s.deps);
  assert.deepEqual(r, { url: URL_, opened: 'orca' });
  assert.deepEqual(s.tabs, [{ worktreeId: 'w1', url: URL_ }]);
  assert.deepEqual(s.opened, []);
  assert.match(s.notes[0][1], /5555/);
});

test('falls back to the OS browser with no active worktree or a failing tab', async () => {
  for (const opts of [{ active: null }, { tabFails: true }, { resolveFails: true }]) {
    const s = setup(opts);
    assert.equal((await openPicker(s.deps)).opened, 'browser');
    assert.deepEqual(s.opened, [URL_]);
  }
});

test('still notifies the url when nothing can be opened', async () => {
  const s = setup({ active: null, openFails: true });
  assert.equal((await openPicker(s.deps)).opened, 'none');
  assert.equal(s.notes.length, 1);
  assert.match(s.logs.join('\n'), /no browser/);
});
