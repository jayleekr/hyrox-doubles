// The two motivation mechanisms, and the invariants that make them worth having.
//
// 1. Team numbers are conjunctive — HYROX Doubles runs all 8km together, so the pair is
//    bounded by its slower half. A mean would let one athlete's good week paper over the
//    other's absence, which is exactly the information the pair needs to see.
// 2. A commitment stated in the morning is quoted back in the evening. An if-then plan that
//    is never revisited barely moves behaviour; the reinforcement is the mechanism.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HYROX_JOURNAL = `${process.env.TMPDIR ?? "/tmp"}/hyrox-journal-test-team.jsonl`;
process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";

const { summarizeTeam } = await import("../src/lib/stats.ts");
const { morningMessage, nudgeMessage } = await import("../src/lib/messages.ts");
const { runCli } = await import("../src/lib/cli.ts");
const { loadSeason } = await import("../src/lib/store.ts");
const { syntheticSeason } = await import("./fake-sheet.ts");

const NAMES = { A: "Jay", B: "정재빈" } as const;
const TODAY = "2026-09-09";
const fresh = (seed = 1) => syntheticSeason({ seed, upTo: "2026-09-08" });

// ---------------------------------------------------------------- conjunctive team maths

test("the team scores only the days both of them trained", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 71, upTo: "2026-08-07", complianceA: 1, complianceB: 0 }));
  const week = season.records.filter((r) => r.date <= "2026-08-07");
  const team = summarizeTeam(week);

  assert.equal(team.bothDone, 0, "one athlete at 100% is still nothing for the team");
  assert.equal(team.completion, 0);
  assert.ok(team.soloDays > 0, "and the sessions that did happen are counted as solo");
  assert.equal(team.behind, "B");
});

test("a team number is never the average of the two", async () => {
  // A at 100% and B at 0% must not read as 50%. This is the whole point.
  const season = await loadSeason(syntheticSeason({ seed: 72, upTo: "2026-08-07", complianceA: 1, complianceB: 0 }));
  const team = summarizeTeam(season.records.filter((r) => r.date <= "2026-08-07"));
  assert.equal(team.completion, 0);
  assert.notEqual(team.completion, 0.5);
});

test("team pace is the slower half, and unknown when either half is unknown", async () => {
  const sheet = syntheticSeason({ seed: 73, upTo: "2026-09-08", metricsBlank: true });
  await runCli(["log", "--who", "a", "--date", "2026-09-07", "--done", "--pace", "4:00"], sheet, "2026-09-07");
  const onlyA = summarizeTeam((await loadSeason(sheet)).records.filter((r) => r.date === "2026-09-07"));
  assert.equal(onlyA.teamPaceSecPerKm, null, "one athlete's pace is not a team pace");

  await runCli(["log", "--who", "b", "--date", "2026-09-07", "--done", "--pace", "6:00"], sheet, "2026-09-07");
  const both = summarizeTeam((await loadSeason(sheet)).records.filter((r) => r.date === "2026-09-07"));
  assert.equal(both.teamPaceSecPerKm, 360, "the pair runs at the slower of the two");
});

test("the both-done streak breaks when either one misses", async () => {
  const sheet = fresh(74);
  for (const d of ["2026-09-05", "2026-09-06", "2026-09-07"]) {
    await runCli(["log", "--who", "a", "--date", d, "--done"], sheet, d);
    await runCli(["log", "--who", "b", "--date", d, "--done"], sheet, d);
  }
  await runCli(["log", "--who", "a", "--date", "2026-09-08", "--done"], sheet, "2026-09-08");
  await runCli(["log", "--who", "b", "--date", "2026-09-08", "--not-done"], sheet, "2026-09-08");

  const upto = (await loadSeason(sheet)).records.filter((r) => r.date <= "2026-09-08");
  assert.equal(summarizeTeam(upto).bothStreak, 0, "A alone does not keep the team streak alive");
});

test("the morning brief shows a team line, not two individual ones", async () => {
  const season = await loadSeason(syntheticSeason({ seed: 75, upTo: "2026-08-07", complianceA: 1, complianceB: 0 }));
  const text = morningMessage(season, "2026-08-08", NAMES);
  assert.match(text, /팀 \d+\/\d+/);
  assert.match(text, /뒤처진 쪽: 정재빈/);
});

// ---------------------------------------------------------------- commitments

test("a commitment round-trips through the sheet", async () => {
  const sheet = fresh(76);
  const r = await runCli(["log", "--who", "a", "--commit", "19:00 헬스장"], sheet, TODAY);
  assert.equal(r.code, 0, r.out);

  const stored = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A.commitment;
  assert.equal(stored, "19:00 헬스장");
});

test("a commitment is stored per athlete, never shared", async () => {
  const sheet = fresh(77);
  await runCli(["log", "--who", "a", "--commit", "19:00 헬스장"], sheet, TODAY);
  await runCli(["log", "--who", "b", "--commit", "06:00 한강"], sheet, TODAY);

  const day = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!;
  assert.equal(day.A.commitment, "19:00 헬스장");
  assert.equal(day.B.commitment, "06:00 한강");
});

test("the morning brief asks whoever has not committed yet, and quotes whoever has", async () => {
  const sheet = fresh(78);
  await runCli(["log", "--who", "a", "--commit", "19:00 헬스장"], sheet, TODAY);
  const season = await loadSeason(sheet);

  const text = morningMessage(season, TODAY, NAMES);
  assert.match(text, /정재빈 — 오늘 몇 시에, 어디서/, "asks the one who has not said");
  assert.match(text, /Jay는 19:00 헬스장 라고 했어/, "and does not re-ask the one who has");
  assert.doesNotMatch(text, /Jay — 오늘 몇 시에/);
});

test("the evening nudge quotes this morning's own words back", async () => {
  // The reinforcement is the mechanism: an unrevisited plan is close to no plan.
  const sheet = fresh(79);
  await runCli(["log", "--who", "a", "--commit", "19:00 헬스장"], sheet, TODAY);
  const season = await loadSeason(sheet);

  const text = nudgeMessage(season, TODAY, NAMES);
  assert.ok(text);
  assert.match(text!, /"19:00 헬스장" 라고 했어/);
});

test("the nudge says the team has nothing when only one of them finished", async () => {
  const sheet = fresh(80);
  await runCli(["log", "--who", "a", "--done"], sheet, TODAY);
  const season = await loadSeason(sheet);

  const text = nudgeMessage(season, TODAY, NAMES);
  assert.ok(text);
  assert.match(text!, /✅ Jay 완료/);
  assert.match(text!, /팀 기록은 아직 0/, "one finisher is not a team result");
});

test("a commitment is not a log: it never marks the day complete", async () => {
  const sheet = fresh(81);
  await runCli(["log", "--who", "a", "--commit", "19:00 헬스장"], sheet, TODAY);
  const day = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!;
  assert.equal(day.A.done, false, "saying you will train is not training");
  assert.equal(day.A.weightKg, null);
});

test("--commit none clears it, and a bare --commit is announced rather than silent", async () => {
  const sheet = fresh(82);
  await runCli(["log", "--who", "a", "--commit", "19:00 헬스장"], sheet, TODAY);

  const bare = await runCli(["log", "--who", "a", "--commit", "--done"], sheet, TODAY);
  assert.equal(bare.code, 0, bare.out);
  assert.match(bare.out, /19:00 헬스장/, "the erased text is quoted back so it is restorable");
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A.commitment, "");

  await runCli(["log", "--who", "a", "--commit", "20:00 집"], sheet, TODAY);
  const cleared = await runCli(["log", "--who", "a", "--commit", "none"], sheet, TODAY);
  assert.equal(cleared.code, 0, cleared.out);
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A.commitment, "");
});

test("writing a commitment leaves every other cell of that day alone", async () => {
  const sheet = fresh(83);
  await runCli(
    ["log", "--who", "a", "--done", "--weight", "82.4", "--pace", "4:20", "--rpe", "7", "--memo", "좋았음"],
    sheet,
    TODAY,
  );
  const before = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A;

  await runCli(["log", "--who", "a", "--commit", "19:00 헬스장"], sheet, TODAY);
  const after = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A;

  assert.deepEqual({ ...after, commitment: "" }, { ...before, commitment: "" });
  assert.equal(after.commitment, "19:00 헬스장");
});
