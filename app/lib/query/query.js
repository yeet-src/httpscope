/* Answering GraphQL from a model snapshot.
 *
 * Runs wherever the `graphql` package does — the Node side of a route,
 * a test — over the plain data `Model.snapshot()` produces in the
 * isolate. Resolvers here are the mapping from the model's rows to the
 * schema's types, the derived ratios an agent filters by, the `where`
 * evaluation, sorting, and "how long ago". Nothing is a verdict.
 *
 * `transactions` is the one field not in the snapshot: a snapshot is
 * small (schemas and counters) and a ring of recent bodies is not, so
 * the root takes a `loaders.transactions(where, limit)` that fetches
 * them on demand — from the isolate, in the app; from a fixture, in a
 * test.
 */

import { Kind, buildSchema, graphql, parse, validate, valueFromASTUntyped } from "graphql";

import { filterTransactions, glob, num, str } from "./filter.js";
import { SDL } from "./schema.js";

export { SDL, filterTransactions };
export const schema = buildSchema(SDL);

const ROLE = { client: "CLIENT", server: "SERVER" };
const TRANSPORT = { wire: "WIRE", tls: "TLS", tcp: "TCP" };
const TRANSPORT_CODE = { 2: "WIRE", 1: "TLS", 0: "TCP" };
const roleArg = (r) => (r ? r.toLowerCase() : null);

/**
 * Execute `source` against `snapshot`. Returns the GraphQL result
 * `{ data, errors? }`, errors as plain `{ message, locations, path }`.
 *
 *   loaders.transactions(where, limit)   recent transactions; without it
 *                                        the field answers from `snapshot.recent`
 *   loaders.transform(code, rows)        runs a pipeline tail's JavaScript
 *                                        over rows (in the app: the isolate);
 *                                        without it, here
 *
 * Two extensions on top of GraphQL, for criteria the schema did not
 * anticipate: field directives (@when gates a row on a value, @div and
 * friends compute from siblings — see the SDL), and a pipeline tail
 * after the document — stages over the rows of every top-level list:
 *
 *   { endpoints { path p50: metric(name: P50) p99: metric(name: P99) } }
 *   | context   { let worst = 0; }
 *   | transform { $.tail = $.p99 / $.p50; if ($.tail < 5) return null; worst = Math.max(worst, $.tail); }
 *   | ai        { group these by what the endpoint seems to do; keep path, add group }
 *
 * `transform` is JavaScript: `$` is the row; mutate it, `return` a new
 * one, or `return null` to drop it. `context` runs once and its
 * declarations are in scope for every transform. `ai` hands the rows
 * and an instruction to a model (`loaders.ai`, in the app the isolate's
 * yeet:ai) and takes back the rows it returns — a JSON array, or one
 * row `{ text }` when it answered in prose. Stages run in the order
 * written.
 */
export async function execute(snapshot, source, { variables = null, operationName = null, now = Date.now, loaders = {} } = {}) {
  const { document: text, tail } = splitTail(source);
  if (tail.some((b) => b.kind === "ai") && !loaders.ai) return { data: null, errors: [{ message: "| ai stages need a model; none is available here" }] };
  let document;
  try {
    document = parse(text);
  } catch (e) {
    return { data: null, errors: [{ message: e.message, locations: e.locations }] };
  }
  const result = await graphql({
    schema,
    source: text,
    rootValue: root(snapshot, now, loaders),
    variableValues: variables ?? undefined,
    operationName: operationName ?? undefined,
  });
  const errors = result.errors ? result.errors.map((e) => ({ message: e.message, locations: e.locations, path: e.path })) : [];
  let data = result.data ?? null;
  if (data) {
    try {
      data = applyDirectives(document, data, variables ?? {}, operationName);
      if (tail.length) data = await applyTail(data, tail, loaders);
    } catch (e) {
      errors.push({ message: e.message });
    }
  }
  return errors.length ? { data, errors } : { data };
}

/* ---- field directives ------------------------------------------------- */

const DROP = Symbol("drop");
const ARITH = { minus: (a, b) => a - b, plus: (a, b) => a + b, times: (a, b) => a * b, div: (a, b) => (b ? a / b : null) };

function applyDirectives(document, data, variables, operationName) {
  const fragments = Object.fromEntries(document.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d) => [d.name.value, d]));
  const op = document.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION && (!operationName || d.name?.value === operationName));
  if (!op) return data;
  const out = walk(op.selectionSet, data, fragments, variables);
  return out === DROP ? null : out;
}

function walk(selectionSet, value, fragments, variables) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => walk(selectionSet, v, fragments, variables)).filter((v) => v !== DROP);
  if (typeof value !== "object") return value;
  const row = { ...value };
  for (const field of fields(selectionSet, fragments)) {
    const key = field.alias?.value ?? field.name.value;
    if (!(key in row)) continue;
    if (field.selectionSet && row[key] != null) {
      const inner = walk(field.selectionSet, row[key], fragments, variables);
      row[key] = inner === DROP ? null : inner;
    }
    for (const d of field.directives ?? []) {
      const name = d.name.value;
      const args = Object.fromEntries((d.arguments ?? []).map((a) => [a.name.value, valueFromASTUntyped(a.value, variables)]));
      if (name in ARITH) {
        const operand = args.field != null ? row[args.field] : args.by;
        if (args.field != null && !(args.field in row)) throw new Error(`@${name}(field: "${args.field}"): no such field in this row — select it before ${key}, by that name or alias`);
        row[key] = row[key] == null || operand == null ? null : ARITH[name](Number(row[key]), Number(operand));
      } else if (name === "when") {
        if (!passes(row[key], args)) return DROP;
      }
    }
  }
  return row;
}

function fields(selectionSet, fragments) {
  const out = [];
  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) out.push(sel);
    else if (sel.kind === Kind.INLINE_FRAGMENT) out.push(...fields(sel.selectionSet, fragments));
    else if (sel.kind === Kind.FRAGMENT_SPREAD && fragments[sel.name.value]) out.push(...fields(fragments[sel.name.value].selectionSet, fragments));
  }
  return out;
}

function passes(v, a) {
  if (a.eq !== undefined && !(v === a.eq || (typeof a.eq === "number" && Number(v) === a.eq))) return false;
  if (a.ne !== undefined && (v === a.ne || (typeof a.ne === "number" && Number(v) === a.ne))) return false;
  if (a.gt != null && !(Number(v) > a.gt)) return false;
  if (a.gte != null && !(Number(v) >= a.gte)) return false;
  if (a.lt != null && !(Number(v) < a.lt)) return false;
  if (a.lte != null && !(Number(v) <= a.lte)) return false;
  if (a.like != null && !glob(a.like)(String(v ?? ""))) return false;
  if (a.in != null && !a.in.some((x) => x === v || (typeof x === "number" && Number(v) === x))) return false;
  return true;
}

/* ---- the pipeline tail ------------------------------------------------- */

/* The document ends at the first `|` outside braces, parentheses and
 * strings; what follows is `| context { … } | transform { … }` blocks. */
export function splitTail(source) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === "#") while (i < source.length && source[i] !== "\n") i++;
    else if (c === "|" && depth === 0) return { document: source.slice(0, i), tail: parseTail(source.slice(i)) };
  }
  return { document: source, tail: [] };
}

function parseTail(text) {
  const blocks = [];
  const re = /\|\s*(context|transform|ai)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    if (depth !== 0) throw new Error(`unbalanced braces in | ${m[1]} block`);
    blocks.push({ kind: m[1], code: text.slice(start, i - 1) });
    re.lastIndex = i;
  }
  if (!blocks.length) throw new Error("a pipeline tail is `| context { … }`, `| transform { … }` and `| ai { … }` blocks");
  return blocks;
}

/* Stages in order: runs of context/transform blocks become one JS
 * program each; an ai block is a model call between them. */
export function stages(blocks) {
  const out = [];
  let run = [];
  for (const b of blocks) {
    if (b.kind === "ai") {
      if (run.length) out.push({ kind: "js", blocks: run });
      run = [];
      out.push({ kind: "ai", instruction: b.code.trim() });
    } else run.push(b);
  }
  if (run.length) out.push({ kind: "js", blocks: run });
  return out;
}

/** One function from the blocks: contexts first, then the transforms in order over each row. */
export function tailProgram(blocks) {
  const contexts = blocks.filter((b) => b.kind === "context").map((b) => b.code);
  const transforms = blocks.filter((b) => b.kind === "transform").map((b) => `function ($) { ${b.code}\n return $; }`);
  return `${contexts.join("\n")}
const __steps = [${transforms.join(", ")}];
const __out = [];
for (const __row of rows) {
  let $ = __row;
  for (const step of __steps) { $ = step($); if ($ == null) break; }
  if ($ != null) __out.push($);
}
return __out;`;
}

/** Run a tail over rows, here. */
export function runTail(blocks, rows) {
  return new Function("rows", tailProgram(blocks))(rows);
}

async function applyTail(data, blocks, loaders) {
  const out = { ...data };
  const plan = stages(blocks);
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value)) continue;
    let rows = JSON.parse(JSON.stringify(value));
    for (const stage of plan) {
      if (stage.kind === "js") rows = loaders.transform ? await loaders.transform(tailProgram(stage.blocks), rows) : runTail(stage.blocks, rows);
      else rows = await loaders.ai(stage.instruction, rows, key);
      if (!Array.isArray(rows)) rows = rows == null ? [] : [rows];
    }
    out[key] = rows;
  }
  return out;
}

/** What an `ai` stage's answer becomes: the JSON array it returned, else one row of text. */
export function rowsFromModel(text) {
  const t = String(text ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t);
  const body = fenced ? fenced[1].trim() : t;
  const start = body.indexOf("[");
  if (start >= 0) {
    const asRows = (parsed) => (Array.isArray(parsed) ? parsed.map((r) => (r !== null && typeof r === "object" && !Array.isArray(r) ? r : { value: r })) : null);
    const end = body.lastIndexOf("]");
    if (end > start) {
      try {
        const rows = asRows(JSON.parse(body.slice(start, end + 1)));
        if (rows) return rows;
      } catch {
        /* fall through to the salvage below */
      }
    }
    /* Cut off mid-array: keep the objects that closed, mark the loss. */
    const lastObj = body.lastIndexOf("}");
    if (lastObj > start) {
      try {
        const rows = asRows(JSON.parse(body.slice(start, lastObj + 1) + "]"));
        if (rows) return [...rows, { _truncated: true }];
      } catch {
        /* prose after all */
      }
    }
  }
  return [{ text: t }];
}

/** Syntax and validation errors for `source`, without running it. */
export function check(source) {
  try {
    return validate(schema, parse(source)).map((e) => ({ message: e.message, locations: e.locations }));
  } catch (e) {
    return [{ message: e.message, locations: e.locations }];
  }
}

/* ---- flattening a learned schema into key rows ------------------------- */

export function keyStats(schema, maxDepth = 4) {
  const out = [];
  const walk = (node, path, depth) => {
    if (!node || depth > maxDepth) return;
    const present = node.types?.object ?? 0;
    for (const [k, child] of Object.entries(node.keys ?? {})) {
      const p = `${path}.${k}`;
      out.push({ path: p, presence: present ? child.n / present : 0, types: Object.keys(child.types ?? {}), values: child.values ?? null, count: child.n });
      walk(child, p, depth + 1);
      if (child.items) walk(child.items, `${p}[]`, depth + 1);
    }
    if (node.items && path.endsWith("[]") === false && !node.keys) walk(node.items, `${path}[]`, depth + 1);
  };
  walk(schema, "$", 0);
  return out;
}

/* ---- the mapping --------------------------------------------------------- */

function root(snap, now, loaders) {
  const t = now();
  const ago = (ms) => (ms == null ? null : Math.max(0, (t - ms) / 1000));
  const drifts = snap.drift ?? [];

  const body = (b, bytes) => ({
    n: b?.n ?? 0,
    text: b?.textN ?? 0,
    shape: b?.shape ?? null,
    schema: b?.schema ?? null,
    keys: ({ maxDepth }) => (b?.schema ? keyStats(b.schema, maxDepth ?? 4) : []),
    example: b?.example ?? null,
    encoded: b?.encoded ?? {},
    inflated: b?.inflated ?? 0,
    bytes: bytes ?? { n: 0, mean: null, p50: null, p95: null, p99: null, max: null },
  });

  const headerCounts = (map) =>
    Object.entries(map ?? {})
      .filter(([k]) => k !== "…")
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

  /* The main response body: the most common 2xx status, else the most common. */
  const mainBody = (e) => {
    let best = null;
    let bestScore = -1;
    for (const [s, n] of Object.entries(e.statuses)) {
      if (s === "…") continue;
      const score = n + (Number(s) >= 200 && Number(s) < 300 ? 1e9 : 0);
      if (score > bestScore) ((bestScore = score), (best = s));
    }
    return best != null ? e.resBodies?.[best] : null;
  };

  const endpoint = (e) => {
    const statuses = Object.entries(e.statuses).filter(([k]) => k !== "…").map(([s, c]) => [Number(s), c]);
    const errors = statuses.reduce((n, [s, c]) => (s >= 400 ? n + c : n), 0);
    const clientErrors = statuses.reduce((n, [s, c]) => (s >= 400 && s < 500 ? n + c : n), 0);
    const serverErrors = statuses.reduce((n, [s, c]) => (s >= 500 ? n + c : n), 0);
    const notFound = e.statuses[404] ?? 0;
    const lat = e.latency ?? {};
    const main = mainBody(e);
    const keys = main?.schema ? keyStats(main.schema, 4) : [];
    const mine = drifts.filter((d) => d.role === e.role && d.service === e.service && d.method === e.method && d.path === e.path);
    const metrics = {
      N: e.n,
      ERRORS: errors,
      ERROR_RATE: e.n ? errors / e.n : 0,
      CLIENT_ERRORS: clientErrors,
      SERVER_ERRORS: serverErrors,
      NOT_FOUND: notFound,
      INCOMPLETE: e.incomplete,
      INCOMPLETE_RATE: e.n ? e.incomplete / e.n : 0,
      P50: lat.p50 ?? null,
      P95: lat.p95 ?? null,
      P99: lat.p99 ?? null,
      MAX: lat.max ?? null,
      MEAN: lat.mean ?? null,
      TAIL_RATIO: lat.p50 ? lat.p99 / lat.p50 : null,
      BURST_MAX: e.burstMax ?? 0,
      LAST_AGO: ago(e.lastAt),
      AGE: ago(e.firstAt),
      STATUS_COUNT: statuses.length,
      RESPONSE_SHAPES: Object.values(e.resBodies ?? {}).filter((b) => b.n).length,
      KEY_PRESENCE_MIN: keys.length ? Math.min(...keys.map((k) => k.presence)) : null,
      KEYS_MIXED: keys.filter((k) => k.types.filter((x) => x !== "null").length > 1).length,
      DRIFT: mine.length,
      REQUEST_BODY_P95: e.reqBodyBytes?.p95 ?? null,
      RESPONSE_BODY_P95: e.resBodyBytes?.p95 ?? null,
    };
    return {
      key: e.key,
      role: ROLE[e.role],
      service: e.service,
      method: e.method,
      path: e.path,
      n: e.n,
      incomplete: e.incomplete,
      statuses: statuses.map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
      errors,
      errorRate: metrics.ERROR_RATE,
      clientErrors,
      serverErrors,
      notFound,
      incompleteRate: metrics.INCOMPLETE_RATE,
      latency: lat,
      tailRatio: metrics.TAIL_RATIO,
      burstMax: metrics.BURST_MAX,
      transports: Object.entries(e.transports ?? {}).map(([k, count]) => ({ transport: TRANSPORT[k] ?? "TCP", count })),
      pids: e.pids,
      query: e.query.map((q) => ({ name: q.name, n: q.n, kinds: Object.entries(q.kinds).map(([kind, count]) => ({ kind, count })) })),
      metric: ({ name }) => metrics[name] ?? null,
      drift: ({ since, kinds }) => {
        const cutoff = since != null ? t - since * 1000 : null;
        return mine.filter((d) => (cutoff == null || d.at >= cutoff) && (!kinds || kinds.includes(d.kind))).map(driftEvent);
      },
      request: { contentTypes: e.reqType ? [e.reqType] : [], headers: Object.keys(e.reqHeaders ?? {}), headerCounts: headerCounts(e.reqHeaders), body: body(e.reqBody, e.reqBodyBytes) },
      responses: Object.entries(e.resBodies ?? {})
        .map(([status, b]) => ({ status: Number(status), contentTypes: e.resType ? [e.resType] : [], headers: Object.keys(e.resHeaders ?? {}), headerCounts: headerCounts(e.resHeaders), body: body(b, e.resBodyBytes) }))
        .sort((a, b) => a.status - b.status),
      firstAt: e.firstAt,
      lastAt: e.lastAt,
      lastAgo: ago(e.lastAt),
      /* for where/orderBy */
      _metrics: metrics,
      _raw: e,
      _drift: mine,
    };
  };

  const driftEvent = (d) => ({ ...d, role: ROLE[d.role], ago: ago(d.at) });

  const matches = (x, w) => {
    if (!w) return true;
    const e = x._raw;
    if (w.role && e.role !== roleArg(w.role)) return false;
    if (!str(e.service, w.service) || !str(e.method, w.method) || !str(e.path, w.path)) return false;
    for (const m of w.metrics ?? []) if (!num(x._metrics[m.metric], m.is)) return false;
    if (w.status != null && !(e.statuses[w.status] > 0)) return false;
    if (w.statusBetween) {
      const [lo, hi] = w.statusBetween;
      if (!Object.keys(e.statuses).some((s) => s !== "…" && Number(s) >= lo && Number(s) <= (hi ?? lo))) return false;
    }
    if (w.requestHeader != null && !(e.reqHeaders?.[w.requestHeader] > 0)) return false;
    if (w.responseHeader != null && !(e.resHeaders?.[w.responseHeader] > 0)) return false;
    if (w.transport && !((e.transports ?? {})[w.transport.toLowerCase()] > 0)) return false;
    if (w.queryParam != null && !e.query.some((q) => q.name === w.queryParam)) return false;
    if (w.templated != null && /\{(?!\*)[^}]+\}/.test(e.path) !== w.templated) return false;
    if (w.collapsed != null && e.path.includes("{*}") !== w.collapsed) return false;
    if (w.bodyUnread != null) {
      const unread = Object.values(e.resBodies ?? {}).some((b) => Object.keys(b.encoded ?? {}).length > 0) || Object.keys(e.reqBody?.encoded ?? {}).length > 0;
      if (unread !== w.bodyUnread) return false;
    }
    if (w.driftKinds || w.driftSince != null) {
      const cutoff = w.driftSince != null ? t - w.driftSince * 1000 : null;
      if (!x._drift.some((d) => (cutoff == null || d.at >= cutoff) && (!w.driftKinds || w.driftKinds.includes(d.kind)))) return false;
    }
    if (w.and && !w.and.every((sub) => matches(x, sub))) return false;
    if (w.or && !w.or.some((sub) => matches(x, sub))) return false;
    if (w.not && matches(x, w.not)) return false;
    return true;
  };

  const all = () => snap.endpoints.map(endpoint);

  const service = (s) => {
    const eps = snap.endpoints.filter((e) => e.role === s.role && e.service === s.name).map(endpoint);
    const median = (xs) => {
      const v = xs.filter((x) => x != null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    const errors = eps.reduce((n, e) => n + e.errors, 0);
    return {
      ...s,
      role: ROLE[s.role],
      lastAgo: ago(s.lastAt),
      stats: {
        transactions: s.transactions,
        errors,
        errorRate: s.transactions ? errors / s.transactions : 0,
        p50Median: median(eps.map((e) => e.latency.p50)),
        p95Median: median(eps.map((e) => e.latency.p95)),
        p95Max: eps.reduce((m, e) => (e.latency.p95 != null && e.latency.p95 > m ? e.latency.p95 : m), null),
        plaintextEndpoints: eps.filter((e) => e.transports.some((x) => x.transport !== "TLS")).length,
      },
    };
  };

  const ORDER = {
    COUNT: (a, b) => b.n - a.n,
    LATENCY: (a, b) => (b._metrics.P95 ?? -1) - (a._metrics.P95 ?? -1),
    RECENT: (a, b) => b.lastAt - a.lastAt,
    ERRORS: (a, b) => b.errors - a.errors,
    NAME: (a, b) => `${a.service} ${a.method} ${a.path}`.localeCompare(`${b.service} ${b.method} ${b.path}`),
  };

  const transaction = (x) => ({
    ...x,
    ago: ago(x.at),
    role: ROLE[x.role] ?? x.role,
    transport: TRANSPORT_CODE[x.transport] ?? TRANSPORT[x.transport] ?? "WIRE",
    requestHeaders: (x.requestHeaders ?? []).map(([name, value]) => ({ name, value })),
    responseHeaders: (x.responseHeaders ?? []).map(([name, value]) => ({ name, value })),
  });

  return {
    summary: () => ({ at: snap.at, transactions: snap.transactions, skipped: snap.skipped, services: snap.services.length, endpoints: snap.endpoints.length, drift: drifts.length, inflated: snap.inflated }),

    services: ({ role, name }) => snap.services.filter((s) => (!role || s.role === roleArg(role)) && (name == null || glob(name)(s.name))).map(service),

    endpoints: ({ service: svc, role, method, path, status, minCount, since, where, sort, orderBy, limit }) => {
      const svcMatch = glob(svc);
      const pathMatch = glob(path);
      const cutoff = since != null ? t - since * 1000 : null;
      let rows = all().filter(
        (x) =>
          (svc == null || svcMatch(x.service)) &&
          (!role || x._raw.role === roleArg(role)) &&
          (method == null || x.method === method.toUpperCase()) &&
          pathMatch(x.path) &&
          (status == null || x._raw.statuses[status] > 0) &&
          (minCount == null || x.n >= minCount) &&
          (cutoff == null || x.lastAt >= cutoff) &&
          matches(x, where),
      );
      if (orderBy) {
        const dir = orderBy.desc === false ? 1 : -1;
        rows.sort((a, b) => {
          const va = a._metrics[orderBy.metric];
          const vb = b._metrics[orderBy.metric];
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          return (va - vb) * dir;
        });
      } else rows.sort(ORDER[sort ?? "COUNT"]);
      if (limit != null) rows = rows.slice(0, Math.max(0, limit));
      return rows;
    },

    endpoint: ({ service: svc, method, path, role }) => {
      const e = snap.endpoints.find((x) => x.service === svc.toLowerCase() && x.method === method.toUpperCase() && x.path === path && x.role === roleArg(role ?? "CLIENT"));
      return e ? endpoint(e) : null;
    },

    drift: ({ since, kinds, service: svc, path, limit }) => {
      const cutoff = since != null ? t - since * 1000 : null;
      const svcMatch = glob(svc);
      const pathMatch = glob(path);
      let rows = drifts.filter((d) => (cutoff == null || d.at >= cutoff) && (!kinds || kinds.includes(d.kind)) && (svc == null || svcMatch(d.service)) && pathMatch(d.path));
      if (limit != null && rows.length > limit) rows = rows.slice(rows.length - limit);
      return rows.map(driftEvent);
    },

    transactions: async ({ where, limit, bodyBytes }) => {
      const rows = loaders.transactions ? await loaders.transactions(where ?? null, limit ?? 50) : filterTransactions(snap.recent ?? [], where, limit ?? 50, t);
      const cut = Math.max(0, Math.min(bodyBytes ?? 4096, 16384));
      return rows.map((x) => transaction({ ...x, requestBody: x.requestBody?.slice(0, cut) ?? null, responseBody: x.responseBody?.slice(0, cut) ?? null }));
    },
  };
}

