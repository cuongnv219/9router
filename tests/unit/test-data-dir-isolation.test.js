// The setup file (tests/setup/isolate-data-dir.js) must keep every test off the
// real ~/.9router, even after a test deletes DATA_DIR in its own teardown.
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

const realDir = path.join(os.homedir(), ".9router");

describe("test data-dir isolation", () => {
  it("DATA_DIR is a temp dir, never the real ~/.9router", () => {
    expect(process.env.DATA_DIR).toBeTruthy();
    expect(process.env.DATA_DIR.startsWith(os.tmpdir())).toBe(true);
    expect(path.resolve(process.env.DATA_DIR)).not.toBe(realDir);
  });

  it("a test that deletes DATA_DIR…", () => {
    delete process.env.DATA_DIR;
  });

  it("…does not leave the next test on the default dir", () => {
    expect(process.env.DATA_DIR?.startsWith(os.tmpdir())).toBe(true);
  });
});
