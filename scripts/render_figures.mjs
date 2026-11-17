// Render the HTML figures in docs/ to PNG at 2x with Playwright: node scripts/render_figures.mjs
import { chromium } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 860, height: 640 }, deviceScaleFactor: 2 });
for (const name of ["architecture"]) {
  await page.goto(pathToFileURL(join(docs, `${name}.html`)).href);
  await page
    .locator("svg")
    .first()
    .screenshot({ path: join(docs, `${name}.png`) });
}
await browser.close();
