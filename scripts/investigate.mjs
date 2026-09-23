#!/usr/bin/env node
/* An investigator: Claude, one tool, and the question "what changed?"
 *
 *   node scripts/investigate.mjs [--minutes 10] [--model claude-opus-5] [--api http://localhost:3000]
 *
 * The tool is httpscope's GraphQL. The system prompt is the page an
 * agent is meant to read (GET /api), so nothing here knows the schema —
 * Claude reads it. It prints every query as it is made and the report
 * at the end. Needs ANTHROPIC_API_KEY (or an `ant auth login` profile).
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";

const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const API = opt("--api", "http://localhost:3000");
const MODEL = opt("--model", "claude-opus-5");
const MINUTES = Number(opt("--minutes", 10));
const MAX_RESULT = 40_000;

const page = await (await fetch(`${API}/api`)).text();

const client = new Anthropic();

const query = betaTool({
  name: "query",
  description:
    "Run a GraphQL query against httpscope, the capture of every HTTP API this machine speaks. Returns the JSON result. Use the schema and the `where` filters, directives and pipeline tail described in your instructions; start wide, then narrow to evidence.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The GraphQL document, optionally followed by a `| transform { … }` tail." },
      variables: { type: "object", description: "Variables for the document, if any." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  run: async ({ query, variables }) => {
    const started = Date.now();
    const res = await fetch(`${API}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables: variables ?? null }) });
    const text = await res.text();
    console.log(`\n▶ query (${res.status}, ${text.length} bytes, ${Date.now() - started} ms)\n${query.trim().split("\n").map((l) => "  " + l).join("\n")}`);
    return text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + `\n… (${text.length - MAX_RESULT} more bytes cut; narrow the query)` : text;
  },
});

const system = `You are a senior SRE investigating API drift on one machine. You have one tool: httpscope's GraphQL, described by the page below — read the schema carefully; it is the whole contract.

Work like an investigator, not a reporter:
- Establish the baseline first: which services, which endpoints, how much traffic, who calls whom.
- Then look for anything that changed or is wrong: fields that appeared or went missing, types that changed, new status codes and error rates, latency steps, bursts, bodies that say something is wrong even when the status is fine, credentials over plaintext, paths that turned into vocabularies. Use the drift events as leads, not as conclusions — confirm each with the endpoint's shape, key statistics, and concrete transactions.
- Distinguish a real change from noise (a single 404 is not drift). Say when something is inconclusive.
- Prefer several targeted queries over one huge one; results over ~40 KB are cut.

Finish with a report: one line per finding — what changed, where (service, method, path), when (about how long ago), the evidence (a transaction or a number), and your confidence — then anything you looked for and did not find. Be exact and brief.

${page}`;

const runner = client.beta.messages.toolRunner({
  model: MODEL,
  max_tokens: 32_000,
  stream: true,
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  output_config: { effort: "high" },
  system,
  tools: [query],
  max_iterations: 40,
  messages: [
    {
      role: "user",
      content: `Something has been changing in the HTTP APIs on this machine over roughly the last ${MINUTES} minutes. Investigate and report every change you can substantiate, with evidence.`,
    },
  ],
});

let final = null;
for await (const stream of runner) {
  const message = await stream.finalMessage();
  final = message;
  for (const block of message.content) if (block.type === "text" && block.text.trim()) console.log(`\n${block.text}`);
  if (message.stop_reason === "refusal") {
    console.error("refused:", message.stop_details?.explanation ?? "");
    break;
  }
}
if (final?.usage) {
  const u = final.usage;
  console.log(`\n— ${MODEL}: ${u.input_tokens} in (${u.cache_read_input_tokens ?? 0} cached), ${u.output_tokens} out`);
}
