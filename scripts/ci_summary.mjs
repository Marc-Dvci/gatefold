// Writes the unit-test count and the coverage per module to the GitHub Actions run page.
import { appendFileSync, readFileSync } from "node:fs";

const v = JSON.parse(readFileSync("vitest.json", "utf8"));
const c = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
const out = ["### Unit and property tests", "", `${v.numPassedTests} passed, ${v.numFailedTests} failed, ${v.numPendingTests} skipped`, ""];
out.push("| Module | Lines | Branches | Functions |", "|---|---|---|---|");
const rows = {};
for (const [file, s] of Object.entries(c)) {
  if (file === "total") continue;
  const m = file
    .split("\\")
    .join("/")
    .match(/src\/(core|chain)\//);
  if (!m) continue;
  const r = (rows[m[1]] ??= { l: [0, 0], b: [0, 0], f: [0, 0] });
  r.l[0] += s.lines.covered;
  r.l[1] += s.lines.total;
  r.b[0] += s.branches.covered;
  r.b[1] += s.branches.total;
  r.f[0] += s.functions.covered;
  r.f[1] += s.functions.total;
}
const pct = ([a, b]) => (b ? ((100 * a) / b).toFixed(1) : "100.0") + " %";
for (const [m, r] of Object.entries(rows)) out.push(`| src/${m} | ${pct(r.l)} | ${pct(r.b)} | ${pct(r.f)} |`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join("\n") + "\n");
else console.log(out.join("\n"));
