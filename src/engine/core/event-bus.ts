import type { EngineEventName, EventHandler } from '../types';

/**
 * Central event bus for engine ↔ UI communication.
 * All modules emit/subscribe through this singleton to avoid tight coupling.
 */
class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<T = unknown>(event: EngineEventName, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);
    return () => this.handlers.get(event)?.delete(handler as EventHandler);
  }

  /** Subscribe to an event for a single firing, then auto-unsubscribe. */
  once<T = unknown>(event: EngineEventName, handler: EventHandler<T>): () => void {
    const wrapper: EventHandler<T> = (payload) => {
      unsub();
      return handler(payload);
    };
    const unsub = this.on(event, wrapper);
    return unsub;
  }

  /**
   * Emit an event to all subscribers. Errors in handlers are caught and logged.
   *
   * Uses a snapshot copy ([...handlers]) to safely iterate even when
   * handlers mutate the Set during iteration (e.g. once() auto-unsubscribes).
   */
  emit(event: EngineEventName, payload?: unknown): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of [...handlers]) {
        try {
          handler(payload);
        } catch (e) {
          console.error(`[EventBus] Error in handler for ${event}:`, e);
        }
      }
    }
  }

  /** Unsubscribe a specific handler, or all handlers for an event if handler is omitted. */
  off(event: EngineEventName, handler?: EventHandler): void {
    if (!handler) {
      this.handlers.delete(event);
    } else {
      this.handlers.get(event)?.delete(handler);
    }
  }

  /** Clear all subscriptions. */
  clear(): void {
    this.handlers.clear();
  }
}

/** Global singleton — used by both engine modules and UI components */
export const eventBus = new EventBus();
