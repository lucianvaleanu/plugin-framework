import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPluginContext } from '../framework/PluginContext.js';
import { makeManifest } from './helpers.js';
import type { IHostAPI, IStorage } from '../framework/interfaces.js';
import { EventBus } from '../framework/EventBus.js';

function makeHostApi(storage: IStorage): IHostAPI {
  return {
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    storage,
    config: {
      get: () => undefined,
      has: () => false,
      getAll: () => ({}),
    },
    events: new EventBus(),
    services: {
      register() {},
      unregister() { return false; },
      async resolve() { return undefined as any; },
      has() { return false; },
      list() { return []; },
    },
  };
}

function makeStorage(): IStorage {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return store.get(key) as T | undefined; },
    async set<T>(key: string, value: T) { store.set(key, value); },
    async delete(key: string) { return store.delete(key); },
    async has(key: string) { return store.has(key); },
    async clear() { store.clear(); },
  };
}

describe('PluginContext', () => {
  describe('createPluginContext()', () => {
    it('provides a scoped logger that prefixes with plugin ID', () => {
      const logged: string[] = [];
      const storage = makeStorage();
      const hostApi = makeHostApi(storage);
      hostApi.logger.info = (msg: string) => { logged.push(msg); };

      const ctx = createPluginContext(makeManifest('my-plugin'), hostApi);
      ctx.logger.info('hello');

      assert.equal(logged.length, 1);
      assert.ok(logged[0]!.includes('[my-plugin]'));
      assert.ok(logged[0]!.includes('hello'));
    });

    it('provides a scoped storage that namespaces keys', async () => {
      const storage = makeStorage();
      const hostApi = makeHostApi(storage);

      const ctx = createPluginContext(makeManifest('alpha'), hostApi);
      await ctx.storage.set('key1', 'value1');

      // The host storage should have the namespaced key.
      assert.equal(await storage.has('plugin:alpha:key1'), true);
      assert.equal(await ctx.storage.get('key1'), 'value1');

      // Different plugin shouldn't see alpha's keys.
      const ctx2 = createPluginContext(makeManifest('beta'), hostApi);
      assert.equal(await ctx2.storage.get('key1'), undefined);
    });

    it('exposes a frozen manifest', () => {
      const storage = makeStorage();
      const hostApi = makeHostApi(storage);
      const ctx = createPluginContext(makeManifest('p1'), hostApi);

      assert.equal(ctx.manifest.id, 'p1');
      assert.throws(() => {
        (ctx.manifest as any).id = 'hacked';
      });
    });

    it('provides access to the host API', () => {
      const storage = makeStorage();
      const hostApi = makeHostApi(storage);
      const ctx = createPluginContext(makeManifest('p1'), hostApi);

      assert.strictEqual(ctx.host, hostApi);
    });
  });
});
