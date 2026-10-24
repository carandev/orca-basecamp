const ENTITIES = [
  [/&nbsp;/g, ' '],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#0?39;/g, "'"],
  // Last, so "&amp;lt;" decodes once to "&lt;" and not twice to "<".
  [/&amp;/g, '&']
];

/** Plain text from a Basecamp HTML fragment: block tags to newlines, `<li>` to "- ", tags stripped, entities decoded. */
export function htmlToText(html) {
  if (typeof html !== 'string') return '';
  let text = html
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>|<\/(p|div|li|ul|ol|h[1-6]|blockquote|pre|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  for (const [pattern, replacement] of ENTITIES) text = text.replace(pattern, replacement);
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
