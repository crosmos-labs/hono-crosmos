export interface BackgroundTasks {
  waitUntil(task: Promise<unknown>): void;
}

export interface Clock {
  nowMs(): number;
  monotonicMs(): number;
}

export interface QueueDelivery<T> {
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(): void;
}

export function createBackgroundTasks(
  waitUntil: (task: Promise<unknown>) => void,
): BackgroundTasks {
  return { waitUntil };
}

export const inlineBackgroundTasks: BackgroundTasks = {
  waitUntil(task) {
    void task;
  },
};

export class RecordingBackgroundTasks implements BackgroundTasks {
  readonly tasks: Promise<unknown>[] = [];

  waitUntil(task: Promise<unknown>): void {
    this.tasks.push(task);
  }

  async settle(): Promise<PromiseSettledResult<unknown>[]> {
    return Promise.allSettled(this.tasks);
  }
}

export const systemClock: Clock = {
  nowMs() {
    return Date.now();
  },
  monotonicMs() {
    return Date.now();
  },
};
