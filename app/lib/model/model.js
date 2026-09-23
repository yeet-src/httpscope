/* Transactions → the APIs a machine speaks.
 *
 * The decoder (app/lib/http) says what happened: one request, one
 * response, on one connection. This says what it means: a **service**
 * (the `Host` a client called, or the one this box answered as), its
 * **endpoints** (method and templated path), each endpoint's **shape**
 * (query parameters, headers, JSON bodies as inferred types, content
 * types), its **statistics** (status codes, latency percentiles, who
 * spoke it), and **drift**: the moments a shape changed — a field that
 * appeared or went missing, a type that changed, a status never seen
 * before, a latency step. Layers above only read this.
 *
 * Paths are templated two ways: identifier-shaped segments on sight
 * (path.js), and any position that accumulates more distinct literals
 * than `collapseAfter` is collapsed to `{*}`, its endpoints merged. So
 * `/users/alice`, `/users/bob`, … become `/users/{*}` once the vocabulary
 * outgrows a route table.
 *
 * Pure. The clock is injected.
 */

import { utf8 } from "../http/bytes.js";
import { header } from "../http/h1.js";
import { isParam, parseTarget, templateOf, valueKind } from "./path.js";
import { describe, diff, merge, newSchema, observe, toJSON } from "./schema.js";
import { Counter, Reservoir, Ring } from "./stats.js";

const MAX_EVENTS = 2000;
const MAX_INFLATED = 8 << 20; /* bytes of decompressed body worth parsing */
const EXAMPLE_CHARS = 1024;
const SETTLED = 20; /* samples before a new status/header/param is drift */
const SCHEMA_SETTLED = 10; /* samples before a new field is drift */
const LATENCY_BASELINE = 64;
const LATENCY_RECENT = 32;
const BURST_WINDOW_MS = 1000;
const BURST_RING = 128;
const TRANSPORT = { 0: "tcp", 1: "tls", 2: "wire" };

/** The service a transaction belongs to: its `Host`, else the peer. */
export function serviceOf(tx) {
  let name = tx.host ? String(tx.host).trim().toLowerCase() : null;
  if (!name && tx.flow) {
    name = tx.role === "server" ? `${tx.flow.saddr}:${tx.flow.sport}` : `${tx.flow.daddr}:${tx.flow.dport}`;
  }
  if (!name) return "unknown";
  return name.replace(/:(80|443)$/, "");
}

export class Model {
  /**
   *   onDrift(event)     each drift event as it is found
   *   collapseAfter      distinct literals at one path position before
   *                      it becomes `{*}`
   *   inflate(encoding, bytes) → bytes
   *                      undo a `Content-Encoding` (the host passes
   *                      `decodeContentEncoding` from `yeet:compression`);
   *                      without it compressed bodies are counted, not read
   *   now()              wall clock, ms
   */
  constructor({ onDrift, collapseAfter = 8, inflate = null, now = Date.now } = {}) {
    this.onDrift = onDrift;
    this.collapseAfter = collapseAfter;
    this.inflate = inflate;
    this.now = now;
    this.inflated = 0;
    this.inflateFailed = 0;
    this.endpointsByKey = new Map();
    this.servicesByKey = new Map();
    this.positions = new Map(); /* role|service|method|prefix → { literals, collapsed } */
    this.events = [];
    this.transactions = 0;
    this.skipped = 0;
  }

  /**
   * One transaction from the decoder. `who` is `{ pid, comm, peer? }`
   * when the caller knows it: the process on `tx.role`'s side, and
   * `peer` the one on the other end if that is local too (a loopback
   * exchange has both). The wire tap has no pid; attribute.js does.
   */
  observe(tx, who = null) {
    if (!tx.method) {
      this.skipped++;
      return [];
    }
    this.transactions++;
    const at = tx.at ?? this.now();
    const role = tx.role ?? "client";
    const service = serviceOf(tx);
    const method = tx.method.toUpperCase();
    const { segments, query } = parseTarget(tx.target);
    const shaped = this.collapse(role, service, method, segments);
    const key = endpointKey(role, service, method, shaped);

    let ep = this.endpointsByKey.get(key);
    const events = [];
    if (!ep) {
      ep = new Endpoint({ role, service, method, segments: shaped, at });
      this.endpointsByKey.set(key, ep);
      this.service(role, service).endpoints.add(key);
      events.push({ kind: "endpoint.new", detail: `${method} ${ep.template}` });
    }
    const svc = this.service(role, service);
    svc.transactions++;
    svc.lastAt = at;
    const pid = who?.pid ?? (tx.pid || null);
    const me = pid ? `${who?.comm ?? "pid"}:${pid}` : null;
    const peer = who?.peer?.pid ? `${who.peer.comm ?? "pid"}:${who.peer.pid}` : null;
    /* A client-role transaction was made by `me` to a server that is
     * `peer` if local; a server-role one was served by `me`. */
    const [client, server] = role === "server" ? [peer, me] : [me, peer];
    if (client) svc.clients.add(client);
    if (server) svc.servers.add(server);

    events.push(...ep.observe(tx, query, { pid, comm: who?.comm ?? null }, at, this));
    const out = this.emit(ep, events, at);
    out.endpoint = ep.key;
    return out;
  }

  service(role, name) {
    const key = `${role}|${name}`;
    let s = this.servicesByKey.get(key);
    if (!s) {
      s = { key, role, name, endpoints: new Set(), transactions: 0, clients: new Counter(32), servers: new Counter(32), firstAt: this.now(), lastAt: this.now() };
      this.servicesByKey.set(key, s);
    }
    return s;
  }

  /* Replace, at any position that has outgrown a route table, the
   * literal by `{*}` — for this path and, by merging, every endpoint
   * already recorded with a literal there. */
  collapse(role, service, method, segments) {
    const out = [...segments];
    for (let i = 0; i < out.length; i++) {
      if (isParam(out[i])) continue;
      const prefix = `${role}|${service}|${method}|${templateOf(out.slice(0, i))}`;
      let pos = this.positions.get(prefix);
      if (!pos) {
        pos = { literals: new Set(), collapsed: false };
        this.positions.set(prefix, pos);
      }
      if (pos.collapsed) {
        out[i] = "{*}";
        continue;
      }
      pos.literals.add(out[i]);
      if (pos.literals.size > this.collapseAfter) {
        pos.collapsed = true;
        pos.literals.clear();
        out[i] = "{*}";
        this.mergeCollapsed(role, service, method, i, templateOf(out.slice(0, i)));
      }
    }
    return out;
  }

  mergeCollapsed(role, service, method, i, prefixTemplate) {
    const svc = this.service(role, service);
    const victims = [];
    for (const key of svc.endpoints) {
      const ep = this.endpointsByKey.get(key);
      if (ep.method !== method || ep.segments.length <= i || isParam(ep.segments[i])) continue;
      if (templateOf(ep.segments.slice(0, i)) !== prefixTemplate) continue;
      victims.push(ep);
    }
    if (!victims.length) return;
    for (const ep of victims) {
      const segments = [...ep.segments];
      segments[i] = "{*}";
      const key = endpointKey(role, service, method, segments);
      this.endpointsByKey.delete(ep.key);
      svc.endpoints.delete(ep.key);
      let target = this.endpointsByKey.get(key);
      if (!target) {
        ep.segments = segments;
        ep.key = key;
        ep.template = templateOf(segments);
        target = ep;
        this.endpointsByKey.set(key, ep);
        svc.endpoints.add(key);
      } else target.merge(ep);
      /* The positions after the collapsed one are now under a new prefix. */
      for (let j = i + 1; j < segments.length; j++) {
        if (isParam(segments[j])) continue;
        const prefix = `${role}|${service}|${method}|${templateOf(segments.slice(0, j))}`;
        let pos = this.positions.get(prefix);
        if (!pos) {
          pos = { literals: new Set(), collapsed: false };
          this.positions.set(prefix, pos);
        }
        if (!pos.collapsed) pos.literals.add(segments[j]);
      }
    }
    const merged = this.endpointsByKey.get(endpointKey(role, service, method, [...victims[0].segments.slice(0, i), "{*}", ...victims[0].segments.slice(i + 1)]));
    if (merged) this.emit(merged, [{ kind: "endpoint.collapsed", detail: `${victims.length} paths became ${merged.template}` }], this.now());
  }

  emit(ep, events, at) {
    const out = events.map((e) => ({ at, role: ep.role, service: ep.service, method: ep.method, path: ep.template, ...e }));
    for (const e of out) {
      this.events.push(e);
      this.onDrift?.(e);
    }
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return out;
  }

  /** `[{ role, name, endpoints, transactions, clients, servers, firstAt, lastAt }]`. */
  services() {
    return [...this.servicesByKey.values()]
      .map((s) => ({
        role: s.role,
        name: s.name,
        endpoints: s.endpoints.size,
        transactions: s.transactions,
        clients: Object.keys(s.clients.toJSON()),
        servers: Object.keys(s.servers.toJSON()),
        firstAt: s.firstAt,
        lastAt: s.lastAt,
      }))
      .sort((a, b) => b.transactions - a.transactions);
  }

  /** Endpoint rows, optionally for one service (`{ service, role }`). */
  endpoints(filter = {}) {
    return [...this.endpointsByKey.values()]
      .filter((e) => (filter.service == null || e.service === filter.service) && (filter.role == null || e.role === filter.role))
      .map((e) => e.row())
      .sort((a, b) => b.n - a.n || (a.path < b.path ? -1 : 1));
  }

  /** Everything about one endpoint, by its row's `key`. */
  endpoint(key) {
    return this.endpointsByKey.get(key)?.detail() ?? null;
  }

  /** Drift events, newest last; `since` is a wall-clock ms bound. */
  drift({ since = 0, kinds = null } = {}) {
    return this.events.filter((e) => e.at >= since && (!kinds || kinds.includes(e.kind)));
  }

  /**
   * Everything, as plain data that survives JSON: what the query layer
   * (app/lib/query) answers from. Built on demand; the model itself
   * keeps Maps, Sets and reservoirs.
   */
  snapshot() {
    return {
      at: this.now(),
      transactions: this.transactions,
      skipped: this.skipped,
      inflated: this.inflated,
      inflateFailed: this.inflateFailed,
      services: this.services(),
      endpoints: [...this.endpointsByKey.values()].map((e) => e.detail()),
      drift: [...this.events],
    };
  }
}

const endpointKey = (role, service, method, segments) => `${role}|${service}|${method}|${templateOf(segments)}`;

/** One method on one templated path of one service. */
export class Endpoint {
  constructor({ role, service, method, segments, at }) {
    this.role = role;
    this.service = service;
    this.method = method;
    this.segments = segments;
    this.template = templateOf(segments);
    this.key = endpointKey(role, service, method, segments);
    this.n = 0;
    this.incomplete = 0;
    this.firstAt = at;
    this.lastAt = at;
    this.statuses = new Counter(32);
    this.latency = new Reservoir(256);
    this.recent = new Ring(LATENCY_RECENT);
    this.baseline = null;
    this.latencyHigh = false;
    this.pids = new Counter(32);
    this.transports = new Counter(4);
    this.recentAt = []; /* the last BURST_RING arrival times */
    this.burstMax = 0; /* most calls seen within one second */
    this.req = newSide();
    this.res = newSide();
    this.query = new Map(); /* name → { n, kinds } */
  }

  observe(tx, query, who, at, model) {
    const events = [];
    const settled = this.n >= SETTLED;
    this.n++;
    this.lastAt = at;
    if (!tx.complete) this.incomplete++;
    if (who.pid) this.pids.add(`${who.comm ?? "pid"}:${who.pid}`);
    this.transports.add(TRANSPORT[tx.transport] ?? "unknown");

    /* Calls per second, at the densest: an N+1 shows here. */
    this.recentAt.push(at);
    if (this.recentAt.length > BURST_RING) this.recentAt.shift();
    let i = this.recentAt.length - 1;
    while (i > 0 && at - this.recentAt[i - 1] <= BURST_WINDOW_MS) i--;
    const burst = this.recentAt.length - i;
    if (burst > this.burstMax) this.burstMax = burst;

    if (tx.status != null) {
      if (settled && !this.statuses.has(tx.status)) events.push({ kind: "status.new", detail: `${tx.status} after ${this.n - 1} responses of ${Object.keys(this.statuses.toJSON()).join(", ")}` });
      this.statuses.add(tx.status);
    }

    if (tx.durationNs != null && tx.complete) {
      const ms = Number(tx.durationNs) / 1e6;
      this.latency.add(ms);
      this.recent.add(ms);
      if (this.baseline == null && this.latency.n >= LATENCY_BASELINE) this.baseline = this.latency.percentile(95);
      if (this.baseline != null && this.recent.full) {
        const p95 = this.recent.percentile(95);
        if (!this.latencyHigh && p95 > Math.max(2 * this.baseline, this.baseline + 20)) {
          this.latencyHigh = true;
          events.push({ kind: "latency.up", detail: `p95 ${fmt(p95)}ms, was ${fmt(this.baseline)}ms` });
        } else if (this.latencyHigh && p95 < 1.5 * this.baseline) {
          this.latencyHigh = false;
          events.push({ kind: "latency.back", detail: `p95 ${fmt(p95)}ms` });
        }
      }
    }

    for (const [name, value] of query) {
      let q = this.query.get(name);
      if (!q) {
        if (settled) events.push({ kind: "query.new", detail: `?${name}=` });
        q = { n: 0, kinds: new Counter(8) };
        this.query.set(name, q);
      }
      q.n++;
      q.kinds.add(valueKind(value));
    }

    events.push(...this.side(this.req, tx.reqHeaders, tx.reqBody, "request", null, settled, model));
    events.push(...this.side(this.res, tx.resHeaders, tx.resBody, "response", tx.status, settled, model));
    return events;
  }

  side(side, headers, body, label, status, settled, model) {
    const events = [];
    for (const [name] of headers ?? []) {
      if (settled && !side.headers.has(name)) events.push({ kind: `${label}.header.new`, detail: name });
      side.headers.add(name);
    }
    const ct = header(headers ?? [], "content-type");
    if (ct) side.contentTypes.add(ct.split(";")[0].trim().toLowerCase());
    if (!body || body.len === 0) return events;
    side.bodyBytes.add(body.len);

    const parsed = parseBody(body, headers ?? [], model?.inflate);
    if (!parsed) return events;
    const slot = status == null ? side.body : bodyFor(side, status);
    if (parsed.inflated) {
      slot.inflated++;
      if (model) model.inflated++;
    } else if (parsed.inflateFailed && model) model.inflateFailed++;
    if (parsed.encoded) slot.encoded.add(parsed.encoded);
    if (parsed.json !== undefined) {
      for (const d of diff(slot.schema, parsed.json, { minSamples: SCHEMA_SETTLED })) {
        events.push({ kind: `${label}.${d.kind}`, detail: `${status != null ? `${status} ` : ""}${d.path}: ${d.detail}` });
      }
      observe(slot.schema, parsed.json);
      slot.n++;
      slot.example = parsed.text.slice(0, EXAMPLE_CHARS);
    } else if (parsed.text != null) {
      slot.textN++;
      slot.example = parsed.text.slice(0, EXAMPLE_CHARS);
    }
    return events;
  }

  merge(other) {
    this.n += other.n;
    this.incomplete += other.incomplete;
    this.firstAt = Math.min(this.firstAt, other.firstAt);
    this.lastAt = Math.max(this.lastAt, other.lastAt);
    this.statuses.merge(other.statuses);
    this.latency.merge(other.latency);
    this.pids.merge(other.pids);
    this.transports.merge(other.transports);
    this.burstMax = Math.max(this.burstMax, other.burstMax);
    for (const [name, q] of other.query) {
      const mine = this.query.get(name);
      if (mine) {
        mine.n += q.n;
        mine.kinds.merge(q.kinds);
      } else this.query.set(name, q);
    }
    mergeSide(this.req, other.req);
    mergeSide(this.res, other.res);
  }

  /** The table row. */
  row() {
    const ok = mainStatus(this.statuses);
    const resBody = ok != null ? this.res.bodies.get(ok) : null;
    return {
      key: this.key,
      role: this.role,
      service: this.service,
      method: this.method,
      path: this.template,
      n: this.n,
      incomplete: this.incomplete,
      statuses: this.statuses.toJSON(),
      latency: this.latency.summary(),
      pids: Object.keys(this.pids.toJSON()),
      transports: this.transports.toJSON(),
      burstMax: this.burstMax,
      query: [...this.query].map(([name, q]) => ({ name, n: q.n, kinds: q.kinds.toJSON() })),
      reqType: top(this.req.contentTypes),
      resType: top(this.res.contentTypes),
      reqShape: this.req.body.n ? describe(this.req.body.schema) : null,
      resShape: resBody?.n ? describe(resBody.schema) : null,
      firstAt: this.firstAt,
      lastAt: this.lastAt,
    };
  }

  /** The row plus every body shape, headers and examples. */
  detail() {
    const bodies = {};
    for (const [status, b] of this.res.bodies) {
      bodies[status] = { n: b.n, textN: b.textN, shape: b.n ? describe(b.schema) : null, schema: b.n ? toJSON(b.schema) : null, example: b.example, encoded: b.encoded.toJSON(), inflated: b.inflated };
    }
    return {
      ...this.row(),
      reqHeaders: this.req.headers.toJSON(),
      resHeaders: this.res.headers.toJSON(),
      reqBodyBytes: this.req.bodyBytes.summary(),
      resBodyBytes: this.res.bodyBytes.summary(),
      reqBody: {
        n: this.req.body.n,
        textN: this.req.body.textN,
        shape: this.req.body.n ? describe(this.req.body.schema) : null,
        schema: this.req.body.n ? toJSON(this.req.body.schema) : null,
        example: this.req.body.example,
        encoded: this.req.body.encoded.toJSON(),
        inflated: this.req.body.inflated,
      },
      resBodies: bodies,
    };
  }
}

const newBody = () => ({ schema: newSchema(), n: 0, textN: 0, example: null, encoded: new Counter(4), inflated: 0 });
const newSide = () => ({ headers: new Counter(64), contentTypes: new Counter(16), bodyBytes: new Reservoir(128), body: newBody(), bodies: new Map() });

function bodyFor(side, status) {
  let b = side.bodies.get(status);
  if (!b) {
    b = newBody();
    side.bodies.set(status, b);
  }
  return b;
}

function mergeBody(a, b) {
  merge(a.schema, b.schema);
  a.n += b.n;
  a.textN += b.textN;
  a.example ??= b.example;
  a.encoded.merge(b.encoded);
  a.inflated += b.inflated;
}

function mergeSide(a, b) {
  a.headers.merge(b.headers);
  a.contentTypes.merge(b.contentTypes);
  a.bodyBytes.merge(b.bodyBytes);
  mergeBody(a.body, b.body);
  for (const [status, body] of b.bodies) {
    if (a.bodies.has(status)) mergeBody(a.bodies.get(status), body);
    else a.bodies.set(status, body);
  }
}

/* The most common 2xx status, else the most common status. */
function mainStatus(counter) {
  let best = null;
  let bestN = -1;
  for (const [s, n] of counter.map) {
    const ok = s >= 200 && s < 300;
    const score = n + (ok ? 1e9 : 0);
    if (score > bestN) {
      bestN = score;
      best = s;
    }
  }
  return best;
}

const top = (counter) => {
  let best = null;
  let n = -1;
  for (const [k, v] of counter.map) if (v > n) ((n = v), (best = k));
  return best;
};

/**
 * A body as data: `{ json, text }` when it parses, `{ text }` when it is
 * text, `{ encoded }` when compressed and there is no `inflate` (or it
 * failed: `inflateFailed`), null when there is nothing to say (empty,
 * cut, binary). A body that was inflated says so (`inflated`), so the
 * shape can be told apart from what was on the wire.
 */
export function parseBody(body, headers, inflate = null) {
  if (!body || body.len === 0) return null;
  if (!body.complete || body.truncated || body.holes) return null;
  let data = body.data;
  let inflated = false;
  const enc = header(headers, "content-encoding");
  if (enc && enc.toLowerCase() !== "identity") {
    if (!inflate) return { encoded: enc.toLowerCase() };
    try {
      data = inflate(enc, data);
      inflated = true;
    } catch {
      return { encoded: enc.toLowerCase(), inflateFailed: true };
    }
    if (data.length > MAX_INFLATED) return { encoded: enc.toLowerCase(), inflated: true, tooBig: data.length };
  }
  const ct = (header(headers, "content-type") ?? "").toLowerCase();
  const text = utf8(data);
  const first = text.trimStart()[0];
  if (ct.includes("json") || first === "{" || first === "[") {
    try {
      return { json: JSON.parse(text), text, inflated };
    } catch {
      /* not JSON after all */
    }
  }
  if (ct.startsWith("text/") || ct.includes("xml") || ct.includes("form") || ct.includes("javascript") || isText(data)) return { text, inflated };
  return inflated ? { inflated } : null;
}

/* Printable enough to show. */
function isText(bytes) {
  const n = Math.min(bytes.length, 512);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++;
  }
  return bad * 20 < n;
}

const fmt = (ms) => (ms >= 100 ? Math.round(ms) : ms.toFixed(1));
