// Fixed-size ring, so a flood is refused rather than growing without limit.
export function createFifo<T>(capacity: number) {
  const items = new Array<T | undefined>(capacity);
  let head = 0;
  let size = 0;

  return {
    get size() {
      return size;
    },

    push(item: T): boolean {
      if (size === capacity) return false;
      items[(head + size) % capacity] = item;
      size++;
      return true;
    },

    shift(): T | undefined {
      if (size === 0) return undefined;
      const item = items[head];
      // Clearing the slot lets a finished request be collected.
      items[head] = undefined;
      head = (head + 1) % capacity;
      size--;
      return item;
    },
  };
}
