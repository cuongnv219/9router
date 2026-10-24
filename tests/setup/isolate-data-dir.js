// Every test file starts with DATA_DIR pointing at a fresh temp dir, so app code
// that falls back to the default ~/.9router (DB, jwt-secret, logs, mitm) can
// never touch the developer's real data. Tests that set their own DATA_DIR
// override this as before; "restore" in their teardown lands back here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-"));
process.env.DATA_DIR = dir;

// Runs once per test file (setupFiles); clean up when the worker exits.
process.on("exit", () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
