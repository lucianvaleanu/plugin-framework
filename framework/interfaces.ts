// ─────────────────────────────────────────────────────────────
// Plugin Framework – Core Type Definitions
// ─────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════
//  1. Enumerations
// ════════════════════════════════════════════════════════════

/**
 * Represents the discrete states a plugin transitions through
 * during its managed lifecycle within the host application.
 *
 * Transition order (happy path):
 *   Discovered → Installed → Activated → Mounted
 *   Mounted → Deactivated → Unmounted → Uninstalled
 *
 * Any state may transition to `Error`.
 */
export enum PluginLifecycleState {
  /** Host has identified the plugin via manifest scanning; no code executed. */
  Discovered = 'discovered',
  /** One-time setup tasks (e.g. schema migration) have completed. */
  Installed = 'installed',
  /** Plugin is prepared for runtime; services and listeners registered. */
  Activated = 'activated',
  /** Primary logic or UI is rendered / invoked. */
  Mounted = 'mounted',
  /** Features disabled gracefully; background tasks stopped. */
  Deactivated = 'deactivated',
  /** UI elements removed; transient memory cleaned up. */
  Unmounted = 'unmounted',
  /** All persistent data and resources fully removed. */
  Uninstalled = 'uninstalled',
  /** An unrecoverable error occurred during a lifecycle transition. */
  Error = 'error',
}

/** Categorises events for efficient routing and filtering. */
export enum EventCategory {
  /** Reflects significant changes in business state (e.g. OrderPlaced). */
  Domain = 'domain',
  /** Facilitates communication across module boundaries. */
  Integration = 'integration',
  /** Relates to infrastructure health and environment changes. */
  System = 'system',
  /** Triggered by the passage of time or reaching a deadline. */
  Temporal = 'temporal',
  /** Signals stages in the existence of a framework entity. */
  Lifecycle = 'lifecycle',
  /** Captures human interactions for analytics or UI logic. */
  UserInterface = 'ui',
}

/** Determines how a service instance is created and shared. */
export enum ServiceScope {
  /** A single instance shared by all consumers (connection pools, etc.). */
  Root = 'root',
  /** A unique instance per consuming plugin — prevents state leakage. */
  Plugin = 'plugin',
  /** A fresh instance for every resolution request. */
  Transient = 'transient',
}

/**
 * Controls how much data an event carries.
 *
 * - `Notification` – a "tap on the shoulder"; consumers must query
 *   the host API for full details.
 * - `StateTransfer` – the event payload contains the full data
 *   snapshot, enabling immediate processing without a callback.
 */
export enum EventDeliveryStrategy {
  Notification = 'notification',
  StateTransfer = 'state-transfer',
}

// ════════════════════════════════════════════════════════════
//  2. Utility Contracts
// ════════════════════════════════════════════════════════════

/** A resource that can be deterministically cleaned up. */
export interface IDisposable {
  dispose(): void;
}

/** Outcome of a validation check. */
export interface IValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

// ════════════════════════════════════════════════════════════
//  3. Plugin Metadata / Manifest
// ════════════════════════════════════════════════════════════

/** Attribution and contact details for the plugin author. */
export interface IPluginAuthor {
  readonly name: string;
  readonly email?: string | undefined;
  readonly url?: string | undefined;
}

/** A dependency on another plugin or on the host itself. */
export interface IDependencyRequirement {
  /** Identifier of the required plugin (or `"host"` for the framework). */
  readonly id: string;
  /** SemVer range string (e.g. `"^2.0.0"`). */
  readonly version: string;
}

/** Execution environment constraints. */
export interface IRuntimeRequirement {
  /** Engine name (e.g. `"node"`, `"deno"`, `"bun"`). */
  readonly engine: string;
  /** SemVer range the engine version must satisfy. */
  readonly version: string;
}

/**
 * The declarative manifest that describes a plugin's identity,
 * requirements, and capabilities without executing any code.
 *
 * Typically materialised from a JSON / YAML / TOML file shipped
 * alongside the plugin module.
 */
export interface IPluginManifest {
  /** A globally unique identifier used for internal routing. */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** SemVer version string (MAJOR.MINOR.PATCH). */
  readonly version: string;
  /** Short human-readable description. */
  readonly description: string;
  /**
   * Semantic description of the plugin's purpose for AI / LLM
   * orchestrators, enabling cognitive plugin discovery.
   */
  readonly descriptionForModel?: string | undefined;
  /** Plugin author / maintainer information. */
  readonly author: IPluginAuthor;
  /** Plugins or host versions this plugin depends on. */
  readonly dependencies?: readonly IDependencyRequirement[] | undefined;
  /** Host APIs and services the plugin intends to consume. */
  readonly capabilities?: readonly string[] | undefined;
  /** Execution environment requirements. */
  readonly runtime?: IRuntimeRequirement | undefined;
  /** Allow-list of network domains or system resources needed. */
  readonly permissions?: readonly string[] | undefined;
  /**
   * Execution priority — higher values run first.
   * Used to resolve implicit ordering between plugins.
   */
  readonly priority?: number | undefined;
  /** Free-form tags for categorisation and search. */
  readonly tags?: readonly string[] | undefined;
  /** Absolute or relative path to the plugin entry-point module. */
  readonly entryPoint?: string | undefined;
}

// ════════════════════════════════════════════════════════════
//  4. Logging, Storage & Configuration
// ════════════════════════════════════════════════════════════

/** Unified logging service provided by the host. */
export interface ILogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Asynchronous key-value storage abstraction.
 * Plugins use this to persist settings and data without caring
 * about the underlying storage backend.
 */
export interface IStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
}

/** Read-only access to configuration values. */
export interface IConfigProvider {
  get<T = unknown>(key: string, defaultValue?: T): T | undefined;
  has(key: string): boolean;
  getAll(): Readonly<Record<string, unknown>>;
}

// ════════════════════════════════════════════════════════════
//  5. Event System
// ════════════════════════════════════════════════════════════

/** An immutable event envelope routed through the framework. */
export interface IEvent<TPayload = unknown> {
  /** Unique event identifier. */
  readonly id: string;
  /** Dot-namespaced event type (e.g. `"order.placed"`). */
  readonly type: string;
  /** Broad classification for routing / filtering. */
  readonly category: EventCategory;
  /** Unix-epoch millisecond timestamp of creation. */
  readonly timestamp: number;
  /** Identifier of the emitting plugin or `"host"`. */
  readonly source: string;
  /** Notification-only or full state transfer. */
  readonly deliveryStrategy: EventDeliveryStrategy;
  /** Event data — shape depends on the event type. */
  readonly payload: TPayload;
}

/**
 * Convenience type for creating events — `id` and `timestamp`
 * are optional and will be auto-generated when omitted.
 */
export type EventInit<TPayload = unknown> = Omit<
  IEvent<TPayload>,
  'id' | 'timestamp'
> & {
  id?: string | undefined;
  timestamp?: number | undefined;
};

/** Callback invoked when a matching event is emitted. */
export type EventHandler<TPayload = unknown> = (
  event: IEvent<TPayload>,
) => void | Promise<void>;

/** A handle to an active event subscription; supports unsubscribing. */
export interface IEventSubscription extends IDisposable {
  readonly id: string;
  readonly eventType: string;
  /** Alias for `dispose()`. */
  unsubscribe(): void;
}

/**
 * The central event bus — the "traffic controller" that routes
 * events from producers to consumers.
 */
export interface IEventBus {
  /** Broadcast an event to all matching subscribers. */
  emit<TPayload = unknown>(event: IEvent<TPayload>): Promise<void>;

  /** Subscribe to every occurrence of `eventType`. */
  on<TPayload = unknown>(
    eventType: string,
    handler: EventHandler<TPayload>,
  ): IEventSubscription;

  /** Subscribe to the next single occurrence of `eventType`. */
  once<TPayload = unknown>(
    eventType: string,
    handler: EventHandler<TPayload>,
  ): IEventSubscription;

  /** Remove a subscription by its unique ID. */
  off(subscriptionId: string): void;

  /** Remove all subscriptions, optionally scoped to an event type. */
  offAll(eventType?: string): void;

  /** List active subscriptions, optionally filtered by type. */
  listSubscriptions(eventType?: string): readonly IEventSubscription[];
}

// ════════════════════════════════════════════════════════════
//  6. Service Registry (Dependency Injection)
// ════════════════════════════════════════════════════════════

/**
 * Describes a service that can be registered with the framework.
 *
 * @typeParam T – the public interface of the service.
 */
export interface IServiceDescriptor<T = unknown> {
  /** Globally unique service identifier (e.g. `"core.logger"`). */
  readonly id: string;
  /** Lifetime / sharing strategy. */
  readonly scope: ServiceScope;
  /** Factory that produces the service instance. */
  readonly factory: (context: IPluginContext) => T | Promise<T>;
  /** Optional SemVer version of the service. */
  readonly version?: string | undefined;
  /** ID of the plugin that provides this service (`undefined` for host-provided). */
  readonly provider?: string | undefined;
}

/**
 * Central directory of available services.
 * Supports registration, resolution, and discovery.
 */
export interface IServiceRegistry {
  /** Register a new service descriptor. */
  register<T>(descriptor: IServiceDescriptor<T>): void;
  /** Remove a previously registered service. Returns `true` if found. */
  unregister(serviceId: string): boolean;
  /** Resolve a service instance by ID. */
  resolve<T = unknown>(serviceId: string): Promise<T>;
  /** Check whether a service is registered. */
  has(serviceId: string): boolean;
  /** List all registered service descriptors. */
  list(): readonly IServiceDescriptor[];
}

// ════════════════════════════════════════════════════════════
//  7. Host API & Contexts
// ════════════════════════════════════════════════════════════

/**
 * The permanent surface area the host exposes to plugins.
 * Provides access to every shared infrastructure service.
 */
export interface IHostAPI {
  readonly logger: ILogger;
  readonly storage: IStorage;
  readonly config: IConfigProvider;
  readonly events: IEventBus;
  readonly services: IServiceRegistry;
}

/**
 * Context object provided to a plugin during `initialize()`.
 * Contains everything the plugin needs to bootstrap itself.
 */
export interface IPluginContext {
  /** Full host API surface. */
  readonly host: IHostAPI;
  /** The plugin's own manifest (read-only mirror). */
  readonly manifest: Readonly<IPluginManifest>;
  /** Pre-scoped logger tagged with the plugin's ID. */
  readonly logger: ILogger;
  /** Plugin-scoped persistent storage. */
  readonly storage: IStorage;
}

/**
 * Transient execution context passed to `execute()`.
 * Follows the extensible "Bag" pattern — plugins may attach
 * arbitrary properties for downstream consumers.
 */
export interface IHostContext {
  /** Unique identifier for this execution / transaction. */
  readonly requestId: string;
  /** Unix-epoch millisecond timestamp when the context was created. */
  readonly timestamp: number;

  /** Retrieve a value from the context bag. */
  get<T = unknown>(key: string): T | undefined;
  /** Attach or overwrite a value in the context bag. */
  set(key: string, value: unknown): void;
  /** Check whether a key exists in the context bag. */
  has(key: string): boolean;
  /** Remove a key from the context bag. */
  delete(key: string): boolean;
}

// ════════════════════════════════════════════════════════════
//  8. Plugin Execution Options
// ════════════════════════════════════════════════════════════

/** Per-invocation options that govern how a plugin is executed. */
export interface IPluginExecutionOptions {
  /** Maximum wall-clock milliseconds before the call is aborted. */
  readonly timeout?: number | undefined;
  /** Number of automatic retry attempts on failure. */
  readonly retries?: number | undefined;
  /** Execution priority override (higher = sooner). */
  readonly priority?: number | undefined;
}

// ════════════════════════════════════════════════════════════
//  9. Plugin Contract
// ════════════════════════════════════════════════════════════

/**
 * The core contract every plugin **must** implement.
 *
 * Provides the host with a universal interface for discovery,
 * initialisation, execution, and teardown — regardless of what
 * the plugin does internally.
 */
export interface IPlugin {
  // ── Identity & State ──────────────────────────────────────

  /** The plugin's declarative manifest. */
  readonly manifest: IPluginManifest;
  /** Current position in the lifecycle state machine. */
  readonly state: PluginLifecycleState;
  /** Whether the plugin is administratively enabled. */
  readonly isEnabled: boolean;
  /** Whether the plugin has completed initialisation and is ready to execute. */
  readonly isReady: boolean;

  // ── Core Methods ──────────────────────────────────────────

  /**
   * Entry point called by the host to provide resources and
   * dependencies. The plugin should register its own capabilities
   * and prepare internal state here.
   */
  initialize(context: IPluginContext): Promise<void>;

  /**
   * Perform the primary task of the plugin.
   * Runs asynchronously to avoid blocking the host's main thread.
   *
   * @typeParam TInput  – shape of the incoming data
   * @typeParam TOutput – shape of the result
   */
  execute<TInput = unknown, TOutput = unknown>(
    input: TInput,
    context?: IHostContext,
  ): Promise<TOutput>;

  /**
   * Update the plugin's behaviour based on external configuration
   * or user input. May be called multiple times while the plugin
   * is active.
   */
  configure(settings: Record<string, unknown>): Promise<void>;

  /**
   * Lets the host ask whether this plugin can process a given
   * input type before routing work to it (Strategy pattern).
   */
  canHandle(inputType: string): boolean;

  /**
   * Graceful shutdown — release resources, close connections,
   * persist transient data, and unsubscribe from events.
   */
  shutdown(): Promise<void>;
}

// ════════════════════════════════════════════════════════════
//  10. Lifecycle Hooks (optional, mix-in)
// ════════════════════════════════════════════════════════════

/**
 * Optional lifecycle hooks a plugin may implement.
 * The host invokes these at well-defined points during the
 * plugin's lifecycle transitions.
 *
 * Cleanup hooks (`onDeactivate`, `onUnmounted`, `onUninstall`)
 * are critical for preventing memory leaks and must
 * unsubscribe listeners, stop timers, and release handles.
 */
export interface IPluginLifecycleHooks {
  /** One-time setup tasks (e.g. database migrations). */
  onInstall?(): Promise<void>;
  /** Preparing for runtime; registering services and listeners. */
  onActivate?(): Promise<void>;
  /** Primary logic or UI is rendered / invoked. */
  onMounted?(): Promise<void>;
  /**
   * Called *before* an update is applied.
   * Return `false` to cancel the update (conditional execution).
   */
  onBeforeUpdate?(
    oldState: unknown,
    newState: unknown,
  ): Promise<boolean>;
  /** Respond to changes in host configuration or reactive data. */
  onUpdate?(oldState: unknown, newState: unknown): Promise<void>;
  /** Disable features gracefully; stop background tasks. */
  onDeactivate?(): Promise<void>;
  /** Remove UI elements; clean up transient memory. */
  onUnmounted?(): Promise<void>;
  /** Full removal of data and persistent resources. */
  onUninstall?(): Promise<void>;
}

/**
 * Convenience intersection: a plugin that supports
 * both the core contract and the optional lifecycle hooks.
 */
export type IPluginWithLifecycle = IPlugin & IPluginLifecycleHooks;

// ════════════════════════════════════════════════════════════
//  11. Plugin Registry
// ════════════════════════════════════════════════════════════

/**
 * In-memory directory of all known plugins.
 * Supports registration, lookup, and filtered queries.
 */
export interface IPluginRegistry {
  /** Add a plugin to the registry. */
  register(plugin: IPlugin): void;
  /** Remove a plugin by ID. Returns `true` if it existed. */
  unregister(pluginId: string): boolean;
  /** Retrieve a single plugin by ID. */
  get(pluginId: string): IPlugin | undefined;
  /** Retrieve every registered plugin. */
  getAll(): readonly IPlugin[];
  /** Check whether a plugin is registered. */
  has(pluginId: string): boolean;
  /** Return all plugins matching a predicate. */
  filter(predicate: (plugin: IPlugin) => boolean): readonly IPlugin[];
  /** Return all plugins that declare a given capability. */
  findByCapability(capability: string): readonly IPlugin[];
}

// ════════════════════════════════════════════════════════════
//  12. Plugin Manager (Lifecycle Orchestrator)
// ════════════════════════════════════════════════════════════

/**
 * Orchestrates the full lifecycle of plugins — from loading
 * through activation to eventual uninstallation.
 *
 * Responsible for dependency resolution, ordering, and
 * error containment (try-catch boundaries around plugin calls).
 */
export interface IPluginManager {
  /** Load and instantiate a plugin from its manifest. */
  load(manifest: IPluginManifest): Promise<IPlugin>;
  /** Unload and dispose a plugin, reclaiming its resources. */
  unload(pluginId: string): Promise<void>;

  /** Run the one-time installation procedure. */
  install(manifest: IPluginManifest): Promise<IPlugin>;
  /** Fully remove a plugin and its persistent data. */
  uninstall(pluginId: string): Promise<void>;

  /** Activate a previously installed plugin. */
  activate(pluginId: string): Promise<void>;
  /** Deactivate a running plugin without uninstalling it. */
  deactivate(pluginId: string): Promise<void>;

  /** Administratively enable a plugin. */
  enable(pluginId: string): Promise<void>;
  /** Administratively disable a plugin (kill-switch). */
  disable(pluginId: string): Promise<void>;

  /** Retrieve a loaded plugin by ID. */
  getPlugin(pluginId: string): IPlugin | undefined;
  /** Retrieve every loaded plugin. */
  getAllPlugins(): readonly IPlugin[];
  /** Query the current lifecycle state of a plugin. */
  getState(pluginId: string): PluginLifecycleState | undefined;
}

// ════════════════════════════════════════════════════════════
//  13. Security & Isolation
// ════════════════════════════════════════════════════════════

/**
 * A sandbox that constrains what a plugin is allowed to do.
 * Permissions are drawn from the plugin's manifest allow-list.
 */
export interface IPluginSandbox {
  readonly pluginId: string;
  readonly permissions: ReadonlySet<string>;

  /** Check whether a specific permission was granted. */
  hasPermission(permission: string): boolean;
  /** Determine whether access to a named resource is allowed. */
  validateAccess(resource: string): boolean;
}

/** Validates manifests and (optionally) cryptographic signatures. */
export interface IPluginValidator {
  /** Validate a manifest's structural and semantic correctness. */
  validateManifest(manifest: IPluginManifest): IValidationResult;
  /**
   * Verify a cryptographic signature over the plugin's binaries
   * to ensure only approved code is executed.
   */
  validateSignature?(
    pluginId: string,
    signature: string,
  ): Promise<boolean>;
}

// ════════════════════════════════════════════════════════════
//  14. UI Extensibility (SlotFill)
// ════════════════════════════════════════════════════════════

/**
 * A named placeholder in the host's UI layout where
 * plugin-provided components (Fills) are projected.
 */
export interface ISlot {
  /** Unique slot identifier. */
  readonly id: string;
  /** Human-readable name (e.g. "PluginSidebar"). */
  readonly name: string;
  /** Optional description of what content is expected. */
  readonly description?: string | undefined;
  /** Whether the slot accepts more than one Fill. */
  readonly allowMultiple: boolean;
}

/**
 * A UI fragment provided by a plugin that targets a specific Slot.
 * The `component` is kept as `unknown` to remain UI-framework-agnostic.
 */
export interface IFill {
  readonly slotId: string;
  readonly pluginId: string;
  /** Render priority within the slot (higher = rendered first). */
  readonly priority?: number | undefined;
  /** The renderable component — React element, DOM node, etc. */
  readonly component: unknown;
}

/** Registry that pairs Slots with their Fills. */
export interface IUIExtensionRegistry {
  registerSlot(slot: ISlot): void;
  registerFill(fill: IFill): void;
  unregisterFill(slotId: string, pluginId: string): void;
  getFills(slotId: string): readonly IFill[];
  getSlots(): readonly ISlot[];
}

// ════════════════════════════════════════════════════════════
//  15. Plugin Host (Top-Level Orchestrator)
// ════════════════════════════════════════════════════════════

/**
 * The root object that owns and orchestrates the entire plugin
 * framework — wiring together the manager, registry, event bus,
 * service registry, and host API into a cohesive runtime.
 */
export interface IPluginHost {
  readonly api: IHostAPI;
  readonly manager: IPluginManager;
  readonly registry: IPluginRegistry;
  readonly events: IEventBus;
  readonly services: IServiceRegistry;

  /** Bootstrap the host and activate all auto-start plugins. */
  start(): Promise<void>;
  /** Gracefully shut down every plugin and release resources. */
  stop(): Promise<void>;
  /** Create a fresh transient execution context. */
  createContext(): IHostContext;
}
