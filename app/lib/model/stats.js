/* Small running statistics: counts by key, and a latency reservoir that
 * answers percentiles without keeping every sample.
 *
 * Pure.
 */

/** Uniform reservoir of `size` samples over any number seen. */
export class Reservoir {
  constructor(size = 256) {
    this.size = size;
    this.samples = [];
    this.n = 0;
    this.sum = 0;
    this.max = -Infinity;
    this.sorted = null;
  }

  add(v) {
    this.n++;
    this.sum += v;
    if (v > this.max) this.max = v;
    if (this.samples.length < this.size) this.samples.push(v);
    else {
      const j = Math.floor(Math.random() * this.n);
      if (j < this.size) this.samples[j] = v;
    }
    this.sorted = null;
  }

  percentile(p) {
    if (!this.samples.length) return null;
    if (!this.sorted) this.sorted = [...this.samples].sort((a, b) => a - b);
    const i = Math.min(this.sorted.length - 1, Math.max(0, Math.ceil((p / 100) * this.sorted.length) - 1));
    return this.sorted[i];
  }

  merge(other) {
    for (const v of other.samples) this.add(v);
    this.n += other.n - other.samples.length;
    this.sum += other.sum - other.samples.reduce((a, b) => a + b, 0);
    if (other.max > this.max) this.max = other.max;
    this.sorted = null;
  }

  summary() {
    return this.n
      ? { n: this.n, mean: this.sum / this.n, p50: this.percentile(50), p95: this.percentile(95), p99: this.percentile(99), max: this.max }
      : { n: 0, mean: null, p50: null, p95: null, p99: null, max: null };
  }
}

/** The last `size` values, in order. */
export class Ring {
  constructor(size = 32) {
    this.size = size;
    this.buf = [];
  }
  add(v) {
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
  }
  get full() {
    return this.buf.length >= this.size;
  }
  percentile(p) {
    if (!this.buf.length) return null;
    const s = [...this.buf].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  }
}

/** Count by key, with a bound on distinct keys. */
export class Counter {
  constructor(limit = 64) {
    this.limit = limit;
    this.map = new Map();
    this.other = 0;
  }
  add(key, n = 1) {
    if (this.map.has(key)) this.map.set(key, this.map.get(key) + n);
    else if (this.map.size < this.limit) this.map.set(key, n);
    else this.other += n;
  }
  has(key) {
    return this.map.has(key);
  }
  merge(other) {
    for (const [k, n] of other.map) this.add(k, n);
    this.other += other.other;
  }
  get total() {
    let t = this.other;
    for (const n of this.map.values()) t += n;
    return t;
  }
  toJSON() {
    const out = Object.fromEntries([...this.map].sort((a, b) => b[1] - a[1]));
    if (this.other) out["…"] = this.other;
    return out;
  }
}
