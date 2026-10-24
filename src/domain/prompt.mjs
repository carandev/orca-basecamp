export const MAX_PROMPT = 8000;

/** Agent prompt: the title, then a blank line and the description when there is one. One string, capped. */
export function buildPrompt(title, description) {
  const body = typeof description === 'string' ? description.trim() : '';
  const prompt = body ? `${title}\n\n${body}` : title;
  return prompt.slice(0, MAX_PROMPT);
}
