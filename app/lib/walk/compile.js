/* From a selection of kernel fields to walk-VM programs, by BTF.
 *
 * A query names what it wants as `alias: root.member.member…`, and the
 * running kernel's BTF says where that is: `yeet:btf`'s walk() resolves
 * a member path into the deref-and-load hops a bounded interpreter
 * runs, on this kernel, with this build's offsets. Those hops become
 * ops one for one (a pointer crossed is `off`+`deref`, the terminal is
 * `off`+`read`), so there is no table of offsets anywhere, no closure
 * of "supported" structs, and no depth limit but the VM's op budget:
 * any member of any struct reachable from the socket or the skb, by
 * name, including through pointers into other objects.
 *
 * The member's type decides how the bytes read back — from the BTF
 * too: an int's signedness, a `__be16`/`__be32` typedef (a port, an
 * address), an enum's names, a `char[]` (a string), a bitfield's
 * position, `struct in6_addr`. A query can override with `(kind)`.
 *
 * Grammar of one selection entry:
 *
 *   entry := [name ":"] expr
 *   expr  := term | term ("+" | "-") term
 *   term  := INT
 *          | path ["(" kind ["," size] ")"]
 *          | "payload" "(" offset "," len ["," kind] ")"
 *   path  := root "." member ("." member)*  |  alias
 *   root  := sock | tcp | inet | icsk | skb
 *   kind  := int | uint | hex | ptr | str | bool | ip4 | ip6 | port | be | bytes | text | json:<field>
 *
 * `payload` is a window of the segment's application bytes: the VM's
 * prologue finds where the TCP header ends and hands that address over
 * as a register, so offset 0 is the first byte after the header. Only
 * the skb's linear head is readable; the row says how much that is
 * (`linear`) and the decoder trims a window to it — a whole body is in
 * `transactions`, from the wire tap. Arithmetic runs in the kernel
 * through the VM's scratch registers, so `inflight: tcp.snd_nxt -
 * tcp.snd_una` is one field.
 *
 * `btf` is passed in: `yeet:btf` in the isolate, a stub in a test. Its
 * lookups memoize, so a query costs a handful of round trips at most.
 */

import { ENTRY_CAP, MAX_FIELDS, MAX_READ, MAX_STEP, REG_PAYLOAD, REG_SKB, REG_SOCK, WOP, op } from "./vm.js";

/** Where a path may start. `tcp`, `inet` and `icsk` are the same pointer as `sock`, reinterpreted — tcp_probe fires on established TCP sockets, so each is valid. */
export const ROOTS = {
  sock: { struct: "sock", reg: REG_SOCK },
  tcp: { struct: "tcp_sock", reg: REG_SOCK },
  inet: { struct: "inet_sock", reg: REG_SOCK },
  icsk: { struct: "inet_connection_sock", reg: REG_SOCK },
  skb: { struct: "sk_buff", reg: REG_SKB },
};

/** Friendly names, resolved against BTF like any path — never a baked offset. */
export const ALIASES = {
  daddr: "sock.__sk_common.skc_daddr",
  saddr: "sock.__sk_common.skc_rcv_saddr",
  dport: "sock.__sk_common.skc_dport",
  sport: "sock.__sk_common.skc_num",
  state: "sock.__sk_common.skc_state",
  family: "sock.__sk_common.skc_family",
  cwnd: "tcp.snd_cwnd",
  ssthresh: "tcp.snd_ssthresh",
  sndNxt: "tcp.snd_nxt",
  sndUna: "tcp.snd_una",
  rcvNxt: "tcp.rcv_nxt",
  sndWnd: "tcp.snd_wnd",
  rcvWnd: "tcp.rcv_wnd",
  srtt: "tcp.srtt_us",
  mdev: "tcp.mdev_us",
  mss: "tcp.mss_cache",
  retrans: "tcp.total_retrans",
  lost: "tcp.lost_out",
  sacked: "tcp.sacked_out",
  bytesAcked: "tcp.bytes_acked",
  bytesReceived: "tcp.bytes_received",
  bytesSent: "tcp.bytes_sent",
  segsIn: "tcp.segs_in",
  segsOut: "tcp.segs_out",
  ca: "icsk.icsk_ca_state",
  rto: "icsk.icsk_rto",
  proto: "sock.__sk_common.skc_prot.name",
  dev: "sock.sk_dst_cache.dev.name", /* the route's device; skb->dev is NULL by this tracepoint */
  mtu: "sock.sk_dst_cache.dev.mtu",
  skbLen: "skb.len",
  rcvbuf: "sock.sk_rcvbuf",
  sndbuf: "sock.sk_sndbuf",
  inode: "sock.sk_socket.file.f_inode.i_ino",
};

export const KINDS = new Set(["int", "uint", "hex", "ptr", "str", "bool", "ip4", "ip6", "port", "be", "bytes", "text", "enum", "json"]);

export class CompileError extends Error {
  constructor(entry, message) {
    super(entry != null ? `\`${entry}\`: ${message}` : message);
    this.entry = entry;
  }
}

/* ---- lexing and parsing one entry ---------------------------------------- */

function lex(text) {
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) i++;
    else if ("():,+-.".includes(c)) toks.push({ t: c }), i++;
    else {
      let m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (m) {
        toks.push({ t: "name", v: m[0] });
        i += m[0].length;
        continue;
      }
      m = /^(0x[0-9a-fA-F]+|\d+)/.exec(text.slice(i));
      if (m) {
        toks.push({ t: "int", v: parseInt(m[0], m[0].startsWith("0x") ? 16 : 10) });
        i += m[0].length;
        continue;
      }
      throw new Error(`unexpected character \`${c}\``);
    }
  }
  return toks;
}

/** `{ name, expr }` where expr is `{ kind: "path"|"payload"|"int"|"arith", … }`. */
export function parseEntry(text) {
  const toks = lex(text);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expect = (t) => {
    const k = next();
    if (!k || k.t !== t) throw new Error(`expected \`${t}\`${k ? `, got \`${k.v ?? k.t}\`` : " at the end"}`);
    return k;
  };

  let name = null;
  if (toks[0]?.t === "name" && toks[1]?.t === ":") {
    name = toks[0].v;
    i = 2;
  }

  const kindArg = () => {
    const k = expect("name").v;
    if (k === "json") {
      expect(":");
      return `json:${expect("name").v}`;
    }
    if (!KINDS.has(k) || k === "enum") throw new Error(`unknown kind \`${k}\`; one of ${[...KINDS].filter((x) => x !== "enum").join(", ")}, json:<field>`);
    return k;
  };

  const term = () => {
    const k = next();
    if (!k) throw new Error("expected a field");
    if (k.t === "int") return { kind: "int", value: k.v };
    if (k.t !== "name") throw new Error(`expected a field, got \`${k.t}\``);
    const parts = [k.v];
    while (peek()?.t === ".") {
      next();
      parts.push(expect("name").v);
    }
    const isPayload = parts.length === 1 && parts[0] === "payload" ? true : parts.length === 2 && parts[0] === "skb" && parts[1] === "payload";
    if (isPayload) {
      expect("(");
      const offset = expect("int").v;
      expect(",");
      const len = expect("int").v;
      let kind = "text";
      if (peek()?.t === ",") {
        next();
        kind = kindArg();
      }
      expect(")");
      return { kind: "payload", offset, len, as: kind };
    }
    const out = { kind: "path", path: parts.join("."), as: null, size: null };
    if (peek()?.t === "(") {
      next();
      out.as = kindArg();
      if (peek()?.t === ",") {
        next();
        out.size = expect("int").v;
      }
      expect(")");
    }
    return out;
  };

  const a = term();
  let expr = a;
  if (peek()?.t === "+" || peek()?.t === "-") {
    const sign = next().t;
    const b = term();
    expr = { kind: "arith", sign, a, b };
  }
  if (i < toks.length) throw new Error(`unexpected \`${toks[i].v ?? toks[i].t}\``);
  if (expr.kind === "int") throw new Error("a number alone is not a field");
  return { name, expr };
}

/* ---- resolving a path through BTF --------------------------------------- */

const isComposite = (k) => k === "struct" || k === "union";

/* The member as declared, found by descending anonymous unions and
 * structs the way a path does. `null` when it is not there; walk()
 * raised the better error already. */
async function locate(btf, typeId, name) {
  const t = await btf.expand(typeId);
  for (const m of t.members ?? []) {
    if (m.name === name) return m;
    if (!m.name && isComposite(m.type?.kind)) {
      const found = await locate(btf, m.type.id, name);
      if (found) return found;
    }
  }
  return null;
}

/* The typedef names the path's last member was declared through
 * (`__be16` is how a big-endian field announces itself), plus the
 * member itself. */
async function declared(btf, struct, members) {
  try {
    let cur = (await btf.type(struct, { kind: "struct" })).id;
    let member = null;
    for (const name of members) {
      member = await locate(btf, cur, name);
      if (!member) return null;
      const peeled = await btf.peel(member.type.id);
      let t = peeled.type;
      if (t.kind === "ptr" && t.target) t = (await btf.peel(t.target.id)).type;
      cur = t.id;
      if (name === members[members.length - 1]) return { member, typedefs: peeled.typedefs ?? [] };
    }
    return null;
  } catch {
    return null;
  }
}

/** Expand an alias or a root-rooted path to `{ root, members }`. */
export function splitPath(path) {
  if (ALIASES[path]) return splitPath(ALIASES[path]);
  const [head, ...rest] = path.split(".");
  if (ALIASES[head]) return splitPath(`${ALIASES[head]}.${rest.join(".")}`);
  const root = ROOTS[head];
  if (!root) throw new Error(`unknown root \`${head}\`; a path starts at ${Object.keys(ROOTS).join(", ")}, or is an alias: ${Object.keys(ALIASES).join(", ")}`);
  if (!rest.length) throw new Error(`\`${head}\` is a struct ${root.struct}; name a member of it`);
  return { root, members: rest };
}

/**
 * Resolve a path: `{ root, hops, type, bitfield, typedefs, decode }`.
 * `decode` is the inferred `{ kind, size, … }` for the value.
 */
export async function resolve(btf, path) {
  const { root, members } = splitPath(path);
  let plan;
  try {
    plan = await btf.walk(root.struct, members.join("."));
  } catch (e) {
    throw new Error(String(e?.message ?? e).replace(/\s+Available members:.*$/s, (m) => m.slice(0, 400)));
  }
  const decl = await declared(btf, root.struct, members);
  const terminal = await btf.expand(plan.type.id).catch(() => plan.type);
  const decode = await inferDecode(btf, terminal, decl?.typedefs ?? [], plan.bitfield ?? null);
  return { root, hops: plan.hops, type: terminal, bitfield: plan.bitfield ?? null, typedefs: decl?.typedefs ?? [], decode };
}

const BE = { __be16: 2, __be32: 4, __be64: 8 };

/* What the bytes of a member are, from its type. */
async function inferDecode(btf, t, typedefs, bitfield) {
  if (bitfield) return { kind: "uint", size: t.size ?? 1, bitfield };
  const be = typedefs.find((n) => BE[n]);
  if (be) return be === "__be32" ? { kind: "ip4", size: 4 } : { kind: "be", size: BE[be] };
  if (typedefs.includes("bool") || t.encoding?.bool) return { kind: "bool", size: t.size ?? 1 };
  switch (t.kind) {
    case "int":
      return { kind: t.encoding?.signed ? "int" : "uint", size: t.size ?? 4 };
    case "enum":
      return { kind: "enum", size: t.size ?? 4, values: Object.fromEntries((t.values ?? []).map((v) => [String(v.value), v.name])) };
    case "ptr":
      return { kind: "ptr", size: 8 };
    case "float":
      return { kind: "hex", size: t.size ?? 8 };
    case "array": {
      const elem = t.elem ? (await btf.peel(t.elem.id).catch(() => ({ type: t.elem }))).type : null;
      const size = (elem?.size ?? 1) * (t.nelems ?? 0);
      if (elem?.kind === "int" && elem.size === 1) return { kind: "str", size: Math.min(size, ENTRY_CAP) };
      return { kind: "bytes", size: Math.min(size || 1, MAX_READ) };
    }
    case "struct":
    case "union":
      if (t.name === "in6_addr") return { kind: "ip6", size: 16 };
      return { kind: "bytes", size: Math.min(t.size || 1, MAX_READ) };
    default:
      throw new Error(`cannot read a ${t.kind}${t.name ? ` (${t.name})` : ""}`);
  }
}

/* ---- ops ------------------------------------------------------------------- */

const SIZE_OF = { int: 4, uint: 4, hex: 8, ptr: 8, bool: 1, ip4: 4, ip6: 16, port: 2, be: 2 };

/* Ops that leave the cursor at the member (every hop but the terminal's read). */
function navigate(root, hops) {
  const ops = [op(WOP.BASE, root.reg)];
  for (const h of hops) {
    if (h.at) ops.push(op(WOP.OFF, h.at));
    if (h.op === "deref") ops.push(op(WOP.DEREF));
  }
  return ops;
}

/* A path read out as bytes: `{ ops, decode }`. */
async function readPath(btf, term) {
  const r = await resolve(btf, term.path);
  const ops = navigate(r.root, r.hops);
  let decode = r.decode;
  if (term.as) {
    const kind = term.as.startsWith("json:") ? "json" : term.as;
    const size = term.size ?? (kind === "str" ? ENTRY_CAP : kind === "text" || kind === "bytes" || kind === "json" ? Math.min(r.decode.size ?? 64, MAX_READ) : (SIZE_OF[kind] ?? r.decode.size));
    if (term.size != null && (term.size < 1 || term.size > MAX_READ)) throw new Error(`size 1–${MAX_READ}`);
    decode = { kind, size, ...(kind === "json" ? { field: term.as.slice(5) } : {}), ...(kind === "port" ? { kind: "be", size: 2 } : {}) };
    if (r.bitfield && kind !== "uint" && kind !== "int" && kind !== "hex" && kind !== "bool") throw new Error(`\`${term.path}\` is a bitfield; read it as uint, int, hex or bool`);
    if (r.bitfield) decode.bitfield = r.bitfield;
  }
  if (decode.kind === "str") ops.push(op(WOP.STR));
  else ops.push(op(WOP.READ, Math.min(decode.size, MAX_READ)));
  return { ops, decode, resolved: r };
}

/* A path loaded INTO the cursor, for arithmetic: `{ ops, size }`. */
async function valuePath(btf, term) {
  const r = await resolve(btf, term.path);
  const last = r.hops[r.hops.length - 1];
  if (!last || last.op !== "load") throw new Error(`\`${term.path}\` is not a scalar; arithmetic needs an integer or a pointer`);
  if (r.bitfield) throw new Error(`\`${term.path}\` is a bitfield; arithmetic on it is not supported`);
  const ops = navigate(r.root, r.hops);
  const width = last.width ?? 8;
  ops.push(width === 8 ? op(WOP.DEREF) : op(WOP.LOADN, width));
  return { ops, size: width, resolved: r };
}

function payloadOps(term) {
  if (term.len < 1 || term.len > MAX_READ) throw new Error(`payload len 1–${MAX_READ}`);
  const ops = [op(WOP.BASE, REG_PAYLOAD)];
  if (term.offset) ops.push(op(WOP.OFF, term.offset));
  const kind = term.as.startsWith("json:") ? "json" : term.as;
  if (kind === "str") ops.push(op(WOP.STR));
  else ops.push(op(WOP.READ, term.len));
  return { ops, decode: { kind, size: term.len, payload: term.offset, ...(kind === "json" ? { field: term.as.slice(5) } : {}) } };
}

async function exprOps(btf, expr) {
  if (expr.kind === "path") return readPath(btf, expr);
  if (expr.kind === "payload") return payloadOps(expr);
  /* arithmetic */
  const { sign, a, b } = expr;
  if (a.kind === "int" && b.kind === "int") throw new Error("arithmetic needs a field");
  if (a.kind === "payload" || b.kind === "payload") throw new Error("payload() is bytes, not a number");
  if (b.kind === "int") {
    const va = await valuePath(btf, a);
    if (b.value) va.ops.push(op(sign === "+" ? WOP.OFF : WOP.BACK, b.value));
    va.ops.push(op(WOP.VAL, va.size));
    return { ops: va.ops, decode: { kind: "uint", size: va.size } };
  }
  if (a.kind === "int") {
    if (sign === "-") throw new Error("`N - field` is not supported; write `field - N` or select the field and compute host-side");
    const vb = await valuePath(btf, b);
    if (a.value) vb.ops.push(op(WOP.OFF, a.value));
    vb.ops.push(op(WOP.VAL, vb.size));
    return { ops: vb.ops, decode: { kind: "uint", size: vb.size } };
  }
  const va = await valuePath(btf, a);
  const vb = await valuePath(btf, b);
  const size = Math.max(va.size, vb.size);
  /* b first into scratch 0, then a, then combine — every path is register-rooted, so order is free. */
  const ops = [...vb.ops, op(WOP.STORE, 0), ...va.ops, op(sign === "+" ? WOP.ADD : WOP.SUB, 0), op(WOP.VAL, size)];
  return { ops, decode: { kind: "uint", size } };
}

/* Split a field's ops across pre/body. The cursor is the only state the
 * VM carries between the sections, so a boundary is valid where no
 * forward skip reaches past it and no scratch value is live across it. */
export function split(ops, name) {
  if (ops.length <= MAX_STEP) return [[], ops];
  if (ops.length > 2 * MAX_STEP) throw new Error(`${ops.length} ops — the VM runs ${2 * MAX_STEP} per field; chase fewer pointers`);
  const barred = new Set();
  for (let i = 0; i < ops.length; i++) {
    const { code, arg } = ops[i];
    let end = -1;
    if (code === WOP.SKIPZ || code === WOP.SKIPNZ) end = i + arg;
    if (code === WOP.STORE) {
      for (let j = i + 1; j < ops.length && !(ops[j].code === WOP.STORE && ops[j].arg === arg); j++) {
        if ((ops[j].code === WOP.LOAD || ops[j].code === WOP.ADD || ops[j].code === WOP.SUB) && ops[j].arg === arg) end = j;
      }
    }
    for (let k = i + 1; k <= end; k++) barred.add(k);
  }
  for (let k = Math.min(MAX_STEP, ops.length - 1); k >= ops.length - MAX_STEP; k--) {
    if (!barred.has(k)) return [ops.slice(0, k), ops.slice(k)];
  }
  throw new Error(`no split point in ${ops.length} ops for \`${name}\``);
}

const defaultName = (expr) => {
  if (expr.kind === "path") return expr.path.split(".").pop();
  if (expr.kind === "payload") return "payload";
  return null;
};

/**
 * Compile `select` (strings, one per column) into field programs:
 * `[{ name, source, pre, body, nextOff, maxIters, decode, ops }]`.
 * Throws a CompileError naming the entry.
 */
export async function compile(btf, select) {
  if (!Array.isArray(select) || !select.length) throw new CompileError(null, "select at least one field");
  if (select.length > MAX_FIELDS) throw new CompileError(null, `at most ${MAX_FIELDS} fields per query`);
  const fields = [];
  const names = new Set();
  for (const entry of select) {
    const text = String(entry ?? "").trim();
    try {
      const { name: given, expr } = parseEntry(text);
      const name = given ?? defaultName(expr);
      if (!name) throw new Error("name this column: `name: a - b`");
      if (names.has(name)) throw new Error(`\`${name}\` is selected twice`);
      names.add(name);
      const { ops, decode } = await exprOps(btf, expr);
      const [pre, body] = split(ops, name);
      fields.push({ name, source: text, pre, body, nextOff: 0, maxIters: 1, decode, ops });
    } catch (e) {
      throw new CompileError(text, String(e?.message ?? e));
    }
  }
  return fields;
}
