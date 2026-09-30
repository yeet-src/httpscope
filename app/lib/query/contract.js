/* The one page an agent reads: what this is, how to ask, the schema.
 * Served at / (to anything that is not a browser) and at /api. */

import { SDL } from "./schema.js";

export const PAGE = `# httpscope

The HTTP APIs this machine speaks — every service it calls or serves,
each endpoint's shape, statistics and drift — captured off the wire and
at TLS library boundaries, read-only.

## Ask

    POST /api/query          body: { "query": "...", "variables": { } }
    POST /api/query?stream=1 the same, answered as JSON lines while it runs:
                             {"event":"start"} · {"event":"text","delta":"…"} per piece of
                             a model's output · {"event":"result","data":…} at the end
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
    { transactions(where: { statusBetween: [500, 599], since: 600 }, limit: 20, bodyBytes: 2048) {
        ago service method target status duration pid comm responseBody } }

String arguments in \`where\` take \`{ eq, ne, like, in }\` (\`like\` with \`*\`);
numbers take \`{ eq, ne, gt, gte, lt, lte }\`. Variables work as in any
GraphQL: \`query($s: String!) { services(name: $s) { name } }\` with
\`"variables": { "s": "…" }\`.

## The kernel's view

\`segments\` is not from the model: it runs a program on the kernel's
own TCP state, live, for the duration of the query. Name the struct
members you want and they are read per delivered segment, where this
kernel's BTF says they are — any member of \`struct sock\`, \`tcp_sock\`,
\`inet_sock\`, \`inet_connection_sock\` or \`sk_buff\`, through pointers
into other objects, no table of offsets involved:

    { segments(select: ["cwnd", "srtt", "inflight: tcp.snd_nxt - tcp.snd_una", "dev"], limit: 20, ms: 3000) {
        t comm sport daddr dport values } }

    # the route's device and the protocol behind the socket: two pointer chases
    { segments(select: ["iface: sock.sk_dst_cache.dev.name", "mtu: sock.sk_dst_cache.dev.mtu", "proto"], limit: 5) { daddr values } }

    # a window of the segment's bytes, as text or as a JSON field — on one port, data segments only
    { segments(select: ["req: payload(0, 120, text)", "id: payload(0, 200, json:id)"], ports: [8080], data: true, limit: 10) {
        comm sport dport len linear values } }

    # congestion state is a 5-bit field; bitfields read by position
    { segments(select: ["ca", "lost", "retrans", "rto"], limit: 20) { t daddr values } }

Entries are \`alias: root.member…\` (roots \`sock tcp inet icsk skb\`) or an
alias — \`cwnd ssthresh sndNxt sndUna rcvNxt sndWnd rcvWnd srtt mdev mss
retrans lost sacked bytesAcked bytesReceived bytesSent segsIn segsOut ca
rto proto dev skbLen rcvbuf sndbuf inode dport sport daddr saddr state\`.
\`a - b\` and \`a + b\` compute in the kernel; \`member(kind[, size])\` reads
the bytes another way (\`hex str ip4 ip6 port be bytes text json:field\`);
\`payload(offset, len[, kind])\` is the segment's application bytes past
the TCP header — read in the kernel when the skb's head holds them
(\`linear\` on the row says how many), else from the wire tap's copy of
the same packet, matched by flow and sequence number (whole bodies,
reassembled, are in \`transactions\`). How each member
reads back — signedness, big-endian typedefs, enum names, strings,
bitfields — comes from its type. Eight fields, sixteen ops each (a
pointer costs two); the tracepoint is receive-side, so a flow shows as
its peer's segments arrive. \`plan(select: […]) { name ops decode }\`
compiles without running; \`struct(name: "tcp_sock") { members { name offset kind type bitfield } }\`
lists what there is. A busy host delivers thousands of segments a
second, most of them bare ACKs: \`ports: [443]\` and \`data: true\` narrow
in the kernel, \`everyMs\` thins. \`values\` is JSON keyed by alias, so a
tail sees \`$.values.cwnd\`.

## Shaping the answer

Two things sit on top of plain GraphQL, for criteria the schema did not
anticipate.

**Field directives**, on any selected field:

    @when(gt: | gte: | lt: | lte: | eq: | ne: | like: | in:)   keep the row only if the value passes;
                                                             on a single object the field becomes null
    @div(field: "sibling") @minus(field:) @plus(field:) @times(field:)   arithmetic against a sibling
    @div(by: 1000) …                                        or against a constant

The sibling is named by its alias or name and must be selected earlier
in the same row:

    { endpoints { path p50: metric(name: P50) tail: metric(name: P99) @div(field: "p50") @when(gt: 10) } }

**A pipeline tail**, after the document, over the rows of every
top-level list, stages in the order written:

    | context   { let seen = 0; }                 JavaScript, run once; its declarations are in
                                                  scope for every transform
    | transform { $.n2 = $.n * 2; if ($.n < 5) return null; }
                                                  JavaScript per row: \`$\` is the row — mutate it,
                                                  \`return\` a new object to reshape it, \`return null\`
                                                  to drop it
    | ai        { instruction }                   a model over the rows (below)

Bodies may span lines. The tail applies to each top-level list with the
same stages, so a document with several roots should either want that
or keep one root per tail. Transforms run in the isolate, not in a
browser and not in Node; they see only the rows.

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

Options go in parentheses before the block: \`| ai(model: "claude-opus-5", max: 4000) { … }\`
picks the model and caps its output in tokens; the default is
\`claude-sonnet-5\`, chosen because it answers questions about API routes
that stricter models decline as reconnaissance. The instruction may span
lines and use light markdown. The model sees at most ~60 KB of rows;
narrow first. An answer cut off mid-array keeps
its complete rows and ends with \`{ _truncated: true }\`. Its answers are
judgement, not measurement — the numbers upstream are the evidence. If
it declines an instruction, the stage returns one row
\`{ text, _stop: "refusal" }\` rather than nothing; rephrasing what the
rows are for usually helps.

An endpoint compared against its service: \`services { stats { p95Median } }\`
gives the middle; \`endpoints(where: { service: { eq: "…" }, metrics: [{ metric: P95, is: { gt: … } }] })\`
the outliers. \`metric(name: …)\` reads any metric by name.

## Schema

Everything above is convention; this is the contract. Every type,
field and argument carries its description. Introspection returns the
same.

\`\`\`graphql
${SDL.trim()}
\`\`\`
`;
