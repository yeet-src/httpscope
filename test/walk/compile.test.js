import assert from "node:assert/strict";
import { test } from "node:test";

import { compile, parseEntry, resolve, split } from "../../app/lib/walk/compile.js";
import { WOP, op, opText } from "../../app/lib/walk/vm.js";
import { btf } from "./btf-stub.js";

const text = (ops) => ops.map(opText).join("; ");
const one = async (entry) => (await compile(btf, [entry]))[0];

test("parseEntry: alias, path with kind, payload, arithmetic", () => {
  assert.deepEqual(parseEntry("cwnd"), { name: null, expr: { kind: "path", path: "cwnd", as: null, size: null } });
  assert.deepEqual(parseEntry("st: sock.__sk_common.skc_state(hex)"), { name: "st", expr: { kind: "path", path: "sock.__sk_common.skc_state", as: "hex", size: null } });
  assert.deepEqual(parseEntry("raw: tcp.rx_opt(bytes, 24)").expr, { kind: "path", path: "tcp.rx_opt", as: "bytes", size: 24 });
  assert.deepEqual(parseEntry("req: payload(32, 96, text)").expr, { kind: "payload", offset: 32, len: 96, as: "text" });
  assert.deepEqual(parseEntry("skb.payload(0, 64)").expr, { kind: "payload", offset: 0, len: 64, as: "text" });
  assert.deepEqual(parseEntry("id: payload(0, 200, json:id)").expr, { kind: "payload", offset: 0, len: 200, as: "json:id" });
  const a = parseEntry("inflight: tcp.snd_nxt - tcp.snd_una");
  assert.equal(a.expr.kind, "arith");
  assert.equal(a.expr.sign, "-");
  assert.equal(a.expr.b.path, "tcp.snd_una");
  assert.throws(() => parseEntry("cwnd(volts)"), /unknown kind/);
  assert.throws(() => parseEntry("42"), /number alone/);
  assert.throws(() => parseEntry("a b"), /unexpected/);
});

test("a plain member: base, offset, read — with the kind from its typedef", async () => {
  const f = await one("daddr");
  assert.equal(f.name, "daddr");
  assert.equal(text(f.body), "base; read 4");
  assert.deepEqual(f.decode, { kind: "ip4", size: 4 });

  const d = await one("dport");
  assert.equal(text(d.body), "base; off 12; read 2");
  assert.deepEqual(d.decode, { kind: "be", size: 2 });

  const s = await one("sport");
  assert.equal(text(s.body), "base; off 14; read 2");
  assert.deepEqual(s.decode, { kind: "uint", size: 2 });

  const c = await one("cwnd");
  assert.equal(text(c.body), "base; off 1492; read 4");
  assert.deepEqual(c.decode, { kind: "uint", size: 4 });

  const r = await one("sock.sk_rcvbuf");
  assert.equal(r.name, "sk_rcvbuf");
  assert.deepEqual(r.decode, { kind: "int", size: 4 });

  const q = await one("sock.__sk_common.skc_state");
  assert.equal(text(q.body), "base; off 18; read 1", "a volatile qualifier is peeled");
});

test("an embedded struct only accumulates the offset", async () => {
  const f = await one("tcp.rx_opt.ts_recent");
  assert.equal(text(f.body), "base; off 1604; read 4");
});

test("a pointer crossed is a deref hop; a char array is a string", async () => {
  const f = await one("iface: sock.sk_dst_cache.dev.name");
  assert.equal(text(f.body), "base; off 552; deref; deref; off 288; str");
  assert.equal(f.decode.kind, "str");
  const p = await one("proto");
  assert.equal(text(p.body), "base; off 40; deref; off 392; str");
  const m = await one("sock.sk_dst_cache.dev.mtu");
  assert.equal(text(m.body), "base; off 552; deref; deref; off 400; read 4");
});

test("the skb root uses register 1", async () => {
  const f = await one("skb.len");
  assert.equal(text(f.body), "base 1; off 112; read 4");
  const d = await one("skb.dev.name");
  assert.equal(text(d.body), "base 1; off 16; deref; off 288; str");
});

test("a pointer leaf reads as a pointer; a struct as bytes; in6_addr as ip6; an enum by name", async () => {
  assert.deepEqual((await one("sock.sk_dst_cache")).decode, { kind: "ptr", size: 8 });
  const s = await one("tcp.rx_opt");
  assert.deepEqual(s.decode, { kind: "bytes", size: 24 });
  assert.equal(text(s.body), "base; off 1600; read 24");
  assert.deepEqual((await one("sock.sk_v6_daddr")).decode, { kind: "ip6", size: 16 });
  const e = await one("sock.sk_kind");
  assert.equal(e.decode.kind, "enum");
  assert.deepEqual(e.decode.values, { 0: "SK_PLAIN", 1: "SK_FANCY" });
});

test("a bitfield reads its storage unit and carries its position", async () => {
  const f = await one("tcp.tcp_usec_ts");
  assert.equal(text(f.body), "base; off 1511; read 1");
  assert.deepEqual(f.decode, { kind: "uint", size: 1, bitfield: { bit_offset: 1, bit_size: 1 } });
  const ca = await one("ca");
  assert.deepEqual(ca.decode.bitfield, { bit_offset: 0, bit_size: 5 });
  await assert.rejects(one("tcp.repair(str)"), /bitfield/);
});

test("an explicit kind overrides; size follows the kind or is given", async () => {
  const h = await one("st: state(hex)");
  assert.equal(text(h.body), "base; off 18; read 8");
  assert.deepEqual(h.decode, { kind: "hex", size: 8 });
  const b = await one("raw: tcp.rx_opt(bytes, 8)");
  assert.equal(text(b.body), "base; off 1600; read 8");
  const j = await one("id: sock.sk_dst_cache.dev.name(json:id)");
  assert.deepEqual(j.decode, { kind: "json", size: 16, field: "id" });
  const p = await one("p: sock.__sk_common.skc_num(port)");
  assert.deepEqual(p.decode, { kind: "be", size: 2 });
  await assert.rejects(one("x: cwnd(bytes, 300)"), /size 1–255/);
});

test("payload() is a window from the payload register the prologue fills", async () => {
  const f = await one("req: payload(32, 96, text)");
  assert.equal(text(f.body), "base 2; off 32; read 96");
  assert.deepEqual(f.decode, { kind: "text", size: 96, payload: 32 });
  const j = await one("id: skb.payload(0, 200, json:id)");
  assert.equal(text(j.body), "base 2; read 200");
  assert.deepEqual(j.decode, { kind: "json", size: 200, payload: 0, field: "id" });
  await assert.rejects(one("payload(0, 256)"), /len 1–255/);
});

test("arithmetic between two members runs through scratch, sized to the wider", async () => {
  const f = await one("inflight: tcp.snd_nxt - tcp.snd_una");
  assert.equal(text(f.pre), "base; off 1720; loadn 4; store; base; off 1716; loadn 4; sub", "the cut falls after the sub consumed the scratch value");
  assert.equal(text(f.body), "val 4");
  assert.deepEqual(f.decode, { kind: "uint", size: 4 });
  const w = await one("x: tcp.bytes_acked + tcp.snd_una");
  assert.equal(text([...w.pre, ...w.body]), "base; off 1720; loadn 4; store; base; off 1840; deref; add; val 8");
  const k = await one("next: cwnd + 1");
  assert.equal(text(k.body), "base; off 1492; loadn 4; off 1; val 4");
  const m = await one("prev: cwnd - 1");
  assert.equal(text(m.body), "base; off 1492; loadn 4; back 1; val 4");
  await assert.rejects(one("tcp.snd_nxt - tcp.snd_una"), /name this column/);
  await assert.rejects(one("x: sock.sk_dst_cache.dev.name - cwnd"), /not a scalar/);
  await assert.rejects(one("x: ca - 1"), /bitfield/);
  await assert.rejects(one("x: 1 - cwnd"), /not supported/);
  await assert.rejects(one("x: payload(0, 4) - cwnd"), /bytes, not a number/);
});

test("a long chase splits across pre and body; too long is refused with the budget", async () => {
  const f = await one("inode");
  assert.equal(text([...f.pre, ...f.body]), "base; off 288; deref; off 16; deref; off 32; deref; off 64; read 8");
  assert.equal(f.pre.length, 8);
  assert.equal(f.body.length, 1);
  assert.deepEqual(f.decode, { kind: "uint", size: 8 });
  const deep = await one("major: sock.sk_socket.file.f_inode.i_sb.s_bdev.bd_disk.major");
  assert.equal(deep.pre.length + deep.body.length, 14, "six pointers fit");
  await assert.rejects(one("nr: sock.sk_socket.file.f_inode.i_sb.s_bdev.bd_disk.queue.nr_requests"), /17 ops — the VM runs 16 per field/);
});

test("split never cuts through a live scratch value or a skip", () => {
  const ops = [op(WOP.BASE), op(WOP.OFF, 1), op(WOP.LOADN, 4), op(WOP.STORE, 0), op(WOP.BASE), op(WOP.OFF, 2), op(WOP.LOADN, 4), op(WOP.OFF, 3), op(WOP.SUB, 0), op(WOP.VAL, 4)];
  const [pre, body] = split(ops, "x");
  assert.equal(pre.length, 3, "the store at 3 keeps 4..8 together");
  assert.equal(body.length, 7);
  const skip = [op(WOP.BASE), op(WOP.OFF, 1), op(WOP.LOADN, 4), op(WOP.EQ, 1), op(WOP.SKIPZ, 4), op(WOP.BASE), op(WOP.OFF, 2), op(WOP.READ, 4), op(WOP.END), op(WOP.END)];
  const [p2] = split(skip, "y");
  assert.ok(p2.length <= 4, `pre ${p2.length} reaches into the skipped range`);
});

test("errors name the entry and carry BTF's own message", async () => {
  await assert.rejects(compile(btf, ["nope.x"]), /`nope\.x`: unknown root `nope`/);
  await assert.rejects(compile(btf, ["sock"]), /name a member/);
  await assert.rejects(compile(btf, ["tcp.snd_cwndd"]), /has no member "snd_cwndd".*Available members: snd_cwnd/);
  await assert.rejects(compile(btf, []), /at least one/);
  await assert.rejects(compile(btf, new Array(9).fill("cwnd")), /at most 8/);
  await assert.rejects(compile(btf, ["cwnd", "cwnd"]), /selected twice/);
  await assert.rejects(compile(btf, ["a: cwnd", "a: srtt"]), /selected twice/);
});

test("resolve() reports what it found", async () => {
  const r = await resolve(btf, "dport");
  assert.deepEqual(r.hops, [{ op: "load", at: 12, width: 2 }]);
  assert.deepEqual(r.typedefs, ["__be16", "__u16"]);
  assert.equal(r.type.kind, "int");
});
