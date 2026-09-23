/* The Go tap, egress half: crypto/tls.(*Conn).Write.
 *
 * Go's TLS is pure Go — no OpenSSL symbols at all — so this hooks the
 * public data path every net/http client and server goes through. The
 * symbol names carry the package path and no hash, so they are stable
 * across builds; they live in .symtab, so a fully stripped binary
 * (`-ldflags="-s -w"`) has nothing to attach to.
 *
 * Arguments are read with goabi.h's GO_PARMn, not PT_REGS_PARMn: Go's
 * register ABI is not the platform C ABI. A method's receiver is arg 0
 * and a []byte passes as three words, so
 *
 *   func (c *Conn) Write(b []byte)   arg0 = c, arg1 = b.ptr, arg2 = b.len
 *
 * The *Conn is stable for the connection's life and is the connection
 * id. The plaintext is in `b` at entry, so one uprobe does it.
 *
 * The ingress half is a separate object (bpf/gotls_read) because it
 * needs the function's RET offsets, which the loader may not have: a
 * uretprobe is not an option on Go — its trampoline return address
 * confuses the runtime's stack copier and kills the process (observed
 * on go1.27) — so reads are caught by plain uprobes placed at each RET.
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

/* func (c *Conn) Write(b []byte) (int, error) — plaintext in `b` at entry. */
SEC("uprobe")
int go_tls_write(struct pt_regs *ctx)
{
    __u64 len = GO_PARM3(ctx);
    if ((long) len > 0)
        emit(GO_PARM1(ctx), GO_PARM2(ctx), (__u32) len, DIR_WRITE);
    return 0;
}
