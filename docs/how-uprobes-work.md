# How uprobes actually work, learned by tapping TLS

*A draft for the blog. Everything below runs in [httpscope](https://github.com/yeet-src/httpscope), a tool that watches the HTTP APIs a machine speaks; the code excerpts are its.*

If you want to see what a program sends over HTTPS, you have two honest choices. You can get between it and the network and terminate TLS yourself, which means certificates, trust stores, and a program that knows it is being watched. Or you can read the bytes where they are still plaintext: inside the process, at the moment it hands them to its TLS library. A call like `SSL_write(ssl, buf, len)` has the plaintext right there in `buf`. If you could run a few instructions of your own every time that function is entered, you would have every request the process makes, before encryption, without touching the network at all.

That is what a uprobe is: a breakpoint in a user-space program, placed by the kernel, that runs code of yours when hit. The idea is a sentence long. The details are where the work is, and they are the point of this post.

## A breakpoint on a file, not a process

The first surprise is what a uprobe is attached to. Not a process. An *inode and an offset*: this file, this many bytes in. When you register one, the kernel walks every process that has that file mapped and, in each, replaces the instruction at that offset with a breakpoint — `int3` on x86, `brk` on arm64. It does this by copying the affected page and swapping the copy into the process's mapping, so the file on disk is untouched and other mappings of the same page are unaffected. It also hooks `mmap`, so a process that maps the file *later* gets the breakpoint the moment the page comes in.

Then a thread executes the breakpoint. The CPU traps into the kernel, the kernel finds the uprobe by looking up the faulting address in the task's mappings, runs the handlers — for us, a BPF program, handed the thread's saved registers — and then has to execute the instruction it overwrote. It does this *out of line*: each process gets a small hidden mapping holding copies of displaced instructions, the thread is pointed there, runs the original instruction, and is steered back. Two traps and a detour per hit, a couple of microseconds on modern hardware.

This changes how you think about attaching. The question is not "which pid" but "which file, at which offset". The pid becomes a filter applied when the probe fires, not a property of the probe. We learned this the expensive way:

> The first version attached per process. A `curl` lives for about fifty milliseconds. By the time the daemon had resolved the process's `libssl` through `/proc/<pid>/root`, the process was gone: *"Could not resolve target binary /proc/146853/root/usr/lib/libssl.so.3"*. Attaching to `/usr/lib/libssl.so.3` itself, once, with no pid, covered every `curl` and `python` that would ever run.

So httpscope attaches to binaries. At boot it scans what the machine's processes map, and attaches to every `libssl`, and to every `node`, `deno` or `bun` executable, since those carry OpenSSL inside. A container's library is a different file behind a mount namespace, reached through `/proc/<pid>/root`, which needs the pid alive; for a server that is fine.

## Turning a name into an offset

The kernel wants an offset. You have a function name. Between them is the ELF file.

For a shared library that exports its API this is bookkeeping: find the symbol in `.dynsym`, take its virtual address, and map it to a file offset through the program headers. The loader does this for you when you say `symbol: "SSL_write"`. OpenSSL has two APIs, the classic `SSL_write`/`SSL_read` and the `_ex` variants from 1.1.1 that report the count through a pointer, and programs pick one, so there are two probe sets; CPython uses `_ex`, curl and Node the classic.

Rust makes it harder. A rustls function is called something like `_ZN6rustls4conn13PlaintextSink5write17h9f3c1c0e2b1d4a5bE`: the name is mangled and carries a hash that changes with every build. You cannot write the symbol down. httpscope asks the loader to match a regular expression against the *demangled* names instead:

```js
["rust_tls_write", { symbol: "PlaintextSink>::write$", match: "regex" }],
["rust_tls_read",  { symbol: "CommonState>?::take_received_plaintext$", match: "regex" }],
```

Go makes it harder still, because a Go binary is usually stripped of `.symtab` entirely. But Go keeps its own table, `.gopclntab`, because its runtime needs it for stack traces, and that table has every function's entry address and name. A stripped Go binary is still fully navigable; you just have to read Go's format rather than ELF's. httpscope does that in a few hundred lines of JavaScript, no binutils, and attaches by raw file offset.

And some binaries defeat all three. Chrome's BoringSSL is statically linked and stripped with no table to fall back on. There is no `SSL_write` to find. That traffic stays dark, and the tool says so rather than guessing.

## Reading the arguments: you are on your own

A kernel probe on a kernel function gets typed arguments, because the kernel carries BTF, a description of every type it has. A uprobe gets the thread's registers and nothing else. Which register holds which argument is the calling convention, and the kernel has no idea what convention the program in front of it uses.

For C on x86-64 that is the System V ABI: first argument in `rdi`, second in `rsi`, third in `rdx`. The BPF helper macros encode exactly that, so an OpenSSL probe reads naturally:

```c
/* int SSL_write(SSL *ssl, const void *buf, int num) */
SEC("uprobe")
int BPF_KPROBE(ssl_write, void *ssl, const void *buf, int num)
{
    if (num > 0)
        emit((__u64) ssl, (__u64) buf, (__u32) num, DIR_WRITE);
    return 0;
}
```

Go does not use the C ABI. Since Go 1.17 its `ABIInternal` passes integer arguments in `rax, rbx, rcx, rdi, rsi, r8, r9, r10, r11`, and keeps the current goroutine's `g` pointer in `r14`. Use `PT_REGS_PARM1` on a Go function and you read `rdi`, the fourth argument, and get garbage that looks plausible. On arm64 the two conventions happen to agree for the first arguments, `x0, x1, x2`, which is how a probe can look right on one machine and read nonsense on another. So the Go taps use their own header:

```c
#if defined(bpf_target_x86)
#define GO_PARM1(x) ((x)->ax)
#define GO_PARM2(x) ((x)->bx)
#define GO_PARM3(x) ((x)->cx)
#define GO_G(x)     ((x)->r14)
#elif defined(bpf_target_arm64)
#define GO_PARM1(x) ((x)->regs[0])
#define GO_PARM2(x) ((x)->regs[1])
#define GO_PARM3(x) ((x)->regs[2])
#define GO_G(x)     ((x)->regs[28])
#endif
```

The lesson generalises: a uprobe is a contract with a specific compiler's output. Nothing checks it for you.

## Return values, and why Go dies

Half of what you want is only there when the function *returns*. `SSL_read(ssl, buf, num)` fills `buf` and returns how many bytes; at entry the buffer is empty. So the read taps stash the arguments at entry, keyed by thread, and copy the bytes at return:

```c
SEC("uprobe")
int BPF_KPROBE(ssl_read_enter, void *ssl, void *buf, int num)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args a = { .conn = (__u64) ssl, .buf = (__u64) buf };
    bpf_map_update_elem(&active_reads, &id, &a, BPF_ANY);
    return 0;
}

SEC("uretprobe")
int BPF_KRETPROBE(ssl_read_exit, int ret)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args *a = bpf_map_lookup_elem(&active_reads, &id);
    if (!a) return 0;
    bpf_map_delete_elem(&active_reads, &id);
    if (ret > 0) emit(a->conn, a->buf, (__u32) ret, DIR_READ);
    return 0;
}
```

The `uretprobe` is the interesting half, because there is no instruction that means "this function is returning". What the kernel does instead is a trick: when the entry breakpoint fires, it *rewrites the return address on the stack* to point at a trampoline in that hidden out-of-line area. The function runs, executes its `ret`, lands on the trampoline, which is another breakpoint; the kernel runs your return handler, restores the real return address, and sends the thread on its way. The function never knows.

The function never knows, but Go's runtime does. Go grows goroutine stacks by copying them to a bigger allocation, and to fix up the copied frames it walks the return addresses on the stack and looks each one up in `.gopclntab`. A trampoline address is not in that table. The runtime concludes the stack is corrupt and kills the process: `fatal error: unexpected return pc`. We watched a go1.27 program die the instant `crypto/tls.(*Conn).Read` was uretprobed. Not a slowdown, not a wrong reading: the process ends.

The way around is to stop using the return-address trick and probe the return *instructions* instead. A function can have several `ret`s; each gets an ordinary uprobe, and at a `ret` the results are already in the registers, since Go returns them in the same sequence it takes arguments. Finding the `ret`s needs a disassembler, or something cheaper: `.gopclntab` also records, for every function, how the stack pointer changes across it, the `pcsp` table. Wherever the recorded stack delta drops back to zero, the frame has been torn down, and the instruction there is the return. httpscope reads that table and checks the byte it lands on, `c3` on x86, `d65f03c0` on arm64:

```js
const isRet = (fo) => machine === EM_AARCH64 ? r.u32(fo) === 0xd65f03c0 : r.u8(fo) === 0xc3;
for (let k = 1; k < segs.length; k++) {
  if (segs[k].value !== 0 || segs[k - 1].value === 0) continue;
  const fo = fileOffset(segs[k].start);
  if (isRet(fo)) rets.push(fo);
}
```

A `Read` in our test binary has seven of them, on both architectures.

One more Go detail hides in the keying. The OpenSSL taps pair entry and exit by thread id, and that works because a C thread that enters `SSL_read` is the thread that returns from it. A goroutine that blocks in `Read` waiting for the network can wake up on a *different* OS thread. Key by thread and the exit finds nothing. So the Go taps key by the goroutine itself, the `g` pointer in `r14`, which is stable for the goroutine's life and, unlike the goroutine id, needs no per-version struct offset to read.

## What a probe can read, and what it cannot

The handler copies `len` bytes from the user buffer with `bpf_probe_read_user`. That is a copy from another address space, and it can fail: a page the program has not touched yet may not be resident, and a probe handler cannot take a page fault on its behalf. When it fails, you get nothing for that segment. httpscope records the hole, the *length* is known even when the bytes are not, and the HTTP decoder treats a hole inside a body as missing bytes and a hole across a header as a lost connection.

There is also a ceiling on how much one hit can copy, set by the BPF verifier's need to prove every access in bounds, so a large write is emitted as several records with offsets, and the receiving side reassembles. Each record is a fixed-size ring buffer reservation; the ring is the one shared resource, and when it is full the probe drops the segment and moves on rather than stall the program.

## Which socket was that?

A TLS probe sees an `SSL *` and bytes. It does not see a socket, an address, or a port. But it is running on a thread that is about to make a system call: the `SSL_write` you just entered will, a few microseconds later, call `send`, which becomes `tcp_sendmsg` in the kernel, on the same thread. So the tap notes "this thread is inside `SSL_write` for connection `c`", and a kernel-side probe on `tcp_sendmsg` on that thread reads the note and binds `c` to the `struct sock` it was handed, with the 4-tuple that comes with it:

```c
SEC("fentry/tcp_sendmsg")
int BPF_PROG(peer_sendmsg, struct sock *sk) { peer_hit(sk); return 0; }
```

It is a heuristic. An event-loop runtime could interleave things so that the note belongs to a different call. In practice it binds once per connection and is right, and the HTTP `Host` header is the authority for naming the service anyway.

## What uprobes are for, and what they are not

Everything above adds up to a tool that reads every HTTPS request a machine makes, with no proxy and no certificates, from processes that never know. It also adds up to a list of caveats that are worth stating plainly, because they are structural, not bugs:

- **You need a name or a table.** No symbols, no `.gopclntab`, no probe. Chrome and Bun are dark.
- **You are bound to an ABI.** Registers per compiler, per architecture, checked by nothing.
- **Return probes are a stack trick**, and runtimes that own their stacks will fight it. Go does; probe the `ret`s instead.
- **Inlining defeats you.** A function the compiler inlined has no entry to break on.
- **Each hit is a trap.** Microseconds each, which is nothing for `SSL_write` and would be ruinous on `memcpy`.

For the same tool we ended up with a second byte source that has none of these properties and different ones: a TCX program on the network devices sees every packet, needs no symbols and costs no traps, and in exchange sees ciphertext for TLS and has to reassemble TCP itself. The two together see the whole picture. But the uprobe is the one that reads the plaintext, and it earns its complications.

*Code: [yeet-src/httpscope](https://github.com/yeet-src/httpscope), `bpf/ssl`, `bpf/gotls_read`, `bpf/include/goabi.h`, `app/lib/probes/gopclntab.js`.*
