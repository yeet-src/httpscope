/* Which binary holds a process's TLS symbols — from the system graph.
 *
 * A uprobe attaches to a file, and a container hides that file behind a
 * mount namespace, so every route here ends the same way: take the
 * pid's SSL-bearing path through `/proc/<pid>/root`, which the host can
 * open whether the process is on the host or in a container.
 *
 *   a mapped libssl        → that library (dynamic OpenSSL, any language)
 *   otherwise the exe      → static OpenSSL, Go, rustls: the taps sort it
 *                            out by attaching
 *
 * The graph is injected so this tests against fixtures.
 */

import { libsslPath } from "./runtimes.js";

const defaultGraph = () => yeet.graph;

/* Rewrite an in-process path to one the host can open. For a host
 * process the root is `/`, so it names the same inode either way. */
export const nsPath = (pid, path) => `/proc/${pid}/root${path.startsWith("/") ? "" : "/"}${path}`;

/**
 * The attach target for `pid`: `{ binary, exe, libssl, comm, cmdline }`,
 * or null if the pid is gone. `binary` is what to hand the uprobe.
 */
export async function targetFor(pid, graph = defaultGraph()) {
  const result = await graph
    .query(`{ proc(pid: ${Number(pid)}) { exe cmdline stat { comm } maps { path } } }`)
    .catch(() => null);
  const p = result?.data?.proc;
  if (!p) return null;
  const libssl = libsslPath((p.maps ?? []).map((m) => m.path));
  const path = libssl || p.exe || null;
  /* Whether the process is in another mount namespace, where its paths
   * are not ours. The graph does not say (its `root` is the process's
   * own view, "/" for everyone), so this is false until it can; the
   * attach-by-binary in scope.js then uses the host path. `binary`
   * below goes through /proc/<pid>/root regardless, for callers that
   * hold the pid. */
  const container = false;
  return {
    pid: Number(pid),
    comm: p.stat?.comm ?? null,
    cmdline: p.cmdline ?? [],
    exe: p.exe ?? null,
    libssl,
    container,
    binary: path ? nsPath(pid, path) : null,
  };
}
