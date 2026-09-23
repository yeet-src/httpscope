#!/usr/bin/env node
// The Go tap's attach points for a binary, from its own .gopclntab — no
// binutils involved. Prints JSON the self-test takes as --go:
//
//   node scripts/go-rets.mjs <binary>
//   yeet run scripts/selftest-tls.js -- --bin <binary> --go "$(node scripts/go-rets.mjs <binary>)"
import { readFileSync } from "node:fs";

import { goTlsTargets } from "../app/lib/probes/gopclntab.js";

const bin = process.argv[2];
if (!bin) {
  console.error("usage: go-rets.mjs <binary>");
  process.exit(2);
}
const targets = goTlsTargets(new Uint8Array(readFileSync(bin)));
if (!targets) {
  console.error(`${bin}: not a Go binary with crypto/tls`);
  process.exit(1);
}
console.log(JSON.stringify(targets));
