/* POST /api/query — GraphQL over the live model.
 *
 * The isolate hands over the model as plain data (`snapshot()`, a
 * "use yeet" call over the hub's socket) and the query runs here in
 * Node, where the `graphql` package is. One snapshot per request: the
 * model is small — schemas and counters, not bodies — and this keeps the
 * isolate's part a single message.
 *
 *   curl -s localhost:3000/api/query -d '{"query":"{ services { name } }"}'
 *   curl -s 'localhost:3000/api/query?query=%7B%20summary%20%7B%20transactions%20%7D%20%7D'
 *
 * With `?stream=1` (or `Accept: application/x-ndjson`) the answer is a
 * chunked stream of JSON lines instead of one object: `start`, then
 * `text` events carrying the model's output as an `| ai` stage produces
 * it, then `result` with the GraphQL result. Progress is polled from the
 * isolate while the query runs, since Node cannot read an isolate
 * stream directly. The server has to pass a streaming body through for
 * the chunks to arrive as they are made; a buffering server still
 * delivers valid lines, all at the end.
 */

import { execute } from "@/lib/query/query.js";
import { ai, kernelStruct, queryFinished, queryProgress, queryStarted, recentTransactions, segments, snapshot, transform, walkPlan } from "@/lib/scope.js";

const bad = (message, status = 400) => Response.json({ errors: [{ message }] }, { status });

/* What the request says about who sent it — enough to tell agents apart
 * on the queries page. */
const clientOf = (request) => {
  const h = request.headers;
  const parts = [h.get("x-forwarded-for") ?? h.get("x-real-ip"), h.get("user-agent")].filter(Boolean);
  return parts.join(" · ").slice(0, 120) || null;
};

const wantsStream = (request) => {
  const url = new URL(request.url);
  return url.searchParams.get("stream") === "1" || (request.headers.get("accept") ?? "").includes("application/x-ndjson");
};

export async function POST(request) {
  let body;
  try {
    const type = request.headers.get("content-type") ?? "";
    body = type.includes("graphql") && !type.includes("json") ? { query: await request.text() } : await request.json();
  } catch {
    return bad("expected a JSON body { query, variables?, operationName? } or application/graphql");
  }
  return wantsStream(request) ? streamRun(body, request, "POST") : run(body, request, "POST");
}

export async function GET(request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("query");
  if (!query) return bad("pass ?query=…; see GET /api");
  let variables = null;
  const raw = url.searchParams.get("variables");
  if (raw) {
    try {
      variables = JSON.parse(raw);
    } catch {
      return bad("variables must be JSON");
    }
  }
  const args = { query, variables, operationName: url.searchParams.get("operationName") };
  return wantsStream(request) ? streamRun(args, request, "GET") : run(args, request, "GET");
}

/* The same query, answered as JSON lines while it runs. */
async function streamRun({ query, variables = null, operationName = null }, request, method) {
  if (typeof query !== "string" || !query.trim()) return bad("query must be a non-empty string");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const line = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      const started = Date.now();
      const id = await queryStarted({ query, variables, client: clientOf(request), method }).catch(() => null);
      line({ event: "start", id, at: started });
      let sent = 0;
      let stop = false;
      const poll = (async () => {
        while (!stop && id != null) {
          await new Promise((r) => setTimeout(r, 150));
          const p = await queryProgress(id).catch(() => null);
          if (p && p.stream.length > sent) {
            line({ event: "text", delta: p.stream.slice(sent) });
            sent = p.stream.length;
          }
        }
      })();
      try {
        const snap = await snapshot();
        const result = await execute(snap, query, {
          variables,
          operationName,
          loaders: {
            transactions: (where, limit) => recentTransactions(where, limit),
            transform: (program, rows) => transform(program, rows),
            segments: (select, options) => segments(select, options),
            plan: (select) => walkPlan(select),
            struct: (name) => kernelStruct(name),
            ai: (instruction, rows, list, options) => ai(instruction, rows, list, { ...options, queryId: id }),
          },
        });
        stop = true;
        await poll;
        const p = id != null ? await queryProgress(id).catch(() => null) : null;
        if (p && p.stream.length > sent) line({ event: "text", delta: p.stream.slice(sent) });
        const ms = Date.now() - started;
        if (id != null) queryFinished(id, { result, ms, status: result.errors && !result.data ? 400 : 200 }).catch(() => {});
        line({ event: "result", ms, ...result });
      } catch (error) {
        stop = true;
        line({ event: "result", errors: [{ message: String(error?.message ?? error) }] });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

async function run({ query, variables = null, operationName = null }, request, method) {
  if (typeof query !== "string" || !query.trim()) return bad("query must be a non-empty string");
  const started = Date.now();
  const id = await queryStarted({ query, variables, client: clientOf(request), method }).catch(() => null);
  const snap = await snapshot();
  /* Recent transactions are fetched from the isolate only when asked
   * for, filtered there, so a snapshot stays small. */
  const result = await execute(snap, query, {
    variables,
    operationName,
    /* Recent transactions come from the isolate only when asked for,
     * filtered there; a pipeline tail's JavaScript runs there too. */
    loaders: {
      transactions: (where, limit) => recentTransactions(where, limit),
      transform: (program, rows) => transform(program, rows),
      segments: (select, options) => segments(select, options),
      plan: (select) => walkPlan(select),
      struct: (name) => kernelStruct(name),
      ai: (instruction, rows, list, options) => ai(instruction, rows, list, { ...options, queryId: id }),
    },
  });
  const status = result.errors && !result.data ? 400 : 200;
  if (id != null) queryFinished(id, { result, ms: Date.now() - started, status }).catch(() => {});
  return Response.json(result, { status });
}
