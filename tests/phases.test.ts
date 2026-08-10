// The 15주 단계별 요약 tab's D/E columns, and the log tab's D/F columns.
//
// The dangerous property here is that `parsePhases` skips rows it cannot read, so the
// array index does not track the sheet row. Anything keyed on the index would write Phase
// 2's target onto Phase 3 the moment one row went unparseable — and nobody would notice,
// because a target weight is written once and read for fifteen weeks.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";

const {
  DEFAULT_PHASES,
  isSheetBacked,
  parsePhases,
  phaseByNumber,
  phaseHeaderMismatches,
  phaseRowMismatches,
} = await import("../src/lib/phases.ts");
const { PHASE_RANGE, PHASE_HEADER_RANGE, loadDay, loadSeason, saveLog, saveLogTarget, savePhaseTarget } =
  await import("../src/lib/store.ts");
const { runCli } = await import("../src/lib/cli.ts");
const { syntheticSeason, FakeSheet } = await import("../tests/fake-sheet.ts");
const { SHEET_LOG_TAB, SHEET_PHASE_TAB } = await import("../src/lib/season.ts");
const { GOAL_WEIGHT_PLACEHOLDER } = await import("../src/lib/cells.ts");

const TODAY = "2026-09-09";
const fresh = (seed = 1) => syntheticSeason({ seed, upTo: "2026-09-08" });

type Sheet = InstanceType<typeof FakeSheet>;

const phaseGrid = (sheet: Sheet) => sheet.tabs.get(SHEET_PHASE_TAB)!;

async function phaseValues(sheet: Sheet) {
  const [body] = await sheet.batchGet([PHASE_RANGE]);
  return body.values;
}

// ---------------------------------------------------------------- row identity

test("every parsed phase carries the sheet row it came from", async () => {
  const phases = parsePhases(await phaseValues(fresh()));
  assert.deepEqual(
    phases.map((p) => p.row),
    [4, 5, 6, 7],
  );
  assert.ok(phases.every(isSheetBacked));
});

test("a skipped row shifts the array but never the row numbers", async () => {
  // This is the regression. Blank out Phase 2's period so it cannot be parsed: the
  // survivors move down one index, and index 1 is now Phase 3 — which lives on row 6.
  const sheet = fresh();
  sheet.set(SHEET_PHASE_TAB, 5, 1, "기간 미상");
  const phases = parsePhases(await phaseValues(sheet));

  assert.equal(phases.length, 3);
  assert.match(phases[1].name, /Phase 3/, "the array index has shifted");
  assert.equal(phases[1].row, 6, "but the row it names has not");
  assert.equal(phaseByNumber(phases, 2), null, "and Phase 2 is simply absent, not silently Phase 3");
  assert.match(phaseByNumber(phases, 3)!.name, /Phase 3/);
});

test("a DEFAULT_PHASES fallback is not sheet-backed", () => {
  const fallback = parsePhases([]);
  assert.equal(fallback, DEFAULT_PHASES, "an unreadable tab falls back");
  assert.ok(fallback.every((p) => !isSheetBacked(p)), "and nothing in the fallback claims a row");
  assert.equal(fallback.every((p) => p.row === 0), true);
});

test("phaseRowMismatches catches a row inserted in the phase tab", async () => {
  const sheet = fresh();
  phaseGrid(sheet).splice(3, 0, []); // insert at row 4; Phase 1 slides to row 5
  const bad = phaseRowMismatches(parsePhases(await phaseValues(sheet)));

  assert.ok(bad.length > 0);
  // Row 5 now holds Phase 1 where Phase 2 belongs — the exact confusion a --phase 2 write
  // would otherwise commit.
  const atRow5 = bad.find((m) => m.row === 5)!;
  assert.match(atRow5.expected, /Phase 2/);
  assert.match(atRow5.found, /Phase 1/);
});

test("an intact phase tab passes both of its anchors", async () => {
  const sheet = fresh();
  const [body, header] = await sheet.batchGet([PHASE_RANGE, PHASE_HEADER_RANGE]);
  assert.deepEqual(phaseRowMismatches(parsePhases(body.values)), []);
  assert.deepEqual(phaseHeaderMismatches(header.values), []);
  assert.deepEqual((await loadSeason(sheet)).misalignedRows, []);
});

test("the phase header anchors distinguish the two athletes' columns", async () => {
  // D3/E3 both contain 목표 and 몸무게, so anchoring on those would wave through a D↔E
  // swap that files one athlete's target under the other's name.
  const sheet = fresh();
  sheet.set(SHEET_PHASE_TAB, 3, 3, "선수 B 목표몸무게");
  sheet.set(SHEET_PHASE_TAB, 3, 4, "선수 A 목표몸무게");
  const [header] = await sheet.batchGet([PHASE_HEADER_RANGE]);
  const bad = phaseHeaderMismatches(header.values);
  assert.equal(bad.length, 2, `a swapped pair must not pass: ${JSON.stringify(bad)}`);
});

test("a phase tab with no header row is not reported as broken on read", async () => {
  const sheet = fresh();
  phaseGrid(sheet)[2] = [];
  const [header] = await sheet.batchGet([PHASE_HEADER_RANGE]);
  assert.deepEqual(phaseHeaderMismatches(header.values), []);
  const season = await loadSeason(sheet);
  assert.deepEqual(season.misalignedRows, [], "a missing header is not a *mismatch*");
  // But it is unreadable, and every phase write is refused on it. The read tolerance and
  // the write refusal used to be two facts nothing connected; this flag is that connection.
  assert.equal(season.phaseHeaderReadable, false);
  assert.equal(season.goalTabReadable, true, "the goal tab is untouched here");
});

test("loadSeason carries the phase tab's row anchor, so goal show cannot read a shifted tab as clean", async () => {
  // The row anchor used to live only inside onboardingReport, so `setup` warned about a
  // shifted phase tab while `goal show` — the one command whose job is to say which phase is
  // which — printed no ⚠️, relabelled three phases one slot down and dropped Phase 4.
  const sheet = fresh();
  phaseGrid(sheet).splice(3, 0, []); // a row inserted above Phase 1

  const season = await loadSeason(sheet);
  assert.ok(
    season.misalignedRows.some((m) => m.tab === SHEET_PHASE_TAB),
    "the row anchor belongs to the sweep every read surface renders",
  );

  const shown = await runCli(["goal", "show"], sheet, TODAY);
  assert.equal(shown.code, 0, shown.out);
  assert.match(shown.out, /⚠️/, "goal show must not report a clean sheet");
  assert.match(shown.out, new RegExp(SHEET_PHASE_TAB.replace(/[()]/g, "\\$&")));
  // And a name that no longer matches its slot is labelled with the slot it is sitting in,
  // rather than printed bare as if it belonged there.
  assert.match(shown.out, /Phase 2 자리에 "Phase 1/);

  const json = JSON.parse((await runCli(["goal", "show", "--json"], sheet, TODAY)).out);
  assert.ok(json.misaligned.length > 0, "the machine-readable field said [] while setup said blocked");

  // setup and goal show now agree, on the same sheet in the same session.
  const viaSetup = JSON.parse((await runCli(["setup", "--json"], sheet, TODAY)).out);
  assert.equal(json.misaligned.length, viaSetup.misaligned.length);
  assert.equal(sheet.writes, 0);
});

test("an intact phase tab keeps the row anchor silent on every read surface", async () => {
  const sheet = fresh();
  assert.deepEqual((await loadSeason(sheet)).misalignedRows, []);
  const shown = await runCli(["goal", "show"], sheet, TODAY);
  assert.doesNotMatch(shown.out, /⚠️/, "a healthy sheet must not grow a warning");
  assert.doesNotMatch(shown.out, /자리에/, "nor a slot label");

  // The DEFAULT_PHASES fallback must not fire the row anchor either: those four rows are an
  // artefact of a failed read, so they would misalign trivially and warn about nothing.
  const fallback = fresh();
  fallback.tabs.delete(SHEET_PHASE_TAB);
  assert.deepEqual((await loadSeason(fallback)).misalignedRows, []);
});

// ---------------------------------------------------------------- phase writes

test("a phase target lands on the row that phase actually occupies", async () => {
  const sheet = fresh();
  const r = await savePhaseTarget(sheet, 3, "A", 81);
  assert.equal(r.written, 1);
  assert.equal(r.range, `'${SHEET_PHASE_TAB}'!D6`, "Phase 3 is row 6");
  assert.equal(r.phase!.row, 6);
  assert.equal(sheet.get(SHEET_PHASE_TAB, 6, 3), "81kg");

  const b = await savePhaseTarget(sheet, 3, "B", 75);
  assert.equal(b.range, `'${SHEET_PHASE_TAB}'!E6`);
  assert.equal(sheet.get(SHEET_PHASE_TAB, 6, 3), "81kg", "A's cell is untouched");
  assert.equal(sheet.get(SHEET_PHASE_TAB, 6, 4), "75kg");
});

test("all four phases round-trip through the sheet", async () => {
  const sheet = fresh();
  for (const n of [1, 2, 3, 4] as const) {
    await savePhaseTarget(sheet, n, "A", 80 + n);
    await savePhaseTarget(sheet, n, "B", 70 + n);
  }
  const phases = (await loadSeason(sheet)).phases;
  assert.deepEqual(
    phases.map((p) => [p.row, p.targetKgA, p.targetKgB]),
    [
      [4, 81, 71],
      [5, 82, 72],
      [6, 83, 73],
      [7, 84, 74],
    ],
  );
});

test("re-writing the same phase target costs zero writes, and clearing restores the placeholder", async () => {
  const sheet = fresh();
  await savePhaseTarget(sheet, 1, "A", 84);
  const before = sheet.writes;
  assert.equal((await savePhaseTarget(sheet, 1, "A", 84)).written, 0);
  assert.equal(sheet.writes, before);

  await savePhaseTarget(sheet, 1, "A", null);
  assert.equal(sheet.get(SHEET_PHASE_TAB, 4, 3), GOAL_WEIGHT_PLACEHOLDER);
});

test("a phase write is refused when the tab fell back to defaults", async () => {
  // The header is intact, so the header check passes — but every phase row is unreadable,
  // so `parsePhases` returned DEFAULT_PHASES. Writing D4 here would write to a sheet the
  // app never actually read.
  const sheet = fresh();
  for (const row of [4, 5, 6, 7]) sheet.set(SHEET_PHASE_TAB, row, 1, "미정");
  await assert.rejects(() => savePhaseTarget(sheet, 1, "A", 84), /기본값으로 대체/);
  assert.equal(sheet.writes, 0);
});

test("a phase write is refused when a row was inserted", async () => {
  const sheet = fresh();
  phaseGrid(sheet).splice(3, 0, []);
  await assert.rejects(() => savePhaseTarget(sheet, 2, "A", 84), /행이나 열/);
  assert.equal(sheet.writes, 0);
});

test("a phase write is refused when a column was inserted", async () => {
  const sheet = fresh();
  for (const row of phaseGrid(sheet)) {
    if (row.length > 3) row.splice(3, 0, "");
  }
  await assert.rejects(() => savePhaseTarget(sheet, 1, "A", 84), /행이나 열/);
  assert.equal(sheet.writes, 0);
});

test("a phase write is refused when the header row is missing entirely", async () => {
  // Reading tolerates a missing header; writing cannot. With no row 3 there is nothing
  // pinning D and E, so a column edit in this tab would be invisible.
  const sheet = fresh();
  phaseGrid(sheet)[2] = [];
  await assert.rejects(() => savePhaseTarget(sheet, 1, "A", 84), /헤더/);
  assert.equal(sheet.writes, 0);
});

test("a broken phase tab does not stop the athletes logging their day", async () => {
  const sheet = fresh();
  phaseGrid(sheet).splice(3, 0, []);
  const r = await saveLog(sheet, TODAY, "A", { done: true, weightKg: 82.4 });
  assert.equal(r.after.weightKg, 82.4);
});

// ---------------------------------------------------------------- log tab D/F

test("a per-day target lands in D or F and survives a later log", async () => {
  const sheet = fresh();
  const r = await saveLogTarget(sheet, TODAY, "A", 83);
  assert.equal(r.written, 1);
  assert.equal(r.range, `'${SHEET_LOG_TAB}'!D44`);
  assert.equal(sheet.get(SHEET_LOG_TAB, 44, 3), "83kg");

  await saveLog(sheet, TODAY, "A", { done: true, weightKg: 82.4 });
  const day = await loadDay(sheet, TODAY);
  assert.equal(day!.A.targetKg, 83, "the target outlived the status write");
  assert.equal(day!.A.weightKg, 82.4);
});

test("a per-day target never touches the other athlete or the measured weight", async () => {
  const sheet = fresh();
  const before = await loadDay(sheet, TODAY);
  await saveLogTarget(sheet, TODAY, "B", 76);
  const after = await loadDay(sheet, TODAY);

  assert.deepEqual(after!.A, before!.A, "A is untouched");
  assert.equal(after!.B.targetKg, 76);
  assert.equal(after!.B.weightKg, before!.B.weightKg, "the measured weight is a different cell");
  assert.equal(after!.B.done, before!.B.done);
  assert.deepEqual(
    sheet.writtenCells.map((c) => c.range),
    [`'${SHEET_LOG_TAB}'!F44`],
  );
});

test("an ordinary log leaves the target columns alone", async () => {
  const sheet = fresh();
  await saveLogTarget(sheet, TODAY, "A", 83);
  const writesBefore = sheet.writes;
  await saveLog(sheet, TODAY, "A", { done: true, rpe: 7, memo: "ok" });
  assert.equal(sheet.get(SHEET_LOG_TAB, 44, 3), "83kg");
  assert.ok(sheet.writes > writesBefore, "the log itself still wrote");
  assert.ok(
    !sheet.writtenCells.slice(1).some((c) => c.range.includes("!D")),
    "but nothing touched column D again",
  );
});

test("a per-day target is refused when the log tab is structurally edited", async () => {
  const sheet = fresh();
  for (const row of sheet.tabs.get(SHEET_LOG_TAB)!) {
    if (row.length > 3) row.splice(3, 0, ""); // insert a column at D
  }
  const r = await runCli(["goal", "--who", "a", "--date", TODAY, "--weight", "83"], sheet, TODAY);
  assert.equal(r.code, 2, r.out);
  assert.equal(sheet.writes, 0);
});

test("a per-day target outside the season is refused as bad input", async () => {
  for (const date of ["2026-07-31", "2026-11-14"]) {
    const sheet = fresh();
    const r = await runCli(["goal", "--who", "a", "--date", date, "--weight", "83"], sheet, TODAY);
    assert.equal(r.code, 1, `${date}: ${r.out}`);
    assert.match(r.out, /프로그램 밖/);
    assert.equal(sheet.writes, 0);
  }
});

test("a target weight is not subject to the equipment-load jump check", async () => {
  // The 10kg guard compares against the last *measured* weight, which is meaningless for a
  // plan: an athlete targeting 12kg below where they are today is the normal case.
  const sheet = fresh();
  await runCli(["log", "--who", "a", "--done", "--weight", "94", "--date", "2026-09-08"], sheet, "2026-09-08");
  const r = await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  assert.equal(r.code, 0, r.out);
  assert.equal((await loadSeason(sheet)).goals.bodyWeightKg.A, 82);
});
