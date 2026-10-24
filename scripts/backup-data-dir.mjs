// Back up a 9router data dir while 9router may still be running.
//
//   node scripts/backup-data-dir.mjs <data-dir> <backup-dir>
//
// db/data.sqlite is copied with SQLite's own online backup (VACUUM INTO), so the
// copy is a consistent snapshot even mid-write; copying the file plus its -wal
// with cp can produce a torn, unopenable database. Everything else (jwt-secret,
// auth/, mitm/, …) is copied as-is; runtime/ and logs/ are skipped (re-creatable),
// as are the live -wal/-shm files (already folded into the snapshot).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error("usage: node backup-data-dir.mjs <data-dir> <backup-dir>");
  process.exit(2);
}
const SKIP = new Set(["runtime", "logs"]);
const DB_REL = path.join("db", "data.sqlite");

fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, {
  recursive: true,
  filter: (p) => {
    const rel = path.relative(src, p);
    if (!rel) return true;
    if (SKIP.has(rel.split(path.sep)[0])) return false;
    return rel !== DB_REL && rel !== `${DB_REL}-wal` && rel !== `${DB_REL}-shm`;
  },
});

const dbFile = path.join(src, DB_REL);
if (fs.existsSync(dbFile)) {
  const out = path.join(dest, DB_REL);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const db = new DatabaseSync(dbFile, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 10000");
  db.prepare("VACUUM INTO ?").run(out);
  db.close();
  // Prove the snapshot opens and is intact before calling it a backup.
  const check = new DatabaseSync(out, { readOnly: true });
  const ok = check.prepare("PRAGMA integrity_check").get();
  check.close();
  if (Object.values(ok)[0] !== "ok") {
    console.error(`backup integrity check failed: ${JSON.stringify(ok)}`);
    process.exit(1);
  }
}
console.log(dest);
