/* A path or target as coloured pieces, for the Path component. Pure. */
import { classify } from "./model/path.js";

/** Slashes dim, literal segments plain, identifier-shaped segments
 * yellow, template placeholders ({n}, {*}) magenta; a query string with
 * names in cyan and values in green. `[{ cls, text }]`. */
export function pathTokens(target) {
  const out = [];
  const t = String(target ?? "");
  const q = t.indexOf("?");
  const path = q >= 0 ? t.slice(0, q) : t;
  const query = q >= 0 ? t.slice(q + 1) : null;
  const parts = path.split("/");
  parts.forEach((seg, i) => {
    if (i > 0) out.push({ cls: "text-dim", text: "/" });
    if (!seg) return;
    if (/^\{.*\}$/.test(seg)) out.push({ cls: "text-magenta", text: seg });
    else if (classify(seg)) out.push({ cls: "text-yellow", text: seg });
    else out.push({ cls: "text-fg", text: seg });
  });
  if (query != null) {
    out.push({ cls: "text-dim", text: "?" });
    query.split("&").forEach((pair, i) => {
      if (i > 0) out.push({ cls: "text-dim", text: "&" });
      const eq = pair.indexOf("=");
      if (eq < 0) out.push({ cls: "text-cyan", text: pair });
      else {
        out.push({ cls: "text-cyan", text: pair.slice(0, eq) }, { cls: "text-dim", text: "=" }, { cls: "text-green", text: pair.slice(eq + 1) });
      }
    });
  }
  return out;
}

