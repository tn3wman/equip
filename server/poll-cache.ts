/** Bound cached account data by bytes, rather than by the number of users. */
export class PollCache {
  private entries = new Map<string, string>();
  private bytes = 0;
  constructor(private readonly maxBytes = 32 * 1024 * 1024) {}
  get(key: string) {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: string) {
    const size = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (size > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.bytes -= Buffer.byteLength(key) + Buffer.byteLength(previous);
      this.entries.delete(key);
    }
    while (this.bytes + size > this.maxBytes) {
      const [oldKey, oldValue] = this.entries.entries().next().value!;
      this.entries.delete(oldKey);
      this.bytes -= Buffer.byteLength(oldKey) + Buffer.byteLength(oldValue);
    }
    this.entries.set(key, value);
    this.bytes += size;
  }
}
