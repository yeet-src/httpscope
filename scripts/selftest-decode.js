/* Self-test for layer 2: the taps feeding the decoder, transactions out.
 *
 *   yeet run scripts/selftest-decode.js -- --port 8080 [--secs 15]
 *   yeet run scripts/selftest-decode.js -- --all
 *   yeet run scripts/selftest-decode.js -- --tls /usr/lib/libssl.so.3
 *   yeet run scripts/selftest-decode.js -- --tls-pid <pid>
 *   yeet run scripts/selftest-decode.js -- --tls ./gobin --go "$(node scripts/go-rets.mjs ./gobin)"
 *
 * The socket tap is always attached (arm it with --port/--pid/--all);
 * --tls / --tls-pid attach the TLS taps as well. Both feed one Decoder,
 * so a plaintext exchange on the wire and a TLS one inside a process
 * come out as the same kind of row. --raw also prints every record.
 */
import { ascii } from "../app/lib/probes/records.js";
import { attachSocket } from "../app/lib/probes/socketcore.js";
import { attachTls } from "../app/lib/probes/tlscore.js";
import { targetFor } from "../app/lib/probes/discover.js";
import { Decoder } from "../app/lib/http/decoder.js";
import { latin1 } from "../app/lib/http/bytes.js";
import { header } from "../app/lib/http/h1.js";

const argv = yeet.args ?? {};
const secs = Number(argv.secs ?? 15);
const spec = (file) => ({ exe: `../bin/${file}`, base: import.meta.dirname });

const ms = (ns) => (ns == null ? "   -  " : `${(Number(ns) / 1e6).toFixed(1).padStart(6)}ms`);
const flowOf = (t) => (t.flow ? `${t.flow.daddr}:${t.flow.dport}` : "?");

const decoder = new Decoder({
  onTransaction(t, c) {
    const who = `${String(t.pid).padStart(7)} ${t.transport ? "tls" : "tcp"} ${t.role === "client" ? "→" : "←"}`;
    const line = `${t.method ?? "?"} ${t.host ?? flowOf(t)}${t.target ?? ""}`;
    const status = t.status ?? "-";
    const sizes = `${t.reqBody.len}b/${t.resBody.len}b`;
    const flag = t.complete ? "" : ` [cut: ${t.cut}${c.note ? `; ${c.note}` : ""}]`;
    const type = header(t.resHeaders, "content-type") ?? "";
    console.log(`${who} ${String(status).padStart(3)} ${ms(t.durationNs)} ${line}  ${sizes} ${type}${flag}`);
    if (argv.body && t.resBody.len) console.log(`        ${ascii(t.resBody.data, 120)}`);
  },
  onConnection(c, event) {
    if (event === "label" && c.proto && c.proto !== "http/1") console.log(`${String(c.pid).padStart(7)} ${c.transport ? "tls" : "tcp"} ${c.conn} is ${c.proto}${c.note ? ` (${c.note})` : ""}`);
  },
});

let records = 0;
const onData = (r, tap) => {
  records++;
  if (argv.raw) console.log(`        ${String(r.ts % 100_000_000_000n).padStart(11)} ${tap ?? "socket"} ${r.dir ? "→" : "←"} ${r.conn} ${r.capLen}b/${r.len}${r.flags ? ` fl=0x${r.flags.toString(16)}` : ""} ${latin1(r.data.subarray(0, 48)).replace(/[^\x20-\x7e]/g, ".")}`);
  decoder.push(r);
};
const onError = (e) => console.log("error:", e?.message ?? e);

const socket = await attachSocket(spec("socket.bpf.o"), { ignorePorts: [3000, 3001, 3002], onData, onError });
if (argv.all) await socket.captureAll(true);
if (argv.port) for (const p of String(argv.port).split(",")) await socket.focusPort(p);
if (argv.pid) for (const p of String(argv.pid).split(",")) await socket.focusPid(p);
console.log("socket tap armed:", JSON.stringify(await socket.settings()));

let tls = null;
let binary = argv.tls;
const tlsPid = argv["tls-pid"] != null ? Number(argv["tls-pid"]) : undefined;
if (!binary && tlsPid != null) {
  const target = await targetFor(tlsPid);
  binary = target?.binary;
  console.log(`pid ${tlsPid} is ${target?.comm}; tls binary ${binary}`);
}
if (binary) {
  tls = await attachTls({
    objects: { openssl: spec("ssl.bpf.o"), openssl_ex: spec("ssl_ex.bpf.o"), go: spec("gotls.bpf.o"), go_read: spec("gotls_read.bpf.o"), rustls: spec("rustls.bpf.o") },
    binary,
    pid: tlsPid,
    go: argv.go ? JSON.parse(String(argv.go)) : null,
    onData,
    onPeer: (p) => decoder.peer(p),
    onError,
  });
  console.log(`tls taps attached: ${tls.taps.join(", ")}; skipped: ${JSON.stringify(tls.failures)}`);
}

console.log(`listening ${secs}s`);
const ticker = setInterval(() => decoder.tick(), 20);
await new Promise((r) => setTimeout(r, secs * 1000));
clearInterval(ticker);
const open = decoder.connections();
console.log(`${records} records; ${open.length} connections open at the end:`);
for (const c of open) console.log(`  ${c.key} ${c.proto} ${c.role ?? "-"} tx=${c.transactions} inflight=${c.inflight}${c.note ? ` (${c.note})` : ""}`);
decoder.sweep(0);
await socket.stop();
await tls?.stop();
yeet.exit(0);
