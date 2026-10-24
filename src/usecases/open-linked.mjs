import { isBasecampUrl } from '../domain/urls.mjs';
import { describeFailure, safeNotify } from './failure.mjs';
import { resolveLinked } from './resolve-linked.mjs';

const TITLE = 'Basecamp: Open';

/**
 * Open command: opens the linked item in an Orca browser tab of the active worktree, else in the OS browser.
 * Only https `basecamp.com` URLs are ever opened. Never throws.
 * Resolves to `{status: 'no_link'|'refused'|'opened'|'failed', via?: 'orca'|'browser'}`.
 */
export function createOpenLinked({ orca, storage, openExternal, notify }) {
  return async function openLinked() {
    let linked;
    try {
      linked = await resolveLinked({ orca, storage });
    } catch (error) {
      await safeNotify(notify, TITLE, describeFailure(error));
      return { status: 'failed' };
    }
    if (!linked) {
      await safeNotify(notify, TITLE, 'No linked item for the active worktree.');
      return { status: 'no_link' };
    }
    const { worktreeId, link } = linked;
    if (!isBasecampUrl(link.appUrl)) {
      await safeNotify(notify, TITLE, 'Refusing to open a stored URL that is not an https basecamp.com address.');
      return { status: 'refused' };
    }
    try {
      await orca.openTab({ worktreeId, url: link.appUrl });
      return { status: 'opened', via: 'orca' };
    } catch {
      // fall back to the OS browser
    }
    try {
      await openExternal(link.appUrl);
      return { status: 'opened', via: 'browser' };
    } catch (error) {
      await safeNotify(notify, TITLE, `Could not open ${link.appUrl}: ${describeFailure(error)}`);
      return { status: 'failed' };
    }
  };
}
