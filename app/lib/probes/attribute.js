/* Who holds each end of a wire flow, from an inventory snapshot.
 *
 * The wire tap has no pid; the graph does, joined to the socket by
 * inode (conns.js). A connection that is over before the snapshot
 * lands cannot be named that way, but a server's listener outlives
 * every connection it accepts — so a local endpoint on a listening
 * port is attributed to the listener's owner. The client end of a
 * connection that lived a few milliseconds stays unnamed; the kernel
 * knows, and a small fentry on tcp_sendmsg could say, if it matters.
 *
 * Pure: `rows` are conns.js snapshot rows `{ state, laddr, lport, pid, comm }`.
 */

/**
 * `{ a: { pid, comm, via } | null, b: ... }` for a flow with endpoints
 * `a`/`b` of `{ addr, port }`. `via` is "socket" or "listener".
 */
export function attribute(flow, rows) {
  const find = (ep) => {
    const own = rows.find((r) => r.pid != null && r.lport === ep.port && r.state !== "Listen" && sameAddr(r.laddr, ep.addr));
    if (own) return { pid: own.pid, comm: own.comm, via: "socket" };
    const listener = rows.find((r) => r.pid != null && r.lport === ep.port && r.state === "Listen" && (sameAddr(r.laddr, ep.addr) || isAny(r.laddr)));
    if (listener) return { pid: listener.pid, comm: listener.comm, via: "listener" };
    return null;
  };
  return { a: find(flow.a), b: find(flow.b) };
}

const isAny = (s) => s === "0.0.0.0" || norm6(s) === "0:0:0:0:0:0:0:0";

/* The graph spells v6 canonically and the tap does not; compare loosely. */
export const sameAddr = (x, y) => x === y || norm6(x) === norm6(y) || v4in6(x) === y || v4in6(y) === x;

const v4in6 = (s) => {
  /* ::ffff:1.2.3.4 as the tap spells it: 0:0:0:0:0:ffff:102:304 */
  const m = /^(?:0:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(norm6(s) ?? "");
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
};

export const norm6 = (s) => {
  if (!s || !s.includes(":")) return s;
  const parts = s.includes("::") ? expand(s) : s.split(":");
  if (parts.length !== 8) return s;
  return parts.map((p) => parseInt(p || "0", 16).toString(16)).join(":");
};

const expand = (s) => {
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  return [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
};
