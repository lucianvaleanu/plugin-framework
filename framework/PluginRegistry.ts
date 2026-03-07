import type { IPlugin, IPluginRegistry } from './interfaces.js';

// ─────────────────────────────────────────────────────────────
// PluginRegistry implementation
// ─────────────────────────────────────────────────────────────

/**
 * In-memory CRUD container for plugins, implementing
 * {@link IPluginRegistry}.
 *
 * Uses a simple `Map<pluginId, IPlugin>` as the backing store.
 * No caching, no lifecycle logic — just storage and lookup.
 */
export class PluginRegistry implements IPluginRegistry {
  readonly #plugins = new Map<string, IPlugin>();

  register(plugin: IPlugin): void {
    const id = plugin.manifest.id;
    if (this.#plugins.has(id)) {
      throw new Error(
        `PluginRegistry: plugin "${id}" is already registered.`,
      );
    }
    this.#plugins.set(id, plugin);
  }

  unregister(pluginId: string): boolean {
    return this.#plugins.delete(pluginId);
  }

  get(pluginId: string): IPlugin | undefined {
    return this.#plugins.get(pluginId);
  }

  getAll(): readonly IPlugin[] {
    return [...this.#plugins.values()];
  }

  has(pluginId: string): boolean {
    return this.#plugins.has(pluginId);
  }

  filter(predicate: (plugin: IPlugin) => boolean): readonly IPlugin[] {
    return [...this.#plugins.values()].filter(predicate);
  }

  findByCapability(capability: string): readonly IPlugin[] {
    return this.filter(
      (plugin) => plugin.manifest.capabilities?.includes(capability) ?? false,
    );
  }
}
