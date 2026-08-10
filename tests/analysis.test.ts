// Numbers that used to be re-derived from --json in every conversation. The point of moving
// them here is that a recomputed number can be wrong differently each time and no test ever
// sees it — so these pin the definitions, especially the ones with a defensible alternative.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HYROX_JOURNAL = `${process.env.TMPDIR ?? "/tmp"}/hyrox-journal-test-analysis.jsonl`;
process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";

const { adherence, paceGap, trend } = await import("../src/lib/stats.ts");
const { parsePaceTarget } = await import("../src/lib/cells.ts");
const { runCli } = await import("../src/lib/cli.ts");
const { loadSeason } = await import("../src/lib/store.ts");
const { syntheticSeason } = await import("./fake-sheet.ts");

const TODAY = "2026-09-09";
const fresh = (seed = 1) => syntheticSeason({ seed, upTo: "2026-09-08", metricsBlank: true });
/**
 * A season with nothing recorded at all — `upTo` before day one, so no row counts as past.
 * `stats` and `trend` read the whole season rather than a filtered range, so anything the
 * fixture pre-fills would drown out the two or three rows a test actually writes.
 */
const empty = (seed = 1) => syntheticSeason({ seed, upTo: "2026-07-31", metricsBlank: true });

// ---------------------------------------------------------------- pace targets

test("a pace target is read out of the free text around it", () => {
  assert.deepEqual(parsePaceTarget("4:15~4:30/km (일정 유지)"), { fastSec: 255, slowSec: 270 });
  assert.deepEqual(parsePaceTarget("빌드업 (4:45 → 4:15/km)"), { fastSec: 255, slowSec: 285 });
  assert.deepEqual(parsePaceTarget("3:40~4:00/km (동반 페이스)"), { fastSec: 220, slowSec: 240 });
});

test("days prescribed by effort or not at all have no pace target", () => {
  // Returning a number here would invent a target the programme never set, and then report
  // the athlete as behind it.
  for (const raw of ["RPE 7~8 (근지구력)", "RPE 2~3 (회복 중심)", "Rest", "", null, undefined]) {
    assert.equal(parsePaceTarget(raw), null, `${JSON.stringify(raw)} should carry no target`);
  }
});

test("a clock-like number outside running range is not a pace", () => {
  // 1:05 is a finish time, far faster than any per-km pace, so it is rejected by bounds.
  // Note that "8:00" is NOT rejected and should not be: 8:00/km is a real jogging pace, and
  // nothing in the text distinguishes it from eight o'clock.
  assert.equal(parsePaceTarget("1:05 완주 목표"), null, "a finish time");
  assert.equal(parsePaceTarget("20:00 시작"), null, "beyond walking pace");
});

// ---------------------------------------------------------------- adherence

test("adherence separates trained days from days the programme was trained", async () => {
  const sheet = empty(2);
  // Three completions, two of them substitutions.
  await runCli(["log", "--who", "a", "--date", "2026-09-04", "--done"], sheet, "2026-09-04");
  await runCli(["log", "--who", "a", "--date", "2026-09-05", "--done", "--alt", "크로스핏 WOD"], sheet, "2026-09-05");
  await runCli(["log", "--who", "a", "--date", "2026-09-07", "--done", "--alt", "헬스장 루틴"], sheet, "2026-09-07");

  const records = (await loadSeason(sheet)).records.filter((r) => r.date >= "2026-09-01" && r.date <= "2026-09-07");
  const a = adherence(records, "A");
  assert.equal(a.done, 3);
  assert.equal(a.asPrescribed, 1);
  assert.equal(a.substituted, 2);
  assert.ok(Math.abs(a.rate - 1 / 3) < 1e-9);
});

test("every completion being a substitution reads as 0%, not as 100% completion", async () => {
  // The failure this exists to catch: five ✅ that are all substitutes.
  const sheet = empty(3);
  for (const d of ["2026-09-04", "2026-09-05", "2026-09-07"]) {
    await runCli(["log", "--who", "a", "--date", d, "--done", "--alt", "자기 루틴"], sheet, d);
  }
  const records = (await loadSeason(sheet)).records.filter((r) => r.date >= "2026-09-01" && r.date <= "2026-09-07");
  const a = adherence(records, "A");
  assert.equal(a.rate, 0);
  assert.equal(a.done, 3, "they did train — this is not a completion failure");
});

test("adherence with nothing done is 0, not a division by zero", () => {
  assert.equal(adherence([], "A").rate, 0);
});

// ---------------------------------------------------------------- pace gap

test("the gap is measured against the slower end of the prescribed range", async () => {
  // Being at 4:30 on a "4:15~4:30" day is on target, not 15 seconds late: the range is what
  // the programme will accept.
  const sheet = fresh(4);
  await runCli(["log", "--who", "a", "--date", "2026-09-07", "--done", "--pace", "4:30"], sheet, "2026-09-07");
  const records = (await loadSeason(sheet)).records.filter((r) => r.date === "2026-09-07");
  const target = parsePaceTarget(records[0].paceTarget);
  if (!target) return; // that weekday carries no pace target in the fixture

  const gap = paceGap(records, "A");
  assert.equal(gap.targetSecPerKm, target.slowSec);
  assert.equal(gap.behindSec, 270 - target.slowSec);
});

test("no measured pace means no gap, not a gap of zero", async () => {
  const sheet = fresh(5);
  const records = (await loadSeason(sheet)).records.filter((r) => r.date >= "2026-09-01" && r.date <= "2026-09-07");
  const gap = paceGap(records, "A");
  assert.equal(gap.actualSecPerKm, null);
  assert.equal(gap.behindSec, null, "unknown is not on-target");
  assert.ok(gap.daysWithTarget > 0, "but the days that asked for one are still counted");
});

// ---------------------------------------------------------------- trend

test("a trend compares two windows and is null until both have data", async () => {
  const sheet = empty(6);
  await runCli(["log", "--who", "a", "--date", "2026-09-07", "--done", "--weight", "82"], sheet, "2026-09-07");

  const records = (await loadSeason(sheet)).records;
  const oneWindow = trend(records, "A", "weightKg", TODAY, 7);
  assert.equal(oneWindow.priorAvg, null);
  assert.equal(oneWindow.delta, null, "one window is not a trend");

  await runCli(["log", "--who", "a", "--date", "2026-08-29", "--done", "--weight", "84"], sheet, "2026-08-29");
  const both = trend((await loadSeason(sheet)).records, "A", "weightKg", TODAY, 7);
  assert.equal(both.recentAvg, 82);
  assert.equal(both.priorAvg, 84);
  assert.equal(both.delta, -2, "losing 2kg reads as negative");
});

// ---------------------------------------------------------------- the command

test("stats reports adherence and the gap without being asked twice", async () => {
  const sheet = empty(7);
  await runCli(["log", "--who", "a", "--date", "2026-09-07", "--done", "--alt", "크로스핏"], sheet, "2026-09-07");
  const r = await runCli(["stats", "--who", "a"], sheet, TODAY);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /프로그램대로 0\/1/);
  assert.match(r.out, /대체 1/);
});

test("stats --json carries the same numbers for the agent to compute with", async () => {
  const sheet = empty(8);
  await runCli(["log", "--who", "a", "--date", "2026-09-07", "--done", "--alt", "크로스핏"], sheet, "2026-09-07");
  const r = await runCli(["stats", "--who", "a", "--json"], sheet, TODAY);
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  assert.equal(d.adherence.substituted, 1);
  assert.equal(d.adherence.asPrescribed, 0);
  assert.ok("paceGap" in d);
  assert.ok("trend" in d && "weight" in d.trend && "pace" in d.trend);
});
