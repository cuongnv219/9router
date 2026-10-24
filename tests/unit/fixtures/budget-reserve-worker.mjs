// Child process for the cross-process budget test: opens the same SQLite file
// with its own connection and races N reservations. Prints how many were granted.
import path from "node:path";
import { createNodeSqliteAdapter } from "../../../src/lib/db/adapters/nodeSqliteAdapter.js";
import { reserveBudget } from "../../../src/lib/db/repos/budgetRepo.js";

const [dataDir, n, amount] = process.argv.slice(2);
const db = await createNodeSqliteAdapter(path.join(dataDir, "db", "data.sqlite"));
let granted = 0;
for (let i = 0; i < Number(n); i++) {
  const r = await reserveBudget({ apiKeyId: "mp-key", budgetUsd: 1, minUsd: Number(amount), maxUsd: Number(amount) }, db);
  if (r.ok) granted++;
}
process.stdout.write(String(granted));
db.close?.();
process.exit(0);
