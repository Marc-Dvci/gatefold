import { resolve } from "node:path";
import { defineConfig } from "vite";

// The embeddable player as an ES module library: dist/embed/gatefold.js plus its worklet file.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist/embed",
    emptyOutDir: true,
    target: "es2022",
    lib: { entry: resolve(__dirname, "src/embed/index.ts"), formats: ["es"], fileName: () => "gatefold.js" },
  },
  worker: { format: "es" },
  resolve: { alias: { "@deployment": resolve(__dirname, "deployments/xlayer.json") } },
});
