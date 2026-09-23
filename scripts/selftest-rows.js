import { snapshot } from "../app/lib/probes/conns.js";
import { attribute } from "../app/lib/probes/attribute.js";
const port = Number(yeet.args?.port ?? 8089);
const rows = await snapshot();
console.log(`${rows.length} rows; on port ${port}:`);
for (const r of rows.filter((r) => r.lport === port || r.rport === port)) console.log(" ", JSON.stringify(r));
console.log("attribute:", JSON.stringify(attribute({ a: { addr: "127.0.0.1", port: 40000 }, b: { addr: "127.0.0.1", port } }, rows)));
yeet.exit(0);
