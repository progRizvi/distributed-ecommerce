// Tiny in-process event bus. Modules announce what happened; others react without being called directly.
// Later this can be swapped for a message queue without changing the emitters.
export interface AppEvents {
  'user.registered': { userId: string; email: string };
}

export type EventName = keyof AppEvents;
export type EventHandler<K extends EventName> = (payload: AppEvents[K]) => void | Promise<void>;

export interface EventBus {
  emit<K extends EventName>(event: K, payload: AppEvents[K]): void;
  on<K extends EventName>(event: K, handler: EventHandler<K>): void;
}

export function createEventBus(onError: (error: unknown, event: EventName) => void = () => {}): EventBus {
  const handlers = new Map<EventName, EventHandler<never>[]>();

  return {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler as EventHandler<never>]);
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) {
        // A failing listener must never break the request that emitted the event.
        Promise.resolve()
          .then(() => (handler as EventHandler<typeof event>)(payload))
          .catch((error: unknown) => onError(error, event));
      }
    },
  };
}
