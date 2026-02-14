type Task<T> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

// Per-topic queues: serial within each topic, parallel across topics
const queues = new Map<string, Task<unknown>[]>();
const processing = new Set<string>();

async function processQueue(topicId: string): Promise<void> {
  if (processing.has(topicId)) return;
  processing.add(topicId);

  const queue = queues.get(topicId);
  while (queue && queue.length > 0) {
    const task = queue.shift()!;
    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    }
  }

  processing.delete(topicId);
  // Clean up empty queue entries
  if (queue && queue.length === 0) {
    queues.delete(topicId);
  }
}

export function enqueue<T>(topicId: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!queues.has(topicId)) {
      queues.set(topicId, []);
    }
    queues.get(topicId)!.push({ fn, resolve, reject } as Task<unknown>);
    processQueue(topicId);
  });
}

export function queueLength(topicId?: string): number {
  if (topicId) {
    return queues.get(topicId)?.length || 0;
  }
  // Total across all topics
  let total = 0;
  for (const q of queues.values()) {
    total += q.length;
  }
  return total;
}
