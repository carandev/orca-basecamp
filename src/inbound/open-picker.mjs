/**
 * Start command: starts (or reuses) the picker server, opens it in an Orca browser tab of the active worktree,
 * else in the OS browser, and always notifies the url. Never throws.
 * Ports: server {start() -> {url}}, orca {resolveActiveWorktree(), openTab({worktreeId, url})},
 * openExternal(url), notify(title, body), log(message).
 * Returns { url, opened: 'orca' | 'browser' | 'none' }.
 */
export async function openPicker({ server, orca, openExternal, notify, log }) {
  const { url } = await server.start();
  let opened = 'none';
  try {
    const active = await orca.resolveActiveWorktree();
    if (active) {
      await orca.openTab({ worktreeId: active.worktreeId, url });
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
  await notify('Basecamp: Start from item', `Open ${url}`);
  return { url, opened };
}
