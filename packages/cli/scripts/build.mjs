import { build } from "esbuild";
import { chmod, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("dist/cli.cjs", root);
await mkdir(new URL("dist/", root), { recursive: true });
await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ["src/cli.ts"],
  outfile: fileURLToPath(output),
  platform: "node",
  target: "node22",
  format: "cjs",
  bundle: true,
  sourcemap: false,
  legalComments: "none"
});
if (process.platform !== "win32") await chmod(output, 0o755);
