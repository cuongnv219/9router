// Resolve the app's `@/` alias (jsconfig) for plain-node child processes in tests.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const src = pathToFileURL(path.resolve(import.meta.dirname, "../../../src") + "/").href;
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  const target = spec.startsWith("@/") ? ${JSON.stringify(src)} + spec.slice(2) : spec;
  try {
    return await next(target, ctx);
  } catch (e) {
    // The app (bundled by Next) imports some files without their .js extension.
    if (e?.code === "ERR_MODULE_NOT_FOUND" && !/\\.[cm]?js$/.test(target)) return next(target + ".js", ctx);
    throw e;
  }
}`)}`);
