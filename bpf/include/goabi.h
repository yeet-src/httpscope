/* Go's register ABI (ABIInternal, register-based since Go 1.17), in the
 * shape of bpf_tracing.h's PT_REGS_* accessors.
 *
 * Go does not use the platform C ABI, so PT_REGS_PARMn reads the wrong
 * registers for a Go function on amd64 (C starts at RDI, Go at RAX). On
 * arm64 the two happen to agree, which is how a probe can look right on
 * one arch and read garbage on the other.
 *
 * Include after vmlinux.h and bpf_tracing.h.
 */
#pragma once

#if defined(bpf_target_x86)

/* Integer/pointer args in order: RAX, RBX, RCX, RDI, RSI, R8, R9, R10,
 * R11. R14 holds the current goroutine's `g`. Results come back in the
 * same sequence, so GO_PARM1 at a return probe is the first result. */
#define GO_PARM1(x) ((x)->ax)
#define GO_PARM2(x) ((x)->bx)
#define GO_PARM3(x) ((x)->cx)
#define GO_G(x)     ((x)->r14)

#elif defined(bpf_target_arm64)

/* Integer/pointer args in order: X0..X15. X28 holds `g`. */
#define GO_PARM1(x) ((x)->regs[0])
#define GO_PARM2(x) ((x)->regs[1])
#define GO_PARM3(x) ((x)->regs[2])
#define GO_G(x)     ((x)->regs[28])

#else
#error "goabi.h: unsupported target architecture"
#endif
