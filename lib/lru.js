/**
 * LRU-кэш с бюджетом в байтах.
 *
 * Опирается на то, что Map сохраняет порядок вставки: самый старый элемент —
 * первый в итерации. Обращение переставляет элемент в конец (delete + set).
 */
export class ByteLRU {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const v = this.map.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    // переставляем в конец — теперь это самый свежий элемент
    this.map.delete(key);
    this.map.set(key, v);
    this.hits++;
    return v;
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value, size) {
    const old = this.map.get(key);
    if (old !== undefined) {
      this.bytes -= old.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.bytes += size;
    this.evict();
  }

  evict() {
    while (this.bytes > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next().value;
      const v = this.map.get(oldest);
      this.map.delete(oldest);
      this.bytes -= v.size;
    }
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      mb: +(this.bytes / 2 ** 20).toFixed(1),
      maxMb: +(this.maxBytes / 2 ** 20).toFixed(0),
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? +((this.hits / total) * 100).toFixed(1) : 0,
    };
  }
}
