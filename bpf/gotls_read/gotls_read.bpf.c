/* The Go tap, ingress half: crypto/tls.(*Conn).Read.
 *
 *   func (c *Conn) Read(b []byte) (n int, err error)
 *
 * The buffer is filled by the time Read returns and the count is its
 * first result, so this needs a probe at the return — and on Go that
 * cannot be a uretprobe. Go grows goroutine stacks by copying them,
 * and the copier walks return addresses; a uretprobe's trampoline
 * address is not one it knows, so the process dies with "unexpected
 * return pc" (observed on go1.27). Instead the loader disassembles the
 * function, finds every RET, and places an ordinary uprobe at each:
 * at a RET the results are already in the argument registers (Go's
 * ABIInternal returns in the same sequence), so GO_PARM1 is `n`.
 *
 * One program can be attached at one place, and an unattached program
 * fails the object, so there are RET_SLOTS identical programs; the
 * loader attaches slot i at RET i, and any slots left over at the last
 * RET again. A duplicate at the same address costs a lookup and finds
 * nothing: the first probe to run consumed the entry.
 *
 * Entry and return are keyed by the goroutine's `g` pointer — read from
 * its reserved register — rather than the thread: Read blocks on the
 * network and the goroutine can resume on another OS thread. `g` is
 * stable for the goroutine's life and needs no per-version offset, which
 * goid would.
 */

#define BPF_NO_KFUNC_PROTOTYPES

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#include "goabi.h"
#include "tap.h"

char LICENSE[] SEC("license") = "GPL";

#define RET_SLOTS 8

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u64); /* g pointer */
    __type(value, struct read_args);
    __uint(max_entries, 10240);
} go_reads SEC(".maps");

SEC("uprobe")
int go_tls_read_enter(struct pt_regs *ctx)
{
    struct read_args a = { .conn = GO_PARM1(ctx), .buf = GO_PARM2(ctx), .nread = GO_PARM3(ctx) };
    __u64 g = GO_G(ctx);
    bpf_map_update_elem(&go_reads, &g, &a, BPF_ANY);
    /* The recvmsg that fills this buffer happens inside the call. */
    note_conn(a.conn);
    return 0;
}

static __always_inline int at_ret(struct pt_regs *ctx)
{
    __u64 g = GO_G(ctx);
    struct read_args *a = bpf_map_lookup_elem(&go_reads, &g);
    if (!a)
        return 0;
    __u64 conn = a->conn, buf = a->buf, cap = a->nread;
    bpf_map_delete_elem(&go_reads, &g);

    long n = (long) GO_PARM1(ctx);
    if (n <= 0)
        return 0;
    if ((__u64) n > cap) /* cannot have read past the buffer it was given */
        return 0;
    emit(conn, buf, (__u32) n, DIR_READ);
    return 0;
}

#define RET_SLOT(i)                             \
    SEC("uprobe")                               \
    int go_tls_read_ret##i(struct pt_regs *ctx) \
    {                                           \
        return at_ret(ctx);                     \
    }

RET_SLOT(0)
RET_SLOT(1)
RET_SLOT(2)
RET_SLOT(3)
RET_SLOT(4)
RET_SLOT(5)
RET_SLOT(6)
RET_SLOT(7)
