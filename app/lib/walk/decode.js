/* A walk event as a row: the flow prefix, then each field's bytes
 * read back by the decode spec the compiler inferred from BTF.
 * Pure: no `yeet:*` imports. */

import { addrOf, bytesOf } from "../probes/records.js";
import { ENTRY_CAP, MAX_ITERS } from "./vm.js";

const TCP_STATE = ["", "ESTABLISHED", "SYN_SENT", "SYN_RECV", "FIN_WAIT1", "FIN_WAIT2", "TIME_WAIT", "CLOSE", "CLOSE_WAIT", "LAST_ACK", "LISTEN", "CLOSING", "NEW_SYN_RECV", "BOUND_INACTIVE"];
export const tcpState = (n) => TCP_STATE[n] ?? String(n);

const printable = (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : "·");

/* A little-endian integer of `len` bytes, as a Number when it fits. */
const le = (b, len, signed = false) => {
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i] ?? 0);
  if (signed && len && v & (1n << BigInt(len * 8 - 1))) v -= 1n << BigInt(len * 8);
  return v;
};
const beInt = (b, len) => {
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(b[i] ?? 0);
  return v;
};
const num = (v) => (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());

/** One captured entry (`bytes` of `len`) under `spec` → a JSON-able value. */
export function decodeEntry(bytes, len, spec) {
  const b = bytesOf(bytes, len);
  const n = b.length;
  switch (spec.kind) {
    case "str": {
      let s = "";
      for (const c of b) {
        if (!c) break;
        s += printable(c);
      }
      return s;
    }
    case "text": {
      let s = "";
      for (let i = 0; i < n; i++) s += printable(b[i]);
      return s;
    }
    case "bytes": {
      let s = "";
      for (let i = 0; i < n; i++) s += b[i].toString(16).padStart(2, "0");
      return s;
    }
    case "json": {
      /* `"<field>"` in the window, then the value after it. */
      let s = "";
      for (let i = 0; i < n; i++) s += b[i] >= 32 && b[i] < 127 ? String.fromCharCode(b[i]) : "\0";
      let i = s.indexOf(`"${spec.field}"`);
      if (i < 0) return null;
      i += spec.field.length + 2;
      while (i < s.length && (s[i] === " " || s[i] === ":")) i++;
      if (s[i] === '"') {
        let out = "";
        for (let j = i + 1; j < s.length && s[j] !== '"'; j++) out += s[j];
        return out;
      }
      let out = "";
      for (let j = i; j < s.length && !",}] \r\n\t\0".includes(s[j]); j++) out += s[j];
      if (out === "true") return true;
      if (out === "false") return false;
      if (out === "null") return null;
      return out === "" ? null : Number.isFinite(Number(out)) ? Number(out) : out;
    }
    case "ip4":
      return n >= 4 ? `${b[0]}.${b[1]}.${b[2]}.${b[3]}` : null;
    case "ip6":
      return n >= 16 ? addrOf(10, b) : null;
    case "be":
      return num(beInt(b, n));
    case "bool":
      return Boolean(b[0]);
    case "ptr":
    case "hex":
      return "0x" + le(b, n).toString(16);
    case "enum": {
      const v = le(b, n, true);
      return spec.values?.[v.toString()] ?? num(v);
    }
    case "int":
    case "uint":
    default: {
      let v = le(b, n, spec.kind === "int" && !spec.bitfield);
      if (spec.bitfield) v = (v >> BigInt(spec.bitfield.bit_offset)) & ((1n << BigInt(spec.bitfield.bit_size)) - 1n);
      return num(v);
    }
  }
}

/**
 * One `walk_event`, as `{ ts, at, cpu, family, state, sport, dport,
 * saddr, daddr, seq, len, linear, values }` — `values` keyed by field
 * name, `null` for a field whose walk failed (a NULL pointer, a page
 * not present). A payload window is cut to the bytes the skb's head
 * holds: past `linear` the VM read the skb's shared info, not the
 * segment.
 */
export function decodeEvent(wrapped, fields) {
  const e = wrapped?.walk_event ?? wrapped;
  const family = Number(e.family ?? 0);
  const ok = Number(e.ok ?? 0);
  const edata = e.edata ?? [];
  const elen = e.elen ?? [];
  const at = (i) => (Array.isArray(edata) ? edata[i] : (edata[i] ?? edata[String(i)]));
  const linear = Number(e.linear ?? 0);
  const values = {};
  fields.forEach((f, i) => {
    if (!(ok & (1 << i))) {
      values[f.name] = null;
      return;
    }
    const idx = i * MAX_ITERS;
    let len = Number((Array.isArray(elen) ? elen[idx] : elen[String(idx)]) ?? 0);
    if (f.decode.payload != null) {
      len = Math.max(0, Math.min(len, linear - f.decode.payload));
      if (len === 0) {
        values[f.name] = null;
        return;
      }
    }
    const off = idx * ENTRY_CAP;
    const bytes = new Uint8Array(len);
    for (let k = 0; k < len; k++) bytes[k] = Number(at(off + k) ?? 0) & 0xff;
    values[f.name] = decodeEntry(bytes, len, f.decode);
  });
  return {
    ts: BigInt(e.ts ?? 0),
    at: Date.now(),
    gen: Number(e.gen ?? 0),
    cpu: Number(e.cpu ?? 0),
    family,
    state: tcpState(Number(e.state ?? 0)),
    sport: Number(e.sport ?? 0),
    dport: Number(e.dport ?? 0),
    saddr: addrOf(family, e.saddr),
    daddr: addrOf(family, e.daddr),
    seq: Number(e.seq ?? 0) >>> 0,
    len: Number(e.plen ?? 0),
    linear,
    values,
  };
}
