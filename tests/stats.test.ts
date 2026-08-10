import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGrid, type DayRecord } from "../src/lib/grid.ts";
import { findByDate, missedDays, recordsForWeek, streak, summarize, weekSummaries } from "../src/lib/stats.ts";
import { LOG_RANGE } from "../src/lib/store.ts";
import { syntheticSeason } from "./fake-sheet.ts";

async function records(seed: number, upTo: string): Promise<DayRecord[]> {
  const sheet = syntheticSeason({ seed, upTo });
  const [range] = await sheet.batchGet([LOG_RANGE]);
  return parseGrid(range.values);
}

test("summarize counts only trainable days", async () => {
  const all = await records(31, "2026-08-07");
  const week1 = all.filter((r) => r.week === 1);
  const s = summarize(week1, "A");
  assert.equal(s.planned, 6, "6 trainable days per week, Sunday is rest");
  assert.ok(s.done <= s.planned);
  assert.equal(s.completion, s.done / s.planned);
});

test("an all-rest range reports zero completion without dividing by zero", () => {
  const rest = parseGrid([]).filter((r) => false);
  const s = summarize(rest, "A");
  assert.equal(s.planned, 0);
  assert.equal(s.done, 0);
  assert.equal(s.completion, 0);
  assert.equal(Number.isFinite(s.completion), true);
});

test("weight delta is first-to-last of the logged values", async () => {
  const all = await records(32, "2026-09-30");
  const s = summarize(all, "A");
  assert.ok(s.weightFirst !== null && s.weightLast !== null);
  assert.equal(s.weightDelta, Math.round((s.weightLast! - s.weightFirst!) * 10) / 10);
});

test("weekSummaries covers exactly the 15 weeks present", async () => {
  const all = await records(33, "2026-11-13");
  const weeks = weekSummaries(all, "B");
  assert.equal(weeks.length, 15);
  assert.equal(weeks[0].week, 1);
  assert.equal(weeks[0].from, "2026-08-01");
  assert.equal(weeks.at(-1)!.week, 15);
  assert.equal(weeks.at(-1)!.to, "2026-11-13");
});

test("streak skips rest days and stops at the first miss", () => {
  const all = parseGrid([]);
  // Hand-build a run: Sat done, Sun rest, Mon done, Tue missed.
  const set = (date: string, done: boolean, rest = false) => {
    const r = findByDate(all, date)!;
    r.isRest = rest;
    r.A.done = done;
  };
  set("2026-08-01", true);
  set("2026-08-02", false, true); // rest
  set("2026-08-03", true);
  set("2026-08-04", true);

  assert.equal(streak(all, "A", "2026-08-04"), 3, "rest day does not break the run");

  set("2026-08-03", false);
  assert.equal(streak(all, "A", "2026-08-04"), 1, "an earlier miss ends the count");
  assert.equal(streak(all, "A", "2026-08-01"), 1);
});

test("streak ignores days after the cutoff", () => {
  const all = parseGrid([]);
  findByDate(all, "2026-08-01")!.A.done = true;
  findByDate(all, "2026-08-03")!.A.done = true;
  // Cut off before 08-03: only 08-01 counts, and 08-02 is not rest in an empty grid,
  // so the walk stops there.
  assert.equal(streak(all, "A", "2026-08-01"), 1);
});

test("missedDays lists incomplete trainable days, newest first", async () => {
  // complianceB: 0 guarantees several misses, so the ordering loop actually runs —
  // with the default compliance this week yielded a single miss and asserted nothing.
  const sheet = syntheticSeason({ seed: 34, upTo: "2026-08-07", complianceB: 0 });
  const [range] = await sheet.batchGet([LOG_RANGE]);
  const week1 = parseGrid(range.values).filter((r) => r.week === 1);

  const missed = missedDays(week1, "B", "2026-08-01", "2026-08-07");
  assert.equal(missed.length, 6, "every trainable day of the week is missed");
  for (const r of missed) {
    assert.equal(r.isRest, false);
    assert.equal(r.B.done, false);
  }
  for (let i = 1; i < missed.length; i++) {
    assert.ok(missed[i - 1].date > missed[i].date, "newest first");
  }

  // And the cutoff is respected.
  assert.equal(missedDays(week1, "B", "2026-08-01", "2026-08-03").length, 2);
});

test("recordsForWeek returns the containing week", async () => {
  const all = await records(35, "2026-08-20");
  const week = recordsForWeek(all, "2026-08-12");
  assert.equal(week.length, 7);
  assert.equal(week[0].date, "2026-08-08");
  assert.equal(week.at(-1)!.date, "2026-08-14");
  assert.deepEqual(recordsForWeek(all, "2027-01-01"), []);
});

test("findByDate returns null rather than throwing for unknown dates", async () => {
  const all = await records(36, "2026-08-05");
  assert.equal(findByDate(all, "2026-12-25"), null);
  assert.ok(findByDate(all, "2026-08-05"));
});
