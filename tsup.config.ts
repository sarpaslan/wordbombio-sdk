import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    target: "node22",
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    sourcemap: true,
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
