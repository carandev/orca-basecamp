/** True only for https URLs whose host is `basecamp.com` or a subdomain of it. */
export function isBasecampUrl(value) {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && (url.hostname === 'basecamp.com' || url.hostname.endsWith('.basecamp.com'));
}

/** Returns `value` when it is a Basecamp https URL, otherwise throws. */
export function assertBasecampUrl(value) {
  if (!isBasecampUrl(value)) throw new Error('Refusing to open a URL that is not an https basecamp.com address');
  return value;
}
