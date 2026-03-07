import type {
  IPluginContext,
  IServiceDescriptor,
  IServiceRegistry,
} from './interfaces.js';
import { ServiceScope } from './interfaces.js';

// ─────────────────────────────────────────────────────────────
// ServiceRegistry implementation
// ─────────────────────────────────────────────────────────────

/**
 * In-process dependency-injection container that implements
 * {@link IServiceRegistry}.
 *
 * Supports three lifetime scopes:
 *
 * | Scope       | Behaviour                                        |
 * |-------------|--------------------------------------------------|
 * | `Root`      | Single shared instance — created once, cached.   |
 * | `Plugin`    | One instance per consuming plugin — cached by ID.|
 * | `Transient` | Fresh instance on every resolution call.         |
 *
 * The `resolve()` method (from the interface) uses a default
 * host-level context. For plugin-scoped resolution where each
 * plugin receives its own instance, call `resolveForPlugin()`
 * with the consumer's {@link IPluginContext}.
 */
export class ServiceRegistry implements IServiceRegistry {
  /** serviceId → descriptor */
  readonly #descriptors = new Map<string, IServiceDescriptor>();

  /**
   * Root-scoped instance cache.
   * serviceId → singleton instance
   */
  readonly #rootInstances = new Map<string, unknown>();

  /**
   * Plugin-scoped instance cache.
   * serviceId → (pluginId → instance)
   */
  readonly #pluginInstances = new Map<string, Map<string, unknown>>();

  /**
   * A fallback context used by the public `resolve()` method
   * (which has no context parameter in the interface).
   */
  readonly #defaultContext: IPluginContext;

  /** Sentinel plugin-ID used for host-level resolution. */
  static readonly HOST_CONSUMER_ID = '__host__';

  constructor(defaultContext: IPluginContext) {
    this.#defaultContext = defaultContext;
  }

  // ── register ──────────────────────────────────────────────

  register<T>(descriptor: IServiceDescriptor<T>): void {
    if (this.#descriptors.has(descriptor.id)) {
      throw new Error(
        `ServiceRegistry: service "${descriptor.id}" is already registered.`,
      );
    }
    this.#descriptors.set(descriptor.id, descriptor as IServiceDescriptor);
  }

  // ── unregister ────────────────────────────────────────────

  unregister(serviceId: string): boolean {
    if (!this.#descriptors.has(serviceId)) return false;

    this.#descriptors.delete(serviceId);
    this.#rootInstances.delete(serviceId);
    this.#pluginInstances.delete(serviceId);

    return true;
  }

  // ── has ───────────────────────────────────────────────────

  has(serviceId: string): boolean {
    return this.#descriptors.has(serviceId);
  }

  // ── list ──────────────────────────────────────────────────

  list(): readonly IServiceDescriptor[] {
    return [...this.#descriptors.values()];
  }

  // ── resolve (interface method — uses default context) ─────

  async resolve<T = unknown>(serviceId: string): Promise<T> {
    return this.resolveForPlugin<T>(serviceId, this.#defaultContext);
  }

  // ── resolveForPlugin (extended API for plugin-scoped DI) ──

  /**
   * Resolve a service with an explicit consumer context.
   *
   * This allows the registry to maintain per-plugin caches for
   * `Plugin`-scoped services. Framework internals (PluginHost,
   * PluginManager) should use this rather than the bare
   * `resolve()` when acting on behalf of a specific plugin.
   */
  async resolveForPlugin<T = unknown>(
    serviceId: string,
    context: IPluginContext,
  ): Promise<T> {
    const descriptor = this.#descriptors.get(serviceId);
    if (!descriptor) {
      throw new Error(
        `ServiceRegistry: no service registered with id "${serviceId}".`,
      );
    }

    switch (descriptor.scope) {
      case ServiceScope.Root:
        return this.#resolveRoot<T>(descriptor, context);
      case ServiceScope.Plugin:
        return this.#resolvePlugin<T>(descriptor, context);
      case ServiceScope.Transient:
        return this.#resolveTransient<T>(descriptor, context);
      default:
        throw new Error(
          `ServiceRegistry: unknown scope "${String(descriptor.scope)}" for service "${serviceId}".`,
        );
    }
  }

  // ── private resolution helpers ────────────────────────────

  async #resolveRoot<T>(
    descriptor: IServiceDescriptor,
    context: IPluginContext,
  ): Promise<T> {
    const cached = this.#rootInstances.get(descriptor.id);
    if (cached !== undefined) return cached as T;

    const instance = await descriptor.factory(context);
    this.#rootInstances.set(descriptor.id, instance);
    return instance as T;
  }

  async #resolvePlugin<T>(
    descriptor: IServiceDescriptor,
    context: IPluginContext,
  ): Promise<T> {
    const consumerId = context.manifest.id;

    let perPlugin = this.#pluginInstances.get(descriptor.id);
    if (!perPlugin) {
      perPlugin = new Map<string, unknown>();
      this.#pluginInstances.set(descriptor.id, perPlugin);
    }

    const cached = perPlugin.get(consumerId);
    if (cached !== undefined) return cached as T;

    const instance = await descriptor.factory(context);
    perPlugin.set(consumerId, instance);
    return instance as T;
  }

  async #resolveTransient<T>(
    descriptor: IServiceDescriptor,
    context: IPluginContext,
  ): Promise<T> {
    return (await descriptor.factory(context)) as T;
  }
}
