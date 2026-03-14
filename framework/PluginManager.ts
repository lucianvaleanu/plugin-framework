import { randomUUID } from 'node:crypto';

import type {
  IEventBus,
  IHostAPI,
  ILogger,
  IPlugin,
  IPluginContext,
  IPluginLifecycleHooks,
  IPluginManifest,
  IPluginManager,
  IPluginRegistry,
} from './interfaces.js';
import {
  EventCategory,
  EventDeliveryStrategy,
  PluginLifecycleState,
} from './interfaces.js';
import { createPluginContext } from './PluginContext.js';

// ─────────────────────────────────────────────────────────────
// State-machine definition
// ─────────────────────────────────────────────────────────────

/**
 * Exhaustive map of legal state transitions.
 *
 * Forward:   Discovered → Installed → Activated → (Mounted)
 * Teardown:  (Mounted →) Deactivated → (Unmounted →) Uninstalled
 * Recovery:  Deactivated → Activated  (re-activation)
 * Terminal:  Any → Error, Error → Uninstalled
 */
const VALID_TRANSITIONS: ReadonlyMap<
  PluginLifecycleState,
  ReadonlySet<PluginLifecycleState>
> = new Map([
  [
    PluginLifecycleState.Discovered,
    new Set([PluginLifecycleState.Installed, PluginLifecycleState.Error]),
  ],
  [
    PluginLifecycleState.Installed,
    new Set([
      PluginLifecycleState.Activated,
      PluginLifecycleState.Uninstalled,
      PluginLifecycleState.Error,
    ]),
  ],
  [
    PluginLifecycleState.Activated,
    new Set([
      PluginLifecycleState.Mounted,
      PluginLifecycleState.Deactivated,
      PluginLifecycleState.Error,
    ]),
  ],
  [
    PluginLifecycleState.Mounted,
    new Set([PluginLifecycleState.Deactivated, PluginLifecycleState.Error]),
  ],
  [
    PluginLifecycleState.Deactivated,
    new Set([
      PluginLifecycleState.Activated,
      PluginLifecycleState.Unmounted,
      PluginLifecycleState.Uninstalled,
      PluginLifecycleState.Error,
    ]),
  ],
  [
    PluginLifecycleState.Unmounted,
    new Set([PluginLifecycleState.Uninstalled, PluginLifecycleState.Error]),
  ],
  [PluginLifecycleState.Uninstalled, new Set()],
  [
    PluginLifecycleState.Error,
    new Set([PluginLifecycleState.Uninstalled]),
  ],
]);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Subset of lifecycle hooks that take no arguments. */
type NoArgHook = Extract<
  keyof IPluginLifecycleHooks,
  | 'onInstall'
  | 'onActivate'
  | 'onMounted'
  | 'onDeactivate'
  | 'onUnmounted'
  | 'onUninstall'
>;

// ─────────────────────────────────────────────────────────────
// PluginManager implementation
// ─────────────────────────────────────────────────────────────

/**
 * Lifecycle orchestrator that implements {@link IPluginManager}.
 *
 * Responsibilities:
 * 1. **State machine** — enforces the legal transition graph defined
 *    by {@link PluginLifecycleState} and rejects illegal moves.
 * 2. **Orchestration** — calls {@link IPlugin.initialize} and
 *    {@link IPlugin.shutdown} (plus optional lifecycle hooks)
 *    at the correct moments during state transitions.
 * 3. **Error containment** — every lifecycle operation is wrapped in
 *    a try-catch boundary so a single plugin failure does not
 *    cascade to others.
 */
export class PluginManager implements IPluginManager {
  readonly #registry: IPluginRegistry;
  readonly #events: IEventBus;
  readonly #hostApi: IHostAPI;
  readonly #logger: ILogger;

  /** Authoritative state — keyed by plugin ID. */
  readonly #states = new Map<string, PluginLifecycleState>();

  /** Administrative enable / disable flag per plugin. */
  readonly #enabled = new Map<string, boolean>();

  /** Cached context objects created once per installed plugin. */
  readonly #contexts = new Map<string, IPluginContext>();

  constructor(
    registry: IPluginRegistry,
    events: IEventBus,
    hostApi: IHostAPI,
    logger: ILogger,
  ) {
    this.#registry = registry;
    this.#events = events;
    this.#hostApi = hostApi;
    this.#logger = logger;
  }

  // ── load ─────────────────────────────────────────────────

  async load(manifest: IPluginManifest): Promise<IPlugin> {
    if (this.#registry.has(manifest.id)) {
      throw new Error(
        `PluginManager: plugin "${manifest.id}" is already loaded.`,
      );
    }

    if (!manifest.entryPoint) {
      throw new Error(
        `PluginManager: manifest for "${manifest.id}" has no entryPoint.`,
      );
    }

    let plugin: IPlugin;

    try {
      const mod: Record<string, unknown> = await import(manifest.entryPoint);
      const exported = mod['default'] ?? mod;
      plugin =
        typeof exported === 'function'
          ? (exported as (m: IPluginManifest) => IPlugin)(manifest)
          : (exported as IPlugin);
    } catch (err) {
      this.#logger.error(
        `Failed to load plugin "${manifest.id}" from "${manifest.entryPoint}"`,
        err,
      );
      throw new Error(
        `PluginManager: failed to load plugin "${manifest.id}".`,
        { cause: err },
      );
    }

    this.#registry.register(plugin);
    this.#states.set(manifest.id, PluginLifecycleState.Discovered);
    this.#enabled.set(manifest.id, plugin.isEnabled);

    this.#logger.info(`Plugin "${manifest.id}" loaded (Discovered).`);
    await this.#emitLifecycleEvent(manifest.id, PluginLifecycleState.Discovered);

    return plugin;
  }

  // ── unload ───────────────────────────────────────────────

  async unload(pluginId: string): Promise<void> {
    this.#requirePlugin(pluginId);
    const state = this.#states.get(pluginId)!;

    // Gracefully tear down if still running.
    if (
      state === PluginLifecycleState.Activated ||
      state === PluginLifecycleState.Mounted
    ) {
      await this.deactivate(pluginId);
    }

    this.#registry.unregister(pluginId);
    this.#states.delete(pluginId);
    this.#enabled.delete(pluginId);
    this.#contexts.delete(pluginId);

    this.#logger.info(`Plugin "${pluginId}" unloaded.`);
  }

  // ── install ──────────────────────────────────────────────

  async install(manifest: IPluginManifest): Promise<IPlugin> {
    // Adopt a pre-registered plugin that the manager doesn't track yet.
    let plugin = this.#registry.get(manifest.id);
    if (plugin && !this.#states.has(manifest.id)) {
      this.#states.set(manifest.id, PluginLifecycleState.Discovered);
      this.#enabled.set(manifest.id, plugin.isEnabled);
    }

    // Dynamic-import path if the plugin isn't in the registry at all.
    if (!plugin) {
      plugin = await this.load(manifest);
    }

    const pluginId = manifest.id;
    this.#assertTransition(pluginId, PluginLifecycleState.Installed);

    const context = this.#createContext(manifest);
    this.#contexts.set(pluginId, context);

    try {
      await this.#callHook(plugin, 'onInstall');
      await plugin.initialize(context);

      this.#setState(pluginId, PluginLifecycleState.Installed);
      this.#logger.info(`Plugin "${pluginId}" installed.`);
      await this.#emitLifecycleEvent(pluginId, PluginLifecycleState.Installed);
    } catch (err) {
      this.#setState(pluginId, PluginLifecycleState.Error);
      this.#logger.error(
        `Plugin "${pluginId}" failed during installation.`,
        err,
      );
      await this.#emitLifecycleEvent(pluginId, PluginLifecycleState.Error);
      throw new Error(
        `PluginManager: plugin "${pluginId}" failed to install.`,
        { cause: err },
      );
    }

    return plugin;
  }

  // ── uninstall ────────────────────────────────────────────

  async uninstall(pluginId: string): Promise<void> {
    const plugin = this.#requirePlugin(pluginId);
    const state = this.#states.get(pluginId)!;

    // Auto-deactivate if still running.
    if (
      state === PluginLifecycleState.Activated ||
      state === PluginLifecycleState.Mounted
    ) {
      await this.deactivate(pluginId);
    }

    this.#assertTransition(pluginId, PluginLifecycleState.Uninstalled);

    try {
      await this.#callHook(plugin, 'onUninstall');

      this.#setState(pluginId, PluginLifecycleState.Uninstalled);
      this.#logger.info(`Plugin "${pluginId}" uninstalled.`);
      await this.#emitLifecycleEvent(
        pluginId,
        PluginLifecycleState.Uninstalled,
      );
    } catch (err) {
      this.#setState(pluginId, PluginLifecycleState.Error);
      this.#logger.error(
        `Plugin "${pluginId}" failed during uninstallation.`,
        err,
      );
      await this.#emitLifecycleEvent(pluginId, PluginLifecycleState.Error);
      throw new Error(
        `PluginManager: plugin "${pluginId}" failed to uninstall.`,
        { cause: err },
      );
    }

    // Clean up internal bookkeeping.
    this.#registry.unregister(pluginId);
    this.#states.delete(pluginId);
    this.#enabled.delete(pluginId);
    this.#contexts.delete(pluginId);
  }

  // ── activate ─────────────────────────────────────────────

  async activate(pluginId: string): Promise<void> {
    const plugin = this.#requirePlugin(pluginId);
    this.#assertTransition(pluginId, PluginLifecycleState.Activated);

    if (!this.#enabled.get(pluginId)) {
      throw new Error(
        `PluginManager: plugin "${pluginId}" is disabled and cannot be activated.`,
      );
    }

    try {
      await this.#callHook(plugin, 'onActivate');

      this.#setState(pluginId, PluginLifecycleState.Activated);
      this.#logger.info(`Plugin "${pluginId}" activated.`);
      await this.#emitLifecycleEvent(
        pluginId,
        PluginLifecycleState.Activated,
      );
    } catch (err) {
      this.#setState(pluginId, PluginLifecycleState.Error);
      this.#logger.error(
        `Plugin "${pluginId}" failed during activation.`,
        err,
      );
      await this.#emitLifecycleEvent(pluginId, PluginLifecycleState.Error);
      throw new Error(
        `PluginManager: plugin "${pluginId}" failed to activate.`,
        { cause: err },
      );
    }
  }

  // ── deactivate ───────────────────────────────────────────

  async deactivate(pluginId: string): Promise<void> {
    const plugin = this.#requirePlugin(pluginId);
    this.#assertTransition(pluginId, PluginLifecycleState.Deactivated);

    try {
      await this.#callHook(plugin, 'onDeactivate');
      await plugin.shutdown();

      this.#setState(pluginId, PluginLifecycleState.Deactivated);
      this.#logger.info(`Plugin "${pluginId}" deactivated.`);
      await this.#emitLifecycleEvent(
        pluginId,
        PluginLifecycleState.Deactivated,
      );
    } catch (err) {
      this.#setState(pluginId, PluginLifecycleState.Error);
      this.#logger.error(
        `Plugin "${pluginId}" failed during deactivation.`,
        err,
      );
      await this.#emitLifecycleEvent(pluginId, PluginLifecycleState.Error);
      throw new Error(
        `PluginManager: plugin "${pluginId}" failed to deactivate.`,
        { cause: err },
      );
    }
  }

  // ── enable / disable ─────────────────────────────────────

  async enable(pluginId: string): Promise<void> {
    this.#requirePlugin(pluginId);
    this.#enabled.set(pluginId, true);
    this.#logger.info(`Plugin "${pluginId}" enabled.`);
  }

  async disable(pluginId: string): Promise<void> {
    this.#requirePlugin(pluginId);
    const state = this.#states.get(pluginId);

    // Kill-switch: deactivate if currently running.
    if (
      state === PluginLifecycleState.Activated ||
      state === PluginLifecycleState.Mounted
    ) {
      await this.deactivate(pluginId);
    }

    this.#enabled.set(pluginId, false);
    this.#logger.info(`Plugin "${pluginId}" disabled.`);
  }

  // ── query ────────────────────────────────────────────────

  getPlugin(pluginId: string): IPlugin | undefined {
    return this.#registry.get(pluginId);
  }

  getAllPlugins(): readonly IPlugin[] {
    return this.#registry.getAll();
  }

  getState(pluginId: string): PluginLifecycleState | undefined {
    return this.#states.get(pluginId);
  }

  // ── private: plugin lookup ───────────────────────────────

  #requirePlugin(pluginId: string): IPlugin {
    const plugin = this.#registry.get(pluginId);
    if (!plugin) {
      throw new Error(
        `PluginManager: plugin "${pluginId}" is not loaded.`,
      );
    }
    return plugin;
  }

  // ── private: state machine ───────────────────────────────

  #assertTransition(
    pluginId: string,
    target: PluginLifecycleState,
  ): void {
    const current = this.#states.get(pluginId);
    if (current === undefined) {
      throw new Error(
        `PluginManager: plugin "${pluginId}" has no tracked state.`,
      );
    }

    const allowed = VALID_TRANSITIONS.get(current);
    if (!allowed?.has(target)) {
      throw new Error(
        `PluginManager: invalid transition "${current}" → "${target}" for plugin "${pluginId}".`,
      );
    }
  }

  #setState(pluginId: string, state: PluginLifecycleState): void {
    this.#states.set(pluginId, state);
  }

  // ── private: lifecycle hooks ─────────────────────────────

  async #callHook(plugin: IPlugin, hook: NoArgHook): Promise<void> {
    const fn = (plugin as unknown as Record<string, unknown>)[hook];
    if (typeof fn === 'function') {
      await (fn as () => Promise<void>).call(plugin);
    }
  }

  // ── private: context factory ─────────────────────────────

  #createContext(manifest: IPluginManifest): IPluginContext {
    return createPluginContext(manifest, this.#hostApi);
  }

  // ── private: event emission ──────────────────────────────

  async #emitLifecycleEvent(
    pluginId: string,
    state: PluginLifecycleState,
  ): Promise<void> {
    try {
      await this.#events.emit({
        id: randomUUID(),
        type: `plugin.${state}`,
        category: EventCategory.Lifecycle,
        timestamp: Date.now(),
        source: 'plugin-manager',
        deliveryStrategy: EventDeliveryStrategy.Notification,
        payload: { pluginId, state },
      });
    } catch {
      // Lifecycle event emission must never disrupt the operation itself.
      this.#logger.warn(
        `Failed to emit lifecycle event for plugin "${pluginId}" (${state}).`,
      );
    }
  }
}
