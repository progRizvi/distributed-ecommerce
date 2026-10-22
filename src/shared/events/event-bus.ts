// Tiny in-process event bus. Modules announce what happened; others react without being called directly.
// Later this can be swapped for a message queue (write another class that implements EventBus).
export interface AppEvents {
  'user.registered': { userId: string; email: string };
}

export type EventName = keyof AppEvents;
export type EventHandler<K extends EventName> = (payload: AppEvents[K]) => void | Promise<void>;

export interface EventBus {
  emit<K extends EventName>(event: K, payload: AppEvents[K]): void;
  on<K extends EventName>(event: K, handler: EventHandler<K>): void;
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<EventName, EventHandler<never>[]>();

  constructor(private readonly onError: (error: unknown, event: EventName) => void = () => {}) {}

  on<K extends EventName>(event: K, handler: EventHandler<K>): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler as unknown as EventHandler<never>]);
  }

  emit<K extends EventName>(event: K, payload: AppEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      // A failing listener must never break the request that emitted the event.
      Promise.resolve()
        .then(() => (handler as unknown as EventHandler<K>)(payload))
        .catch((error: unknown) => this.onError(error, event));
    }
  }
}
