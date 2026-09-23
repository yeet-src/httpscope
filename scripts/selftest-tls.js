/* Self-test for the TLS taps: resolve a pid's TLS binary through the
 * graph (or take --bin), attach whichever boundaries it has, and print
 * plaintext windows and socket bindings until --secs elapse.
 *
 *   yeet run scripts/selftest-tls.js -- --pid <pid> [--secs 10]
 *   yeet run scripts/selftest-tls.js -- --bin /usr/lib/libssl.so.3
 *   yeet run scripts/selftest-tls.js -- --bin /usr/bin/node --pid <pid>
 *   yeet run scripts/selftest-tls.js -- --bin ./gobin --go "$(node scripts/go-rets.mjs ./gobin)"
 *
 * With --bin alone every process mapping the binary is traced. --go is
 * the Go binary's attach points from its pclntab (file offsets, so a
 * stripped binary works); without it a Go target is not tapped.
 */
import { targetFor } from "../app/lib/probes/discover.js";
import { ascii } from "../app/lib/probes/records.js";
import { attachTls } from "../app/lib/probes/tlscore.js";

const argv = yeet.args ?? {};
const secs = Number(argv.secs ?? 10);
const pid = argv.pid != null ? Number(argv.pid) : undefined;

let binary = argv.bin;
if (!binary) {
  if (pid == null) {
    console.log("need --pid or --bin");
    yeet.exit(1);
  }
  const target = await targetFor(pid);
  if (!target?.binary) {
    console.log(`pid ${pid}: no exe/maps visible`);
    yeet.exit(1);
  }
  console.log(`pid ${pid} is ${target.comm} (${target.cmdline.join(" ").slice(0, 60)}); libssl=${target.libssl ?? "none"} → ${target.binary}`);
  binary = target.binary;
}

const go = argv.go ? JSON.parse(String(argv.go)) : null;

const spec = (file) => ({ exe: `../bin/${file}`, base: import.meta.dirname });
let count = 0;
const session = await attachTls({
  objects: {
    openssl: spec("ssl.bpf.o"),
    openssl_ex: spec("ssl_ex.bpf.o"),
    go: spec("gotls.bpf.o"),
    go_read: spec("gotls_read.bpf.o"),
    rustls: spec("rustls.bpf.o"),
  },
  binary,
  pid,
  go,
  onData(r, tap) {
    count++;
    const arrow = r.dir ? "→" : "←";
    const seg = r.len > r.capLen ? ` [${r.off}+${r.capLen}/${r.len}]` : "";
    console.log(`${String(r.pid).padStart(7)} ${tap.padEnd(10)} ${arrow} ${r.conn} ${String(r.capLen).padStart(5)}b${seg}  ${ascii(r.data, 64)}`);
  },
  onPeer(p, tap) {
    console.log(`${String(p.pid).padStart(7)} ${tap.padEnd(10)} ⇄ ${p.conn} is ${p.saddr}:${p.sport} → ${p.daddr}:${p.dport}`);
  },
  onError: (e) => console.log("error:", e?.message ?? e),
});
console.log(`attached: ${session.taps.join(", ")}; skipped: ${JSON.stringify(session.failures)} — listening ${secs}s`);

await new Promise((r) => setTimeout(r, secs * 1000));
console.log(`${count} records`);
await session.stop();
yeet.exit(0);
