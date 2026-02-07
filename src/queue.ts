type Task<T> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const queue: Task<unknown>[] = [];
let processing = false;

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const task = queue.shift()!;
    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    }
  }

  processing = false;
}

export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ fn, resolve, reject } as Task<unknown>);
    processQueue();
  });
}

export function queueLength(): number {
  return queue.length;
}
