import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../../src/domain/html-text.mjs';

test('strips inline tags', () => {
  assert.equal(htmlToText('<p>Fix <b>login</b></p>'), 'Fix login');
});

test('list items become dash bullets on their own lines', () => {
  assert.equal(htmlToText('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
});

test('block tags and br produce newlines, blank runs collapse', () => {
  assert.equal(htmlToText('<div>a</div><div>b</div><br><br><br><p>c</p>'), 'a\nb\n\nc');
});

test('decodes common entities, ampersand last', () => {
  assert.equal(htmlToText('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; f&nbsp;g'), 'a & b <c> "d" \'e\' f g');
  assert.equal(htmlToText('&amp;lt;'), '&lt;');
});

test('empty, blank or non-string input gives an empty string', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText('<p> </p>'), '');
  assert.equal(htmlToText(undefined), '');
  assert.equal(htmlToText(null), '');
});
