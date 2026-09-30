/* The walk VM: a once-verified interpreter over the kernel's own view
 * of each delivered TCP segment.
 *
 * `raw_tp/tcp_probe` fires in tcp_rcv_established for every segment an
 * established flow receives, with the socket and the skb in hand. This
 * program does not know what to read from them: it runs a small op
 * program per field, patched into the `programs` map from JS while it
 * runs, that moves a cursor through kernel memory (offset, dereference)
 * and copies a terminal value out. The op stream is the data, so a new
 * question — a different struct member, a pointer chased into another
 * object, a window of the packet's bytes — is a map update, never a
 * reload, and the verifier judged the program once.
 *
 * The host decides the ops from BTF (yeet:btf resolves a member path
 * into deref/load hops on the running kernel, app/lib/walk/compile.js
 * turns those into ops), so nothing here knows any struct's layout —
 * except the fixed flow prefix: the socket's 4-tuple, family and state
 * are read through CO-RE into every event, so the host can join a row
 * to the flow the wire tap already attributed without spending any of
 * the eight fields on it.
 *
 * A field is three sections, which gives the VM bounded iteration
 * without a backward jump the verifier would reject:
 *   pre[]     straight-line ops that leave `cur` at a chain head
 *   next_off  byte offset of the "next" pointer within a node (0 = scalar)
 *   body[]    straight-line ops run per node, from that node's address,
 *             whose terminal read emits one list entry
 *
 * tcp_probe is receive-side: a segment this host sends is not seen
 * here, only the flow's state as its peer's segments arrive. The
 * tracepoint fires per segment, so a bulk transfer is throttled to one
 * event per `min_gap_ns` or the ring would drown the isolate.
 *
 * Derived from tcpwalk2's VM (github.com/yeet-src/tcpwalk2); the op set
 * is the same, so its programs are valid here.
 */

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

char LICENSE[] SEC("license") = "GPL";

#define AF_INET  2
#define AF_INET6 10

#define MAX_FIELDS 8
#define MAX_STEP   8   /* ops per pre[] / body[] section */
#define MAX_ITERS  16  /* nodes visited per loop field */
#define ENTRY_CAP  256 /* bytes captured per entry; a power of two */
#define NREGS      8
#define NSCRATCH   4   /* writable scratch registers %s0..%s3; a power of two */

/* WOP_READ copies memory at `cur` out; WOP_VAL copies `cur` itself, for
 * a computed value. WOP_LOADN pulls an N-byte scalar at `cur` INTO
 * `cur`, WOP_EQ sets cur = (cur == arg), and WOP_SKIPZ/WOP_SKIPNZ skip
 * the next `arg` ops on cur zero / non-zero — a forward skip within the
 * unrolled loop, never a backward jump. STORE/LOAD/ADD/SUB go through
 * the scratch registers for arithmetic between two reads. */
enum {
    WOP_END = 0,
    WOP_BASE,   /* cur = regs[arg]: 0 = struct sock *, 1 = struct sk_buff *, 2 = the segment's payload */
    WOP_OFF,    /* cur += arg */
    WOP_DEREF,  /* cur = *(u64 *) cur */
    WOP_READ,   /* out[0..arg) = memory at cur; terminal */
    WOP_STR,    /* out = NUL-terminated string at cur; terminal */
    WOP_VAL,    /* out = cur, arg bytes of it; terminal */
    WOP_LOADN,  /* cur = *(uN *) cur, N = arg & 7 (0 → 4) */
    WOP_EQ,     /* cur = (cur == arg) */
    WOP_SKIPZ,  /* if (!cur) skip arg ops */
    WOP_SKIPNZ, /* if (cur) skip arg ops */
    WOP_BACK,   /* cur -= arg: a dedicated op keeps every arg a small positive u32 */
    WOP_STORE,  /* scratch[arg] = cur */
    WOP_LOAD,   /* cur = scratch[arg] */
    WOP_ADD,    /* cur += scratch[arg] */
    WOP_SUB,    /* cur -= scratch[arg] */
};

struct walk_op {
    __u32 code;
    __u32 arg;
};

/* A field program: reach a head (pre), then either emit one value
 * (next_off == 0) or walk the chain and emit one per node. */
struct walk_prog {
    __u32 n_pre;
    struct walk_op pre[MAX_STEP];
    __u32 next_off;
    __u32 max_iters;
    __u32 n_body;
    struct walk_op body[MAX_STEP];
};

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, MAX_FIELDS);
    __type(key, __u32);
    __type(value, struct walk_prog);
} programs SEC(".maps");

/* Ports never reported: the app's own, so the UI does not watch itself. */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u8);
    __uint(max_entries, 64);
} ignore_ports SEC(".maps");

/* When `focus` is set, only flows with one of these ports are run. */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u8);
    __uint(max_entries, 64);
} focus_ports SEC(".maps");

volatile __u32 nfields;                  /* .bss: live field programs; 0 = quiet */
volatile __u32 gen;                      /* .bss: which program; stamped on each event so the host drops stragglers */
volatile __u8 focus;                     /* .bss: require a focus_ports match */
volatile __u8 data_only;                 /* .bss: skip segments carrying no payload */
volatile __u64 min_gap_ns = 1000000;     /* .data: throttle between events */
volatile __u64 seen, emitted, ring_full; /* .bss: counters the host reads */
__u64 last_ns;

/* One delivered segment: the flow, then each field's entries. Entries
 * are flat (entry (f, it) at index f * MAX_ITERS + it) so the loader's
 * BTF marshaler hands them over as one array. `sport`/`saddr` are the
 * socket's own end, `dport`/`daddr` its peer. */
struct walk_event {
    __u64 ts;
    __u32 cpu;
    __u32 gen;                /* the program that ran, as armed */
    __u32 ok;                 /* bit f set = field f produced ≥ 1 entry */
    __u8  family;
    __u8  state;              /* TCP_ESTABLISHED = 1, … */
    __u16 sport;              /* host order */
    __u16 dport;
    __u16 _pad;
    __u8  saddr[16];          /* v4 in the first 4 bytes */
    __u8  daddr[16];
    __u32 seq;                /* the segment's sequence number, host order */
    __u32 plen;               /* its TCP payload, in bytes (paged frags included) */
    __u32 linear;             /* of which this many are in the skb's head, where the VM can read */
    __u32 fcount[MAX_FIELDS]; /* entries produced by field f */
    __u32 elen[MAX_FIELDS * MAX_ITERS];
    __u8  edata[MAX_FIELDS * MAX_ITERS * ENTRY_CAP];
};

#define ENTRY_IDX(f, it) (((f) * MAX_ITERS + (it)) & (MAX_FIELDS * MAX_ITERS - 1))

__attribute__((used)) static const struct walk_event __walk_event_anchor;

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 22);
} events SEC(".maps");

/* Everything the VM threads through its loops, on the tracepoint's
 * frame: bpf_loop callbacks each get their own frame, and the whole
 * chain shares 512 bytes, so state lives here and the callbacks hold
 * one pointer to it. */
struct walk_state {
    __u64 regs[NREGS];
    struct walk_event *e;
    /* the field being run */
    struct walk_prog *p;
    __u32 f;
    __u64 node;
    /* the section being run */
    struct walk_op *ops;
    __u32 n;
    __u64 cur;
    __u8 *out;
    __u32 wrote;
    __u32 skip;
    __u32 live;
    __u64 scratch[NSCRATCH];
};

/* One op of a straight-line section, as a bpf_loop step. Every op is a
 * branch of one dispatch the verifier walks once per call site; run
 * unrolled, the same dispatch is walked for each of the eight slots of
 * each section of each field and the state budget is gone. Returns 1
 * to stop the section: past its end, or a read failed. */
static long step(__u32 i, void *pst)
{
    struct walk_state *st = pst;
    if (i >= st->n || !st->live)
        return 1;
    if (st->skip > 0) {
        st->skip--;
        return 0;
    }
    struct walk_op *op = &st->ops[i & (MAX_STEP - 1)];
    __u32 code = op->code;
    __u32 arg = op->arg;
    __u64 cur = st->cur;

    if (code == WOP_LOADN) {
        __u64 v = 0;
        __u32 sz = arg & 7;
        if (sz == 0)
            sz = 4;
        if (bpf_probe_read_kernel(&v, sz, (void *) cur))
            st->live = 0;
        else
            cur = v;
    } else if (code == WOP_EQ) {
        cur = (cur == (__u64) arg) ? 1 : 0;
    } else if (code == WOP_SKIPZ) {
        if (cur == 0)
            st->skip = arg;
    } else if (code == WOP_SKIPNZ) {
        if (cur != 0)
            st->skip = arg;
    } else if (code == WOP_BASE) {
        cur = st->regs[arg & (NREGS - 1)];
    } else if (code == WOP_OFF) {
        cur += arg;
    } else if (code == WOP_BACK) {
        cur -= arg;
    } else if (code == WOP_STORE) {
        st->scratch[arg & (NSCRATCH - 1)] = cur;
    } else if (code == WOP_LOAD) {
        cur = st->scratch[arg & (NSCRATCH - 1)];
    } else if (code == WOP_ADD) {
        cur += st->scratch[arg & (NSCRATCH - 1)];
    } else if (code == WOP_SUB) {
        cur -= st->scratch[arg & (NSCRATCH - 1)];
    } else if (code == WOP_DEREF) {
        __u64 next = 0;
        if (bpf_probe_read_kernel(&next, sizeof(next), (void *) cur))
            st->live = 0;
        else
            cur = next;
    } else if (code == WOP_READ) {
        __u32 sz = arg & (ENTRY_CAP - 1);
        if (sz == 0)
            sz = 1;
        if (bpf_probe_read_kernel(st->out, sz, (void *) cur))
            st->live = 0;
        else
            st->wrote = sz;
    } else if (code == WOP_STR) {
        long r = bpf_probe_read_kernel_str(st->out, ENTRY_CAP, (void *) cur);
        if (r < 0)
            st->live = 0;
        else
            st->wrote = (__u32) r;
    } else if (code == WOP_VAL) {
        __u32 sz = arg;
        if (sz == 0 || sz > 8)
            sz = 8;
        *(__u64 *) st->out = cur; /* all 8 written; the host reads `len` */
        st->wrote = sz;
    }

    st->cur = cur;
    return st->live ? 0 : 1;
}

/* Run a section: `ops`/`n` from cursor `start`, terminal bytes to
 * `out`. Afterwards st->cur is where the cursor ended (a navigation-only
 * pre hands its head onward) and st->wrote how much a terminal emitted. */
static __always_inline void run_section(struct walk_state *st, struct walk_op *ops, __u32 n, __u64 start, __u8 *out)
{
    st->ops = ops;
    st->n = n > MAX_STEP ? MAX_STEP : n;
    st->cur = start;
    st->out = out;
    st->wrote = 0;
    st->skip = 0;
    st->live = 1;
    for (int i = 0; i < NSCRATCH; i++)
        st->scratch[i] = 0;
    bpf_loop(MAX_STEP, step, st, 0);
}

/* One chain node: run body from the node, emit an entry, advance via
 * next_off. Returns 1 to stop (NULL, a failed read, or a scalar's one
 * entry), 0 to continue. */
static long walk_node(__u32 it, void *pst)
{
    struct walk_state *st = pst;
    struct walk_prog *p = st->p;
    if (p->next_off && st->node == 0)
        return 1;
    __u32 idx = ENTRY_IDX(st->f, it);
    __u8 *out = &st->e->edata[idx * ENTRY_CAP];
    run_section(st, p->body, p->n_body, st->node, out);
    if (!st->live || st->wrote == 0)
        return 1;
    st->e->elen[idx] = st->wrote;
    st->e->fcount[st->f & (MAX_FIELDS - 1)] = it + 1;
    st->e->ok |= (1u << (st->f & (MAX_FIELDS - 1)));
    if (p->next_off == 0)
        return 1;
    __u64 adv = 0;
    if (bpf_probe_read_kernel(&adv, sizeof(adv), (void *) (st->node + p->next_off)))
        return 1;
    st->node = adv;
    return 0;
}

/* Throwaway terminal buffer for a navigation-only pre. Global, not
 * stack: the frames of the nested loops share the 512-byte BPF stack.
 * CPUs may race on it; the contents are never read. */
static __u8 nav_scratch[ENTRY_CAP];

/* One field: reach the chain head (or, for a scalar, leave the cursor
 * wherever pre lands), then walk. */
static long run_field(__u32 f, void *pst)
{
    struct walk_state *st = pst;
    __u32 key = f & (MAX_FIELDS - 1);
    struct walk_prog *p = bpf_map_lookup_elem(&programs, &key);
    if (!p)
        return 0;
    st->p = p;
    st->f = key;

    run_section(st, p->pre, p->n_pre, 0, nav_scratch);
    st->node = st->cur;

    __u32 mi = p->max_iters;
    if (mi == 0)
        mi = 1;
    if (mi > MAX_ITERS)
        mi = MAX_ITERS;
    bpf_loop(mi, walk_node, st, 0);
    return 0;
}

static __always_inline void fill_flow(struct walk_event *e, struct sock *sk)
{
    __u16 family = BPF_CORE_READ(sk, __sk_common.skc_family);
    e->family = family == AF_INET6 ? AF_INET6 : AF_INET;
    e->state = BPF_CORE_READ(sk, __sk_common.skc_state);
    e->sport = BPF_CORE_READ(sk, __sk_common.skc_num);
    e->dport = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));
    e->_pad = 0;
    __builtin_memset(e->saddr, 0, 16);
    __builtin_memset(e->daddr, 0, 16);
    if (family == AF_INET6) {
        BPF_CORE_READ_INTO(e->saddr, sk, __sk_common.skc_v6_rcv_saddr);
        BPF_CORE_READ_INTO(e->daddr, sk, __sk_common.skc_v6_daddr);
    } else {
        __u32 s = BPF_CORE_READ(sk, __sk_common.skc_rcv_saddr);
        __u32 d = BPF_CORE_READ(sk, __sk_common.skc_daddr);
        __builtin_memcpy(e->saddr, &s, 4);
        __builtin_memcpy(e->daddr, &d, 4);
    }
}

/* The segment: at tcp_rcv_established skb->data is the TCP header, so
 * the payload starts doff words past it. Its start becomes register 2;
 * how much of it the head holds goes to the event — a window past the
 * linear head would read the skb's shared info, so the host trims. */
struct segment {
    __u64 payload;
    __u32 seq, plen, linear;
};

static __always_inline void read_segment(struct segment *sg, struct sk_buff *skb)
{
    unsigned char *data = BPF_CORE_READ(skb, data);
    __u32 len = BPF_CORE_READ(skb, len);
    __u32 data_len = BPF_CORE_READ(skb, data_len);
    __u32 seq = 0;
    __u8 doff = 0;
    bpf_probe_read_kernel(&seq, sizeof(seq), data + 4);
    bpf_probe_read_kernel(&doff, sizeof(doff), data + 12);
    __u32 hdr = (__u32) (doff >> 4) * 4;
    __u32 head = len > data_len ? len - data_len : 0;
    sg->seq = bpf_ntohl(seq);
    sg->plen = len > hdr ? len - hdr : 0;
    sg->linear = head > hdr ? head - hdr : 0;
    sg->payload = (__u64) data + hdr;
}

/* TP_PROTO(struct sock *sk, struct sk_buff *skb), in tcp_rcv_established. */
SEC("raw_tp/tcp_probe")
int on_tcp_probe(struct bpf_raw_tracepoint_args *ctx)
{
    seen++;
    __u32 nf = nfields;
    if (nf == 0)
        return 0;
    if (nf > MAX_FIELDS)
        nf = MAX_FIELDS;

    struct sock *sk = (struct sock *) ctx->args[0];
    __u32 sport = BPF_CORE_READ(sk, __sk_common.skc_num);
    __u32 dport = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));
    if (bpf_map_lookup_elem(&ignore_ports, &sport) || bpf_map_lookup_elem(&ignore_ports, &dport))
        return 0;
    if (focus && !bpf_map_lookup_elem(&focus_ports, &sport) && !bpf_map_lookup_elem(&focus_ports, &dport))
        return 0;

    struct segment sg;
    read_segment(&sg, (struct sk_buff *) ctx->args[1]);
    if (data_only && sg.plen == 0)
        return 0;

    __u64 tnow = bpf_ktime_get_ns();
    if (min_gap_ns && tnow - last_ns < min_gap_ns)
        return 0;
    last_ns = tnow;

    struct walk_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e) {
        ring_full++;
        return 0;
    }
    e->ts = tnow;
    e->cpu = bpf_get_smp_processor_id();
    e->gen = gen;
    e->ok = 0;
    for (int f = 0; f < MAX_FIELDS; f++)
        e->fcount[f] = 0;
    fill_flow(e, sk);
    e->seq = sg.seq;
    e->plen = sg.plen;
    e->linear = sg.linear;

    struct walk_state st = {};
    st.regs[0] = ctx->args[0]; /* struct sock * */
    st.regs[1] = ctx->args[1]; /* struct sk_buff * */
    st.regs[2] = sg.payload;
    st.e = e;
    bpf_loop(nf, run_field, &st, 0);

    emitted++;
    bpf_ringbuf_submit(e, 0);
    return 0;
}
