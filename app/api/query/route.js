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
 */

import { execute } from "@/lib/query/query.js";
import { recentTransactions, snapshot, transform } from "@/lib/scope.js";

const bad = (message, status = 400) => Response.json({ errors: [{ message }] }, { status });

export async function POST(request) {
  let body;
  try {
    const type = request.headers.get("content-type") ?? "";
    body = type.includes("graphql") && !type.includes("json") ? { query: await request.text() } : await request.json();
  } catch {
    return bad("expected a JSON body { query, variables?, operationName? } or application/graphql");
  }
  return run(body);
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
  return run({ query, variables, operationName: url.searchParams.get("operationName") });
}

async function run({ query, variables = null, operationName = null }) {
  if (typeof query !== "string" || !query.trim()) return bad("query must be a non-empty string");
  const snap = await snapshot();
  /* Recent transactions are fetched from the isolate only when asked
   * for, filtered there, so a snapshot stays small. */
  const result = await execute(snap, query, {
    variables,
    operationName,
    /* Recent transactions come from the isolate only when asked for,
     * filtered there; a pipeline tail's JavaScript runs there too. */
    loaders: { transactions: (where, limit) => recentTransactions(where, limit), transform: (program, rows) => transform(program, rows) },
  });
  return Response.json(result, { status: result.errors && !result.data ? 400 : 200 });
}
