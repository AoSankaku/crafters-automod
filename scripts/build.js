import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkRules, projectDirectory } from "./check-rules.js";

try {
  await checkRules();
  const outdir = join(projectDirectory, "dist");
  const entryPoints = ["src/index.js", "src/cli.js"].map((path) => join(projectDirectory, path));
  let outputs;
  if (process.versions.bun) {
    const result = await Bun.build({ entrypoints: entryPoints, outdir, target: "bun", format: "esm", write: false,
      external: ["bun", "bun:*", "node:sqlite", "postgres"] });
    if (!result.success) throw new Error("Bun build failed.");
    outputs = await Promise.all(result.outputs.map(async (output) => ({ path: output.path, contents: new Uint8Array(await output.arrayBuffer()) })));
  } else {
    const { build } = await import("esbuild");
    const result = await build({ entryPoints, outdir, absWorkingDir: projectDirectory, bundle: true, format: "esm",
      platform: "node", target: "node24", external: ["bun", "bun:*"], logLevel: "silent", write: false });
    outputs = result.outputFiles;
  }
  await mkdir(outdir, { recursive: true });
  for (const output of outputs) {
    if (dirname(resolve(output.path)) !== resolve(outdir)) throw new Error("Unexpected build output location.");
    await writeFile(output.path, output.contents);
  }
  console.log(`Built ${outputs.length} artifacts with ${process.versions.bun ? "Bun" : "Node.js"}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Build failed.");
  process.exitCode = 1;
}
