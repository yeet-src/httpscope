/* Where the linked objects are, from inside the bundle.
 *
 * `make bpf` links each bpf/<name>/ directory into bin/<name>.bpf.o at
 * the project root. yeetkit places only the top-level `app.bpf.o` next
 * to the bundle, so these are reached by relative path instead: the
 * bundle runs from `.yeetkit/` in development and `dist/` in production,
 * both one level below the root, so `../bin/` is right from either. Run
 * the app from the project root.
 *
 * A standalone script (scripts/selftest-*.js) does not import this; it
 * spells its own path, because its `import.meta.dirname` is elsewhere.
 */

const spec = (file) => ({ exe: `../bin/${file}`, base: import.meta.dirname });

export const SOCKET = spec("socket.bpf.o");
export const WIRE = spec("wire.bpf.o");

export const TLS = {
  openssl: spec("ssl.bpf.o"),
  openssl_ex: spec("ssl_ex.bpf.o"),
  go: spec("gotls.bpf.o"),
  go_read: spec("gotls_read.bpf.o"),
  rustls: spec("rustls.bpf.o"),
};
