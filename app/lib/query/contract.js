/* The one page an agent reads: what this is, how to ask, the schema.
 * Served at / (to anything that is not a browser) and at /api. */

import { SDL } from "./schema.js";

export const PAGE = `# httpscope

The HTTP APIs this machine speaks — every service it calls or serves,
each endpoint's shape, statistics and drift — captured off the wire and
at TLS library boundaries, read-only.

## Ask

    POST /api/query          body: { "query": "...", "variables": { } }
    GET  /api/query?query=...
    GET  /api/schema         this schema alone, as SDL
    GET  /api/status         are the taps alive
    GET  /                   this page (a browser gets the UI instead)

Responses are standard GraphQL: \`{ "data": ... }\` or \`{ "errors": [...] }\`.
Introspection works. Times are milliseconds since the epoch with an
\`ago\` in seconds beside them; \`since\` arguments are seconds; \`path\`
and \`service\` arguments take \`*\` as a wildcard.

## For example

    { services { role name transactions clients servers stats { errorRate p95Median } } }

    { endpoints(sort: LATENCY, limit: 10) {
        service method path n errors latency { p95 }
        responses { status body { shape } } } }

    { drift(since: 600) { ago kind service method path detail } }

    { endpoint(service: "api.example.com", method: "POST", path: "/orders") {
        request { body { shape example } } responses { status body { shape } } } }

## Deciding for yourself

Nothing here is pre-judged. Every metric is a number on the endpoint,
and \`where\` composes comparisons on them with and/or/not, so the
criteria are yours:

    # more than 5% errors, on something called at least 20 times
    { endpoints(where: { metrics: [{ metric: ERROR_RATE, is: { gt: 0.05 } },
                                    { metric: N, is: { gte: 20 } }] },
                orderBy: { metric: ERROR_RATE }) {
        service method path n errorRate statuses { status count } } }

    # a heavy tail: p99 more than ten times p50
    { endpoints(where: { metrics: [{ metric: TAIL_RATIO, is: { gt: 10 } }] }) {
        service method path latency { p50 p99 } } }

    # credentials over plaintext
    { endpoints(where: { requestHeader: "authorization", transport: WIRE }) {
        service method path transports { transport count } } }

    # a response whose keys come and go, or change type
    { endpoints(where: { or: [{ metrics: [{ metric: KEY_PRESENCE_MIN, is: { lt: 0.9 } }] },
                              { metrics: [{ metric: KEYS_MIXED, is: { gt: 0 } }] }] }) {
        service method path responses { status body { keys { path presence types } } } } }

    # bursts: more than 20 calls in one second — an N+1
    { endpoints(where: { metrics: [{ metric: BURST_MAX, is: { gt: 20 } }] }) { service method path burstMax } }

    # what changed in the last ten minutes, and the evidence
    { endpoints(where: { driftSince: 600, driftKinds: ["response.field.missing", "response.type.changed"] }) {
        service method path drift(since: 600) { kind detail } } }
    { transactions(where: { statusBetween: [500, 599], since: 600 }, limit: 20) {
        ago service method target status duration pid comm responseBody } }

## Asking a model

A tail may also have \`| ai { instruction }\` stages: the rows so far and
your instruction go to a model, and the rows it returns continue down
the pipeline — a JSON array, or one row \`{ text }\` when it answered
in prose. Stages run in the order written, so a \`transform\` can shape
what the model sees and another can check what it said:

    { endpoints { service method path n errorRate resShape: responses { status body { shape } } } }
    | ai { group these endpoints by what they seem to be for; return path and group }

    { drift(since: 3600) { ago kind service method path detail } }
    | ai { which of these would break an existing client? return kind, path, breaking (true/false), why }

    { transactions(where: { statusBetween: [500, 599] }, limit: 20) { target status responseBody } }
    | ai { summarise the failure modes in three lines }

A tail runs over every top-level list in the document, with the same
instruction, so a query with several roots should either want that or
keep one root per tail. Bodies may span lines: JavaScript in
\`transform\`, plain prose or light markdown in \`ai\`.

The model sees at most ~60 KB of rows; narrow first. Its answers are
judgement, not measurement — the numbers upstream are the evidence. If
it declines an instruction, the stage returns one row
\`{ text, _stop: "refusal" }\` rather than nothing; rephrasing what the
rows are for usually helps.

An endpoint compared against its service: \`services { stats { p95Median } }\`
gives the middle; \`endpoints(where: { service: { eq: "…" }, metrics: [{ metric: P95, is: { gt: … } }] })\`
the outliers. \`metric(name: …)\` reads any metric by name.

## Schema

\`\`\`graphql
${SDL.trim()}
\`\`\`
`;
