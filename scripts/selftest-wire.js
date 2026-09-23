/* Self-test for the wire tap: TCX on every interface → reassembly →
 * the decoder, with the TLS taps alongside if asked.
 *
 *   yeet run scripts/selftest-wire.js -- --port 8089 [--secs 15] [--raw] [--body]
 *   yeet run scripts/selftest-wire.js -- --all
 *   yeet run scripts/selftest-wire.js -- --port 8089 --tls /usr/lib/libssl.so.3
 *
 * Each transaction prints with the pids the inventory attributes to the
 * flow's two ends (both, on loopback).
 */
import { ascii } from "../app/lib/probes/records.js";
import { attachWire, attribute, loopbackIfindex } from "../app/lib/probes/wire.js";
import { attachTls } from "../app/lib/probes/tlscore.js";
import { snapshot } from "../app/lib/probes/conns.js";
import { Decoder } from "../app/lib/http/decoder.js";
import { Reassembler, connKeyOf } from "../app/lib/http/tcp.js";
import { header } from "../app/lib/http/h1.js";

const argv = yeet.args ?? {};
const secs = Number(argv.secs ?? 15);
const spec = (file) => ({ exe: `../bin/${file}`, base: import.meta.dirname });
const ms = (ns) => (ns == null ? "   -  " : `${(Number(ns) / 1e6).toFixed(1).padStart(6)}ms`);

/* The inventory, refreshed each second, for attribution. A snapshot
 * can miss a socket's owner now and then (the fd walk races the
 * process table), so listeners once seen with an owner are remembered
 * and merged in: a server outlives its connections. */
let rows = [];
const listeners = new Map();
const refresh = async () => {
  const fresh = await snapshot().catch(() => null);
  if (!fresh) return rows;
  for (const r of fresh) if (r.state === "Listen" && r.pid != null) listeners.set(`${r.laddr}:${r.lport}`, r);
  rows = [...fresh.filter((r) => r.state !== "Listen"), ...listeners.values()];
  return rows;
};
await refresh();
const inventory = setInterval(refresh, 1000);

/* Attribution is looked up when a flow opens — the socket is still in
 * the inventory then — and kept on the flow. */
const flows = new Map();
const who = (t) => {
  const f = flows.get(t.conn);
  if (!f) return String(t.pid || "?").padStart(7);
  const at = f.who ?? attribute(f, rows);
  const name = (p) => (p ? `${p.comm}:${p.pid}` : "remote");
  return t.role === "client" ? `${name(at.a)} → ${name(at.b)}` : `${name(at.a)} ← ${name(at.b)}`;
};

const decoder = new Decoder({
  onTransaction(t, c) {
    const label = t.transport === 2 ? "wire" : t.transport ? "tls" : "tcp";
    const line = `${t.method ?? "?"} ${t.host ?? `${t.flow?.daddr}:${t.flow?.dport}`}${t.target ?? ""}`;
    const flag = t.complete ? "" : ` [cut: ${t.cut}${c.note ? `; ${c.note}` : ""}]`;
    console.log(`${label.padEnd(4)} ${String(t.status ?? "-").padStart(3)} ${ms(t.durationNs)} ${line}  ${t.reqBody.len}b/${t.resBody.len}b ${header(t.resHeaders, "content-type") ?? ""}${flag}  (${who(t)})`);
    if (argv.body && t.resBody.len) console.log(`        ${ascii(t.resBody.data, 120)}`);
    if (argv.raw) console.log(`        attribution: rows=${rows.length} listeners=${[...listeners.keys()].join(",")} who=${JSON.stringify(flows.get(t.conn)?.who ?? null)}`);
  },
  onConnection(c, event) {
    if (event === "label" && c.proto && c.proto !== "http/1") console.log(`${c.transport === 2 ? "wire" : "tls "} ${c.conn} is ${c.proto}${c.note ? ` (${c.note})` : ""}`);
  },
});

let segments = 0;
const tcp = new Reassembler({
  onRecord: (r) => decoder.push(r),
  onClose: (key, why) => decoder.close(connKeyOf(key), why),
  onFlow: (f, event) => {
    if (event === "open") {
      flows.set(f.key, f);
      refresh().then((r) => (f.who = attribute(f, r)));
    }
    if (argv.raw) console.log(`        flow ${event} ${f.key}`);
  },
});

const wire = await attachWire(spec("wire.bpf.o"), {
  ignorePorts: [3000, 3001, 3002],
  loIfindex: await loopbackIfindex(),
  ifindex: argv.ifindex ? String(argv.ifindex).split(",").map(Number) : undefined,
  ns: argv.ns ? (argv.ns === "host" ? "host" : { pid: Number(argv.ns) }) : undefined,
  onRecord(r) {
    segments++;
    if (argv.raw) {
      const fl = [r.tcpflags & 2 ? "S" : "", r.tcpflags & 1 ? "F" : "", r.tcpflags & 4 ? "R" : "", r.tcpflags & 8 ? "P" : ""].join("");
      console.log(`        if${r.ifindex} ${r.hook ? "out" : "in "} ${r.saddr}:${r.sport} > ${r.daddr}:${r.dport} seq=${r.seq} ${r.capLen}b/${r.len}${r.off ? `@${r.off}` : ""} ${fl}  ${ascii(r.data, 40)}`);
    }
    tcp.push(r);
  },
  onError: (e) => console.log("error:", e?.message ?? e),
});
if (argv.all) await wire.captureAll(true);
if (argv.port) for (const p of String(argv.port).split(",")) await wire.focusPort(p);
console.log("wire tap armed:", JSON.stringify(await wire.settings()), "on interfaces", JSON.stringify(wire.ifindex));

let tls = null;
if (argv.tls) {
  tls = await attachTls({
    objects: { openssl: spec("ssl.bpf.o"), openssl_ex: spec("ssl_ex.bpf.o"), go: spec("gotls.bpf.o"), go_read: spec("gotls_read.bpf.o"), rustls: spec("rustls.bpf.o") },
    binary: argv.tls,
    go: argv.go ? JSON.parse(String(argv.go)) : null,
    onData: (r) => decoder.push(r),
    onPeer: (p) => decoder.peer(p),
    onError: (e) => console.log("error:", e?.message ?? e),
  });
  console.log(`tls taps attached: ${tls.taps.join(", ")}`);
}

console.log(`listening ${secs}s`);
const ticker = setInterval(() => {
  tcp.tick();
  decoder.tick();
}, 20);
await new Promise((r) => setTimeout(r, secs * 1000));
clearInterval(ticker);
clearInterval(inventory);

console.log("kernel counters:", JSON.stringify(await wire.stats()));
console.log(`${segments} segments; ${tcp.list().length} flows open:`);
for (const f of tcp.list()) console.log(`  ${f.key} out=${f.bytesOut}b in=${f.bytesIn}b holes=${f.holes} pending=${f.pending}`);
for (const c of decoder.connections()) console.log(`  ${c.key} ${c.proto} ${c.role ?? "-"} tx=${c.transactions} inflight=${c.inflight}${c.note ? ` (${c.note})` : ""}`);
await wire.stop();
await tls?.stop();
yeet.exit(0);
