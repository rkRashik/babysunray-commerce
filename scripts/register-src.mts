// Lets a local CLI run the application's own TypeScript services with plain Node (no bundler): resolves the
// "@/..." alias to src/, extensionless relative imports to .ts files, and "server-only" to an empty module.
// Used only by `npm run orders:expire-verification`; Next.js and the tests resolve these themselves.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(import.meta.dirname, "../src");
const EMPTY = pathToFileURL(path.resolve(import.meta.dirname, "../node_modules/server-only/empty.js")).href;

function withExtension(file: string): string | null {
  for (const candidate of [file, `${file}.ts`, `${file}.tsx`, path.join(file, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep)) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
    let target: string | null = null;
    if (specifier.startsWith("@/")) target = path.join(SRC, specifier.slice(2));
    else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (target && !path.extname(target)) {
      const file = withExtension(target);
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    } else if (target && specifier.startsWith("@/")) {
      return { url: pathToFileURL(target).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
