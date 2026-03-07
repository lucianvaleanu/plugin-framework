import { randomUUID } from 'node:crypto';

import type {
  EventHandler,
  IEvent,
  IEventBus,
  IEventSubscription,
} from './interfaces.js';

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/** A subscription handle backed by the bus that created it. */
class EventSubscription implements IEventSubscription {
  readonly id: string;
  readonly eventType: string;

  #disposed = false;
  readonly #removeSelf: () => void;

  constructor(eventType: string, removeSelf: () => void) {
    this.id = randomUUID();
    this.eventType = eventType;
    this.#removeSelf = removeSelf;
  }

  unsubscribe(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#removeSelf();
  }
}

/** Internal record kept per subscription in the bus. */
interface SubscriptionRecord {
  readonly subscription: EventSubscription;
  readonly handler: EventHandler<any>;
  /** If `true`, the handler is automatically removed after firing once. */
  readonly once: boolean;
}

// ─────────────────────────────────────────────────────────────
// EventBus implementation
// ─────────────────────────────────────────────────────────────

/**
 * A lightweight, in-process event bus that implements {@link IEventBus}.
 *
 * - Handlers for a given event type run sequentially in registration
 *   order (`emit` awaits each handler before moving to the next).
 * - A failing handler does **not** prevent subsequent handlers from
 *   executing — its error is captured and re-thrown as an aggregate
 *   after all handlers have run.
 * - Supports wildcard subscriptions via the special `"*"` event type
 *   which receives every emitted event.
 */
export class EventBus implements IEventBus {
  /**
   * Map of event-type → ordered list of subscription records.
   * The `"*"` key holds wildcard subscribers.
   */
  readonly #listeners = new Map<string, SubscriptionRecord[]>();

  // ── emit ────────────────────────────────────────────────

  async emit<TPayload = unknown>(event: IEvent<TPayload>): Promise<void> {
    const errors: unknown[] = [];

    // Collect matching records: type-specific + wildcards.
    const targets = [
      ...(this.#listeners.get(event.type) ?? []),
      ...(this.#listeners.get('*') ?? []),
    ];

    for (const record of targets) {
      try {
        await record.handler(event);
      } catch (err) {
        errors.push(err);
      } finally {
        if (record.once) {
          record.subscription.dispose();
        }
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `${errors.length} handler(s) failed while processing event "${event.type}"`,
      );
    }
  }

  // ── on / once ───────────────────────────────────────────

  on<TPayload = unknown>(
    eventType: string,
    handler: EventHandler<TPayload>,
  ): IEventSubscription {
    return this.#subscribe(eventType, handler, false);
  }

  once<TPayload = unknown>(
    eventType: string,
    handler: EventHandler<TPayload>,
  ): IEventSubscription {
    return this.#subscribe(eventType, handler, true);
  }

  // ── off / offAll ────────────────────────────────────────

  off(subscriptionId: string): void {
    for (const [eventType, records] of this.#listeners) {
      const idx = records.findIndex((r) => r.subscription.id === subscriptionId);
      if (idx !== -1) {
        records.splice(idx, 1);
        if (records.length === 0) this.#listeners.delete(eventType);
        return;
      }
    }
  }

  offAll(eventType?: string): void {
    if (eventType !== undefined) {
      this.#listeners.delete(eventType);
    } else {
      this.#listeners.clear();
    }
  }

  // ── query ───────────────────────────────────────────────

  listSubscriptions(eventType?: string): readonly IEventSubscription[] {
    if (eventType !== undefined) {
      return (this.#listeners.get(eventType) ?? []).map(
        (r) => r.subscription,
      );
    }

    const all: IEventSubscription[] = [];
    for (const records of this.#listeners.values()) {
      for (const r of records) {
        all.push(r.subscription);
      }
    }
    return all;
  }

  // ── private ─────────────────────────────────────────────

  #subscribe<TPayload>(
    eventType: string,
    handler: EventHandler<TPayload>,
    once: boolean,
  ): IEventSubscription {
    const subscription = new EventSubscription(eventType, () =>
      this.off(subscription.id),
    );

    const record: SubscriptionRecord = { subscription, handler, once };

    let records = this.#listeners.get(eventType);
    if (!records) {
      records = [];
      this.#listeners.set(eventType, records);
    }
    records.push(record);

    return subscription;
  }
}
