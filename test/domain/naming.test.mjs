import test from 'node:test';
import assert from 'node:assert/strict';
import { worktreeName, slugify } from '../../src/domain/naming.mjs';

test('normalizes accents, punctuation and case', () => {
  assert.equal(worktreeName(123, 'Fix: Login Bug -- ÁÉ!!'), 'bc-123-fix-login-bug-ae');
});

test('plain title with spaces', () => {
  assert.equal(worktreeName(7, 'Add dark mode'), 'bc-7-add-dark-mode');
});

test('slug is capped at 40 chars with no trailing dash', () => {
  const slug = slugify('a'.repeat(100));
  assert.equal(slug, 'a'.repeat(40));
  // cut lands right after a separator: the trailing dash is trimmed
  const cut = slugify(`${'a'.repeat(39)} bbbb`);
  assert.equal(cut, 'a'.repeat(39));
  assert.equal(worktreeName(5, 'word '.repeat(30)).slice('bc-5-'.length).length <= 40, true);
});

test('empty slug falls back to bc-<id>', () => {
  assert.equal(worktreeName(9, '!!!'), 'bc-9');
  assert.equal(worktreeName(9, ''), 'bc-9');
});

test('non-string title falls back to bc-<id>', () => {
  assert.equal(worktreeName(9, undefined), 'bc-9');
});
