import type {
  IHostAPI,
  ILogger,
  IPluginContext,
  IPluginManifest,
  IStorage,
} from './interfaces.js';

// ─────────────────────────────────────────────────────────────
// PluginContext — scoped bridge between host and plugin
// ─────────────────────────────────────────────────────────────

/**
 * Creates a scoped logger that prefixes every message with the
 * plugin's ID so log output is easy to attribute.
 */
function createScopedLogger(pluginId: string, hostLogger: ILogger): ILogger {
  return {
    debug: (msg, ...args) =>
      hostLogger.debug(`[${pluginId}] ${msg}`, ...args),
    info: (msg, ...args) =>
      hostLogger.info(`[${pluginId}] ${msg}`, ...args),
    warn: (msg, ...args) =>
      hostLogger.warn(`[${pluginId}] ${msg}`, ...args),
    error: (msg, ...args) =>
      hostLogger.error(`[${pluginId}] ${msg}`, ...args),
  };
}

/**
 * Creates a scoped storage adapter that namespaces all keys
 * under the plugin's ID to prevent cross-plugin key collisions.
 */
function createScopedStorage(pluginId: string, hostStorage: IStorage): IStorage {
  const prefix = `plugin:${pluginId}:`;
  return {
    get: <T = unknown>(key: string) => hostStorage.get<T>(`${prefix}${key}`),
    set: <T = unknown>(key: string, value: T) =>
      hostStorage.set(`${prefix}${key}`, value),
    delete: (key: string) => hostStorage.delete(`${prefix}${key}`),
    has: (key: string) => hostStorage.has(`${prefix}${key}`),
    clear: () => hostStorage.clear(),
  };
}

/**
 * Factory that builds a fully scoped {@link IPluginContext}.
 *
 * Each plugin receives:
 * - A **scoped logger** tagged with its ID.
 * - A **scoped storage** namespaced by its ID.
 * - A read-only copy of its own manifest.
 * - A reference to the host API for cross-cutting services.
 */
export function createPluginContext(
  manifest: Readonly<IPluginManifest>,
  hostApi: IHostAPI,
): IPluginContext {
  const logger = createScopedLogger(manifest.id, hostApi.logger);
  const storage = createScopedStorage(manifest.id, hostApi.storage);

  return Object.freeze({
    host: hostApi,
    manifest: Object.freeze({ ...manifest }),
    logger,
    storage,
  });
}
