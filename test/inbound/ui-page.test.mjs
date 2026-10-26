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

test('the list request carries mine=1|0 and cards only send projectId when not "mine"', () => {
  assert.match(page, /'&mine=' \+ \(\$\('mine'\)\.checked \? '1' : '0'\)/);
  assert.match(page, /\$\('project-wrap'\)\.hidden = kind !== 'card' \|\| \$\('mine'\)\.checked/);
  assert.match(page, /\$\('mine'\)\.addEventListener\('change', load\)/);
});

test('the Sync grid lists several columns per status with a destination label, remove button and add select', () => {
  assert.match(page, /\(destination\)/);
  assert.match(page, /'add column'/);
  assert.match(page, /title = 'Remove column'/);
});
