/* Self-test for layer 3: wire tap (+ TLS taps) → decoder → model.
 *
 *   yeet run scripts/selftest-model.js -- --port 8089 [--secs 20]
 *   yeet run scripts/selftest-model.js -- --all --tls /usr/lib/libssl.so.3
 *   yeet run scripts/selftest-model.js -- --port 8089 --dump   # then the snapshot as JSON, after a ---SNAPSHOT--- line
 *
 * Drift events print as they happen; the endpoint table at the end.
 */
import { attachWire, attribute } from "../app/lib/probes/wire.js";
import { attachTls } from "../app/lib/probes/tlscore.js";
import { snapshot } from "../app/lib/probes/conns.js";
import { Decoder } from "../app/lib/http/decoder.js";
import { Reassembler, connKeyOf } from "../app/lib/http/tcp.js";
import { Model } from "../app/lib/model/model.js";
import { decodeContentEncoding } from "yeet:compression";

const argv = yeet.args ?? {};
const secs = Number(argv.secs ?? 20);
const spec = (file) => ({ exe: `../bin/${file}`, base: import.meta.dirname });

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

const flows = new Map();
const whoFor = (t) => {
  const f = flows.get(t.conn);
  if (!f) return t.pid ? { pid: t.pid, comm: null } : null;
  const at = f.who ?? attribute(f, rows);
  const [side, other] = t.role === "client" ? [at.a, at.b] : [at.b, at.a];
  const who = side ? { pid: side.pid, comm: side.comm } : { pid: null, comm: null };
  if (other) who.peer = { pid: other.pid, comm: other.comm };
  return who;
};

const model = new Model({
  inflate: decodeContentEncoding,
  onDrift: (e) => console.log(`drift ${e.kind.padEnd(24)} ${e.role} ${e.service} ${e.method} ${e.path}  ${e.detail}`),
});
let txCount = 0;
const decoder = new Decoder({
  onTransaction(t) {
    txCount++;
    model.observe(t, whoFor(t));
  },
});
const tcp = new Reassembler({
  onRecord: (r) => decoder.push(r),
  onClose: (key, why) => decoder.close(connKeyOf(key), why),
  onFlow: (f, event) => {
    if (event === "open") {
      flows.set(f.key, f);
      refresh().then((r) => (f.who = attribute(f, r)));
    }
  },
});
const wire = await attachWire(spec("wire.bpf.o"), { ignorePorts: [3000, 3001, 3002], onRecord: (r) => tcp.push(r), onError: (e) => console.log("error:", e?.message ?? e) });
if (argv.all) await wire.captureAll(true);
if (argv.port) for (const p of String(argv.port).split(",")) await wire.focusPort(p);
let tls = null;
if (argv.tls) {
  tls = await attachTls({
    objects: { openssl: spec("ssl.bpf.o"), openssl_ex: spec("ssl_ex.bpf.o"), go: spec("gotls.bpf.o"), go_read: spec("gotls_read.bpf.o"), rustls: spec("rustls.bpf.o") },
    binary: argv.tls,
    onData: (r) => decoder.push(r),
    onPeer: (p) => decoder.peer(p),
    onError: (e) => console.log("error:", e?.message ?? e),
  });
}
console.log(`listening ${secs}s on interfaces ${JSON.stringify(wire.ifindex)}${tls ? `, tls: ${tls.taps.join(",")}` : ""}`);
const ticker = setInterval(() => {
  tcp.tick();
  decoder.tick();
}, 20);
await new Promise((r) => setTimeout(r, secs * 1000));
clearInterval(ticker);
clearInterval(inventory);

console.log(`\n${txCount} transactions → ${model.services().length} services, ${model.endpoints().length} endpoints; ${model.inflated} bodies inflated, ${model.inflateFailed} failed\n`);
for (const s of model.services()) console.log(`${s.role.padEnd(6)} ${s.name.padEnd(28)} ${String(s.endpoints).padStart(3)} endpoints ${String(s.transactions).padStart(5)} tx  by ${s.clients.join(" ") || "-"}  served by ${s.servers.join(" ") || "-"}`);
console.log();
for (const e of model.endpoints()) {
  const lat = e.latency.p50 != null ? `p50 ${e.latency.p50.toFixed(1)}ms p95 ${e.latency.p95.toFixed(1)}ms` : "";
  console.log(`${e.role.padEnd(6)} ${e.service.padEnd(22)} ${e.method.padEnd(6)} ${e.path.padEnd(32)} ${String(e.n).padStart(4)}  ${JSON.stringify(e.statuses)}  ${lat}`);
  if (e.query.length) console.log(`         ?${e.query.map((q) => `${q.name}<${Object.keys(q.kinds).join("|")}>`).join("&")}`);
  if (e.reqShape) console.log(`         → ${e.reqType}: ${e.reqShape.replace(/\n/g, "\n           ")}`);
  if (e.resShape) console.log(`         ← ${e.resType}: ${e.resShape.replace(/\n/g, "\n           ")}`);
  else if (e.resType) console.log(`         ← ${e.resType}`);
}
if (argv.dump) {
  console.log("---SNAPSHOT---");
  console.log(JSON.stringify(model.snapshot()));
}
await wire.stop();
await tls?.stop();
yeet.exit(0);
