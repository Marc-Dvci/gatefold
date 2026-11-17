import { resolve } from "node:path";
import { defineConfig } from "vite";

// The site is built with relative paths so it works from any folder: a DeWEB container, a gateway subpath or Pages.
export default defineConfig({
  root: "web",
  base: "./",
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    rollupOptions: {
      input: { main: resolve(__dirname, "web/index.html") },
    },
  },
  worker: { format: "es" },
  resolve: {
    // The deployment the site is built against: X Layer mainnet by default, or the file the deploy script names.
    alias: { "@deployment": process.env.GATEFOLD_DEPLOYMENT_FILE ?? resolve(__dirname, "deployments/xlayer.json") },
  },
  server: { port: 5173 },
});
