import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, MAX_PROMPT } from '../../src/domain/prompt.mjs';
import { isBasecampUrl, assertBasecampUrl } from '../../src/domain/urls.mjs';
import { buildLink, parseLink, linkKey } from '../../src/domain/link.mjs';

test('prompt is title, blank line, description', () => {
  assert.equal(buildPrompt('Fix login', 'Steps here'), 'Fix login\n\nSteps here');
});

test('prompt is exactly the title when the description is empty', () => {
  assert.equal(buildPrompt('Fix login', ''), 'Fix login');
  assert.equal(buildPrompt('Fix login', '   '), 'Fix login');
  assert.equal(buildPrompt('Fix login', undefined), 'Fix login');
});

test('prompt is capped at 8000 chars', () => {
  assert.equal(MAX_PROMPT, 8000);
  assert.equal(buildPrompt('T', 'x'.repeat(20000)).length, 8000);
  assert.equal(buildPrompt('T', 'short').length, 8);
});

test('quotes, ampersands and newlines stay in one string value', () => {
  const p = buildPrompt('Say "hi" & bye', 'line1\nline2 `x` $(y)');
  assert.equal(typeof p, 'string');
  assert.equal(p, 'Say "hi" & bye\n\nline1\nline2 `x` $(y)');
});

test('only https URLs on basecamp.com hosts are accepted', () => {
  assert.equal(isBasecampUrl('https://app.basecamp.com/1/buckets/7/todos/1'), true);
  assert.equal(isBasecampUrl('https://3.basecamp.com/1/x'), true);
  assert.equal(isBasecampUrl('http://app.basecamp.com/1'), false);
  assert.equal(isBasecampUrl('https://evilbasecamp.com/1'), false);
  assert.equal(isBasecampUrl('https://basecamp.com.evil.io/1'), false);
  assert.equal(isBasecampUrl('javascript:alert(1)'), false);
  assert.equal(isBasecampUrl('not a url'), false);
  assert.equal(isBasecampUrl(undefined), false);
});

test('assertBasecampUrl throws on refused URLs and returns accepted ones', () => {
  assert.equal(assertBasecampUrl('https://app.basecamp.com/1'), 'https://app.basecamp.com/1');
  assert.throws(() => assertBasecampUrl('https://example.com/1'), /basecamp/i);
});

test('link has the v1 shape and round-trips', () => {
  const link = buildLink({
    type: 'todo', id: 1, projectId: 7, appUrl: 'https://app.basecamp.com/a/buckets/7/todos/1',
    title: 'T', now: 1700000000000
  });
  assert.deepEqual(link, {
    v: 1, type: 'todo', id: 1, projectId: 7,
    appUrl: 'https://app.basecamp.com/a/buckets/7/todos/1', title: 'T', createdAt: 1700000000000
  });
  assert.deepEqual(parseLink(link), link);
  assert.equal(linkKey('wt-1'), 'link:wt-1');
});

test('parseLink rejects malformed or foreign values', () => {
  assert.equal(parseLink(null), null);
  assert.equal(parseLink({ v: 3, type: 'todo', id: 1, projectId: 7 }), null);
  assert.equal(parseLink({ v: 1, type: 'doc', id: 1, projectId: 7 }), null);
  assert.equal(parseLink({ v: 1, type: 'card', id: 'x', projectId: 7 }), null);
});
