/* GET /api/status — are the taps alive. */

import { status } from "@/lib/scope.js";

export async function GET() {
  return Response.json(await status());
}
