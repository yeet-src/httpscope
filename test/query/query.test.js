import assert from "node:assert/strict";
import { test } from "node:test";

import { bytesOfString } from "../../app/lib/http/bytes.js";
import { Model } from "../../app/lib/model/model.js";
import { check, execute as run } from "../../app/lib/query/query.js";

/* GraphQL results are null-prototype objects; compare them as plain data. */
const execute = async (...args) => JSON.parse(JSON.stringify(await run(...args)));

let seq = 0;
const body = (text) => {
  const data = bytesOfString(text ?? "");
  return { len: data.length, holes: 0, truncated: false, data, complete: true };
};
const tx = ({ method = "GET", target = "/", host = "api.test", status = 200, res = null, req = null, ms = 10, role = "client", pid = 42, at } = {}) => ({
  id: ++seq,
  at: at ?? 1_000_000 + seq * 1000,
  pid,
  role,
  host,
  method,
  target,
  status,
  complete: true,
  durationNs: BigInt(Math.round(ms * 1e6)),
  reqHeaders: [["host", host], ...(req != null ? [["content-type", "application/json"]] : [])],
  resHeaders: res != null ? [["content-type", "application/json"]] : [],
  reqBody: body(req),
  resBody: body(res),
  flow: null,
});

const snapshot = () => {
  const m = new Model({ now: () => 2_000_000 });
  for (let i = 1; i <= 5; i++) m.observe(tx({ target: `/users/${i}?expand=true`, res: `{"id":${i},"name":"u${i}"}`, ms: 5 + i }), { pid: 42, comm: "curl" });
  m.observe(tx({ target: "/users/9", status: 404, res: '{"error":"no"}', ms: 3 }));
  m.observe(tx({ method: "POST", target: "/users", req: '{"name":"z"}', status: 201, res: '{"id":6}', ms: 40 }));
  m.observe(tx({ host: "other.test", target: "/health", ms: 1, role: "server" }), { pid: 7, comm: "node" });
  return m.snapshot();
};

test("summary and services", async () => {
  const r = await execute(snapshot(), "{ summary { transactions services endpoints drift } services { role name endpoints transactions clients servers lastAgo } }", { now: () => 2_000_000 });
  assert.equal(r.errors, undefined);
  assert.deepEqual(r.data.summary, { transactions: 8, services: 2, endpoints: 3, drift: 3 });
  const s0 = r.data.services[0];
  assert.deepEqual([s0.role, s0.name, s0.endpoints, s0.transactions, s0.clients, s0.servers], ["CLIENT", "api.test", 2, 7, ["curl:42", "pid:42"], []]);
  assert.equal(r.data.services[1].role, "SERVER");
  assert.deepEqual(r.data.services[1].servers, ["node:7"]);
});

test("endpoints: filters, sorting, shapes and statuses", async () => {
  const snap = snapshot();
  const q = `{
    endpoints(service: "api.test", sort: LATENCY) {
      method path n errors statuses { status count } latency { p50 p95 } query { name kinds { kind count } }
      request { body { shape } } responses { status body { shape example } }
    }
  }`;
  const r = await execute(snap, q);
  assert.equal(r.errors, undefined);
  const [post, get] = r.data.endpoints;
  assert.equal(post.method, "POST");
  assert.equal(post.request.body.shape, "{ name: string }");
  assert.deepEqual(post.responses, [{ status: 201, body: { shape: "{ id: number }", example: '{"id":6}' } }]);
  assert.equal(get.path, "/users/{n}");
  assert.equal(get.n, 6);
  assert.equal(get.errors, 1);
  assert.deepEqual(get.statuses, [{ status: 200, count: 5 }, { status: 404, count: 1 }]);
  assert.deepEqual(get.query, [{ name: "expand", kinds: [{ kind: "bool", count: 5 }] }]);
  assert.deepEqual(get.responses.map((x) => [x.status, x.body.shape]), [[200, "{ id: number, name: string }"], [404, "{ error: string }"]]);

  const only404 = (await execute(snap, '{ endpoints(status: 404) { path } }')).data.endpoints;
  assert.deepEqual(only404, [{ path: "/users/{n}" }]);
  const globbed = (await execute(snap, '{ endpoints(path: "/users*", method: "post") { path } }')).data.endpoints;
  assert.deepEqual(globbed, [{ path: "/users" }]);
  const servers = (await execute(snap, "{ endpoints(role: SERVER) { service path } }")).data.endpoints;
  assert.deepEqual(servers, [{ service: "other.test", path: "/health" }]);
  assert.equal((await execute(snap, "{ endpoints(limit: 1) { path } }")).data.endpoints.length, 1);
});

test("endpoint by identity, and drift with since", async () => {
  const snap = snapshot();
  const one = (await execute(snap, '{ endpoint(service: "api.test", method: "GET", path: "/users/{n}") { key n pids } }')).data.endpoint;
  assert.equal(one.n, 6);
  assert.deepEqual(one.pids, ["curl:42", "pid:42"]);
  assert.equal((await execute(snap, '{ endpoint(service: "nope", method: "GET", path: "/") { n } }')).data.endpoint, null);

  const last = snap.drift[snap.drift.length - 1].at;
  const now = () => last + 2000;
  const all = (await execute(snap, "{ drift { kind path ago } }", { now })).data.drift;
  assert.deepEqual(all.map((d) => d.kind), ["endpoint.new", "endpoint.new", "endpoint.new"]);
  assert.ok(all[0].ago > 0);
  /* the events are 1s apart; 3.5s back from 2s after the last one reaches the last two */
  const recent = (await execute(snap, "{ drift(since: 3.5) { path } }", { now })).data.drift;
  assert.deepEqual(recent.map((d) => d.path), ["/users", "/health"]);
  assert.deepEqual((await execute(snap, '{ drift(kinds: ["status.new"]) { kind } }')).data.drift, []);
});

test("variables, introspection and errors", async () => {
  const snap = snapshot();
  const r = await execute(snap, "query($s: String!) { endpoints(service: $s) { path } }", { variables: { s: "other.test" } });
  assert.deepEqual(r.data.endpoints, [{ path: "/health" }]);
  const intro = await execute(snap, "{ __schema { queryType { name } } __type(name: \"Endpoint\") { fields { name } } }");
  assert.equal(intro.data.__schema.queryType.name, "Query");
  assert.ok(intro.data.__type.fields.some((f) => f.name === "responses"));
  const bad = await execute(snap, "{ endpoints { nope } }");
  assert.match(bad.errors[0].message, /Cannot query field "nope"/);
  assert.equal(check("{ services { name } }").length, 0);
  assert.match(check("{ services { ")[0].message, /Syntax Error/);
});

test("where composes comparisons on metrics and facts; orderBy sorts by any metric", async () => {
  const snap = snapshot();
  const q = (where, extra = "") => execute(snap, `{ endpoints(where: ${where} ${extra}) { path method errorRate n tailRatio } }`).then((r) => {
    if (r.errors) throw new Error(JSON.stringify(r.errors));
    return r.data.endpoints;
  });
  assert.deepEqual((await q("{ metrics: [{ metric: ERROR_RATE, is: { gt: 0.1 } }] }")).map((e) => e.path), ["/users/{n}"]);
  assert.deepEqual((await q("{ metrics: [{ metric: ERROR_RATE, is: { gt: 0.1 } }, { metric: N, is: { gte: 100 } }] }")), []);
  assert.deepEqual((await q("{ statusBetween: [500, 599] }")), []);
  assert.deepEqual((await q("{ status: 404 }")).map((e) => e.path), ["/users/{n}"]);
  assert.deepEqual((await q("{ templated: true }")).map((e) => e.path), ["/users/{n}"]);
  assert.deepEqual((await q("{ requestHeader: \"content-type\" }")).map((e) => e.method), ["POST"]);
  assert.deepEqual((await q("{ or: [{ method: { eq: \"POST\" } }, { role: SERVER }] }")).map((e) => e.path).sort(), ["/health", "/users"]);
  assert.deepEqual((await q("{ not: { service: { like: \"api.*\" } } }")).map((e) => e.path), ["/health"]);
  assert.deepEqual((await q("{}", ", orderBy: { metric: P95 }")).map((e) => e.path), ["/users", "/users/{n}", "/health"]);
  assert.deepEqual((await q("{}", ", orderBy: { metric: P95, desc: false }")).map((e) => e.path), ["/health", "/users/{n}", "/users"]);
  assert.deepEqual((await q("{ queryParam: \"expand\" }")).map((e) => e.path), ["/users/{n}"]);
  assert.deepEqual((await q("{ driftKinds: [\"endpoint.new\"] }")).length, 3);
});

test("metrics, key stats, transports and service aggregates are plain numbers and facts", async () => {
  const snap = snapshot();
  const r = await execute(snap, `{
    services(name: "api.test") { stats { transactions errors errorRate p95Median p95Max plaintextEndpoints } }
    endpoint(service: "api.test", method: "GET", path: "/users/{n}") {
      errorRate clientErrors serverErrors notFound tailRatio burstMax transports { transport count }
      p95: metric(name: P95) presence: metric(name: KEY_PRESENCE_MIN) mixed: metric(name: KEYS_MIXED)
      responses { status body { keys { path presence types count } } }
      request { headerCounts { name count } }
      drift { kind }
    }
  }`);
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  const s = r.data.services[0].stats;
  assert.deepEqual([s.transactions, s.errors, s.errorRate.toFixed(3), s.plaintextEndpoints], [7, 1, "0.143", 2]);
  assert.ok(s.p95Max >= s.p95Median);
  const e = r.data.endpoint;
  assert.deepEqual([e.clientErrors, e.serverErrors, e.notFound, e.errorRate.toFixed(3)], [1, 0, 1, "0.167"]);
  assert.ok(e.tailRatio >= 1);
  assert.ok(e.burstMax >= 2, "calls a second apart overlap in pairs");
  assert.deepEqual(e.transports, [{ transport: "TCP", count: 6 }]);
  assert.equal(e.p95, e.p95);
  assert.equal(e.presence, 1);
  assert.equal(e.mixed, 0);
  assert.deepEqual(e.responses[0].body.keys, [
    { path: "$.id", presence: 1, types: ["number"], count: 5 },
    { path: "$.name", presence: 1, types: ["string"], count: 5 },
  ]);
  assert.deepEqual(e.request.headerCounts, [{ name: "host", count: 6 }]);
  assert.deepEqual(e.drift.map((d) => d.kind), ["endpoint.new"]);
});

test("transactions come from the loader, filtered by the same where semantics", async () => {
  const snap = snapshot();
  const ring = [
    { at: 1000, role: "client", service: "api.test", method: "GET", path: "/users/{n}", target: "/users/1", status: 200, duration: 5, transport: 2, pid: 42, comm: "curl", peer: null, complete: true, cut: null, requestHeaders: [["host", "api.test"], ["authorization", "Bearer x"]], responseHeaders: [["content-type", "application/json"]], requestBody: null, requestBodyLength: 0, responseBody: '{"id":1}', responseBodyLength: 8 },
    { at: 2000, role: "client", service: "api.test", method: "GET", path: "/users/{n}", target: "/users/9", status: 404, duration: 3, transport: 2, pid: 43, comm: "curl", peer: null, complete: true, cut: null, requestHeaders: [["host", "api.test"]], responseHeaders: [], requestBody: null, requestBodyLength: 0, responseBody: '{"error":"no"}', responseBodyLength: 14 },
  ];
  const { filterTransactions } = await import("../../app/lib/query/query.js");
  const loaders = { transactions: async (where, limit) => filterTransactions(ring, where, limit, 3000) };
  const r = await execute(snap, `{ transactions(where: { statusBetween: [400, 499] }) { target status transport requestHeaders { name } responseBody ago } }`, { loaders, now: () => 3000 });
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  assert.deepEqual(r.data.transactions, [{ target: "/users/9", status: 404, transport: "WIRE", requestHeaders: [{ name: "host" }], responseBody: '{"error":"no"}', ago: 1 }]);
  const auth = await execute(snap, `{ transactions(where: { requestHeader: "authorization", transport: WIRE }) { target } }`, { loaders });
  assert.deepEqual(auth.data.transactions, [{ target: "/users/1" }]);
  const body = await execute(snap, `{ transactions(where: { responseBodyContains: "error" }) { status } }`, { loaders });
  assert.deepEqual(body.data.transactions, [{ status: 404 }]);
  const none = await execute({ ...snap, recent: ring }, `{ transactions(limit: 1) { status } }`);
  assert.deepEqual(none.data.transactions, [{ status: 404 }], "without a loader the snapshot's own ring answers, newest first");
});

test("field directives: @when drops rows, arithmetic computes from siblings", async () => {
  const snap = snapshot();
  const r = await execute(snap, `{
    endpoints {
      path
      p50: metric(name: P50)
      p99: metric(name: P99)
      tail: metric(name: P99) @div(field: "p50")
      slow: metric(name: P95) @when(gt: 20)
      errorRate @when(lte: 1)
    }
  }`);
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  assert.deepEqual(r.data.endpoints.map((e) => e.path), ["/users"], "only the POST has p95 over 20ms");
  const e = r.data.endpoints[0];
  assert.ok(Math.abs(e.tail - e.p99 / e.p50) < 1e-9);
  const glob = await execute(snap, `{ endpoints { path @when(like: "/users*") method @when(in: ["GET"]) } }`);
  assert.deepEqual(glob.data.endpoints, [{ path: "/users/{n}", method: "GET" }]);
  const single = await execute(snap, `{ endpoint(service: "api.test", method: "GET", path: "/users/{n}") { n @when(gt: 1000) } }`);
  assert.equal(single.data.endpoint, null, "a non-list object failing @when becomes null");
  const bad = await execute(snap, `{ endpoints { n @minus(field: "nope") } }`);
  assert.match(bad.errors[0].message, /no such field/);
});

test("a pipeline tail runs JavaScript over every top-level list", async () => {
  const snap = snapshot();
  const r = await execute(
    snap,
    `{ endpoints { path n p50: metric(name: P50) } }
     | context   { let total = 0; const seen = []; }
     | transform { total += $.n; if ($.p50 < 5) return null; seen.push($.path); $.rank = seen.length; $.runningTotal = total; }`,
  );
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  assert.deepEqual(r.data.endpoints.map((e) => [e.path, e.rank]), [["/users/{n}", 1], ["/users", 2]]);
  assert.equal(r.data.endpoints[1].runningTotal, 7);
  const reshaped = await execute(snap, `{ services { name transactions } } | transform { return { label: \`\${$.name}:\${$.transactions}\` }; }`);
  assert.deepEqual(reshaped.data.services, [{ label: "api.test:7" }, { label: "other.test:1" }]);
  const viaLoader = await execute(snap, `{ services { name } } | transform { $.x = 1; }`, { loaders: { transform: async (program, rows) => rows.map((row) => ({ ...row, x: "isolate" })) } });
  assert.deepEqual(viaLoader.data.services[0], { name: "api.test", x: "isolate" });
  const broken = await execute(snap, `{ services { name } } | transform { this is not js }`);
  assert.ok(broken.errors?.length);
});

test("an | ai stage hands rows to a model and takes rows back, in order with transforms", async () => {
  const snap = snapshot();
  const calls = [];
  const ai = async (instruction, rows, list) => {
    calls.push({ instruction, n: rows.length, list });
    return rows.map((r) => ({ ...r, group: r.path.startsWith("/users") ? "users" : "other" }));
  };
  const r = await execute(snap, `{ endpoints { path n } } | transform { if ($.n < 2) return null; } | ai { group them } | transform { $.tag = $.group.toUpperCase(); }`, { loaders: { ai } });
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  assert.deepEqual(calls, [{ instruction: "group them", n: 1, list: "endpoints" }]);
  assert.deepEqual(r.data.endpoints, [{ path: "/users/{n}", n: 6, group: "users", tag: "USERS" }]);

  const prose = await execute(snap, `{ services { name } } | ai { summarise }`, { loaders: { ai: async () => [{ text: "two services" }] } });
  assert.deepEqual(prose.data.services, [{ text: "two services" }]);

  const none = await execute(snap, `{ services { name } } | ai { summarise }`);
  assert.match(none.errors[0].message, /need a model/);
});

test("rowsFromModel takes a JSON array, a fenced one, or prose", async () => {
  const { rowsFromModel } = await import("../../app/lib/query/query.js");
  assert.deepEqual(rowsFromModel('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(rowsFromModel("Here you go:\n```json\n[{\"a\":1}]\n```"), [{ a: 1 }]);
  assert.deepEqual(rowsFromModel("[1, \"x\"]"), [{ value: 1 }, { value: "x" }]);
  assert.deepEqual(rowsFromModel("The API looks healthy."), [{ text: "The API looks healthy." }]);
  assert.deepEqual(rowsFromModel('[{"a":1},{"a":2},{"a":'), [{ a: 1 }, { a: 2 }, { _truncated: true }]);
});
