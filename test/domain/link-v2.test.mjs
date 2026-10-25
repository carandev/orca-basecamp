import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLink, parseLink, withSync } from '../../src/domain/link.mjs';

const base = { type: 'todo', id: 1, projectId: 7, appUrl: 'https://app.basecamp.com/1/buckets/7/todos/1', title: 'T', createdAt: 5 };
const v1 = { v: 1, ...base };

test('a v1 link still parses and is returned unchanged', () => {
  assert.deepEqual(parseLink(v1), v1);
  assert.equal(parseLink(v1).sync, undefined);
});

test('a v2 link with a valid sync baseline parses', () => {
  const link = { ...base, v: 2, sync: { orca: 'in-review', bc: 'open', at: 100, lastOpenOrca: 'in-review' } };
  assert.deepEqual(parseLink(link), link);
  const noLast = { ...base, v: 2, sync: { orca: 'completed', bc: 'completed', at: 1 } };
  assert.deepEqual(parseLink(noLast), noLast);
});

test('a v2 link without sync parses', () => {
  const link = { ...base, v: 2 };
  assert.deepEqual(parseLink(link), link);
});

test('a malformed sync is dropped but the link survives', () => {
  const bad = [null, 'x', { orca: 'a' }, { orca: 'a', bc: 'b', at: 'now' }, { orca: 1, bc: 'b', at: 1 }, { orca: 'a', bc: 'b', at: 1, lastOpenOrca: 5 }];
  for (const sync of bad) {
    const parsed = parseLink({ ...base, v: 2, sync });
    assert.equal(parsed.v, 2);
    assert.equal('sync' in parsed, false, JSON.stringify(sync));
    assert.equal(parsed.id, 1);
  }
});

test('unknown versions and invalid ids are still rejected', () => {
  assert.equal(parseLink({ ...v1, v: 3 }), null);
  assert.equal(parseLink({ ...base, v: 2, id: 'x' }), null);
  assert.equal(parseLink({ ...base, v: 2, type: 'other' }), null);
  assert.equal(parseLink(null), null);
});

test('withSync sets v:2 and the baseline without mutating the input', () => {
  const sync = { orca: 'in-progress', bc: 'open', at: 9 };
  const out = withSync(v1, sync);
  assert.equal(out.v, 2);
  assert.deepEqual(out.sync, sync);
  assert.equal(out.title, 'T');
  assert.equal(v1.v, 1);
  assert.equal('sync' in v1, false);
  assert.deepEqual(parseLink(out), out);
});

test('buildLink still produces a v1 record', () => {
  assert.equal(buildLink({ type: 'todo', id: 1, projectId: 7, appUrl: 'a', title: 't', now: 5 }).v, 1);
});
