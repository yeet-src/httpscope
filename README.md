# httpscope

Watch the HTTP APIs a machine speaks — plaintext and TLS, every runtime —
and notice when they drift. Agents read one page of GraphQL schema to
learn the shape, then query it — the same language as the system graph;
people get an HTML table.

Built on [yeetkit](../yeetkit): the app runs inside a yeet isolate next to
the kernel data it shows. The capture is eBPF; the inventory is the system
graph; the UI is Solid rendered over a socket.

## The layers, bottom up

| # | layer | where | status |
|---|---|---|---|
| 1 | **probes** — kernel taps and the connection inventory | `bpf/`, `app/lib/probes/` | done, verified on this box; the wire tap (TCX) is the byte source |
| 2 | **decode** — bytes per connection → HTTP transactions | `app/lib/http/` | done, HTTP/1.x and HTTP/2, verified on this box |
| 3 | **model** — transactions → endpoints, shapes, drift | `app/lib/model/` | done, verified on this box |
| 4 | **query** — the GraphQL agents send, with filters, directives and a JS tail | `app/lib/query/` | done, verified on this box |
| 5 | **API** — `GET /api` the page agents read, `POST /api/query` GraphQL | `app/api/`, `app/lib/scope.js` | done, verified on this box |
| 6 | **UI** — the HTML table | `app/**/page.jsx` | done, verified on this box |

## Layer 6: UI

Five pages, Solid rendered in the isolate and patched over the socket;
each reads the pipeline (`app/lib/scope.js`) as a plain function call in
the same process, once a second, except drift which is a stream.

| page | shows |
|---|---|
| `/` | is the capture alive (interfaces, segments, TLS taps, flows, transactions, errors); the services table — role, name, endpoints, transactions, who called, who served, last seen; the twelve most recent drift events |
| `/services/:role/:name` | one service's endpoints: method, templated path, transactions, statuses (red when any is ≥ 400), p50 and p95, response type and shape, last seen |
| `/endpoints/:id` | one endpoint in full: statistics, callers, query parameters with kinds, request and response shapes per status as types with an example body, body sizes, the last ten exchanges with their bodies, and the drift that touched it |
| `/transactions` | the last hundred transactions, newest first; a click opens one to its request and response headers and bodies (inflated if compressed, up to 16 KiB) |
| `/drift` | every drift event, newest first, live — an async generator in the isolate pushes each event the tick it happens |

The palette is the template's: a terminal's sixteen colours, no boxes,
structure from whitespace. Colour is never the only channel — a red
status sits beside its number. Every colour is a token, so the nav
offers themes — the terminal default, an all-white `paper`, Solarized
dark and light, Gruvbox dark and light, Nord, Dracula, Tokyo Night,
One Light — each a block of overrides in `globals.css`; the picker is a
browser-side island (`app/lib/ThemePicker.jsx`) that remembers the
choice per browser, since the isolate's view is shared.

```sh
npm run dev                                # http://localhost:3000
node scripts/render.mjs /                  # the page as text, headless: connects to the hub as a browser would
node scripts/render.mjs /drift --ms 4000
```

Verified here headless with `scripts/render.mjs`, which speaks the
hub's protocol and applies the patch stream the way the browser client
does: all four pages rendered live data — services with the serving
python pid, `/users/{n}` with its optional `email?` field, the ten
`/api/*` paths collapsed, HTTPS calls attributed to curl — and the
drift feed streamed. `yeetkit check` still passes its wire, routing,
live-data, BPF, stream and hub phases; its six failures are the
template's own demo assertions (the counter, the `Filter` island),
which the home page no longer contains.

## Layer 5: API, and the pipeline behind it

Two parts: the routes, in Node, and the pipeline they ask, in the isolate.

**`app/lib/scope.js`** (`"use yeet"`) is the app itself: started by the
layout on the isolate's first frame and kept for its life. It attaches
the wire tap to every interface with capture-all (minus the app's own
ports), runs reassembler → decoder → model, refreshes the inventory each
second for attribution, and attaches TLS taps — **to binaries, not
pids**: a uprobe on the host's libssl fires for every process that maps
it, now and later, so one attach covers each curl and python that will
ever run, and a process that lives 50 ms could not be attached by pid in
time anyway. At start every libssl and every executable of a runtime
known to carry its own TLS (node, deno, bun) is attached; after that a
TLS flow on the wire from a process whose binary is not yet tapped
triggers one more. A binary with no boundary is remembered as failed.
`snapshot()` and `status()` are what the routes call.

| route | serves |
|---|---|
| `GET /api` | the one page an agent reads: how to ask, four examples, the schema (markdown) |
| `GET /api/schema` | the SDL alone |
| `POST /api/query` | GraphQL: `{ query, variables?, operationName? }` as JSON, or the query as `application/graphql`; also `GET /api/query?query=…`. Standard `{ data }` / `{ errors }`; a query that yields no data is a 400 |
| `GET /api/status` | uptime, wire counters, flows and connections, model sizes, each TLS binary with its state and pids, recent errors |

```sh
npm run dev
curl -s localhost:3000/api                       # the page
curl -s localhost:3000/api/query -d '{"query":"{ services { name transactions clients servers } }"}'
curl -s localhost:3000/api/status
```

Verified here with `npm run dev`: the pipeline up on eight interfaces
within a second of boot, libssl attached with both OpenSSL boundaries,
plaintext loopback requests and HTTPS requests from curl and python
decoded and attributed to their pids, shapes queryable, a field typo
answered with GraphQL's error and a 400.

Not yet: Go binaries (their pclntab offsets need Node; the daemon at
HEAD resolves `at: "ret"` itself and will make this go away); container
processes are treated as host processes (the graph exposes no mount
namespace, so a container's libssl would be attached by the host path,
which is the wrong file); no authentication or redaction on the routes.

## Layer 4: query

`app/lib/query/` is a GraphQL schema over the model, executed with the
`graphql` package in Node — the runtime that holds the HTTP listener —
against `Model.snapshot()`, the plain-data form the isolate hands over.
GraphQL rather than a DSL of our own because the system graph already
speaks it: an agent learns one language for the box and for the APIs
the box speaks, and gets introspection, validation and standard errors
for free.

Nothing in it is a verdict. The design rule is that every fact an
agent might judge by is a plain number or list on the row, and the
query composes the criteria — so "a bad API" is whatever the agent
decides to ask for.

| file | does |
|---|---|
| `schema.js` | the SDL: `summary`, `services` (with `stats` aggregates), `endpoints`, `endpoint`, `drift`, `transactions`, and the kernel's view — `segments`, `plan`, `struct` (layer 1, the walk VM). Times are ms since the epoch with an `ago` in seconds beside them; `since` arguments are seconds; `path` and `service` arguments take `*` |
| `query.js` | `execute(snapshot, source, { variables, loaders })` → `{ data, errors }`; `check(source)` validates without running. The mapping from the model's rows to the types, the derived metrics, `where`, `orderBy`, the directive pass and the tail |
| `filter.js` | the `Num`/`Str` comparisons and the transaction filter, with no `graphql` dependency, so the isolate filters its ring with the same code |

Four ways to say what you mean, from least to most free:

- **Metrics on every endpoint**, by field or by name (`metric(name: TAIL_RATIO)`):
  count, errors and error rate split by class, incomplete rate, p50/p95/p99/max/mean,
  tail ratio (p99/p50), the densest calls per second (`burstMax`), age, distinct
  statuses and shapes, the lowest key presence and the mixed-type keys in the main
  response body, drift count, body sizes. Plus facts: which transports carried it,
  header names with counts, `keys` of a body flattened to rows with presence and types.
- **`where`** on `endpoints`: comparisons on any metric (`{ metrics: [{ metric: ERROR_RATE, is: { gt: 0.05 } }] }`),
  string matches with `*`, a status or status range answered with, a header name
  seen, a transport, a query parameter, templated or collapsed paths, unread
  bodies, drift kinds within a window — all and-ed, nesting with `and`/`or`/`not`.
  `orderBy: { metric, desc }` sorts by any metric.
- **Field directives**, as tcpwalk had them: `@when(gt/gte/lt/lte/eq/ne/like/in)` on a field
  drops the row when the value fails; `@div/@minus/@plus/@times(field: "sibling" | by: n)`
  compute from a sibling selected earlier in the row, by name or alias.
- **A pipeline tail** after the document — `| context { … } | transform { … }` —
  JavaScript over the rows of every top-level list, `$` the row: mutate it, `return`
  a new one, `return null` to drop it; `context` runs once and its declarations
  are in scope. It runs in the isolate, not in Node.
- **`| ai { instruction }`**, a stage that hands the rows and an instruction to a
  model through `yeet:ai` and takes back the rows it returns (a JSON array, or one
  `{ text }` row for prose), in order with the other stages. Judgement over rows the
  query already selected: "group these by what they are for", "which of these would
  break a client", "summarise the failure modes". It runs on `claude-sonnet-5`:
  measured here, `claude-opus-5`'s safeguards decline tables of API routes as
  reconnaissance every time, while Sonnet 5 and Haiku 4.5 answer. A refusal comes
  back as a `{ text, _stop: "refusal" }` row, never as silence. Usage is on
  `/api/status` under `ai`.

`transactions(where: TransactionWhere, limit)` is the evidence: the last
thousand transactions kept in the pipeline with headers and up to 4 KiB
of each body, filtered in the isolate by service, path, target, status
or range, duration, pid, transport, completeness, recency, a header
name, or a substring of either body.

```graphql
{ endpoints(where: { requestHeader: "authorization", transport: WIRE }) { service method path n } }
{ endpoints(where: { metrics: [{ metric: ERROR_RATE, is: { gt: 0.05 } }, { metric: N, is: { gte: 20 } }] },
            orderBy: { metric: ERROR_RATE }) { service method path errorRate statuses { status count } } }
{ endpoints { path p50: metric(name: P50) tail: metric(name: P99) @div(field: "p50") @when(gt: 10) } }
{ endpoints { path burstMax n } } | transform { if ($.burstMax < 20) return null; $.perCall = $.n / $.burstMax; }
{ transactions(where: { statusBetween: [500, 599], since: 600 }, limit: 20) { ago service method target status pid comm responseBody } }
```

```sh
npm test                                                     # includes introspection and variables
yeet run scripts/selftest-model.js -- --port 8089,80 --dump  # …then cut the JSON after ---SNAPSHOT---
node scripts/query.mjs snapshot.json '{ services { name transactions servers } }'
```

Verified here through the live API: a `where` on the `authorization`
header over `WIRE` found the plaintext credentials; error rates
filtered and ordered; the burst metric with a `@div` tail ratio through
a `| transform` that dropped the quiet rows; 5xx evidence from
`transactions` with pid and comm; service aggregates for comparison;
and a field typo answered with GraphQL's own "Did you mean" error.

## Layer 3: model

`app/lib/model/` turns transactions into the APIs a machine speaks. Pure
JavaScript; `npm test` covers it.

| file | does |
|---|---|
| `path.js` | a request target → templated segments and query. Identifier-shaped segments are recognised on sight: `{n}`, `{uuid}`, `{hex}`, `{date}`, `{email}`, `{token}`. Query values get a kind (`int`, `bool`, `uuid`, `list`, …) |
| `schema.js` | the shape of JSON, learned from samples: types, keys with presence counts (optional when absent from some sample), array items, enumerations for few distinct strings. `diff()` says what a value would change; `describe()` prints a type |
| `stats.js` | a latency reservoir with percentiles, a recent-window ring, bounded counters |
| `model.js` | **services** (the `Host` called, or answered as; else the peer), their **endpoints** (method × template), each with status counts, latency, query parameters, headers, content types, request body shape and a response body shape per status, who called and who served; and **drift** |

A path position that accumulates more than `collapseAfter` (8) distinct
literals is collapsed to `{*}` and its endpoints merged, so
`/api/alice`, `/api/bob`, … become `/api/{*}` once the vocabulary outgrows
a route table.

Drift is an event stream (`onDrift`, `drift()`), each with the endpoint
and a detail line:

| kind | when |
|---|---|
| `endpoint.new`, `endpoint.collapsed` | first sighting; a vocabulary collapsed |
| `status.new` | a status code first seen after 20 responses |
| `response.field.added` / `.field.missing` / `.type.changed` (and `request.…`) | a JSON key appears, a key present in every sample so far is absent, a type never seen at that path — after 10 JSON samples |
| `query.new`, `request.header.new`, `response.header.new` | a parameter or header name first seen after 20 requests |
| `latency.up` / `latency.back` | the p95 of the last 32 requests is over twice the baseline p95 (the first 64) and 20ms above it; and when it returns under 1.5× |

Bodies are parsed when complete. A compressed one (`Content-Encoding`
gzip, deflate, br, zstd, stacked or not) is inflated through the
`inflate` option — the host passes `decodeContentEncoding` from
`yeet:compression`, which is native; the model stays pure and, without
it, counts the body under its encoding instead. Up to 8 MiB of inflated
body is parsed. Both ends of a loopback exchange are named: the model
takes `{ pid, comm, peer }` per transaction, from `attribute.js` for wire
flows.

```sh
yeet run scripts/selftest-model.js -- --port 8089,80 [--tls /usr/lib/libssl.so.3]   # drift live, endpoint table at the end
```

Verified here: a local `http.server` (`/users/{n}` with typed query
parameters and an `email?` field seen in one of six responses,
`/api/{*}` collapsed from ten names, a 404, a form POST), and httpbin
and example.com over the Wi-Fi interface, with the JSON shapes of
httpbin's responses printed as types — including its `/gzip` and
`/brotli` responses, inflated.

## Layer 2: decode

`app/lib/http/` turns the records of layer 1 into HTTP/1.x transactions.
Pure JavaScript, no `yeet:*` imports: `npm test` runs it under Node
against fixtures and against a real loopback exchange.

| file | does |
|---|---|
| `bytes.js` | a byte queue a parser eats from the front; Latin-1 and UTF-8 by hand (the isolate has no TextDecoder); a bounded body capture that keeps counting past its limit |
| `h1.js` | one direction's messages: start line, headers, and the body framing of RFC 7230 §3.3.3 — content-length, chunked (de-chunked, trailers kept), until-close, and none for 1xx/204/304/HEAD; `CONNECT` and `101` make the rest of the direction opaque |
| `hpack.js`, `hpack-tables.js` | HPACK (RFC 7541): integers, Huffman strings, the static table and a dynamic table per direction, sized by the receiver's SETTINGS. The tables are generated from Go's standard library source, not typed |
| `h2.js` | HTTP/2 (RFC 7540) on one connection: frames, padding, CONTINUATION, PUSH_PROMISE (decoded, to keep HPACK in step), RST_STREAM, trailers, interim responses; streams become transactions in the same shape as HTTP/1's, with `:authority` as the `host` header and `stream` set. A hole inside a DATA payload costs the body; a hole across a frame boundary loses the HPACK state, so the connection is declared opaque and its open streams cut |
| `decoder.js` | one entry per connection, keyed by pid and the tap's connection id; decides which side the process is on from the first bytes; runs a request parser on one direction and a response parser on the other and pairs them in order, pipelined or not; emits a **transaction** |

A transaction carries who (pid, role, transport, flow), what (method,
target, `Host`, request headers, status, response headers), the bodies
(length, bytes kept up to `bodyLimit`, holes), kernel timestamps for
request start, response start and end, and `complete`/`cut` saying
whether it was seen whole or how it was lost.

What the decoder knows about its input, and does about it:

- **Records arrive out of order.** The loader hands a ring's records
  over with the head of a response sometimes behind its body, tens of
  microseconds apart. Records wait in a window sorted by kernel
  timestamp (`reorderMs`, 20 by default) and are fed once later
  timestamps have been seen, or once `tick()` finds them aged out.
- **Holes are known.** A record says how long its call was and how much
  was copied; the difference is a gap. A gap inside a body of known
  length costs only the bytes (`holes` on the body); a gap across a
  head loses the framing, everything in flight is flushed as
  `cut: "desync"`, and both parsers restart at the next call boundary —
  the next call a client makes begins a request.
- **First bytes label the connection.** HTTP/1 in either direction
  (a request the process wrote makes it the client), the HTTP/2 preface
  (`h2`: handed to h2.js), a TLS record (`tls`: the socket tap
  seeing ciphertext, whose plaintext arrives under the TLS tap's own
  id), or `other` after a few tries. The connection table
  (`connections()`) says why a connection shows no transactions.
- **A `struct sock` address comes back.** The 4-tuple on each TCP record
  tells a reused address from the old connection; the old one is closed
  and what it had in flight is reported cut.
- **The inventory closes connections.** `close(key)` finishes a body
  that ran to the close and cuts the rest; `sweep(idleMs)` does that for
  connections that went quiet.

```sh
npm test                                               # h1 parser, decoder, loopback
yeet run scripts/selftest-decode.js -- --port 8089     # socket tap → decoder, then curl a local server
yeet run scripts/selftest-decode.js -- --port 8089 --tls /usr/lib/libssl.so.3   # plus the TLS taps
yeet run scripts/selftest-decode.js -- --tls-pid <pid> --raw --body             # every record, and bodies
```

Verified here: curl and a python `http.server` on loopback (GET, 404,
HEAD, POST, both the client's and the server's side of each), curl over
TLS with `--http1.1` (GET, POST with a JSON body, a chunked streaming
response), python urllib over TLS (`ssl_ex`), and curl's default HTTP/2
over TLS (GET and a JSON POST, bodies intact). HPACK is tested against
RFC 7541's Appendix C vectors and the HTTP/2 layer against a real h2c
exchange through Node's own `http2` module, captured at a relay.

Bodies are kept as sent, up to `bodyLimit` (1 MiB; the rest is counted
and the body marked truncated); layer 3 inflates compressed ones.

## Layer 1: probes

Two kinds of source, one record type.

**Capture** is eBPF. Every tap emits the same `data_event` — pid, tid, an
opaque connection id, direction, the bytes — so one decoder serves all of
them (`bpf/include/events.h`).

| object | boundary | how |
|---|---|---|
| `bin/wire.bpf.o` | TCX ingress + egress on every interface, `lo` included | **The byte source.** Every TCP segment as it crosses a device, with its sequence number, up to a 64 KiB GSO super-segment. Sees bodies sent by `sendfile`/`splice`, which never pass `tcp_sendmsg`. No process context there, so no pid: the inventory attributes a flow by its 4-tuple (`app/lib/probes/attribute.js` — a live socket, else the listener on that port), and the host puts segments back into a stream (`app/lib/http/tcp.js`). Filtered in the kernel by port or capture-all. Interfaces are listed to the daemon explicitly, because its wildcard attach skips loopback. |
| `bin/socket.bpf.o` | `tcp_sendmsg` / `tcp_recvmsg` | Kept as an alternative. fentry/fexit, kernel-global. Sees what is plaintext on the wire: port 80, localhost, anything behind a TLS-terminating proxy. Carries the 4-tuple and, on a read, the recvmsg flags (so a `MSG_PEEK` is not counted twice). Filtered **in the kernel** by pid, port, or capture-all; an unarmed tap emits nothing. |
| `bin/ssl.bpf.o` | `SSL_read` / `SSL_write` | uprobes. Node, curl, Rust native-tls, most C. |
| `bin/ssl_ex.bpf.o` | `SSL_read_ex` / `SSL_write_ex` | uprobes. CPython and anything on OpenSSL 1.1.1+'s `_ex` API. |
| `bin/gotls.bpf.o` | `crypto/tls.(*Conn).Write` | Go register ABI (`bpf/include/goabi.h`). Attached by raw file offset from the binary's `.gopclntab`, so a stripped binary works. |
| `bin/gotls_read.bpf.o` | `crypto/tls.(*Conn).Read` | uprobes at each RET of the function, never a uretprobe: Go's stack copier dies on a uretprobe trampoline (observed on go1.27). The RET sites come from pclntab's per-PC stack-delta table (`app/lib/probes/gopclntab.js`, pure JS, no binutils). Entry and return keyed by the `g` pointer, so no per-version goid offset. |
| `bin/rustls.bpf.o` | `PlaintextSink::write`, `CommonState::take_received_plaintext` | uprobes matched by **regex** against demangled names, since rustls symbols carry a per-build hash. |
| `bin/walk.bpf.o` | `raw_tp/tcp_probe` | **The kernel's view.** Not a capture: a once-verified interpreter that runs a small op program per field — patched in from a query, never reloaded — over the socket and the skb of every delivered segment. What it reads is decided at query time from this kernel's BTF (below). |

The TLS taps share `bpf/include/tap.h`: the ring buffers, a live focus
filter (one connection and/or one pid), and the correlation that finds a
TLS connection's socket — the thread that just entered `SSL_write` is the
thread about to call `tcp_sendmsg`, so an fentry there binds the SSL
pointer to the socket and emits a `peer_event` once per connection.

Each tap is its own loadable object because `start()` rejects an object
with any unattached uprobe: a target offers some subset of these
boundaries, so they attach independently and best-effort. Every
`bpf/<name>/` directory links to `bin/<name>.bpf.o` (`build/bpf.mk`).

**Reassembly** (`app/lib/http/tcp.js`, pure) turns wire segments into
the decoder's stream records: one flow per 4-tuple, oriented at its
first packet (the SYN sender is "the process"; the decoder then reads
the first bytes and knows client from server), each direction ordered by
sequence number. Retransmits are dropped, overlaps trimmed, out-of-order
segments wait `holdMs` (200) for the bytes before them and then become
a hole the decoder is told about. FIN both ways or RST closes the flow
and the decoder's connection with it; a fresh SYN on a live 4-tuple is a
reused port. The ring's own reordering falls out of this for free — a
late lower-sequence record is simply the segment the stream was waiting
for. Verified here over the Wi-Fi interface (GET, POST, chunked stream,
a 100 KB body, each attributed to its curl or python pid) and over
loopback (GET, 404, HEAD, POST, python urllib, a 400 KB body — all
reassembled with no holes, the server attributed through its listener).

```sh
yeet run scripts/selftest-wire.js -- --port 80 [--tls /usr/lib/libssl.so.3] [--raw] [--body]
yeet run scripts/selftest-wire.js -- --all       # everything but the tool's own ports
```

The kernel-side counters the self-test prints (`ingress`, `egress`,
`lo`, `parsed`, `matched`, `emitted`, `ringFull`) say whether the tap is
alive before any decoding happens. `lo: 0` after loopback traffic is how
the daemon's loopback skip was found: its wildcard attach leaves `lo`
out (believing TCX returns `EINVAL` there — it does not, on 7.2), and
the installed client predates the `ifindex` sugar, so `attachWire`
enumerates `network_interfaces` from the graph and passes the daemon
its own `net: { handle, ifindex }` shape.

**Inventory** is the system graph, no kernel code: `tcp`/`tcp6` joined to
each process's socket fds on inode gives every connection and listener
with its pid and comm (`app/lib/probes/conns.js`). It sees what was open
before the tool started; a connection shorter than one poll is still
captured by the tap with full attribution.

**Discovery** of where a pid's TLS symbols live is also the graph: a
mapped `libssl` wins, else the exe, both reached through
`/proc/<pid>/root` so containers work (`app/lib/probes/discover.js`).

### The walk VM: the kernel's view

`segments` is the one query root that is not answered from captured
bytes. It runs on `bin/walk.bpf.o`, an interpreter attached to
`raw_tp/tcp_probe` — the tracepoint in `tcp_rcv_established` that fires
for every segment an established flow receives, with the socket and the
skb in hand. The program does not know any struct's layout. It runs, per
field, up to sixteen ops (`base`, `off`, `deref`, `read`, `str`, scratch
arithmetic, forward skips) from an array map, and the ops are written by
the host for each query:

```
{ segments(select: ["cwnd", "srtt", "inflight: tcp.snd_nxt - tcp.snd_una",
                    "iface: sock.sk_dst_cache.dev.name", "req: payload(0, 80, text)"],
           ports: [443], data: true, limit: 20, ms: 3000) { t comm daddr values } }
```

`app/lib/walk/compile.js` turns each entry into ops through `yeet:btf`:
`walk("sock", "sk_dst_cache.dev.name")` answers, on the running kernel,
with the hops a bounded interpreter takes to reach that member — a
pointer crossed is `off` + `deref`, the terminal is `off` + `read` — so
there is no table of offsets in the tree, no closure of supported
structs, and no depth limit but the op budget (a pointer costs two).
The member's type decides how its bytes read back, also from BTF: an
int's signedness, a `__be16`/`__be32` typedef (a port, an address), an
enum's names, a `char[]`, a bitfield's position, `struct in6_addr`; a
query overrides with `(kind)`. This is what tcpwalk2 does with a
54 KB schema table rendered at build time from one kernel's BTF — a
table that, checked here, had `snd_cwnd` forty bytes from where this
kernel keeps it. The kernel side is derived from tcpwalk2's VM with
one structural change: every op runs as a `bpf_loop` step, so the
verifier walks the dispatch once per call site instead of once per
slot per section per field, which on this kernel was the difference
between a million-instruction rejection and a load.

The event carries the socket's 4-tuple, state and the segment's
sequence number and lengths, read through CO-RE in a fixed prologue,
so the host joins a row to the inventory (pid, comm, the peer) without
spending a field. `payload(offset, len)` is the segment's application
bytes: the prologue finds where the TCP header ends and hands that
address to the ops as a register. Only the skb's linear head is
readable there, and on this box neither loopback nor the wifi driver
keeps payload in it (header split; the row's `linear` says how much
there was) — so a window the head could not serve is filled from the
wire tap's copy of the same packet, matched by flow and sequence number
(`app/lib/walk/join.js`), which is where the `values` in the example
above come from. `plan(select: […])` shows the ops without running;
`struct(name: "tcp_sock")` lists a struct's members from BTF. Filters
run in the kernel: `ports`, `data: true` (skip bare ACKs), `everyMs`
(one event per interval at most, since the tracepoint fires per
segment). One program runs at a time; a query holds the VM for `ms`.

### Build and self-test

```sh
make bpf                                   # every bin/*.bpf.o, vmlinux.h from this kernel
yeet run scripts/selftest-conns.js         # the inventory, as a table
yeet run scripts/selftest-socket.js -- --port 8080     # then curl a local server
yeet run scripts/selftest-tls.js -- --bin /usr/lib/libssl.so.3   # then curl https://…
yeet run scripts/selftest-tls.js -- --pid <pid>                  # resolves the binary itself
yeet run scripts/selftest-tls.js -- --bin ./gobin --go "$(node scripts/go-rets.mjs ./gobin)"
yeet run scripts/selftest-walk.js -- --ports 8093 --data --select "cwnd, srtt, req: payload(0, 80, text)"
```

Verified here (kernel 7.2, x86_64): curl over HTTP/2 (`ssl`), Python
urllib (`ssl_ex`), a Go net/http client both directions (`gotls`,
`gotls_read`, including a `strip -s` copy), a rustls client both directions (`rustls`), and a
python `http.server` exchange on loopback (`socket`). Arch's node links
libssl dynamically, so it is covered by the `libssl` attach.

Two lessons from layer 2's first run against this tap, both now fixed
in `bpf/socket/socket.bpf.c`: the receive side must start at the
iterator's `iov_offset` (one syscall can reach `tcp_recvmsg` twice with
the same `msghdr`, the second round landing after the first), and the
`int` return arrives zero-extended, so `-EAGAIN` read as a huge count
until it was cast back. Both produced a record holding whatever the
buffer held before — a response head where curl's body should be.

### Build requirements and portability

- **Toolchain**: `make bpf` fetches a pinned static clang and bpftool
  for x86_64 or aarch64 (`build/toolchain.mk`), and generates
  `bpf/include/vmlinux.h` from the build host's kernel BTF. Build on the
  architecture you run on, as CO-RE projects do.
- **Kernel header version**: the wire tap and every TLS tap compile
  against any recent `vmlinux.h`. The legacy socket tap
  (`bpf/socket`) names `iov_iter.__iov` and `ITER_UBUF`, which exist
  from kernel 6.4 — on an older build host it does not compile, and it
  is not needed: the wire tap is the byte source.
- **Architectures**: x86_64 is what runs here. For aarch64 the
  arch-specific pieces are `goabi.h` (Go's register ABI: X0… for
  arguments, X28 for `g`), the RET encoding `gopclntab.js` checks
  (`d65f03c0`), and `bpf_tracing.h`'s `PT_REGS_*` behind
  `-D__TARGET_ARCH_arm64`. Verified here without an arm64 machine:
  every object except the socket tap compiles for arm64 against a real
  arm64 kernel's BTF (Ubuntu 20.04, 5.8), and `go-rets.mjs` on a
  cross-compiled arm64 Go TLS client finds seven return sites for
  `crypto/tls.(*Conn).Read`, each at a real `RET`. Loading and running
  on arm64 has not been exercised.
- **Clean clone**: `git clone`, `npm install`, `make bpf`, `npm test`,
  `npx yeetkit build` all pass from a fresh checkout on this box. The
  yeetkit dependency is by absolute path for now.
- **Kernel matrix**: `.github/workflows/kernel-matrix.yml` (the one
  `yeet new` scaffolds, adapted to this repo's per-directory objects)
  builds every `bin/*.bpf.o` on the runner, boots 6.6, 6.12, 6.18, 7.2
  and bpf-next under cilium's little-vm-helper, and runs the vendored
  static veristat in each VM via `build/verify-kernel.sh`. The summary
  is a grid of (object, program) × kernel, since
  `peer_sendmsg`/`peer_recvmsg` recur across the TLS taps. The floor is
  6.6: 6.1 refuses the wire tap's TCX attach type at load, and every
  other object loads there (the socket tap's `iov_iter` reads are CO-RE
  guarded, so the 6.4 note above is for the build host only). The first
  run also caught the 6.6 verifier rejecting the wire tap's
  `bpf_skb_load_bytes` size as possibly zero, since a verifier before
  6.9 does not narrow a register on a `!= 0` branch; the bound is now
  rebuilt by arithmetic. bpf-next runs but does not gate: on 7.3-rc4 the
  walk VM's `bpf_loop` callbacks cost 850k verifier instructions against
  14k on 6.12 and hit the one-million limit. `make veristat-matrix` runs the same thing
  locally with lvh + a static qemu (Linux, KVM, root for the VM), and
  `make veristat` is the single-kernel check against this host.

### Known limits

- Capture is per call, up to 8 × 4095 bytes; a larger call is reported
  with a hole (`off + cap_len < len` on its last record) and the decoder
  resyncs.
- `sendfile`/`splice` bodies never pass through `tcp_sendmsg`; the wire
  tap sees them.
- The wire tap attaches to the interfaces that exist when it starts;
  one that appears later (a new veth) is not covered until re-attach.
- A wire flow's client end is named only if its socket is still in the
  inventory when the flow opens; a connection that lives a few
  milliseconds shows as `remote`. The server end is named through its
  listener regardless. A small fentry on `tcp_sendmsg` emitting
  (pid, 4-tuple) once per socket would close the gap.
- The TLS↔socket correlation is a heuristic on event-loop runtimes; the
  decoder's `Host` header is the authority for naming a service.
- The walk VM is receive-side (`tcp_probe` fires as a peer's segment
  arrives), reads eight fields of sixteen ops per segment, and holds
  one program at a time: concurrent `segments` queries run in turn.
  `skb->dev` is already NULL there; the route's device is
  `sock.sk_dst_cache.dev`. Pointer chases read live kernel memory with
  no lock, so a value can be a stale or torn read, never a crash.
- HTTP/2 is decoded when its plaintext is seen (the TLS taps, or h2c on
  the wire). Server push is followed; HTTP/3 (QUIC) is not seen at all.
