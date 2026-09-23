#!/usr/bin/env node
/* Ask a model snapshot a GraphQL question, from the shell.
 *
 *   node scripts/query.mjs snapshot.json '{ services { name transactions } }'
 *   node scripts/query.mjs snapshot.json --check '{ nope }'
 *
 * The snapshot is what `selftest-model.js --dump` writes (the isolate's
 * `Model.snapshot()`); layer 5 serves the same thing over HTTP.
 */
import { readFileSync } from "node:fs";

import { check, execute } from "../app/lib/query/query.js";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: query.mjs <snapshot.json> [--check] '<graphql>'");
  process.exit(2);
}
const checking = rest[0] === "--check";
const source = (checking ? rest.slice(1) : rest).join(" ") || "{ summary { transactions services endpoints drift } }";
const snapshot = JSON.parse(readFileSync(file, "utf8"));
const out = checking ? { errors: check(source) } : await execute(snapshot, source);
console.log(JSON.stringify(out, null, 2));
process.exit(out.errors?.length ? 1 : 0);
