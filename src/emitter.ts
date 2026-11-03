type Listener<T> = (payload: T) => unknown;

function report(event: PropertyKey, e: unknown): void {
  console.error(`[wordbomb] "${String(event)}" listener failed:`, e);
}

export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      return fn(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(fn);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set] as Listener<Events[K]>[]) {
      try {
        const result = fn(payload);
        if (result instanceof Promise) result.catch((e: unknown) => report(event, e));
      } catch (e) {
        report(event, e);
      }
    }
  }
}
