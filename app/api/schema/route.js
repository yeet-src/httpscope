/* GET /api/schema — the SDL alone. */

import { SDL } from "@/lib/query/schema.js";

export async function GET() {
  return new Response(SDL.trim() + "\n", { headers: { "content-type": "application/graphql; charset=utf-8" } });
}
