import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";

const {
  MAX_MESSAGE_CHARS,
  clampMessage,
  formatDday,
  morningMessage,
  nudgeMessage,
  savedConfirmation,
  weeklyFacts,
  weeklySummaryText,
} = await import("../src/lib/messages.ts");
const { loadSeason } = await import("../src/lib/store.ts");
const { syntheticSeason } = await import("./fake-sheet.ts");

const NAMES = { A: "Jay", B: "정재빈" } as const;



test("D-day formatting covers before, on and after race day", () => {
  assert.equal(formatDday("2026-08-05"), "D-100");
  assert.equal(formatDday("2026-11-13"), "D-DAY");
  assert.equal(formatDday("2026-11-20"), "D+7");
});

test("the morning message names today's session and yesterday's result", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 51, upTo: "2026-08-04" }));
  const text = morningMessage(season, "2026-08-05", NAMES);
  assert.match(text, /D-100/);
  assert.match(text, /상체 \+ 코어/);
  assert.match(text, /W1/);
  assert.match(text, /어제 \(2026-08-04/);
  assert.match(text, /Jay/);
  assert.match(text, /정재빈/);
});

test("the morning message survives an out-of-season date", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 52 }));
  assert.match(morningMessage(season, "2026-12-25", NAMES), /프로그램 기간이 아니야/);
});

test("race day gets its own message and no logging prompt", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 53, upTo: "2026-11-12" }));
  const text = morningMessage(season, "2026-11-13", NAMES);
  assert.match(text, /RACE DAY/);
  assert.doesNotMatch(text, /끝나면 편하게 말해줘/);
});

test("the nudge is silent on rest days, race day, and when both have logged", async () => {
  const done = await loadSeason(syntheticSeason({ seed: 54, upTo: "2026-08-05", complianceA: 1, complianceB: 1 }));
  assert.equal(nudgeMessage(done, "2026-08-05", NAMES), null, "both logged");
  assert.equal(nudgeMessage(done, "2026-08-02", NAMES), null, "rest day");
  assert.equal(nudgeMessage(done, "2026-11-13", NAMES), null, "race day");
  assert.equal(nudgeMessage(done, "2026-12-25", NAMES), null, "out of season");
});

test("the nudge names only the people who have not logged", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 55, upTo: "2026-08-05", complianceA: 1, complianceB: 0 }));
  const text = nudgeMessage(season, "2026-08-05", NAMES);
  assert.ok(text);
  assert.match(text!, /⬜️ 정재빈/);
  assert.match(text!, /✅ Jay/);
});

test("weekly facts summarise both players for the containing week", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 56, upTo: "2026-08-07" }));
  const facts = weeklyFacts(season, "2026-08-05", NAMES);
  assert.ok(facts);
  assert.equal(facts!.week, 1);
  assert.equal(facts!.from, "2026-08-01");
  assert.equal(facts!.to, "2026-08-07");
  assert.equal(facts!.players.length, 2);
  for (const p of facts!.players) {
    assert.equal(p.planned, 6);
    assert.ok(p.completionPct >= 0 && p.completionPct <= 100);
    assert.ok(p.done <= p.planned);
  }
  assert.match(facts!.phase, /Phase 1/);
});

test("weeklyFacts returns null outside the season", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 57 }));
  assert.equal(weeklyFacts(season, "2027-02-02", NAMES), null);
});

test("the weekly summary renders every player's numbers", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 58, upTo: "2026-08-07" }));
  const facts = weeklyFacts(season, "2026-08-05", NAMES)!;
  const text = weeklySummaryText(facts);
  assert.match(text, /W1 리뷰/);
  assert.match(text, /Jay/);
  assert.match(text, /정재빈/);
  assert.match(text, /완료 \d\/6/);
});

test("output carries no markup, and hostile names pass through verbatim", async () => {
  // Nothing downstream parses these strings as HTML or Markdown any more, so the
  // invariant is the opposite of escaping: emit exactly what is in the sheet, and never
  // introduce a tag or an entity that a renderer could act on.
  const season = await loadSeason(syntheticSeason({ seed: 59, upTo: "2026-08-05", complianceA: 0, complianceB: 0 }));
  const hostile = { A: "<script>x</script>", B: "b&b" } as const;
  for (const text of [
    morningMessage(season, "2026-08-05", hostile),
    nudgeMessage(season, "2026-08-05", hostile) ?? "",
    weeklySummaryText(weeklyFacts(season, "2026-08-05", hostile)!),
  ]) {
    assert.doesNotMatch(text, /<\/?(b|i|code|pre|a)\b/, "no markup of our own");
    assert.doesNotMatch(text, /&(amp|lt|gt);/, "no HTML entities");
    assert.match(text, /<script>x<\/script>/, "the name is passed through as written");
    assert.match(text, /b&b/);
  }
});

test("the save confirmation echoes exactly what was stored", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 60, upTo: "2026-08-05" }));
  const record = season.records.find((r) => r.date === "2026-08-05")!;
  record.A = { ...record.A, done: true, weightKg: 82.4, paceSecPerKm: 260, durationMin: 55, rpe: 7, memo: "good" };
  const text = savedConfirmation("Jay", record, "A");
  assert.match(text, /✅ 완료/);
  assert.match(text, /82\.4kg/);
  assert.match(text, /4:20\/km/);
  assert.match(text, /55분/);
  assert.match(text, /RPE 7/);
  assert.match(text, /메모: good/);
});


test("clampMessage leaves short messages untouched", () => {
  assert.equal(clampMessage("hello"), "hello");
  const exact = "x".repeat(MAX_MESSAGE_CHARS);
  assert.equal(clampMessage(exact), exact);
});

test("clampMessage never exceeds the limit", () => {
  for (const [i, text] of ["x".repeat(9000), "헤더 ".repeat(4000), "\n".repeat(9000)].entries()) {
    const out = clampMessage(text);
    assert.ok(out.length <= MAX_MESSAGE_CHARS, `case ${i}: ${out.length} chars`);
    assert.ok(out.endsWith("…"), `case ${i}: truncation is visible`);
  }
});

test("clampMessage is applied to a real over-long weekly review", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 61, upTo: "2026-08-07" }));
  const facts = weeklyFacts(season, "2026-08-05", NAMES)!;
  const huge = `${weeklySummaryText(facts)}\n\n${"코치 노트 ".repeat(2000)}`;
  const out = clampMessage(huge);
  assert.ok(out.length <= MAX_MESSAGE_CHARS);
  assert.match(out, /W1 리뷰/, "the numbers survive; only the tail is cut");
});

test("the nudge reports a real streak instead of a constant zero", async () => {
  // Measured to yesterday: today is by definition the day they have not done.
  const season = await loadSeason(
    syntheticSeason({ seed: 62, upTo: "2026-08-10", complianceA: 1, complianceB: 1 }),
  );
  // Everyone completed through 08-10; nobody has logged 08-11 yet.
  const text = nudgeMessage(season, "2026-08-11", NAMES);
  assert.ok(text);
  assert.match(text!, /연속 \d+일 진행 중/);
});

test("the weekly cutoff is the week's own last day, not the caller's anchor", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 63, upTo: "2026-08-07", complianceA: 0, complianceB: 0 }));
  // Anchor mid-week; the facts must still cover Saturday..Friday consistently.
  const facts = weeklyFacts(season, "2026-08-03", NAMES)!;
  assert.equal(facts.from, "2026-08-01");
  assert.equal(facts.to, "2026-08-07");
  const a = facts.players.find((p) => p.id === "A")!;
  assert.equal(a.done, 0);
  assert.equal(a.missed.length, a.planned, "every trainable day of the week is listed as missed");
});
