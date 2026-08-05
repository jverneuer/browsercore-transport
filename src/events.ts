/**
 * Typed event emitter — a type-safe wrapper around `node:events.EventEmitter`.
 *
 * The public type {@link TypedEventEmitter} has no `node:events` dependency: it
 * is a pure interface parameterized by an event map. The implementation
 * delegates to Node's {@link EventEmitter} behind the interface, so the backend
 * is swappable without changing any consumer code.
 *
 * @module
 */

import { EventEmitter } from "node:events";

/**
 * A type-safe event emitter parameterized by an event map.
 *
 * `T` maps event names to listener function signatures. The compiler checks
 * every `on`/`once`/`off`/`removeListener`/`emit` call against this map —
 * passing a listener with the wrong parameters, or emitting with the wrong
 * arguments, is a compile error.
 *
 * Example:
 * ```ts
 * type TransportEvents = {
 *     connect: () => void;
 *     data: (chunk: Uint8Array) => void;
 *     error: (err: Error) => void;
 * };
 * const emitter = createTypedEventEmitter<TransportEvents>();
 * emitter.on("data", (chunk) => { /* chunk is Uint8Array * / });
 * emitter.emit("data", new Uint8Array([1, 2, 3]));
 * ```
 *
 * The TYPE has no `node:events` dependency — it is a pure interface. The
 * implementation delegates to Node's {@link EventEmitter} behind the
 * interface.
 *
 * @template T - A map from event names to listener function signatures. Each
 *   value must be a function returning `void`.
 */
export interface TypedEventEmitter<T extends Record<string, (...args: readonly unknown[]) => void>> {
    /**
     * Subscribe to an event.
     *
     * The listener signature is checked against the event map — passing a
     * function with the wrong parameters is a compile error.
     *
     * @param event - The event name.
     * @param listener - The listener function, typed by the event map.
     * @returns `this` for chaining.
     */
    on<K extends keyof T>(event: K, listener: T[K]): this;

    /**
     * Subscribe to a one-shot event.
     *
     * The listener fires on the next emission, then is automatically removed.
     *
     * @param event - The event name.
     * @param listener - The listener function, typed by the event map.
     * @returns `this` for chaining.
     */
    once<K extends keyof T>(event: K, listener: T[K]): this;

    /**
     * Remove a listener from an event.
     *
     * Alias: {@link removeListener}. Both behave identically.
     *
     * @param event - The event name.
     * @param listener - The previously-registered listener to remove.
     * @returns `this` for chaining.
     */
    off<K extends keyof T>(event: K, listener: T[K]): this;

    /**
     * Remove a listener from an event.
     *
     * Alias for {@link off}. Both behave identically.
     *
     * @param event - The event name.
     * @param listener - The previously-registered listener to remove.
     * @returns `this` for chaining.
     */
    removeListener<K extends keyof T>(event: K, listener: T[K]): this;

    /**
     * Emit an event, invoking all registered listeners synchronously.
     *
     * Arguments are checked against the event map — emitting with the wrong
     * number or types of arguments is a compile error.
     *
     * @param event - The event name.
     * @param args - Arguments to pass to each listener, typed by the event map.
     * @returns `true` if the event had at least one listener, `false` otherwise.
     */
    emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): boolean;
}

/**
 * Concrete implementation of {@link TypedEventEmitter}.
 *
 * Wraps a Node {@link EventEmitter} (composition rather than inheritance) so
 * that only the typed interface is exposed. Keeping the base class methods
 * off the public surface means the backend is fully swappable: a different
 * event-emitter implementation could replace `EventEmitter` without any
 * consumer noticing.
 *
 * This class is not exported directly — use {@link createTypedEventEmitter} to
 * create instances so the backend remains swappable.
 *
 * @template T - The event map.
 */
class TypedEventEmitterImpl<T extends Record<string, (...args: readonly unknown[]) => void>> implements TypedEventEmitter<T> {
    /** The underlying Node event emitter — private so only typed methods are reachable. */
    private readonly emitter = new EventEmitter();

    on<K extends keyof T>(event: K, listener: T[K]): this {
        this.emitter.on(event as string, listener as (...args: readonly unknown[]) => void);
        return this;
    }

    once<K extends keyof T>(event: K, listener: T[K]): this {
        this.emitter.once(event as string, listener as (...args: readonly unknown[]) => void);
        return this;
    }

    off<K extends keyof T>(event: K, listener: T[K]): this {
        this.emitter.off(event as string, listener as (...args: readonly unknown[]) => void);
        return this;
    }

    removeListener<K extends keyof T>(event: K, listener: T[K]): this {
        this.emitter.removeListener(event as string, listener as (...args: readonly unknown[]) => void);
        return this;
    }

    emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): boolean {
        return this.emitter.emit(event as string, ...args);
    }
}

/**
 * Create a typed event emitter.
 *
 * The returned object is a {@link TypedEventEmitter} backed by Node's
 * {@link EventEmitter}. The backend is an implementation detail — interact
 * only through the typed interface so the emitter can be swapped without
 * changing consumer code.
 *
 * @template T - A map from event names to listener function signatures.
 * @returns A typed event emitter instance.
 */
export function createTypedEventEmitter<T extends Record<string, (...args: readonly unknown[]) => void>>(): TypedEventEmitter<T> {
    return new TypedEventEmitterImpl<T>();
}
