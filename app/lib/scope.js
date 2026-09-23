"use yeet";

/* The pipeline, running in the isolate for the life of the app.
 *
 *   wire tap (TCX, every interface) → reassembler → decoder → model
 *   TLS taps, attached to a process the moment a TLS flow of its shows
 *   up on the wire → the same decoder
 *   the inventory (system graph), for who owns each end of a flow
 *
 * One instance per isolate, started when the layout first imports this
 * module and kept by the functions below, which are what a route or a
 * page calls: `snapshot()` is the model as plain data for GraphQL,
 * `status()` is whether the taps are alive.
 *
 * TLS taps attach to **binaries, not pids**: a uprobe on the host's
 * libssl fires for every process that maps it, now and later, so one
 * attach covers each curl and python that will ever run — and a process
 * that lives for 50ms cannot be attached to by pid in time anyway. At
 * start, every libssl and every known runtime executable the inventory
 * shows is attached; after that, a TLS flow on the wire from a process
 * whose binary is not yet tapped triggers one more attach (a container's
 * binary is reached through /proc/<pid>/root, which needs the pid to
 * live — fine for a server). A binary that offers no boundary is
 * remembered so it is not tried again. Go binaries need their pclntab
 * offsets, which only Node can compute; they show as failed for now.
 */

import { stream as aiStream } from "yeet:ai";
import { decodeContentEncoding } from "yeet:compression";

import { utf8 } from "./http/bytes.js";
import { Decoder } from "./http/decoder.js";
import { Reassembler, connKeyOf } from "./http/tcp.js";
import { Model } from "./model/model.js";
import { filterTransactions } from "./query/filter.js";
import { rowsFromModel } from "./query/query.js";
import { rootsOf } from "./gql.js";
import { attribute } from "./probes/attribute.js";
import { snapshot as inventory } from "./probes/conns.js";
import { nsPath, targetFor } from "./probes/discover.js";
import { TLS, WIRE } from "./probes/objects.js";
import { classify, libsslPath } from "./probes/runtimes.js";
import { attachTls } from "./probes/tlscore.js";
import { attachWire } from "./probes/wire.js";

/* The app's own listeners: never captured, or the UI would watch itself. */
const OWN_PORTS = [3000, 3001, 3002];
const TICK_MS = 20;
const INVENTORY_MS = 1000;
const SWEEP_MS = 30_000;
const IDLE_MS = 120_000;
const MAX_ERRORS = 50;
const RECENT = 1000; /* transactions kept, with up to BODY_KEEP of each body */
const BODY_KEEP = 16384;

let pipeline = null;

/** Start the pipeline if it is not running; resolves to it. */
export function ensureStarted() {
  pipeline ??= start().catch((error) => {
    pipeline = null;
    throw error;
  });
  return pipeline;
}

/* ---- agent queries -----------------------------------------------------
 *
 * Every query that reaches /api/query is recorded here by the route: when
 * it started, who sent it (what the request said about itself), the text,
 * and — once it finishes — how long it took, whether it worked, how big
 * the answer was and a preview of it. The queries page shows them live.
 */
const QUERIES = 200;
const RESULT_PREVIEW = 8192;
const queryListeners = new Set();
let queryId = 0;

/** A query began. Returns its id for `queryFinished`. */
export async function queryStarted({ query, variables = null, client = null, method = "POST" }) {
  const p = await ensureStarted();
  const entry = {
    id: ++queryId,
    at: Date.now(),
    method,
    client,
    query: String(query ?? "").slice(0, 20_000),
    variables: variables ? JSON.stringify(variables).slice(0, 2000) : null,
    stages: [...String(query ?? "").matchAll(/\|\s*(context|transform|ai)\s*(\(([^)]*)\))?\s*\{/g)].map((m) => (m[3] ? `${m[1]}(${m[3].trim()})` : m[1])),
    roots: rootsOf(query),
    state: "running",
    ms: null,
    ok: null,
    errors: [],
    bytes: 0,
    rows: null,
    preview: null,
  };
  p.state.queries.push(entry);
  if (p.state.queries.length > QUERIES) p.state.queries.splice(0, p.state.queries.length - QUERIES);
  for (const fn of queryListeners) fn(entry);
  return entry.id;
}

/** A query ended: `result` is the GraphQL result object. */
export async function queryFinished(id, { result, ms, status }) {
  const p = await ensureStarted();
  const entry = p.state.queries.find((q) => q.id === id);
  if (!entry) return;
  const text = JSON.stringify(result ?? null);
  entry.state = "done";
  entry.ms = ms;
  entry.status = status;
  entry.ok = !result?.errors?.length;
  entry.errors = (result?.errors ?? []).map((e) => e.message).slice(0, 5);
  entry.bytes = text.length;
  entry.rows = result?.data ? Object.fromEntries(Object.entries(result.data).map(([k, v]) => [k, Array.isArray(v) ? v.length : v == null ? 0 : 1])) : null;
  entry.preview = text.length > RESULT_PREVIEW ? text.slice(0, RESULT_PREVIEW) + `\n… ${text.length - RESULT_PREVIEW} more bytes` : text;
  for (const fn of queryListeners) fn(entry);
}

/** Where a running query is: its state and the model's text so far — for a route that streams progress. */
export async function queryProgress(id) {
  const p = await ensureStarted();
  const q = p.state.queries.find((x) => x.id === id);
  return q ? { state: q.state, stream: q.stream ?? "", streaming: Boolean(q.streaming) } : null;
}

/** The last `limit` queries, newest first. */
export async function recentQueries(limit = 100) {
  const p = await ensureStarted();
  return p.state.queries.slice(-limit).reverse();
}

/** Query starts and finishes as they happen: the entry, each time it changes. */
export async function* queryStream() {
  await ensureStarted();
  const queue = [];
  let wake = null;
  const listener = (e) => {
    queue.push(e);
    wake?.();
  };
  queryListeners.add(listener);
  try {
    for (;;) {
      if (!queue.length) await new Promise((r) => (wake = r));
      wake = null;
      while (queue.length) yield { ...queue.shift() };
    }
  } finally {
    queryListeners.delete(listener);
  }
}

/** Recent transactions matching `where` (a TransactionWhere), newest first. */
export async function recentTransactions(where = null, limit = 50) {
  const p = await ensureStarted();
  return filterTransactions(p.state.recent, where, Math.min(Math.max(0, limit ?? 50), 500));
}

const AI_MAX_INPUT = 60_000; /* characters of rows handed to the model */
const AI_MAX_OUTPUT = 8_000; /* tokens */
/* Measured here: claude-opus-5's safeguards decline tables of API routes
 * with statistics as reconnaissance — every instruction, every try —
 * while claude-sonnet-5 and claude-haiku-4-5 answer all of them. The
 * stage is judgement over rows the engineer already has, so Sonnet is
 * the right size anyway. */
const AI_MODEL = "claude-sonnet-5";
const AI_RETRIES = 1; /* a refusal is stochastic on borderline content */

/**
 * A query's `| ai { instruction }` stage: the rows and the instruction
 * go to the model through yeet:ai, its answer comes back as rows. The
 * model is asked for a JSON array; prose becomes one `{ text }` row.
 * `list` names which top-level field the rows came from.
 */
export async function ai(instruction, rows, list = "rows", { queryId = null, model = null, max = null } = {}) {
  const p = await ensureStarted();
  /* The query this stage belongs to, if the route said: its entry gets
   * the model's text as it streams, so the queries page shows it live. */
  const entry = queryId != null ? p.state.queries.find((q) => q.id === queryId) : null;
  let payload = JSON.stringify(rows);
  let note = "";
  if (payload.length > AI_MAX_INPUT) {
    let keep = rows.length;
    while (keep > 1 && JSON.stringify(rows.slice(0, keep)).length > AI_MAX_INPUT) keep = Math.floor(keep / 2);
    payload = JSON.stringify(rows.slice(0, keep));
    note = ` Only the first ${keep} of ${rows.length} rows are included; say so if it matters.`;
  }
  const started = Date.now();
  /* The framing matters to a model's safeguards too: rows of routes
   * described as "captured" or "monitored" traffic read as
   * reconnaissance; the same rows as the engineer's own application
   * being documented and maintained are answered. Which is what this is. */
  const request = {
    model: typeof model === "string" && model ? model : AI_MODEL,
    system:
      "You help an engineer understand, document and maintain the HTTP APIs of their own applications, working from tables their tooling produced: routes, request and response shapes, latency and error statistics, schema changes over time. You receive rows (a JSON array) and an instruction. Apply the instruction to the rows and answer with a JSON array of objects and nothing else — the rows for the next step: keep the fields the instruction needs, add the fields it asks for, drop the rows it excludes. Answer in plain text only when the instruction asks for a summary or an explanation.",
    messages: [{ role: "user", content: `Instruction: ${instruction}\n\nRows (${list}):${note}\n${payload}` }],
    max_tokens: AI_MAX_OUTPUT,
  };
  const run = async () => {
    const st = aiStream(request);
    let text = "";
    let lastPush = 0;
    const push = (final = false) => {
      if (!entry) return;
      const now = Date.now();
      if (!final && now - lastPush < 150) return;
      lastPush = now;
      entry.stream = text;
      entry.streaming = !final;
      for (const fn of queryListeners) fn(entry);
    };
    for await (const ev of st) {
      if (ev.type === "text") {
        text += ev.delta ?? "";
        push();
      }
    }
    const r = await st.result;
    push(true);
    return r;
  };
  let r = await run();
  for (let i = 0; i < AI_RETRIES && r.stop_reason === "refusal"; i++) r = await run();
  const s = p.state.ai;
  s.calls++;
  s.inputTokens += r.usage?.input_tokens ?? 0;
  s.outputTokens += r.usage?.output_tokens ?? 0;
  s.lastMs = Date.now() - started;
  s.model = r.usage?.model ?? s.model;
  return rowsFromModel(r.text);
}

/** Run a query's pipeline tail (JavaScript, from tailProgram) over rows, in this isolate rather than in Node. */
export async function transform(program, rows) {
  return new Function("rows", program)(rows);
}

/** The model as plain data, for the query layer. */
export async function snapshot() {
  const p = await ensureStarted();
  return p.model.snapshot();
}

/** Is it alive: taps, counters, what is being decoded. */
export async function status() {
  const p = await ensureStarted();
  const s = p.state;
  return {
    startedAt: s.startedAt,
    uptimeMs: Date.now() - s.startedAt,
    wire: { interfaces: p.wire.ifindex, counters: await p.wire.stats().catch(() => null), segments: s.segments },
    flows: p.tcp.list().length,
    connections: p.decoder.connections().length,
    /* Every live connection the decoder holds: what it decided it was
     * carrying, and why it decodes nothing when it does not. */
    decoding: p.decoder.connections().map((c) => ({ key: c.key, proto: c.proto, role: c.role, note: c.note, transactions: c.transactions, inflight: c.inflight, bytesIn: c.bytesIn, bytesOut: c.bytesOut })),
    transactions: s.transactions,
    model: { services: p.model.services().length, endpoints: p.model.endpointsByKey.size, drift: p.model.events.length, inflated: p.model.inflated },
    tls: [...s.tls.values()].map((t) => ({ binary: t.binary, label: t.label ?? null, pids: [...t.pids], taps: t.session?.taps ?? [], state: t.state, reason: t.reason ?? null })),
    ai: s.ai,
    queries: { total: queryId, running: s.queries.filter((q) => q.state === "running").length },
    errors: s.errors.slice(-10),
  };
}

async function start() {
  /* `tls` is keyed by the binary as the host can open it. `comms` maps
   * a pid to its comm, for naming what a TLS tap reports (a tap's
   * record has a pid and nothing else). */
  const state = { startedAt: Date.now(), segments: 0, transactions: 0, errors: [], tls: new Map(), comms: new Map(), flows: new Map(), rows: [], listeners: new Map(), recent: [], queries: [], ai: { calls: 0, inputTokens: 0, outputTokens: 0, lastMs: null, model: null, lastStop: null } };
  const fail = (where) => (error) => {
    state.errors.push({ at: Date.now(), where, message: String(error?.message ?? error) });
    if (state.errors.length > MAX_ERRORS) state.errors.shift();
  };

  /* The inventory, with listeners remembered: a server outlives its
   * connections, and a snapshot can miss an owner now and then. */
  const refresh = async () => {
    const fresh = await inventory().catch(fail("inventory"));
    if (!fresh) return state.rows;
    for (const r of fresh) if (r.state === "Listen" && r.pid != null) state.listeners.set(`${r.laddr}:${r.lport}`, r);
    state.rows = [...fresh.filter((r) => r.state !== "Listen"), ...state.listeners.values()];
    return state.rows;
  };
  await refresh();

  const whoFor = (t) => {
    if (t.transport === 2) {
      const f = state.flows.get(t.conn);
      if (!f) return null;
      const at = f.who ?? attribute(f, state.rows);
      const [side, other] = t.role === "client" ? [at.a, at.b] : [at.b, at.a];
      const who = side ? { pid: side.pid, comm: side.comm } : { pid: null, comm: null };
      if (other) who.peer = { pid: other.pid, comm: other.comm };
      return who;
    }
    return t.pid ? { pid: t.pid, comm: state.comms.get(t.pid) ?? commOf(t.pid) } : null;
  };
  const commOf = (pid) => state.rows.find((r) => r.pid === pid)?.comm ?? null;

  /* Drift fans out to whoever is listening: the model has one callback,
   * a drift page per open tab wants its own. */
  state.driftListeners = new Set();
  const model = new Model({
    inflate: decodeContentEncoding,
    onDrift: (e) => {
      for (const fn of state.driftListeners) fn(e);
    },
  });

  const decoder = new Decoder({
    onTransaction: (t) => {
      state.transactions++;
      const who = whoFor(t);
      const events = model.observe(t, who);
      remember(t, who, events.endpoint ?? null);
    },
    onConnection: (c, event) => {
      if (event === "label" && c.proto === "tls" && c.transport === 2) considerTls(c);
    },
  });

  const tcp = new Reassembler({
    onRecord: (r) => decoder.push(r),
    onClose: (key, why) => decoder.close(connKeyOf(key), why),
    onFlow: (f, event) => {
      if (event === "open") {
        state.flows.set(f.key, f);
        refresh().then((rows) => (f.who = attribute(f, rows)));
      } else state.flows.delete(f.key);
    },
  });

  /* A body as text for the ring: inflated first when it arrived
   * compressed and whole, then the first BODY_KEEP bytes. */
  const bodyText = (body, headers) => {
    if (!body.len) return null;
    let data = body.data;
    const enc = headers.find(([n]) => n === "content-encoding")?.[1];
    if (enc && enc.toLowerCase() !== "identity" && body.complete && !body.truncated && !body.holes) {
      try {
        data = decodeContentEncoding(enc, data);
      } catch {
        /* left as it came */
      }
    }
    return utf8(data.subarray(0, BODY_KEEP));
  };

  /* The ring of recent transactions the query layer drills into: the
   * facts of each, and the first BODY_KEEP bytes of each body as text. */
  let recentId = 0;
  const remember = (t, who, endpointKey) => {
    const path = endpointKey ? endpointKey.split("|").slice(3).join("|") : null;
    state.recent.push({
      id: ++recentId,
      at: t.at,
      role: t.role,
      service: endpointKey ? endpointKey.split("|")[1] : (t.host ?? null),
      method: t.method,
      path: path ?? t.target,
      target: t.target ?? "",
      status: t.status,
      duration: t.durationNs != null ? Number(t.durationNs) / 1e6 : null,
      transport: t.transport,
      pid: who?.pid ?? t.pid ?? null,
      comm: who?.comm ?? null,
      peer: who?.peer?.pid ? `${who.peer.comm ?? "pid"}:${who.peer.pid}` : null,
      complete: t.complete,
      cut: t.cut ?? null,
      requestHeaders: t.reqHeaders,
      responseHeaders: t.resHeaders,
      requestBody: bodyText(t.reqBody, t.reqHeaders),
      requestBodyLength: t.reqBody.len,
      responseBody: bodyText(t.resBody, t.resHeaders),
      responseBodyLength: t.resBody.len,
    });
    if (state.recent.length > RECENT) state.recent.splice(0, state.recent.length - RECENT);
  };

  /* A TLS flow from a local process: tap that process's binary, if not
   * already. */
  const considerTls = (c) => {
    const f = state.flows.get(c.conn);
    if (!f) return;
    const at = f.who ?? attribute(f, state.rows);
    for (const end of [at.a, at.b]) {
      if (!end?.pid) continue;
      targetFor(end.pid)
        .then((target) => {
          if (!target?.binary) return;
          state.comms.set(end.pid, target.comm ?? end.comm ?? null);
          const host = hostPath(target);
          tap(host, { pid: end.pid, label: classify({ exe: target.exe, comm: target.comm, maps: target.libssl ? [target.libssl] : [] }).label ?? target.comm });
        })
        .catch(fail(`discover pid ${end.pid}`));
    }
  };

  /* A host process's binary by its plain path, so the attach outlives
   * the pid; a container's through /proc/<pid>/root, which does not. */
  const hostPath = (target) => {
    const inProcess = target.libssl || target.exe;
    return target.container ? nsPath(target.pid, inProcess) : inProcess;
  };

  /* Attach the TLS taps to one binary, once. */
  const tap = (binary, { pid = null, label = null } = {}) => {
    let entry = state.tls.get(binary);
    if (entry) {
      if (pid) entry.pids.add(pid);
      return entry.promise;
    }
    entry = { binary, label, pids: new Set(pid ? [pid] : []), state: "attaching", session: null, reason: null };
    state.tls.set(binary, entry);
    entry.promise = attachTls({
      objects: TLS,
      binary,
      go: null,
      onData: (r) => decoder.push(r),
      onPeer: (p) => decoder.peer(p),
      onError: fail(`tls ${binary}`),
    })
      .then((session) => {
        entry.session = session;
        entry.state = "attached";
      })
      .catch((error) => {
        entry.state = "failed";
        entry.reason = String(error?.message ?? error);
      });
    return entry.promise;
  };

  /* At start: every libssl mapped by anyone, and every executable of a
   * runtime known to carry its own TLS (node, deno, bun), by path. */
  const preattach = async () => {
    const r = await yeet.graph.query(`{ procs { pid exe stat { comm } maps { path } } }`).catch(fail("scan"));
    const seen = new Map();
    for (const p of r?.data?.procs ?? []) {
      const maps = (p.maps ?? []).map((m) => m.path);
      const libssl = libsslPath(maps);
      const profile = classify({ exe: p.exe, comm: p.stat?.comm, maps });
      const binary = libssl ?? (profile.tap === "exe" ? p.exe : null);
      if (!binary) continue;
      state.comms.set(p.pid, p.stat?.comm ?? null);
      if (!seen.has(binary)) seen.set(binary, { label: profile.label ?? p.stat?.comm, pids: [] });
      seen.get(binary).pids.push(p.pid);
    }
    await Promise.all([...seen].map(([binary, { label, pids }]) => tap(binary, { label, pid: pids[0] }).then(() => pids.forEach((pid) => state.tls.get(binary)?.pids.add(pid)))));
  };

  const wire = await attachWire(WIRE, {
    ignorePorts: OWN_PORTS,
    onRecord: (r) => {
      state.segments++;
      tcp.push(r);
    },
    onError: fail("wire"),
  });
  await wire.captureAll(true);
  await preattach();

  const timers = [
    setInterval(() => {
      tcp.tick();
      decoder.tick();
    }, TICK_MS),
    setInterval(async () => {
      const rows = await refresh();
      /* A binary reached through a pid that is gone cannot be kept. */
      const live = new Set(rows.map((r) => r.pid));
      for (const [binary, entry] of state.tls) {
        const m = /^\/proc\/(\d+)\/root\//.exec(binary);
        if (m && entry.state === "attached" && !live.has(Number(m[1]))) {
          state.tls.delete(binary);
          entry.session?.stop().catch(fail(`tls stop ${binary}`));
        }
      }
      for (const pid of state.comms.keys()) if (!live.has(pid)) state.comms.delete(pid);
    }, INVENTORY_MS),
    setInterval(() => decoder.sweep(IDLE_MS), SWEEP_MS),
  ];

  return {
    state,
    model,
    decoder,
    tcp,
    wire,
    async stop() {
      for (const t of timers) clearInterval(t);
      for (const [, entry] of state.tls) await entry.session?.stop().catch(() => {});
      await wire.stop();
      pipeline = null;
    },
  };
}

/* ---- what the pages read -------------------------------------------------
 *
 * Pages run in this same isolate and call these as plain functions; an
 * island or Node reaches them over the socket. An endpoint's key has
 * `|` and `/` in it, so a URL carries it hex-encoded (`endpointId`).
 */

export const endpointId = (key) => Array.from(String(key), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
export const keyOf = (id) => (String(id).match(/.{2}/g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join("");

/** The home page: services, recent drift, whether the taps are alive. */
export async function overview() {
  const p = await ensureStarted();
  const s = await status();
  return {
    status: { uptimeMs: s.uptimeMs, interfaces: s.wire.interfaces.length, emitted: s.wire.counters?.emitted ?? 0, flows: s.flows, connections: s.connections, transactions: s.transactions, tls: s.tls.filter((t) => t.state === "attached").length, errors: s.errors.length },
    services: p.model.services(),
    drift: p.model.events.slice(-12).reverse(),
  };
}

/** One service's endpoints, as table rows with an `id` for the detail page. */
export async function serviceEndpoints(role, name) {
  const p = await ensureStarted();
  return p.model.endpoints({ role, service: name }).map((row) => ({ ...row, id: endpointId(row.key) }));
}

/** Everything about one endpoint, plus its own drift, newest first. */
export async function endpointDetail(id) {
  const p = await ensureStarted();
  const key = keyOf(id);
  const d = p.model.endpoint(key);
  if (!d) return null;
  const mine = (e) => e.role === d.role && e.service === d.service && e.method === d.method && e.path === d.path;
  return { ...d, id, drift: p.model.events.filter(mine).slice(-20).reverse() };
}

/** The last `limit` drift events, newest first. */
export async function recentDrift(limit = 100) {
  const p = await ensureStarted();
  return p.model.events.slice(-limit).reverse();
}

/** Drift as it happens: a stream, one event per value. */
export async function* driftStream() {
  const p = await ensureStarted();
  const queue = [];
  let wake = null;
  const listener = (e) => {
    queue.push(e);
    wake?.();
  };
  p.state.driftListeners.add(listener);
  try {
    for (;;) {
      if (!queue.length) await new Promise((r) => (wake = r));
      wake = null;
      while (queue.length) yield queue.shift();
    }
  } finally {
    p.state.driftListeners.delete(listener);
  }
}
