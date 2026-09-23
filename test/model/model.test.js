import assert from "node:assert/strict";
import { test } from "node:test";

import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";

import { bytesOfString } from "../../app/lib/http/bytes.js";
import { Model, parseBody, serviceOf } from "../../app/lib/model/model.js";

let seq = 0;
const body = (text, extra = {}) => {
  const data = bytesOfString(text ?? "");
  return { len: data.length, holes: 0, truncated: false, data, complete: true, ...extra };
};
const tx = ({ method = "GET", target = "/", host = "api.test", status = 200, res = null, req = null, resType = "application/json", reqType = "application/json", ms = 10, role = "client", pid = 42, at, complete = true, resHeaders = [], flow } = {}) => ({
  id: ++seq,
  at: at ?? 1000 + seq,
  pid,
  role,
  host,
  method,
  target,
  status,
  complete,
  durationNs: BigInt(Math.round(ms * 1e6)),
  reqHeaders: [["host", host], ...(req != null ? [["content-type", reqType]] : [])],
  resHeaders: [...(res != null ? [["content-type", resType]] : []), ...resHeaders],
  reqBody: body(req),
  resBody: body(res),
  flow: flow ?? null,
});

test("services are named by Host, endpoints by method and templated path", () => {
  const m = new Model();
  m.observe(tx({ target: "/users/1", res: '{"id":1}' }));
  m.observe(tx({ target: "/users/2?expand=1", res: '{"id":2}' }));
  m.observe(tx({ method: "POST", target: "/users", req: '{"name":"x"}', status: 201, res: '{"id":3}' }));
  m.observe(tx({ host: "Other.test:443", target: "/" }));
  assert.deepEqual(m.services().map((s) => [s.name, s.endpoints, s.transactions]), [["api.test", 2, 3], ["other.test", 1, 1]]);
  const eps = m.endpoints({ service: "api.test" });
  assert.deepEqual(eps.map((e) => [e.method, e.path, e.n]), [["GET", "/users/{n}", 2], ["POST", "/users", 1]]);
  assert.equal(eps[0].resShape, "{ id: number }");
  assert.deepEqual(eps[0].query, [{ name: "expand", n: 1, kinds: { int: 1 } }]);
  assert.equal(eps[1].reqShape, "{ name: string }");
  assert.deepEqual(eps[1].statuses, { 201: 1 });
  assert.deepEqual(eps[0].pids, ["pid:42"]);
});

test("both ends of a local exchange are named: the caller and the server", () => {
  const m = new Model();
  m.observe(tx({ host: "127.0.0.1:8089", target: "/x" }), { pid: 1, comm: "curl", peer: { pid: 2, comm: "python3" } });
  m.observe(tx({ host: "127.0.0.1:8089", target: "/y", role: "server" }), { pid: 2, comm: "python3", peer: { pid: 3, comm: "node" } });
  const [c, s] = m.services().sort((a, b) => (a.role < b.role ? -1 : 1));
  assert.deepEqual([c.role, c.clients, c.servers], ["client", ["curl:1"], ["python3:2"]]);
  assert.deepEqual([s.role, s.clients, s.servers], ["server", ["node:3"], ["python3:2"]]);
});

test("a vocabulary at one position collapses into {*} and its endpoints merge", () => {
  const events = [];
  const m = new Model({ collapseAfter: 3, onDrift: (e) => events.push(e) });
  for (const name of ["alice", "bob", "carol"]) m.observe(tx({ target: `/users/${name}/posts`, res: '{"n":1}' }));
  assert.equal(m.endpoints().length, 3);
  m.observe(tx({ target: "/users/dave/posts", res: '{"n":2}' }));
  const eps = m.endpoints();
  assert.deepEqual(eps.map((e) => [e.path, e.n]), [["/users/{*}/posts", 4]]);
  assert.equal(eps[0].resShape, "{ n: number }");
  assert.ok(events.some((e) => e.kind === "endpoint.collapsed"));
  m.observe(tx({ target: "/users/erin/posts" }));
  assert.equal(m.endpoints().length, 1);
  m.observe(tx({ target: "/users/erin/likes" }));
  assert.deepEqual(m.endpoints().map((e) => e.path).sort(), ["/users/{*}/likes", "/users/{*}/posts"]);
});

test("drift: a new field, a missing field, a new status, a latency step", () => {
  const events = [];
  const m = new Model({ onDrift: (e) => events.push(e) });
  for (let i = 0; i < 70; i++) m.observe(tx({ target: "/thing", res: '{"id":1,"name":"a"}', ms: 10 + (i % 5) }));
  assert.deepEqual(events.map((e) => e.kind), ["endpoint.new"]);

  m.observe(tx({ target: "/thing", res: '{"id":1,"name":"a","extra":true}' }));
  m.observe(tx({ target: "/thing", res: '{"id":1}' }));
  m.observe(tx({ target: "/thing", status: 503, res: '{"error":"down"}' }));
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("response.field.added"), kinds.join());
  assert.ok(kinds.includes("response.field.missing"));
  assert.ok(kinds.includes("status.new"));
  assert.match(events.find((e) => e.kind === "response.field.added").detail, /200 \$\.extra: boolean/);

  for (let i = 0; i < 32; i++) m.observe(tx({ target: "/thing", res: '{"id":1,"name":"a"}', ms: 200 }));
  assert.ok(events.some((e) => e.kind === "latency.up"), "p95 doubled");
  for (let i = 0; i < 32; i++) m.observe(tx({ target: "/thing", res: '{"id":1,"name":"a"}', ms: 10 }));
  assert.ok(events.some((e) => e.kind === "latency.back"));
  const row = m.endpoints()[0];
  assert.deepEqual(Object.keys(row.statuses).sort(), ["200", "503"]);
  assert.equal(m.endpoint(row.key).resBodies[503].shape, "{ error: string }");
});

test("no drift before an endpoint is settled; a new query parameter afterwards is", () => {
  const events = [];
  const m = new Model({ onDrift: (e) => events.push(e) });
  for (let i = 0; i < 25; i++) m.observe(tx({ target: `/search?q=${i}` }));
  m.observe(tx({ target: "/search?q=1&page=2" }));
  assert.deepEqual(events.map((e) => e.kind), ["endpoint.new", "query.new"]);
});

test("server role, peers without Host, and orphan transactions", () => {
  const m = new Model();
  m.observe(tx({ role: "server", host: null, flow: { saddr: "10.0.0.5", sport: 8080, daddr: "10.0.0.9", dport: 5000 } }));
  m.observe(tx({ role: "client", host: null, flow: { saddr: "10.0.0.5", sport: 5000, daddr: "1.2.3.4", dport: 443 } }));
  m.observe({ method: null, status: 200 });
  assert.deepEqual(m.services().map((s) => [s.role, s.name]), [["server", "10.0.0.5:8080"], ["client", "1.2.3.4"]]);
  assert.equal(m.skipped, 1);
});

test("parseBody: json, text, compressed, cut", () => {
  assert.deepEqual(parseBody(body('{"a":1}'), [["content-type", "application/json"]]).json, { a: 1 });
  assert.deepEqual(parseBody(body("[1]"), []).json, [1]);
  assert.equal(parseBody(body("hello"), [["content-type", "text/plain"]]).text, "hello");
  assert.deepEqual(parseBody(body("\x1f\x8b"), [["content-encoding", "gzip"]]), { encoded: "gzip" });
  assert.equal(parseBody(body('{"a":1}', { truncated: true }), []), null);
  assert.equal(parseBody(body("\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18"), [["content-type", "application/octet-stream"]]), null);
  assert.equal(serviceOf({ host: "Example.COM:443" }), "example.com");
});

test("compressed bodies are inflated through the injected decoder and shaped", () => {
  const inflate = (enc, bytes) => {
    const buf = Buffer.from(bytes);
    const out = enc === "gzip" ? gunzipSync(buf) : enc === "br" ? brotliDecompressSync(buf) : null;
    if (!out) throw new Error(`unsupported ${enc}`);
    return new Uint8Array(out);
  };
  const gz = new Uint8Array(gzipSync(Buffer.from('{"id":1,"tags":["a"]}')));
  const br = new Uint8Array(brotliCompressSync(Buffer.from('{"id":2,"tags":[]}')));
  const zst = new Uint8Array([40, 181, 47, 253, 0, 0]);
  const compressed = (data, enc) => ({ len: data.length, holes: 0, truncated: false, data, complete: true, headers: [["content-type", "application/json"], ["content-encoding", enc]] });

  const withInflate = new Model({ inflate });
  for (const [data, enc] of [[gz, "gzip"], [br, "br"], [zst, "zstd"]]) {
    const c = compressed(data, enc);
    withInflate.observe({ ...tx({ target: "/z" }), resHeaders: c.headers, resBody: c });
  }
  const row = withInflate.endpoints()[0];
  assert.equal(row.resShape, "{ id: number, tags: string[] }");
  assert.equal(withInflate.inflated, 2);
  assert.equal(withInflate.inflateFailed, 1, "zstd was refused by this test's inflate");
  const detail = withInflate.endpoint(row.key);
  assert.deepEqual(detail.resBodies[200].encoded, { zstd: 1 });
  assert.equal(detail.resBodies[200].inflated, 2);

  const without = new Model();
  const c = compressed(gz, "gzip");
  without.observe({ ...tx({ target: "/z" }), resHeaders: c.headers, resBody: c });
  assert.equal(without.endpoints()[0].resShape, null);
  assert.deepEqual(without.endpoint(without.endpoints()[0].key).resBodies[200].encoded, { gzip: 1 });
});
