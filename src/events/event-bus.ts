import type { AgencyEvent } from "../domain/index.js";

type EventType = AgencyEvent["type"];
type EventFor<Type extends EventType> = Extract<AgencyEvent, { type: Type }>;
export type EventListener<Type extends EventType> = (event: EventFor<Type>) => void;

type StoredListener = (event: AgencyEvent) => void;
type ListenerKey = (event: never) => void;

export class EventBus {
  readonly #listeners = new Map<
    EventType,
    Map<ListenerKey, StoredListener>
  >();

  subscribe<Type extends EventType>(
    type: Type,
    listener: EventListener<Type>,
  ): () => void {
    let listeners = this.#listeners.get(type);
    if (listeners === undefined) {
      listeners = new Map();
      this.#listeners.set(type, listeners);
    }

    const storedListener: StoredListener = (event) => {
      listener(event as EventFor<Type>);
    };
    listeners.set(listener, storedListener);

    return () => this.unsubscribe(type, listener);
  }

  unsubscribe<Type extends EventType>(
    type: Type,
    listener: EventListener<Type>,
  ): void {
    const listeners = this.#listeners.get(type);
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      this.#listeners.delete(type);
    }
  }

  emit(event: AgencyEvent): void {
    const listeners = this.#listeners.get(event.type);
    if (listeners === undefined) return;

    for (const listener of [...listeners.values()]) {
      listener(event);
    }
  }
}
