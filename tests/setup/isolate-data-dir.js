// Every test file starts with DATA_DIR pointing at a fresh temp dir, so app code
// that falls back to the default ~/.9router (DB, jwt-secret, logs, mitm) can
// never touch the developer's real data. Tests may set their own DATA_DIR; after
// each test it is put back to this temp dir, so a test that `delete`s it cannot
// leave later tests (or deferred timers) pointing at the real ~/.9router.
//
// Exception: RUN_REAL=1 real-provider tests (tests/translator/real/) read the
// developer's active connections from the real data dir on purpose.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.env.RUN_REAL !== "1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-"));
  process.env.DATA_DIR = dir;
  afterEach(() => { process.env.DATA_DIR = dir; });
  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
