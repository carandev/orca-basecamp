/** Plugin-private key-value storage over `orca.host.call` (`storage.get|set|delete|keys`). */
export function createStorage(hostCall) {
  return {
    async get(key) {
      const reply = await hostCall('storage.get', { key });
      return reply?.value ?? null;
    },
    async set(key, value) {
      await hostCall('storage.set', { key, value });
    },
    async delete(key) {
      await hostCall('storage.delete', { key });
    },
    async keys() {
      const reply = await hostCall('storage.keys');
      return reply?.keys ?? [];
    }
  };
}
