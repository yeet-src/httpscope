/* GET /api — the one page an agent reads, also served at / to anything
 * that is not a browser. */

import { PAGE } from "@/lib/query/page.js";


export async function GET() {
  return new Response(PAGE, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
