import { normalizeSyncConfig, validateSyncConfig } from '../domain/mapping.mjs';

export const SYNC_CONFIG_KEY = 'sync:config';

/** Sync settings over plugin storage. `get` never throws on bad stored data; `save` validates before writing. */
export function createSyncConfig({ storage }) {
  return {
    async get() {
      return normalizeSyncConfig(await storage.get(SYNC_CONFIG_KEY));
    },
    /** Resolves to `{ok:true, value}` after storing, or `{ok:false, error}` with storage untouched. */
    async save(body) {
      const checked = validateSyncConfig(body);
      if (!checked.ok) return checked;
      await storage.set(SYNC_CONFIG_KEY, checked.value);
      return checked;
    }
  };
}
