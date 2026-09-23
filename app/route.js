/* GET / — the front door.
 *
 * A browser asks for text/html and gets the UI's shell, as every other
 * path does. Anything else — curl, an agent, a script — gets the page
 * that says what this is and how to ask, so the whole surface is
 * discoverable from the root with nothing known in advance.
 *
 * The shell is whatever the server answers for an unclaimed path, so it
 * is fetched from ourselves rather than rebuilt here.
 */

import { PAGE } from "@/lib/query/page.js";

export async function GET(request) {
  const accept = request.headers.get("accept") ?? "";
  const wantsHtml = accept.includes("text/html") && !accept.includes("text/markdown");
  if (wantsHtml) {
    const shell = await fetch(new URL("/@shell", request.url), { headers: { accept: "*/*" } });
    return new Response(await shell.text(), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(PAGE, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
