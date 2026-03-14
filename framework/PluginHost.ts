import { randomUUID } from 'node:crypto';

import type {
  IConfigProvider,
  IHostAPI,
  IHostContext,
  ILogger,
  IPluginHost,
  IPluginManifest,
  IStorage,
} from './interfaces.js';

import { EventBus } from './EventBus.js';
import { PluginRegistry } from './PluginRegistry.js';
import { ServiceRegistry } from './ServiceRegistry.js';
import { PluginManager } from './PluginManager.js';
import { DependencyResolver } from './DependencyResolver.js';
import { ManifestLoader } from './ManifestLoader.js';
import { createPluginContext } from './PluginContext.js';

// ─────────────────────────────────────────────────────────────
// HostContext — transient execution context (bag pattern)
// ─────────────────────────────────────────────────────────────

class HostContext implements IHostContext {
  readonly requestId: string;
  readonly timestamp: number;
  readonly #bag = new Map<string, unknown>();

  constructor() {
    this.requestId = randomUUID();
    this.timestamp = Date.now();
  }

  get<T = unknown>(key: string): T | undefined {
    return this.#bag.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.#bag.set(key, value);
  }

  has(key: string): boolean {
    return this.#bag.has(key);
  }

  delete(key: string): boolean {
    return this.#bag.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────
// Default infrastructure stubs
// ─────────────────────────────────────────────────────────────

function createConsoleLogger(): ILogger {
  return {
    debug: (msg, ...args) => console.debug(`[DEBUG] ${msg}`, ...args),
    info: (msg, ...args) => console.info(`[INFO]  ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[WARN]  ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
  };
}

function createInMemoryStorage(): IStorage {
  const store = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set<T = unknown>(key: string, value: T) {
      store.set(key, value);
    },
    async delete(key: string) {
      return store.delete(key);
    },
    async has(key: string) {
      return store.has(key);
    },
    async clear() {
      store.clear();
    },
  };
}

function createEmptyConfig(): IConfigProvider {
  return {
    get: <T = unknown>(_key: string, defaultValue?: T) => defaultValue,
    has: () => false,
    getAll: () => ({}),
  };
}

// ─────────────────────────────────────────────────────────────
// PluginHost options
// ─────────────────────────────────────────────────────────────

export interface PluginHostOptions {
  /** Directory to scan for plugin sub-directories. */
  pluginDir?: string | undefined;
  /** Custom logger (defaults to console). */
  logger?: ILogger | undefined;
  /** Custom storage backend (defaults to in-memory Map). */
  storage?: IStorage | undefined;
  /** Custom config provider (defaults to empty). */
  config?: IConfigProvider | undefined;
}

// ─────────────────────────────────────────────────────────────
// PluginHost implementation
// ─────────────────────────────────────────────────────────────

/**
 * Top-level orchestrator that owns and wires together the full
 * plugin runtime: registry, event bus, service registry,
 * dependency resolver, manifest loader, and lifecycle manager.
 *
 * Usage:
 * ```ts
 * const host = new PluginHost({ pluginDir: './plugins' });
 * await host.start();   // discover → install → activate all
 * // … app runs …
 * await host.stop();    // graceful shutdown
 * ```
 */
export class PluginHost implements IPluginHost {
  readonly api: IHostAPI;
  readonly registry: PluginRegistry;
  readonly events: EventBus;
  readonly services: ServiceRegistry;
  readonly manager: PluginManager;

  readonly #resolver: DependencyResolver;
  readonly #loader: ManifestLoader;
  readonly #logger: ILogger;
  readonly #pluginDir: string | undefined;

  constructor(options: PluginHostOptions = {}) {
    this.#logger = options.logger ?? createConsoleLogger();
    this.#pluginDir = options.pluginDir;

    this.events = new EventBus();
    this.registry = new PluginRegistry();

    const storage = options.storage ?? createInMemoryStorage();
    const config = options.config ?? createEmptyConfig();

    // Build the api object in two steps because ServiceRegistry
    // needs a host context that references api, creating a
    // chicken-and-egg situation. We use a mutable wrapper and
    // assign `services` after construction.
    const api = {
      logger: this.#logger,
      storage,
      config,
      events: this.events as IHostAPI['events'],
      services: undefined! as IHostAPI['services'],
    };

    const hostCtx = createPluginContext(
      {
        id: '__host__',
        name: 'Host',
        version: '1.0.0',
        description: 'Plugin host application',
        author: { name: 'host' },
      },
      api,
    );

    this.services = new ServiceRegistry(hostCtx);
    api.services = this.services;

    this.api = api;

    this.manager = new PluginManager(
      this.registry,
      this.events,
      this.api,
      this.#logger,
    );

    this.#resolver = new DependencyResolver();
    this.#loader = new ManifestLoader(this.#logger);
  }

  // ── start ──────────────────────────────────────────────────

  async start(): Promise<void> {
    this.#logger.info('PluginHost starting…');

    let manifests: readonly IPluginManifest[] = [];

    if (this.#pluginDir) {
      const result = await this.#loader.loadFromDirectory(this.#pluginDir);
      manifests = result.manifests;

      for (const err of result.errors) {
        this.#logger.error(`Manifest error in "${err.directory}": ${err.message}`);
      }

      if (manifests.length === 0) {
        this.#logger.info('No plugins discovered.');
        return;
      }
    }

    // Validate the dependency graph.
    const validation = this.#resolver.validate(manifests);
    for (const w of validation.warnings) this.#logger.warn(w);

    if (!validation.valid) {
      for (const e of validation.errors) this.#logger.error(e);
      throw new Error(
        `PluginHost: dependency validation failed — ${validation.errors.join('; ')}`,
      );
    }

    // Resolve boot order.
    const bootOrder = this.#resolver.resolve(manifests);
    const manifestMap = new Map(manifests.map((m) => [m.id, m]));

    // Install then activate in dependency order.
    for (const id of bootOrder) {
      const manifest = manifestMap.get(id)!;
      try {
        await this.manager.install(manifest);
      } catch (err) {
        this.#logger.error(
          `Failed to install plugin "${id}": ${(err as Error).message}`,
        );
        // Error containment: continue with remaining plugins.
        continue;
      }

      try {
        await this.manager.activate(id);
      } catch (err) {
        this.#logger.error(
          `Failed to activate plugin "${id}": ${(err as Error).message}`,
        );
      }
    }

    this.#logger.info('PluginHost started.');
  }

  // ── stop ───────────────────────────────────────────────────

  async stop(): Promise<void> {
    this.#logger.info('PluginHost stopping…');

    // Deactivate in reverse boot order for clean teardown.
    const plugins = this.manager.getAllPlugins();
    for (let i = plugins.length - 1; i >= 0; i--) {
      const plugin = plugins[i]!;
      const id = plugin.manifest.id;
      try {
        const state = this.manager.getState(id);
        if (state === 'activated' || state === 'mounted') {
          await this.manager.deactivate(id);
        }
      } catch (err) {
        this.#logger.error(
          `Error deactivating plugin "${id}": ${(err as Error).message}`,
        );
      }
    }

    this.#logger.info('PluginHost stopped.');
  }

  // ── createContext ──────────────────────────────────────────

  createContext(): IHostContext {
    return new HostContext();
  }
}