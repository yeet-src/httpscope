/* Small formatters for the pages. Pure. */

/** "3s", "4m", "2h" since `ms` (epoch milliseconds). */
export function ago(ms, now = Date.now()) {
  if (ms == null) return "–";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

/** Milliseconds as a short number. */
export const ms = (v) => (v == null ? "–" : v >= 100 ? `${Math.round(v)}` : v >= 10 ? v.toFixed(1) : v.toFixed(2));

/** `{ "200": 5, "404": 1 }` → "200×5 404×1". */
export const statuses = (map) =>
  Object.entries(map ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join(" ");

/** Errors (status ≥ 400) out of a status map. */
export const errorsOf = (map) => Object.entries(map ?? {}).reduce((n, [k, c]) => (Number(k) >= 400 ? n + c : n), 0);

/** Bytes as a short number. */
export const bytes = (n) => (n == null ? "–" : n < 1024 ? `${Math.round(n)}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(1)}M`);

/** A drift kind's colour class: what appeared, what went, what moved. */
export const driftTone = (kind) =>
  kind.includes("missing") || kind.includes("changed") || kind === "latency.up"
    ? "text-red"
    : kind.includes("added") || kind.includes("new")
      ? "text-yellow"
      : kind === "latency.back"
        ? "text-green"
        : "text-dim";
