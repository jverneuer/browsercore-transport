/**
 * Typed event emitter — a type-safe wrapper over an injected EventProvider.
 *
 * The public type {@link TypedEventEmitter} is re-exported from
 * @browsercore/contracts (single source of truth). The implementation
 * delegates to an injected {@link EventProvider} so the backend is swappable
 * (EventTarget, mock) without changing consumer code.
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
class TypedEventEmitterImpl<T extends Record<string, (...args: never[]) => void>> implements TypedEventEmitter<T> {
    constructor(private readonly events: EventProvider) {}

    on<K extends keyof T>(event: K, listener: T[K]): void {
        // The injected EventProvider's on()/once()/off() may return `this`
        // (chainable) per @browsercore/contracts — call without leaking that
        // chainable return into a void context (backend is swappable).
        //
        // `listener as never` is the variance bridge at this seam: the
        // canonical map constraint is `(...args: never[]) => void` (the
        // bottom function type — see contracts' events.ts), which is not
        // assignable to the provider's `(...args: unknown[]) => void`
        // parameter in either direction. The gap is closed by construction:
        // `emit` — the only dispatcher — passes exactly `Parameters<T[K]>`.
        // `never` (bottom) keeps the cast local and identity-preserving so
        // off() removes the very reference on() registered.
        this.events.on(event as string, listener as never);
    }

    once<K extends keyof T>(event: K, listener: T[K]): void {
        this.events.once(event as string, listener as never);
    }

    off<K extends keyof T>(event: K, listener: T[K]): void {
        this.events.off(event as string, listener as never);
    }

    emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): boolean {
        return this.events.emit(event as string, ...args);
    }
}

/**
 * Create a typed event emitter backed by an injected EventProvider.
 *
 * The returned object is a typed emitter whose backend is the provider you
 * pass in. Interact only through the typed interface so the emitter can be
 * swapped without changing consumer code.
 *
 * @template T - A map from event names to listener function signatures.
 * @param events - The EventProvider backend (e.g. EventTarget, mock).
 * @returns A typed event emitter instance.
 */
export function createTypedEventEmitter<T extends Record<string, (...args: never[]) => void>>(
    events: EventProvider,
): TypedEventEmitter<T> {
    return new TypedEventEmitterImpl<T>(events);
}

/**
 * Concrete implementation of a namespaced {@link EventProvider} view.
 *
 * Every method maps onto the base provider under `<namespace>:<event>`
 * channels, so multiple scopes sharing one base provider never see each
 * other's registrations or emissions. The base provider remains the sole
 * listener store and dispatcher — the scope only translates channel names.
 */
class ScopedEventProviderImpl implements EventProvider {
    /** Event names this scope has ever registered listeners for. Drives the
     * untargeted `removeAllListeners()`, which must clear ONLY this scope's
     * channels — a blanket call on the base would wipe every other scope's
     * registrations too. */
    private readonly registeredEvents = new Set<string>();

    constructor(
        private readonly base: EventProvider,
        private readonly namespace: string,
    ) {}

    private channel(event: string): string {
        return `${this.namespace}:${event}`;
    }

    public on(event: string, listener: (...args: unknown[]) => void): void {
        this.registeredEvents.add(event);
        this.base.on(this.channel(event), listener);
    }

    public once(event: string, listener: (...args: unknown[]) => void): void {
        this.registeredEvents.add(event);
        this.base.once(this.channel(event), listener);
    }

    public off(event: string, listener: (...args: unknown[]) => void): void {
        this.base.off(this.channel(event), listener);
    }

    public removeListener(event: string, listener: (...args: unknown[]) => void): void {
        this.base.removeListener(this.channel(event), listener);
    }

    public emit(event: string, ...args: unknown[]): boolean {
        return this.base.emit(this.channel(event), ...args);
    }

    public listenerCount(event: string): number {
        return this.base.listenerCount(this.channel(event));
    }

    public removeAllListeners(event?: string): void {
        if (event !== undefined) {
            this.base.removeAllListeners(this.channel(event));
            return;
        }
        for (const name of this.registeredEvents) {
            this.base.removeAllListeners(this.channel(name));
        }
    }
}

/**
 * Create an EventProvider view that namespaces all operations onto a base
 * provider under a transport-unique channel key.
 *
 * This is how a process-wide shared provider (e.g. browsersmith's
 * `nodeEventProvider` singleton) can be injected into many transports without
 * them cross-delivering `data`/`close`/`error` events: each scope registers
 * and emits only on its own `<namespace>:<event>` channels of the base, so
 * the base provider stays the single injected backend while delivery is
 * scoped per instance.
 *
 * @param base - The shared EventProvider backend (listener store + dispatcher).
 * @param namespace - Transport-unique channel prefix for this scope.
 * @returns An EventProvider whose surface is confined to the namespace.
 */
export function createScopedEventProvider(base: EventProvider, namespace: string): EventProvider {
    return new ScopedEventProviderImpl(base, namespace);
}
