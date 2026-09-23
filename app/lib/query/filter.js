/* The comparisons behind `where`, with no dependency on the graphql
 * package — the isolate filters recent transactions with the same code
 * Node filters endpoints with. Pure. */

const ROLE_ARG = (r) => (r ? r.toLowerCase() : null);
const TRANSPORT = { wire: "WIRE", tls: "TLS", tcp: "TCP" };
const TRANSPORT_CODE = { 2: "WIRE", 1: "TLS", 0: "TCP" };

/** `*` is a wildcard; no `*` is equality. */
export const glob = (pattern) => {
  if (pattern == null) return () => true;
  if (!pattern.includes("*")) return (s) => s === pattern;
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return (s) => re.test(s);
};

/** A `Num` comparison; every present field must hold. */
export const num = (value, cmp) => {
  if (!cmp) return true;
  if (value == null) return false;
  if (cmp.eq != null && !(value === cmp.eq)) return false;
  if (cmp.ne != null && !(value !== cmp.ne)) return false;
  if (cmp.gt != null && !(value > cmp.gt)) return false;
  if (cmp.gte != null && !(value >= cmp.gte)) return false;
  if (cmp.lt != null && !(value < cmp.lt)) return false;
  if (cmp.lte != null && !(value <= cmp.lte)) return false;
  return true;
};

/** A `Str` comparison. */
export const str = (value, cmp) => {
  if (!cmp) return true;
  const v = value == null ? "" : String(value);
  if (cmp.eq != null && v !== cmp.eq) return false;
  if (cmp.ne != null && v === cmp.ne) return false;
  if (cmp.like != null && !glob(cmp.like)(v)) return false;
  if (cmp.in != null && !cmp.in.includes(v)) return false;
  return true;
};

/** The `TransactionWhere` filter over recent-transaction rows; shared with the isolate. */
export function filterTransactions(rows, where, limit, now = Date.now()) {
  const w = where ?? {};
  const roleArg = ROLE_ARG;
  const cutoff = w.since != null ? now - w.since * 1000 : null;
  const out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    const x = rows[i];
    if (w.role && x.role !== roleArg(w.role)) continue;
    if (!str(x.service, w.service) || !str(x.method, w.method) || !str(x.path, w.path) || !str(x.target, w.target)) continue;
    if (w.status != null && x.status !== w.status) continue;
    if (w.statusBetween && !(x.status != null && x.status >= w.statusBetween[0] && x.status <= (w.statusBetween[1] ?? w.statusBetween[0]))) continue;
    if (!num(x.duration, w.duration)) continue;
    if (w.pid != null && x.pid !== w.pid) continue;
    if (w.transport && (TRANSPORT_CODE[x.transport] ?? TRANSPORT[x.transport]) !== w.transport) continue;
    if (w.complete != null && x.complete !== w.complete) continue;
    if (cutoff != null && x.at < cutoff) continue;
    if (w.requestHeader != null && !(x.requestHeaders ?? []).some(([n]) => n === w.requestHeader)) continue;
    if (w.responseHeader != null && !(x.responseHeaders ?? []).some(([n]) => n === w.responseHeader)) continue;
    if (w.responseBodyContains != null && !(x.responseBody ?? "").includes(w.responseBodyContains)) continue;
    if (w.requestBodyContains != null && !(x.requestBody ?? "").includes(w.requestBodyContains)) continue;
    out.push(x);
  }
  return out;
}
