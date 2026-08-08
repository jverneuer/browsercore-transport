/**
 * Typed event emitter — a type-safe wrapper over an injected EventProvider.
 *
 * The public type {@link TypedEventEmitter} is re-exported from
 * @browsercore/contracts (single source of truth). The implementation
 * delegates to an injected {@link EventProvider} so the backend is swappable
 * (Node EventEmitter, EventTarget, mock) without changing consumer code.
 *
 * @module
 */

import type { EventProvider, TypedEventEmitter } from "@browsercore/contracts";

/**
 * Concrete implementation of {@link TypedEventEmitter}.
 *
 * Wraps an injected {@link EventProvider} (composition rather than inheritance)
 * so that only the typed interface is exposed. Keeping the base class methods
 * off the public surface means the backend is fully swappable.
 *
 * This class is not exported directly — use {@link createTypedEventEmitter} to
 * create instances so the backend remains swappable.
 *
 * @template T - The event map.
 */
class TypedEventEmitterImpl<T extends Record<string, (...args: readonly unknown[]) => void>> implements TypedEventEmitter<T> {
    constructor(private readonly events: EventProvider) {}

    on<K extends keyof T>(event: K, listener: T[K]): this {
        this.events.on(event as string, listener as (...args: readonly unknown[]) => void);
        return this;
    }

    once<K extends keyof T>(event: K, listener: T[K]): this {
        this.events.once(event as string, listener as (...args: readonly unknown[]) => void);
        return this;
    }

    off<K extends keyof T>(event: K, listener: T[K]): this {
        this.events.off(event as string, listener as (...args: readonly unknown[]) => void);
        return this;
    }

    removeListener<K extends keyof T>(event: K, listener: T[K]): this {
        this.events.removeListener(event as string, listener as (...args: readonly unknown[]) => void);
        return this;
    }

    emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): boolean {
        return this.events.emit(event as string, ...args);
    }
}

/**
 * Create a typed event emitter backed by an injected EventProvider.
 *
 * The returned object is a {@link TypedEventEmitter} whose backend is the
 * provider you pass in. Interact only through the typed interface so the
 * emitter can be swapped without changing consumer code.
 *
 * @template T - A map from event names to listener function signatures.
 * @param events - The EventProvider backend (e.g. Node EventEmitter, EventTarget).
 * @returns A typed event emitter instance.
 */
export function createTypedEventEmitter<T extends Record<string, (...args: readonly unknown[]) => void>>(
    events: EventProvider,
): TypedEventEmitter<T> {
    return new TypedEventEmitterImpl<T>(events);
}
