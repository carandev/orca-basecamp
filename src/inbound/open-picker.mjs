/**
 * Start command: starts (or reuses) the picker server, opens it in an Orca browser tab of the active worktree,
 * else in the OS browser, and always notifies the url. Never throws.
 * With `link: {worktreeId, displayName}` the picker opens in LINK mode bound to that worktree: a single-use session
 * is created on the server, the url carries `mode=link&session=<nonce>`, and the tab opens on that worktree.
 * Ports: server {start() -> {url}, createLinkSession({worktreeId, displayName}) -> nonce (link mode only)},
 * orca {resolveActiveWorktree(), openTab({worktreeId, url})}, openExternal(url), notify(title, body), log(message).
 * Returns { url, opened: 'orca' | 'browser' | 'none' }.
 */
export async function openPicker({ server, orca, openExternal, notify, log, link }) {
  const started = await server.start();
  const url = link
    ? `${started.url}&mode=link&session=${encodeURIComponent(server.createLinkSession(link))}`
    : started.url;
  let opened = 'none';
  try {
    const worktreeId = link ? link.worktreeId : (await orca.resolveActiveWorktree())?.worktreeId;
    if (worktreeId) {
      await orca.openTab({ worktreeId, url });
      opened = 'orca';
    }
  } catch (error) {
    log(`could not open the picker in Orca: ${error.message}`);
  }
  if (opened === 'none') {
    try {
      await openExternal(url);
      opened = 'browser';
    } catch (error) {
      log(`could not open the OS browser: ${error.message}`);
    }
  }
  await notify(link ? 'Basecamp: Link item to this worktree' : 'Basecamp: Start from item', `Open ${url}`);
  return { url, opened };
}
