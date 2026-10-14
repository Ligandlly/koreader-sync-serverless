// Build the Aliyun Function Compute code package (CJS bundle + migrations).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist-fc");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/fc/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: resolve(outDir, "index.js"),
  loader: { ".sql": "text" },
  // NOTE: identifier minification breaks the sql.js (Emscripten) UMD glue and
  // ends up producing an empty `module.exports`. Whitespace/syntax only.
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  sourcemap: false,
  logLevel: "info",
});

cpSync(resolve(root, "migrations"), resolve(outDir, "migrations"), { recursive: true });
// Force CommonJS so the FC runtime (and local `require`) does not interpret the
// bundle as ESM because of the repository-level `"type": "module"`.
writeFileSync(resolve(outDir, "package.json"), `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);

console.log(`Aliyun FC bundle written to ${outDir}`);
