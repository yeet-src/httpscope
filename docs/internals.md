# httpscope internals

How `httpscope` is built, layer by layer, and how to build and test it. For installing and using it, see the [README](../README.md).

## Contents

[The pipeline](#the-pipeline) · [Layer 1: probes](#layer-1-probes) · [Layer 2: decode](#layer-2-decode) · [Layer 3: model](#layer-3-model) · [Layers 4 and 5: query and API](#layers-4-and-5-query-and-api) · [The walk VM](#the-walk-vm-the-kernels-view) · [Building and self-tests](#building-and-self-tests) · [Known limits](#known-limits-of-the-internals) · [Testing across kernels](#testing-across-kernels)

## The pipeline

Six layers, bottom up. Every layer below the UI is plain JavaScript or BPF C, and layers 2 and 3 have no `yeet:*` imports, so `npm test` runs them under Node.

| # | layer | where | does |
| --- | --- | --- | --- |
| 1 | **probes** | `bpf/`, `app/lib/probes/` | kernel taps and the connection inventory; the wire tap (TCX) is the byte source |
| 2 | **decode** | `app/lib/http/` | bytes per connection → HTTP/1.x and HTTP/2 transactions |
| 3 | **model** | `app/lib/model/` | transactions → services, endpoints, shapes, drift |
| 4 | **query** | `app/lib/query/` | the GraphQL agents send, with filters, directives and a JS tail |
| 5 | **API** | `app/api/`, `app/lib/scope.js` | `GET /api`, `POST /api/query`, and the pipeline behind them |
| 6 | **UI** | `app/**/page.jsx` | Solid rendered in the isolate and patched over the socket |

**`app/lib/scope.js`** (`"use yeet"`) is the app itself: started on the isolate's first frame and kept for its life. It attaches the wire tap to every interface with capture-all (minus the app's own ports), runs reassembler → decoder → model, refreshes the inventory every second for attribution, and attaches TLS taps **to binaries, not pids**. At start every `libssl` mapped by anyone and every executable of a runtime known to carry its own TLS (Node, Deno, Bun) is attached; after that, a TLS flow on the wire from a process whose binary is not yet tapped triggers one more. A binary with no TLS boundary is remembered as failed. The pages call it as plain functions in the same process, once a second, except drift, which is an async generator that pushes each event the tick it happens.

### Layer 1: probes

Every tap emits the same `data_event` (pid, tid, an opaque connection id, direction, the bytes), so one decoder serves all of them (`bpf/include/events.h`).

| object | boundary | how |
| --- | --- | --- |
| `bin/wire.bpf.o` | TCX ingress and egress on every interface, `lo` included | **The byte source.** Every TCP segment as it crosses a device, with its sequence number, up to a 64 KiB GSO super-segment. Sees bodies sent by `sendfile`/`splice`, which never pass `tcp_sendmsg`. No process context there, so the inventory attributes a flow by its 4-tuple (`app/lib/probes/attribute.js`: a live socket, else the listener on that port). Filtered in the kernel by port or capture-all. Interfaces are listed to the daemon explicitly, because its wildcard attach skips loopback. |
| `bin/socket.bpf.o` | `tcp_sendmsg` / `tcp_recvmsg` | Kept as an alternative. fentry/fexit, filtered in the kernel by pid, port or capture-all; carries the 4-tuple and, on a read, the recvmsg flags, so a `MSG_PEEK` is not counted twice. |
| `bin/ssl.bpf.o` | `SSL_read` / `SSL_write` | uprobes. Node, curl, Rust native-tls, most C. |
| `bin/ssl_ex.bpf.o` | `SSL_read_ex` / `SSL_write_ex` | uprobes. CPython and anything on OpenSSL 1.1.1+'s `_ex` API. |
| `bin/rustls.bpf.o` | `PlaintextSink::write`, `CommonState::take_received_plaintext` | uprobes matched by **regex** against demangled names, since rustls symbols carry a per-build hash. |
| `bin/gotls.bpf.o` | `crypto/tls.(*Conn).Write` | Go register ABI (`bpf/include/goabi.h`), attached by raw file offset from the binary's `.gopclntab`, so a stripped binary works. Self-test only for now; see [What it can't see](../README.md#what-it-cant-see). |
| `bin/gotls_read.bpf.o` | `crypto/tls.(*Conn).Read` | uprobes at each `RET` of the function, never a uretprobe: Go's stack copier dies on a uretprobe trampoline (observed on go1.27). The `RET` sites come from pclntab's per-PC stack-delta table (`app/lib/probes/gopclntab.js`, pure JS). Self-test only. |
| `bin/walk.bpf.o` | `raw_tp/tcp_probe` | **The kernel's view.** Not a capture: a once-verified interpreter that runs a small op program per field, patched in from a query and never reloaded, over the socket and skb of every delivered segment. See [The walk VM](#the-walk-vm-the-kernels-view). |

The TLS taps share `bpf/include/tap.h`: the ring buffers, a live focus filter (one connection and/or one pid), and the correlation that finds a TLS connection's socket. The thread that just entered `SSL_write` is the thread about to call `tcp_sendmsg`, so an fentry there binds the SSL pointer to the socket and emits a `peer_event` once per connection. Each tap is its own object because the daemon rejects an object with any unattached uprobe, and a binary offers some subset of these boundaries, so they attach independently and best-effort.

**Reassembly** (`app/lib/http/tcp.js`) turns wire segments into stream records: one flow per 4-tuple, each direction ordered by sequence number. Retransmits are dropped, overlaps trimmed, and out-of-order segments wait 200 ms for the bytes before them and then become a hole the decoder is told about. FIN both ways or RST closes the flow; a fresh SYN on a live 4-tuple is a reused port.

**Inventory** is the system graph, no kernel code: `tcp`/`tcp6` joined to each process's socket fds on inode gives every connection and listener with its pid and comm (`app/lib/probes/conns.js`). It sees what was open before the tool started.

<details>
<summary>How the daemon's loopback skip was found, and two socket-tap bugs it took to get bodies right</summary>

The kernel-side counters the wire self-test prints (`ingress`, `egress`, `lo`, `parsed`, `matched`, `emitted`, `ringFull`) say whether the tap is alive before any decoding happens. `lo: 0` after loopback traffic is how the daemon's loopback skip was found: its wildcard attach leaves `lo` out (believing TCX returns `EINVAL` there; it does not, on 7.2), so `attachWire` enumerates `network_interfaces` from the graph and passes the daemon its own `net: { handle, ifindex }` shape.

Two lessons from the decoder's first run against the socket tap, both fixed in `bpf/socket/socket.bpf.c`: the receive side must start at the iterator's `iov_offset` (one syscall can reach `tcp_recvmsg` twice with the same `msghdr`, the second round landing after the first), and the `int` return arrives zero-extended, so `-EAGAIN` read as a huge count until it was cast back. Both produced a record holding whatever the buffer held before: a response head where curl's body should be.

</details>

### Layer 2: decode

`app/lib/http/` turns layer 1's records into transactions. Pure JavaScript, no `yeet:*` imports.

| file | does |
| --- | --- |
| `bytes.js` | a byte queue a parser eats from the front; Latin-1 and UTF-8 by hand (the isolate has no `TextDecoder`); a bounded body capture that keeps counting past its limit |
| `h1.js` | one direction's messages: start line, headers, and the body framing of RFC 7230 §3.3.3 (content-length, chunked with trailers kept, until-close, and none for 1xx/204/304/HEAD); `CONNECT` and `101` make the rest of the direction opaque |
| `hpack.js`, `hpack-tables.js` | HPACK (RFC 7541): integers, Huffman strings, the static table and a dynamic table per direction. The tables are generated from Go's standard library source, not typed |
| `h2.js` | HTTP/2 (RFC 7540) on one connection: frames, padding, CONTINUATION, PUSH_PROMISE, RST_STREAM, trailers, interim responses; streams become transactions in the same shape as HTTP/1's, with `:authority` as the `host` header |
| `decoder.js` | one entry per connection; decides which side the process is on from the first bytes; pairs requests and responses in order, pipelined or not; emits a **transaction** |

A transaction carries who (pid, role, transport, flow), what (method, target, `Host`, headers, status), the bodies (length, bytes kept up to 1 MiB, holes), kernel timestamps for request start, response start and end, and `complete`/`cut` saying whether it was seen whole or how it was lost.

<details>
<summary>What the decoder knows about its input</summary>

- **Records arrive out of order.** The loader hands a ring's records over with the head of a response sometimes behind its body, tens of microseconds apart. Records wait in a window sorted by kernel timestamp (`reorderMs`, 20 by default) and are fed once later timestamps have been seen, or once `tick()` finds them aged out.
- **Holes are known.** A record says how long its call was and how much was copied; the difference is a gap. A gap inside a body of known length costs only the bytes (`holes` on the body); a gap across a head loses the framing, everything in flight is flushed as `cut: "desync"`, and both parsers restart at the next call boundary.
- **First bytes label the connection.** HTTP/1 in either direction (a request the process wrote makes it the client), the HTTP/2 preface (`h2`), a TLS record (`tls`: ciphertext, whose plaintext arrives under the TLS tap's own id), or `other` after a few tries. The connection table says why a connection shows no transactions.
- **A `struct sock` address comes back.** The 4-tuple on each record tells a reused address from the old connection; the old one is closed and what it had in flight is reported cut.
- **The inventory closes connections.** `close(key)` finishes a body that ran to the close and cuts the rest; `sweep(idleMs)` does that for connections that went quiet.
- **A hole across an HTTP/2 frame boundary loses the HPACK state**, so the connection is declared opaque and its open streams cut. A hole inside a DATA payload costs only the body.

</details>

### Layer 3: model

`app/lib/model/` turns transactions into the APIs a machine speaks.

| file | does |
| --- | --- |
| `path.js` | a request target → templated segments and query; query values get a kind (`int`, `bool`, `uuid`, `list`, …) |
| `schema.js` | the shape of JSON, learned from samples: types, keys with presence counts (optional when absent from some sample), array items, enumerations for few distinct strings. `diff()` says what a value would change |
| `stats.js` | a latency reservoir with percentiles, a recent-window ring, bounded counters |
| `model.js` | **services** (the `Host` called, or answered as; else the peer), their **endpoints** (method × template), each with status counts, latency, query parameters, headers, content types, request body shape and a response body shape per status, who called and who served; and **drift** |

Bodies are parsed when complete, up to 8 MiB inflated. A compressed one (gzip, deflate, br, zstd, stacked or not) is inflated through `yeet:compression`, which is native; without it the model counts the body under its encoding instead.

### Layers 4 and 5: query and API

The routes run in Node, which holds the HTTP listener; the pipeline they ask runs in the isolate. `app/lib/query/` is a GraphQL schema over the model, executed with the `graphql` package against `Model.snapshot()`, the plain-data form the isolate hands over. GraphQL rather than a language of its own, because the system graph already speaks it: an agent learns one language for the box and for the APIs the box speaks, and gets introspection, validation and standard errors for free.

| file | does |
| --- | --- |
| `schema.js` | the SDL: `summary`, `services` (with `stats` aggregates), `endpoints`, `endpoint`, `drift`, `transactions`, and the kernel's view: `segments`, `plan`, `struct` |
| `query.js` | `execute(snapshot, source, { variables, loaders })` → `{ data, errors }`; `check(source)` validates without running. The mapping from rows to types, derived metrics, `where`, `orderBy`, directives and the tail |
| `filter.js` | the `Num`/`Str` comparisons and the transaction filter, with no `graphql` dependency, so the isolate filters its ring with the same code |

### The walk VM: the kernel's view

`segments` is the one query root not answered from captured bytes. It runs on `bin/walk.bpf.o`, an interpreter attached to `raw_tp/tcp_probe`, the tracepoint in `tcp_rcv_established` that fires for every segment an established flow receives, with the socket and the skb in hand. The program knows no struct's layout. Per field it runs up to sixteen ops (`base`, `off`, `deref`, `read`, `str`, scratch arithmetic, forward skips) from an array map, written by the host for each query:

```graphql
{ segments(select: ["cwnd", "srtt", "inflight: tcp.snd_nxt - tcp.snd_una",
                    "iface: sock.sk_dst_cache.dev.name", "req: payload(0, 80, text)"],
           ports: [443], data: true, limit: 20, ms: 3000) { t comm daddr values } }
```

`app/lib/walk/compile.js` turns each entry into ops through `yeet:btf`: `walk("sock", "sk_dst_cache.dev.name")` answers, on the running kernel, with the hops a bounded interpreter takes to reach that member. So there is no table of offsets in the tree, no list of supported structs, and no depth limit but the op budget. The member's type decides how its bytes read back, also from BTF: an int's signedness, a `__be16`/`__be32` (a port, an address), an enum's names, a `char[]`, a bitfield, `struct in6_addr`. `plan(select: […])` shows the ops without running; `struct(name: "tcp_sock")` lists a struct's members.

The event carries the socket's 4-tuple, state, and the segment's sequence number and lengths, so a row joins the inventory (pid, comm, peer) without spending a field. `payload(offset, len)` is the segment's application bytes; where the skb's linear head doesn't hold them (loopback and many drivers split headers), the window is filled from the wire tap's copy of the same packet, matched by flow and sequence number (`app/lib/walk/join.js`). Filters run in the kernel: `ports`, `data: true` (skip bare ACKs), `everyMs`. One program runs at a time; a query holds the VM for `ms`.

<details>
<summary>Why the VM's state lives in a per-CPU map, and what it replaced</summary>

This is what tcpwalk2 does with a 54 KB schema table rendered at build time from one kernel's BTF, a table that, when checked, had `snd_cwnd` forty bytes from where the test kernel kept it. The kernel side is derived from tcpwalk2's VM with two structural changes. Every op runs as a `bpf_loop` step, so the verifier walks the dispatch once per call site instead of once per slot per section per field. And the VM's mutable state lives in a one-element per-CPU array, not on the stack, with the callbacks reaching it by lookup and only the event pointer riding on the stack as the callback context.

A callback loop is verified once only when its entry state converges with an earlier one, and the verifier does not track map memory, so nothing the ops do can tell one iteration from the last. With the state on the stack, the 7.2.7 verifier backports left the object simulating every one of its 8 × 16 × 8 nested iterations and hitting the million-instruction limit; with it in the map, the whole object verifies in under 5k instructions on every kernel in the matrix.

</details>

## Known limits of the internals

These sit below the user-facing list in the README's [What it can't see](../README.md#what-it-cant-see).

- **Which TLS connection is which socket, for certain.** On event-loop runtimes the TLS-to-socket correlation is a heuristic; the decoded `Host` header is the authority for naming a service.
- **The wire tap's segment size.** It copies up to a 64 KiB GSO super-segment per packet; reassembly turns anything missing into a hole the decoder is told about.
- **The walk VM.** It is receive-side (`tcp_probe` fires as a peer's segment arrives), reads eight fields of sixteen ops per segment, and holds one program at a time, so concurrent `segments` queries run in turn. `skb->dev` is already NULL there; the route's device is `sock.sk_dst_cache.dev`. Pointer chases read live kernel memory with no lock, so a value can be stale or torn, never a crash.

## Building and self-tests

```sh
make bpf              # every bin/*.bpf.o, and bpf/include/vmlinux.h from this kernel
make veristat         # load each object and let this kernel's verifier judge it (needs sudo)
make clean-bpf        # remove bin/*.bpf.o, .build/ and the generated vmlinux.h
npm test              # decode, model and query layers under Node, including a real loopback exchange
```

`make bpf` fetches a pinned static clang and bpftool for x86_64 or aarch64 into a per-machine cache under `~/.cache/yeet/toolchain` (`build/toolchain.mk`), generates `vmlinux.h` from the build host's BTF, and links each `bpf/<name>/` directory into its own `bin/<name>.bpf.o` (`build/bpf.mk`). Build on the architecture you run on. The legacy socket tap names `iov_iter.__iov` and `ITER_UBUF`, which exist from 6.4, so it does not compile on an older build host; it is not needed, since the wire tap is the byte source.

Each layer has a self-test that runs under yeet without the app:

```sh
yeet run scripts/selftest-conns.js                                # the inventory, as a table
yeet run scripts/selftest-wire.js -- --port 80 [--tls /usr/lib/libssl.so.3] [--raw] [--body]
yeet run scripts/selftest-wire.js -- --all                        # everything but the tool's own ports
yeet run scripts/selftest-socket.js -- --port 8080                # then curl a local server
yeet run scripts/selftest-tls.js -- --bin /usr/lib/libssl.so.3    # then curl https://…
yeet run scripts/selftest-tls.js -- --pid <pid>                   # resolves the binary itself
yeet run scripts/selftest-tls.js -- --bin ./gobin --go "$(node scripts/go-rets.mjs ./gobin)"
yeet run scripts/selftest-decode.js -- --port 8089 [--tls /usr/lib/libssl.so.3]
yeet run scripts/selftest-model.js -- --port 8089,80 [--dump]     # drift live, endpoint table at the end
yeet run scripts/selftest-walk.js -- --ports 8093 --data --select "cwnd, srtt, req: payload(0, 80, text)"
node scripts/render.mjs / [--port 3000] [--ms 3000]               # a page as text, headless, through the hub
node scripts/query.mjs snapshot.json '{ services { name transactions servers } }'
```

<details>
<summary>What has been run by hand, and where</summary>

On x86_64 with kernel 7.2: curl over HTTP/2 (`ssl`), Python urllib (`ssl_ex`), a Go net/http client both directions (`gotls`, `gotls_read`, including a `strip -s` copy), a rustls client both directions (`rustls`), and a Python `http.server` exchange on loopback (`socket`). The wire tap over Wi-Fi (GET, POST, a chunked stream, a 100 KB body, each attributed to its curl or Python pid) and over loopback (GET, 404, HEAD, POST, Python urllib, a 400 KB body, all reassembled with no holes). HPACK is tested against RFC 7541's Appendix C vectors and the HTTP/2 layer against a real h2c exchange through Node's own `http2` module. The model against a local `http.server` (`/users/{n}` with typed query parameters and an `email?` field seen in one of six responses, `/api/{*}` collapsed from ten names) and httpbin and example.com over Wi-Fi, including httpbin's `/gzip` and `/brotli` responses, inflated. The live API: a `where` on the `authorization` header over `WIRE` found plaintext credentials, a field typo was answered with GraphQL's own "Did you mean" error and a 400.

On arm64 with kernel 6.12 (Debian 13), the full app: the wire tap on 19 interfaces including Docker bridges and veths, `libssl` and Node attached, a Dockerised Node gateway's endpoints, statuses and a `status.new` drift event decoded and attributed.

</details>

## Testing across kernels

A BPF program that loads on your laptop can be rejected by an older kernel's verifier. `sudo make veristat` checks every object against the kernel you are on; that `sudo` is correct, since it loads programs directly rather than through the yeet daemon.

`.github/workflows/kernel-matrix.yml` builds every `bin/*.bpf.o` once, boots 6.6, 6.12, 6.18, 7.2 and bpf-next under cilium's little-vm-helper, runs a static veristat in each VM via `build/verify-kernel.sh`, and pivots the results into one grid of (object, program) × kernel. bpf-next runs but does not gate. `make veristat-matrix` runs the same thing locally on Linux with KVM. The matrix proves each program verifies, which is not the same as attaching.

<details>
<summary>What the matrix caught</summary>

The first run caught the 6.6 verifier rejecting the wire tap's `bpf_skb_load_bytes` size as possibly zero, since a verifier before 6.9 does not narrow a register on a `!= 0` branch; the bound is now rebuilt by arithmetic. The second catch was the walk VM: on 7.2.6 it verified in 14k instructions, but stable 7.2.7 backported a batch of verifier precision fixes for `bpf_loop` callbacks, after which the 7.2.8 image and bpf-next ran it to the one-million limit. Moving the VM's state into a per-CPU map brought it under 5k everywhere.

</details>
