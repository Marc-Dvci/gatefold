import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

/** No request leaves the page except to X Layer's node; in these tests the node is offline. */
async function offlineChain(page: Page): Promise<string[]> {
  const external: string[] = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:4173/")) return route.continue();
    external.push(url);
    return route.abort();
  });
  return external;
}

async function noSeriousAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
}

test("listen: the song plays, the clock moves and the die lights up", async ({ page }) => {
  const external = await offlineChain(page);
  await page.goto("/#/listen/gatefold");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Gatefold");
  await expect(page.locator(".facts")).toContainText("Netlist on chain");
  const play = page.getByRole("button", { name: "Play", exact: true });
  await play.click();
  await expect(page.getByRole("button", { name: "Pause", exact: true }).first()).toBeVisible();
  await expect(page.locator(".time")).not.toHaveText(/^0:00 \//, { timeout: 8_000 });
  await expect(page.locator(".meter-fill").first()).not.toHaveAttribute("style", /width: 0%/, { timeout: 8_000 });
  await expect(page.getByText("compiled to JavaScript")).toBeVisible();
  // Intensity 0 dims the channels above layer 0.
  await page.getByRole("button", { name: "0", exact: true }).click();
  await expect(page.locator(".meter.off")).toHaveCount(1);
  await noSeriousAxeViolations(page);
  expect(external.filter((u) => !u.startsWith("https://rpc.xlayer.tech/"))).toEqual([]);
});

test("listen: every track in the list opens its own sleeve", async ({ page }) => {
  await offlineChain(page);
  await page.goto("/#/listen/gatefold");
  await page.getByRole("link", { name: /Ode to Joy/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ode to Joy");
  await page.getByRole("link", { name: /Mountain King/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("In the Hall of the Mountain King");
});

test("studio: a typo is reported in its channel, and fixing it recompiles", async ({ page }) => {
  await offlineChain(page);
  await page.goto("/#/studio");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(".compile-status")).toHaveText(/^Compiled in/);
  const lead = page.getByRole("textbox", { name: "lead notes in MML" });
  await lead.fill("v12 o4 c d e q");
  await expect(page.locator(".compile-status")).toContainText('unknown command "q"');
  await expect(page.locator(".channel .error")).toContainText("lead");
  await lead.fill("v12 o4 c d e f");
  await expect(page.locator(".compile-status")).toHaveText(/^Compiled in/);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download netlist" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.netlist\.json$/);
  await noSeriousAxeViolations(page);
});

test("studio: tape-out waits for the instruments to be on X Layer", async ({ page }) => {
  await offlineChain(page);
  await page.goto("/#/studio");
  await expect(page.getByRole("heading", { name: "Tape out" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tape out on X Layer" })).toBeDisabled();
});

test("instruments: a key press plays a note through the circuit", async ({ page }) => {
  await offlineChain(page);
  await page.goto("/#/instruments");
  await page.getByRole("button", { name: "Triangle" }).click();
  await expect(page.getByRole("heading", { name: "Triangle" })).toBeVisible();
  await page.getByRole("button", { name: /^A \(key H\)/ }).dispatchEvent("pointerdown");
  await expect(page.getByText(/440\.0 Hz/)).toBeVisible();
  await noSeriousAxeViolations(page);
});

test("play: the game drives the song's pins", async ({ page }) => {
  await offlineChain(page);
  await page.goto("/#/play");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.locator(".hud")).toContainText("intensity pin 0");
  await expect(page.getByText(/compiled in this page/)).toBeVisible();
  await noSeriousAxeViolations(page);
});

test("x layer: without a node the page says so instead of hanging", async ({ page }) => {
  await offlineChain(page);
  await page.goto("/#/chain");
  await expect(page.locator(".chain-head")).toContainText("X Layer did not answer", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Check 6 random circuits" })).toBeVisible();
  await noSeriousAxeViolations(page);
});

test("liner notes: the pipeline and the ecosystem table", async ({ page }) => {
  await offlineChain(page);
  await page.goto("/#/how");
  await expect(page.getByRole("heading", { name: "Liner notes" })).toBeVisible();
  await expect(page.locator(".steps li")).toHaveCount(7);
  await noSeriousAxeViolations(page);
});

test("phone width: no horizontal scroll on any page", async ({ page }) => {
  await offlineChain(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["#/listen", "#/studio", "#/instruments", "#/play", "#/chain", "#/how"]) {
    await page.goto(`/${route}`);
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, route).toBeLessThanOrEqual(0);
  }
});
