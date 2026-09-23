/* TCP segments off the wire → the byte stream the decoder expects.
 *
 * The wire tap (bpf/wire) hands over segments as packets crossed a
 * device: each with its sequence number, some out of order, some twice
 * (retransmits, and the ring itself delivers records out of order).
 * This puts each direction of each flow back into a stream and feeds
 * the decoder dataRecords under TRANSPORT_WIRE, with the same hole
 * convention the taps use — a record with `cap_len` 0 and `len` n is
 * n bytes that went by unseen.
 *
 * A flow is oriented at its first packet: the side that sent it (or,
 * on a SYN-ACK, the side it was sent to) is "the process" whose writes
 * are DIR_WRITE; the decoder then reads the first bytes and knows
 * whether that side is the client or the server. There is no pid here;
 * `flow.a`/`flow.b` name the endpoints for the inventory to attribute.
 *
 * Out-of-order segments wait in `pending` for the bytes before them.
 * When they have waited `holdMs` (tick()), or more than `maxHold` bytes
 * are waiting, the missing range is declared a hole and the stream
 * moves on. SYN on a live flow with a new sequence number is a reused
 * port: the old flow is closed. FIN in both directions, or RST, closes.
 *
 * Pure. Sequence arithmetic is mod 2^32 with `| 0` for the signed
 * distance.
 */

import { DIR_READ, DIR_WRITE, TCPF_ACK, TCPF_FIN, TCPF_RST, TCPF_SYN, TRANSPORT_WIRE } from "../probes/records.js";

const SEG = 4095; /* CAP_MASK: the copy a record can hold */

const endpoint = (addr, port) => `${addr}:${port}`;

/* The flow's key, the same whichever way a packet is going. */
export function flowKey(r) {
  const s = endpoint(r.saddr, r.sport);
  const d = endpoint(r.daddr, r.dport);
  return `${r.family}|${s < d ? `${s}>${d}` : `${d}>${s}`}`;
}

/* The decoder's key for a flow: its records carry no pid. */
export const connKeyOf = (flowKey) => `0:${TRANSPORT_WIRE}:${flowKey}`;

const distance = (a, b) => (a - b) | 0; /* signed, mod 2^32 */
const add = (a, n) => (a + n) >>> 0;

export class Reassembler {
  /**
   *   onRecord(dataRecord)   a stream record for the decoder
   *   onClose(key, why)      the flow ended; close it in the decoder under
 *                          connKeyOf(key)
   *   onFlow(flow, event)    "open" | "close", for attribution
   *   holdMs                 how long an out-of-order segment waits
   *   maxHold                bytes waiting per direction before giving up
   *   idleMs                 a silent flow is closed after this
   *   now()                  wall clock, ms
   */
  constructor({ onRecord, onClose, onFlow, holdMs = 200, maxHold = 1 << 20, idleMs = 120_000, now = Date.now } = {}) {
    this.onRecord = onRecord;
    this.onClose = onClose;
    this.onFlow = onFlow;
    this.holdMs = holdMs;
    this.maxHold = maxHold;
    this.idleMs = idleMs;
    this.now = now;
    this.flows = new Map();
  }

  /** One wireRecord. */
  push(r) {
    const key = flowKey(r);
    let f = this.flows.get(key);
    const syn = (r.tcpflags & TCPF_SYN) !== 0;
    const synOnly = syn && !(r.tcpflags & TCPF_ACK);

    if (f && synOnly) {
      /* A new connection on the same 4-tuple. */
      const d = f.dirs[this.dirOf(f, r)];
      if (d.next != null && add(r.seq, 1) !== d.next) {
        this.close(key, "reused");
        f = null;
      }
    }
    if (!f) f = this.open(key, r, synOnly ? "src" : syn ? "dst" : "src");

    const dir = this.dirOf(f, r);
    const d = f.dirs[dir];
    f.lastAt = this.now();
    f.lastTs = r.ts;

    if (syn) {
      if (d.next == null) d.next = add(r.seq, 1);
      if (r.tcpflags & TCPF_RST) this.close(key, "reset");
      return;
    }
    if (d.next == null) d.next = r.seq; /* joined mid-stream */

    /* The bytes: this record's slice of the packet. A short copy is a
     * hole the tap already knows about. */
    const expected = Math.min(SEG, Math.max(0, r.len - r.off));
    if (expected > 0) {
      this.segment(f, dir, { seq: add(r.seq, r.off), len: expected, data: r.data, ts: r.ts, at: f.lastAt });
    }

    /* FIN and RST ride on the last record of the packet only. */
    const last = r.off + expected >= r.len;
    if (last && r.tcpflags & TCPF_RST) {
      this.close(key, "reset");
      return;
    }
    if (last && r.tcpflags & TCPF_FIN) {
      const finSeq = add(r.seq, r.len);
      if (distance(finSeq, d.next) <= 0) this.fin(f, dir);
      else d.finAt = finSeq; /* after the bytes still to come */
    }
  }

  open(key, r, processSide) {
    const src = { addr: r.saddr, port: r.sport };
    const dst = { addr: r.daddr, port: r.dport };
    const f = {
      key,
      family: r.family,
      a: processSide === "src" ? src : dst,
      b: processSide === "src" ? dst : src,
      ifindex: r.ifindex,
      openedAt: this.now(),
      lastAt: this.now(),
      firstTs: r.ts,
      lastTs: r.ts,
      dirs: {
        [DIR_WRITE]: { next: null, pending: [], pendingBytes: 0, fin: false, finAt: null, bytes: 0, holes: 0 },
        [DIR_READ]: { next: null, pending: [], pendingBytes: 0, fin: false, finAt: null, bytes: 0, holes: 0 },
      },
    };
    this.flows.set(key, f);
    this.onFlow?.(f, "open");
    return f;
  }

  /* Bytes from `a` are what the process wrote. */
  dirOf(f, r) {
    return r.saddr === f.a.addr && r.sport === f.a.port ? DIR_WRITE : DIR_READ;
  }

  segment(f, dir, seg) {
    const d = f.dirs[dir];
    let rel = distance(seg.seq, d.next);
    if (rel < 0) {
      /* Already have the start: a retransmit, wholly or in part. */
      const trim = -rel;
      if (trim >= seg.len) return;
      seg = { ...seg, seq: d.next, len: seg.len - trim, data: seg.data.subarray(Math.min(trim, seg.data.length)) };
      rel = 0;
    }
    if (rel > 0) {
      this.hold(f, dir, seg);
      if (d.pendingBytes > this.maxHold) this.giveUp(f, dir);
      return;
    }
    this.deliver(f, dir, seg);
    this.drain(f, dir);
  }

  hold(f, dir, seg) {
    const d = f.dirs[dir];
    const p = d.pending;
    let i = p.length;
    while (i > 0 && distance(p[i - 1].seq, seg.seq) > 0) i--;
    if (i > 0 && p[i - 1].seq === seg.seq) return; /* duplicate */
    p.splice(i, 0, seg);
    d.pendingBytes += seg.len;
  }

  /* Feed what is now contiguous. */
  drain(f, dir) {
    const d = f.dirs[dir];
    while (d.pending.length) {
      const seg = d.pending[0];
      const rel = distance(seg.seq, d.next);
      if (rel > 0) break;
      d.pending.shift();
      d.pendingBytes -= seg.len;
      if (rel < 0) {
        const trim = -rel;
        if (trim >= seg.len) continue;
        this.deliver(f, dir, { ...seg, seq: d.next, len: seg.len - trim, data: seg.data.subarray(Math.min(trim, seg.data.length)) });
      } else this.deliver(f, dir, seg);
    }
    if (d.finAt != null && distance(d.finAt, d.next) <= 0) this.fin(f, dir);
  }

  /* Declare the gap up to the first waiting segment a hole. */
  giveUp(f, dir) {
    const d = f.dirs[dir];
    if (!d.pending.length) return;
    const gap = distance(d.pending[0].seq, d.next);
    if (gap > 0) this.emitGap(f, dir, gap, d.pending[0].ts);
    this.drain(f, dir);
  }

  deliver(f, dir, seg) {
    const d = f.dirs[dir];
    d.next = add(seg.seq, seg.len);
    d.bytes += seg.data.length;
    d.holes += seg.len - seg.data.length;
    this.onRecord?.(this.record(f, dir, seg.ts, seg.len, seg.data));
  }

  emitGap(f, dir, n, ts) {
    const d = f.dirs[dir];
    d.next = add(d.next, n);
    d.holes += n;
    this.onRecord?.(this.record(f, dir, ts, n, new Uint8Array(0)));
  }

  /* A dataRecord as the decoder takes it: the flow from the process
   * side's point of view, `len` bytes of which `data` were captured. */
  record(f, dir, ts, len, data) {
    return {
      ts,
      at: this.now(),
      conn: f.key,
      pid: 0,
      tid: 0,
      len,
      off: 0,
      capLen: data.length,
      dir,
      transport: TRANSPORT_WIRE,
      flags: 0,
      family: f.family,
      sport: f.a.port,
      dport: f.b.port,
      saddr: f.a.addr,
      daddr: f.b.addr,
      data,
    };
  }

  fin(f, dir) {
    const d = f.dirs[dir];
    if (d.fin) return;
    d.fin = true;
    d.finAt = null;
    d.next = add(d.next, 1);
    if (f.dirs[DIR_READ].fin && f.dirs[DIR_WRITE].fin) this.close(f.key, "fin");
  }

  /** The flow is over: what waits is flushed past its holes, then the decoder is told. */
  close(key, why = "closed") {
    const f = this.flows.get(key);
    if (!f) return;
    this.flows.delete(key);
    for (const dir of [DIR_WRITE, DIR_READ]) while (f.dirs[dir].pending.length) this.giveUp(f, dir);
    this.onClose?.(key, why);
    this.onFlow?.(f, "close");
  }

  /** Every `holdMs` or so: stalled waits become holes, idle flows close. */
  tick() {
    const now = this.now();
    for (const f of [...this.flows.values()]) {
      if (now - f.lastAt > this.idleMs) {
        this.close(f.key, "idle");
        continue;
      }
      for (const dir of [DIR_WRITE, DIR_READ]) {
        const d = f.dirs[dir];
        if (d.pending.length && now - d.pending[0].at >= this.holdMs) this.giveUp(f, dir);
      }
    }
  }

  /** A row per flow. */
  list() {
    return [...this.flows.values()].map((f) => ({
      key: f.key,
      family: f.family,
      a: f.a,
      b: f.b,
      ifindex: f.ifindex,
      bytesOut: f.dirs[DIR_WRITE].bytes,
      bytesIn: f.dirs[DIR_READ].bytes,
      holes: f.dirs[DIR_WRITE].holes + f.dirs[DIR_READ].holes,
      pending: f.dirs[DIR_WRITE].pending.length + f.dirs[DIR_READ].pending.length,
      openedAt: f.openedAt,
      lastAt: f.lastAt,
    }));
  }
}
