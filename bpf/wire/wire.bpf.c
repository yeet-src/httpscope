/* The wire tap: TCP payload off every network device, at TCX.
 *
 * Attached at tcx/ingress and tcx/egress on the host's interfaces, this
 * sees each packet as it crosses a device — not as a process reads or
 * writes it. What that buys over the socket tap (bpf/socket): bodies
 * sent by sendfile/splice, which never pass tcp_sendmsg, and one hook
 * for the whole box independent of how the kernel's socket layer is
 * shaped. What it costs: there is no process here, so no pid (the
 * inventory in app/lib/probes/conns.js attributes a flow by its
 * 4-tuple), and what comes out is segments, not a stream — the host
 * puts them back in order by sequence number (app/lib/http/tcp.js).
 *
 * A loopback packet crosses lo twice, once out and once in; the ingress
 * program skips lo so each byte is seen once. Devices with no link
 * layer (tun, tailscale) hand over a bare IP packet; both framings are
 * recognised. A GSO super-segment is copied whole, up to WIRE_SEGS
 * records, with bpf_skb_load_bytes so paged data is reached too.
 *
 * Filtered in the kernel like the socket tap: an ignored port emits
 * nothing, otherwise capture_all or a focused port. There is no pid
 * filter — there is no pid.
 */

#define BPF_NO_KFUNC_PROTOTYPES

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_helpers.h>

#include "events.h"

char LICENSE[] SEC("license") = "GPL";

#define ETH_P_IP   0x0800
#define ETH_P_IPV6 0x86DD
#define TCX_NEXT   (-1)

volatile __u8 capture_all;   /* .bss, patched from JS */
volatile __u32 lo_ifindex;   /* .bss, patched from JS: skipped on ingress */

/* Counters, read back from JS: how many packets each hook saw, how many
 * parsed as TCP, passed the filter, and were emitted. Not atomic — a
 * lost increment is fine for a gauge of whether the tap is alive. */
volatile __u64 seen_ingress, seen_egress, seen_lo, seen_lo_ingress, parsed, matched, emitted, ring_full;

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u8);
    __uint(max_entries, 1024);
} focus_ports SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u8);
    __uint(max_entries, 64);
} ignore_ports SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);
} frames SEC(".maps");

struct pkt {
    __u8  family;
    __u8  tcpflags;
    __u16 sport, dport;
    __u8  saddr[16], daddr[16];
    __u32 seq, ack;
    __u32 data_off, data_len;
};

/* Where the IP header starts: after a 14-byte Ethernet header whose
 * type agrees with the version nibble that follows it, else at 0. */
static __always_inline int find_ip(struct __sk_buff *skb, __u32 *nhoff, __u8 *version)
{
    __u16 eth_type = 0;
    __u8 v0 = 0, v14 = 0;
    if (bpf_skb_load_bytes(skb, 0, &v0, 1))
        return 0;
    if (!bpf_skb_load_bytes(skb, 12, &eth_type, 2) && !bpf_skb_load_bytes(skb, 14, &v14, 1)) {
        eth_type = bpf_ntohs(eth_type);
        if ((eth_type == ETH_P_IP && (v14 >> 4) == 4) || (eth_type == ETH_P_IPV6 && (v14 >> 4) == 6)) {
            *nhoff = 14;
            *version = v14 >> 4;
            return 1;
        }
    }
    if ((v0 >> 4) == 4 || (v0 >> 4) == 6) {
        *nhoff = 0;
        *version = v0 >> 4;
        return 1;
    }
    return 0;
}

static __always_inline int parse(struct __sk_buff *skb, struct pkt *p)
{
    __u32 nhoff = 0, tcpoff = 0, end = 0;
    __u8 version = 0;
    if (!find_ip(skb, &nhoff, &version))
        return 0;

    __builtin_memset(p->saddr, 0, 16);
    __builtin_memset(p->daddr, 0, 16);

    if (version == 4) {
        struct iphdr ip;
        if (bpf_skb_load_bytes(skb, nhoff, &ip, sizeof(ip)))
            return 0;
        if (ip.protocol != IPPROTO_TCP)
            return 0;
        __u32 ihl = (__u32) ip.ihl * 4;
        if (ihl < 20)
            return 0;
        p->family = AF_INET;
        __builtin_memcpy(p->saddr, &ip.saddr, 4);
        __builtin_memcpy(p->daddr, &ip.daddr, 4);
        /* tot_len is 0 on a BIG TCP skb; then the skb is the length. */
        __u32 tot = bpf_ntohs(ip.tot_len);
        end = tot ? nhoff + tot : skb->len;
        tcpoff = nhoff + ihl;
    } else {
        struct ipv6hdr ip6;
        if (bpf_skb_load_bytes(skb, nhoff, &ip6, sizeof(ip6)))
            return 0;
        if (ip6.nexthdr != IPPROTO_TCP)
            return 0; /* extension headers: not followed */
        p->family = AF_INET6;
        __builtin_memcpy(p->saddr, &ip6.saddr, 16);
        __builtin_memcpy(p->daddr, &ip6.daddr, 16);
        __u32 plen = bpf_ntohs(ip6.payload_len);
        end = plen ? nhoff + 40 + plen : skb->len;
        tcpoff = nhoff + 40;
    }
    if (end > skb->len)
        end = skb->len; /* a padded runt frame reports more than it has */

    struct tcphdr th;
    if (bpf_skb_load_bytes(skb, tcpoff, &th, sizeof(th)))
        return 0;
    __u32 doff = (__u32) th.doff * 4;
    if (doff < 20)
        return 0;
    p->sport = bpf_ntohs(th.source);
    p->dport = bpf_ntohs(th.dest);
    p->seq = bpf_ntohl(th.seq);
    p->ack = bpf_ntohl(th.ack_seq);
    p->tcpflags = (th.fin ? TCPF_FIN : 0) | (th.syn ? TCPF_SYN : 0) | (th.rst ? TCPF_RST : 0) |
                  (th.psh ? TCPF_PSH : 0) | (th.ack ? TCPF_ACK : 0);
    p->data_off = tcpoff + doff;
    p->data_len = end > p->data_off ? end - p->data_off : 0;
    return 1;
}

static __always_inline int wanted(struct pkt *p)
{
    __u32 sport = p->sport, dport = p->dport;
    if (bpf_map_lookup_elem(&ignore_ports, &sport) || bpf_map_lookup_elem(&ignore_ports, &dport))
        return 0;
    if (capture_all)
        return 1;
    if (bpf_map_lookup_elem(&focus_ports, &sport) || bpf_map_lookup_elem(&focus_ports, &dport))
        return 1;
    return 0;
}

/* The segment, as up to WIRE_SEGS records. A record whose copy failed
 * is still submitted with cap_len 0: the host needs the segment's
 * place in the sequence even when it cannot have the bytes. */
static __always_inline void emit(struct __sk_buff *skb, struct pkt *p, __u8 hook)
{
    __u64 ts = bpf_ktime_get_ns();
    __u32 len = p->data_len;

#pragma unroll
    for (int i = 0; i < WIRE_SEGS; i++) {
        __u32 off = (__u32) i * CAP_MASK;
        if (i > 0 && off >= len)
            break;

        struct wire_event *e = bpf_ringbuf_reserve(&frames, sizeof(*e), 0);
        if (!e) {
            ring_full++;
            return;
        }
        emitted++;
        e->ts = ts;
        e->ifindex = skb->ifindex;
        e->hook = hook;
        e->family = p->family;
        e->tcpflags = p->tcpflags;
        e->_pad = 0;
        e->sport = p->sport;
        e->dport = p->dport;
        __builtin_memcpy(e->saddr, p->saddr, 16);
        __builtin_memcpy(e->daddr, p->daddr, 16);
        e->seq = p->seq;
        e->ack = p->ack;
        e->len = len;
        e->off = off;

        __u32 cap = len > off ? len - off : 0;
        if (cap > CAP_MASK)
            cap = CAP_MASK;
        if (cap == 0) {
            e->cap_len = 0;
            bpf_ringbuf_submit(e, 0);
            return;
        }
        /* bpf_skb_load_bytes refuses a size that may be zero, and a
         * verifier before 6.9 does not narrow a register on the
         * `!= 0` branch above (6.6 rejects: "R4 invalid zero-sized
         * read: u64=[0,4094]"). Rebuild the bound by arithmetic it
         * does track: [1, CAP_MASK + 1], an identity on [1, CAP_MASK].
         * The barrier keeps clang from folding it away. */
        barrier_var(cap);
        cap = ((cap - 1) & CAP_MASK) + 1;
        if (bpf_skb_load_bytes(skb, p->data_off + off, e->data, cap))
            cap = 0;
        e->cap_len = cap;
        bpf_ringbuf_submit(e, 0);
        if (cap == 0)
            return;
    }
}

static __always_inline int handle(struct __sk_buff *skb, __u8 hook)
{
    struct pkt p;
    if (skb->ifindex == lo_ifindex)
        seen_lo++;
    if (!parse(skb, &p))
        return TCX_NEXT;
    parsed++;
    if (p.data_len == 0 && !(p.tcpflags & (TCPF_SYN | TCPF_FIN | TCPF_RST)))
        return TCX_NEXT; /* a bare ACK */
    if (!wanted(&p))
        return TCX_NEXT;
    matched++;
    emit(skb, &p, hook);
    return TCX_NEXT;
}

SEC("tcx/ingress")
int wire_ingress(struct __sk_buff *skb)
{
    seen_ingress++;
    if (skb->ifindex == lo_ifindex) {
        seen_lo_ingress++;
        return TCX_NEXT; /* already seen on the way out */
    }
    return handle(skb, HOOK_INGRESS);
}

SEC("tcx/egress")
int wire_egress(struct __sk_buff *skb)
{
    seen_egress++;
    return handle(skb, HOOK_EGRESS);
}
