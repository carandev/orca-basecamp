import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../../src/inbound/ui/index.html', import.meta.url), 'utf8');

test('the page never uses innerHTML', () => {
  assert.doesNotMatch(page, /innerHTML/);
});

test('"Only mine" is a checkbox, checked by default, outside the Sync panel', () => {
  assert.match(page, /<input type="checkbox" id="mine" checked>/);
  assert.ok(page.indexOf('id="mine"') < page.indexOf('<div id="sync"'));
});

test('the list request carries mine=1|0', () => {
  assert.match(page, /'&mine=' \+ \(\$\('mine'\)\.checked \? '1' : '0'\)/);
  assert.match(page, /\$\('mine'\)\.addEventListener\('change', load\)/);
});

test('the Sync grid lists several columns per status with a destination label, remove button and add select', () => {
  assert.match(page, /\(destination\)/);
  assert.match(page, /'add column'/);
  assert.match(page, /title = 'Remove column'/);
});

test('link mode is chosen by mode=link and a session from the URL, and the page never names a worktree', () => {
  assert.match(page, /\.get\('mode'\) === 'link'/);
  assert.match(page, /\.get\('session'\)/);
  assert.doesNotMatch(page, /worktreeId/);
});

test('link mode reads the display name from /api/link-session and shows it with textContent', () => {
  assert.match(page, /'\/api\/link-session\?session=' \+ encodeURIComponent\(session\)/);
  assert.match(page, /textContent = 'Link to: ' \+ /);
});

test('link mode hides the repository and agent selectors and the Sync tab, keeping Only mine and the tabs', () => {
  assert.match(page, /id="repo-wrap"/);
  assert.match(page, /id="agent-wrap"/);
  assert.match(page, /\$\('repo-wrap'\)\.hidden = true/);
  assert.match(page, /\$\('agent-wrap'\)\.hidden = true/);
  assert.match(page, /\$\('tab-sync'\)\.hidden = true/);
  assert.ok(page.indexOf('id="mine"') > page.indexOf('id="agent-wrap"'));
});

test('link mode replaces Start with a Link button that posts only ids and the session to /api/link', () => {
  assert.match(page, /action\.textContent = linkMode \? 'Link' : 'Start'/);
  assert.match(page, /api\('POST', '\/api\/link', \{ type: item\.type, id: item\.id, projectId: item\.projectId, session: session \}\)/);
});

test('already-linked items show a "Linked to worktree" badge instead of a button', () => {
  assert.match(page, /'linked-badge'/);
  assert.match(page, /'Linked to worktree'/);
  assert.match(page, /isLinked/);
});

test('load fetches /api/linked-items in parallel with /api/items and passes the result to render', () => {
  assert.match(page, /\/api\/linked-items/);
  assert.match(page, /Promise\.all/);
  assert.match(page, /li\.ok.*li\.items|li\.items.*li\.ok/);
});

test('the project select is always visible, defaults to "All projects", and reloads the list', () => {
  assert.doesNotMatch(page, /project-wrap'\)\.hidden/);
  assert.doesNotMatch(page, /id="project-wrap" hidden/);
  assert.match(page, /&projectId=' \+ encodeURIComponent\(\$\('project'\)\.value\)/);
  assert.match(page, /'Choose a project\.'/);
  assert.match(page, /\$\('project'\)\.addEventListener\('change', load\)/);
  assert.match(page, /'All projects'/);
});
