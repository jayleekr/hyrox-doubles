// The 목표 및 더블 운영 원칙 tab, and the onboarding report built on top of it.
//
// A target weight is authored once and then read for fifteen weeks, so nobody re-checks
// it. That makes a write to the wrong cell here longer-lived than a wrong daily log — and
// these tests are mostly about the cases where the module refuses to write at all.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HYROX_JOURNAL = `${process.env.TMPDIR ?? "/tmp"}/hyrox-journal-test-goals.jsonl`;
process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";

const { goalMismatches, onboardingReport, parseGoals } = await import("../src/lib/goals.ts");
const { GOAL_RANGE, PHASE_HEADER_RANGE, loadSeason, saveGoalWeight, saveLog } = await import("../src/lib/store.ts");
const { runCli } = await import("../src/lib/cli.ts");
const { syntheticSeason, FakeSheet } = await import("../tests/fake-sheet.ts");
const { SHEET_GOAL_TAB, SHEET_LOG_TAB, SHEET_PHASE_TAB: PHASE_TAB } = await import("../src/lib/season.ts");
const { formatWeightCell, GOAL_WEIGHT_PLACEHOLDER } = await import("../src/lib/cells.ts");

const TODAY = "2026-09-09";
const fresh = (seed = 1) => syntheticSeason({ seed, upTo: "2026-09-08" });

/**
 * A client that answers one range the way the live API does for an all-blank range: a
 * ValueRange with no `values` key at all, rather than `values: []`. Both must take the same
 * branch everywhere, or a defect that reproduces against FakeSheet is dismissed as a
 * fixture artefact (or worse, the other way round).
 */
function withAbsentValues(sheet: InstanceType<typeof FakeSheet>, blankRange: string) {
  return {
    batchGet: async (ranges: string[]) =>
      (await sheet.batchGet(ranges)).map((v) => (v.range === blankRange ? { range: v.range } : v)),
    batchUpdate: (updates: { range: string; value: string }[]) => sheet.batchUpdate(updates),
  };
}

async function goalValues(sheet: InstanceType<typeof FakeSheet>) {
  const [range] = await sheet.batchGet([GOAL_RANGE]);
  return range.values;
}

/** The goal tab as a mutable grid, for the structural-edit cases. */
function goalGrid(sheet: InstanceType<typeof FakeSheet>) {
  return sheet.tabs.get(SHEET_GOAL_TAB)!;
}

// ---------------------------------------------------------------- parsing

test("the authored placeholder reads as empty, and authored prose is preserved", async () => {
  const goals = parseGoals(await goalValues(fresh()));
  assert.equal(goals.bodyWeightKg.A, null, '"[   ] kg" is an empty cell, not a weight');
  assert.equal(goals.bodyWeightKg.B, null);
  // Read as text and never re-rendered: "5분대 후반" is a nuance no pace parser round-trips.
  assert.equal(goals.soloPace.A, "5분대 / km");
  assert.equal(goals.hyroxPace.B, "5분대 후반");
  assert.equal(goals.finish.team, "1시간 05분 ~ 1시간 12분 완주");
});

test("a filled-in bracket parses, and a cell full of other numbers does not", () => {
  const grid = [
    ["구분", "선수 A (Player A)", "선수 B (Player B)"],
    ["대회 일정", "2026.08.01 시작", "2026.08.01 시작"],
    ["몸무게 (Body Weight)", "[  82  ] kg", "2026.08.01 시작"],
  ];
  const goals = parseGoals(grid);
  assert.equal(goals.bodyWeightKg.A, 82, "a human typing inside the bracket still counts");
  assert.equal(goals.bodyWeightKg.B, null, "three numbers and no kg is not a body weight");
});

test("parseGoals never throws on garbage", () => {
  for (const input of [null, undefined, 0, "", [], [null], [[null, undefined]], [{}]]) {
    assert.doesNotThrow(() => parseGoals(input), `${JSON.stringify(input)}`);
  }
  assert.deepEqual(parseGoals([]).bodyWeightKg, { A: null, B: null });
});

test("formatWeightCell restores the sheet's authored empty state on the goal tabs", () => {
  assert.equal(formatWeightCell(82), "82kg");
  assert.equal(formatWeightCell(82.4), "82.4kg");
  assert.equal(formatWeightCell(null), "", "the log tab reads better as a blank column");
  assert.equal(formatWeightCell(null, GOAL_WEIGHT_PLACEHOLDER), "[   ] kg");
});

// ---------------------------------------------------------------- structural anchors

test("an absent goal tab is not reported as a broken one", async () => {
  // Every fixture that predates this tab hits this path, and so does a fresh spreadsheet.
  // Reporting it as misaligned would make the whole season look structurally damaged.
  const sheet = fresh();
  sheet.tabs.delete(SHEET_GOAL_TAB);
  assert.deepEqual(goalMismatches(await goalValues(sheet)), []);
  assert.deepEqual((await loadSeason(sheet)).misalignedRows, []);
});

test("an intact goal tab passes its anchors", async () => {
  assert.deepEqual(goalMismatches(await goalValues(fresh())), []);
  assert.deepEqual((await loadSeason(fresh())).misalignedRows, []);
});

test("a row inserted above 몸무게 is caught", async () => {
  const sheet = fresh();
  goalGrid(sheet).splice(5, 0, []); // insert a row at 6, pushing 몸무게 down to 7
  const bad = goalMismatches(await goalValues(sheet));
  assert.ok(bad.length > 0, "an inserted row must not pass");
  assert.ok(
    bad.some((m) => m.row === 6 && m.column === "A"),
    `the 몸무게 row anchor must fire: ${JSON.stringify(bad)}`,
  );
  assert.equal(bad[0].tab, SHEET_GOAL_TAB, "the mismatch names its tab");
});

test("a column inserted at B is caught, because it would file A's target under B", async () => {
  const sheet = fresh();
  for (const row of goalGrid(sheet)) {
    if (row.length > 1) row.splice(1, 0, "");
  }
  const bad = goalMismatches(await goalValues(sheet));
  assert.ok(
    bad.some((m) => m.column === "B" || m.column === "C"),
    `the write columns must be pinned: ${JSON.stringify(bad)}`,
  );
});

test("a blank anchor cell is a mismatch, not a skip", async () => {
  // An inserted row arrives blank. Skipping blanks would wave through exactly the edit
  // these anchors exist to catch.
  const sheet = fresh();
  sheet.set(SHEET_GOAL_TAB, 6, 0, "");
  const bad = goalMismatches(await goalValues(sheet));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].row, 6);
  assert.equal(bad[0].found, "");
});

// ---------------------------------------------------------------- writing

test("a season target lands in B6 / C6 and is immediately readable", async () => {
  const sheet = fresh();
  const a = await saveGoalWeight(sheet, "A", 82);
  assert.equal(a.written, 1);
  assert.equal(a.before, null);
  assert.equal(a.after, 82);
  assert.equal(a.range, `'${SHEET_GOAL_TAB}'!B6`);

  await saveGoalWeight(sheet, "B", 76.5);
  assert.equal(sheet.get(SHEET_GOAL_TAB, 6, 1), "82kg");
  assert.equal(sheet.get(SHEET_GOAL_TAB, 6, 2), "76.5kg");

  const goals = (await loadSeason(sheet)).goals;
  assert.deepEqual(goals.bodyWeightKg, { A: 82, B: 76.5 });
});

test("one athlete's target never touches the other's cell", async () => {
  const sheet = fresh();
  await saveGoalWeight(sheet, "A", 82);
  assert.equal(sheet.get(SHEET_GOAL_TAB, 6, 2), GOAL_WEIGHT_PLACEHOLDER, "B's cell is untouched");
  assert.deepEqual(
    sheet.writtenCells.map((c) => c.range),
    [`'${SHEET_GOAL_TAB}'!B6`],
  );
});

test("re-writing the same target costs zero writes", async () => {
  const sheet = fresh();
  await saveGoalWeight(sheet, "A", 82);
  const before = sheet.writes;
  const again = await saveGoalWeight(sheet, "A", 82);
  assert.equal(again.written, 0);
  assert.equal(sheet.writes, before);
});

test("clearing a target restores the authored placeholder rather than gutting the cell", async () => {
  const sheet = fresh();
  await saveGoalWeight(sheet, "A", 82);
  const cleared = await saveGoalWeight(sheet, "A", null);
  assert.equal(cleared.after, null);
  assert.equal(sheet.get(SHEET_GOAL_TAB, 6, 1), GOAL_WEIGHT_PLACEHOLDER);

  // And clearing an already-empty cell writes nothing at all.
  const noop = await saveGoalWeight(sheet, "A", null);
  assert.equal(noop.written, 0);
});

test("a write to a goal tab we could not read is refused", async () => {
  // goalMismatches tolerates an empty range so a read stays clean; a write cannot, because
  // an empty read means we do not know where row 6 is.
  const sheet = fresh();
  sheet.tabs.delete(SHEET_GOAL_TAB);
  await assert.rejects(() => saveGoalWeight(sheet, "A", 82), /읽지 못했어/);
  assert.equal(sheet.writes, 0);
});

test("a structurally edited goal tab refuses the write and leaves the sheet untouched", async () => {
  for (const edit of ["row", "column"] as const) {
    const sheet = fresh();
    if (edit === "row") goalGrid(sheet).splice(5, 0, []);
    else for (const row of goalGrid(sheet)) if (row.length > 1) row.splice(1, 0, "");

    await assert.rejects(() => saveGoalWeight(sheet, "A", 82), /행이나 열/, edit);
    assert.equal(sheet.writes, 0, `${edit}: nothing may be written on a refusal`);
  }
});

test("a broken goal tab does not stop the athletes logging their day", async () => {
  // The tabs fail independently on purpose. A mangled goal tab is an onboarding problem;
  // locking out the daily log over it would be a much worse outcome than the bug.
  const sheet = fresh();
  goalGrid(sheet).splice(5, 0, []);
  const r = await saveLog(sheet, TODAY, "A", { done: true, weightKg: 82.4 });
  assert.equal(r.after.done, true);
  assert.equal(r.after.weightKg, 82.4);
});

// ---------------------------------------------------------------- onboarding report

test("the onboarding report names every empty target and the command that fills it", async () => {
  const report = onboardingReport(await loadSeason(fresh()));
  assert.equal(report.complete, false);
  assert.equal(report.stage, "empty");
  assert.equal(report.missing.length, 10, "2 season targets + 4 phases x 2 players");
  assert.deepEqual(report.goal, { A: null, B: null });
  assert.deepEqual(
    report.phases.map((p) => p.row),
    [4, 5, 6, 7],
  );
  for (const m of report.missing) {
    // An absolute path, not the bare word `hyrox`. `setup` prints these under "그대로
    // 실행하면 돼" and the agent execs them verbatim through OpenClaw, whose PATH holds no
    // `hyrox` — so a bare name is exit 127, a code this CLI does not document, whose symptom
    // is indistinguishable from the sheet silently not filling up.
    assert.match(m.command, /^\/.*\/bin\/hyrox goal --who [ab] /, m.command);
    assert.match(m.command, /--weight <kg>$/, m.command);
  }
});

test("the two season goals are required; the eight phase goals are not", async () => {
  // The tiers are the whole point: a pair who set their season goals and declined a phase
  // ladder are *done*. Treating all ten alike left the report permanently red, and a report
  // that can never go green is one both the agent and the athletes learn to skip.
  const report = onboardingReport(await loadSeason(fresh()));
  const tiers = report.missing.map((m) => m.tier);
  assert.deepEqual(tiers.slice(0, 2), ["required", "required"], "the season goals come first");
  assert.equal(tiers.filter((t) => t === "required").length, 2);
  assert.equal(tiers.filter((t) => t === "recommended").length, 8);
  assert.deepEqual(report.progress.required, { filled: 0, total: 2, blocked: false });
  assert.deepEqual(report.progress.recommended, { filled: 0, total: 8, blocked: false });
  assert.deepEqual(report.progress.optional, { filled: { A: 0, B: 0 }, total: 210 });
  for (const m of report.missing.filter((x) => x.tier === "required")) {
    assert.equal(m.where, "goal");
    assert.equal(m.phase, 0);
  }
});

test("onboarding is finished at the two season goals, with the phase ladder still empty", async () => {
  const sheet = fresh();
  await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  await runCli(["goal", "--who", "b", "--weight", "76"], sheet, TODAY);

  const report = onboardingReport(await loadSeason(sheet));
  assert.equal(report.complete, true, "two numbers is the whole requirement");
  assert.equal(report.stage, "ready");
  assert.equal(report.blocked, false);
  assert.deepEqual(report.blockReasons, []);
  assert.equal(report.missing.filter((m) => m.tier === "required").length, 0);
  assert.equal(report.missing.length, 8, "the phase ladder is still offered, just not required");
  assert.deepEqual(report.progress.required, { filled: 2, total: 2, blocked: false });
});

test("one season goal on its own is partial, not ready", async () => {
  const sheet = fresh();
  await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  const report = onboardingReport(await loadSeason(sheet));
  assert.equal(report.stage, "partial");
  assert.equal(report.complete, false, "a goal belongs to one person; A's does not cover B");
  assert.equal(report.progress.required.filled, 1);
  assert.deepEqual(
    report.missing.filter((m) => m.tier === "required").map((m) => m.player),
    ["B"],
  );
  assert.equal(report.byPlayer.A.required.filled, 1);
  assert.equal(report.byPlayer.B.required.filled, 0);
  assert.equal(report.byPlayer.A.goalKg, 82);
});

test("clearing a season goal un-finishes onboarding, because done is derived not stored", async () => {
  const sheet = fresh();
  await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  await runCli(["goal", "--who", "b", "--weight", "76"], sheet, TODAY);
  assert.equal(onboardingReport(await loadSeason(sheet)).complete, true);

  await runCli(["goal", "--who", "b", "--weight", "none"], sheet, TODAY);
  const after = onboardingReport(await loadSeason(sheet));
  assert.equal(after.complete, false, "a hand-cleared goal must reopen the question");
  assert.equal(after.stage, "partial");
});

test("the report shrinks as targets are filled in, and empties out completely", async () => {
  const sheet = fresh();
  await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  await runCli(["goal", "--who", "b", "--weight", "76"], sheet, TODAY);
  assert.equal(onboardingReport(await loadSeason(sheet)).missing.length, 8);

  for (const phase of ["1", "2", "3", "4"]) {
    for (const who of ["a", "b"]) {
      const r = await runCli(["goal", "--who", who, "--phase", phase, "--weight", "80"], sheet, TODAY);
      assert.equal(r.code, 0, r.out);
    }
  }
  const done = onboardingReport(await loadSeason(sheet));
  assert.deepEqual(done.missing, []);
  assert.equal(done.complete, true);
  assert.equal(done.stage, "ready");
  assert.deepEqual(done.progress.recommended, { filled: 8, total: 8, blocked: false });
});

test("per-day targets are counted, never demanded", async () => {
  // 105 days x 2 athletes would keep the report permanently red, and a permanently red
  // report is an ignored one.
  const sheet = fresh();
  const before = onboardingReport(await loadSeason(sheet));
  assert.equal(before.log.days, 105);
  assert.deepEqual(before.log.filled, { A: 0, B: 0 });

  await runCli(["goal", "--who", "a", "--date", TODAY, "--weight", "83"], sheet, TODAY);
  const after = onboardingReport(await loadSeason(sheet));
  assert.deepEqual(after.log.filled, { A: 1, B: 0 });
  assert.equal(after.missing.length, before.missing.length, "a day target changes nothing required");
});

test("a broken goal tab blocks onboarding instead of asking for numbers it would refuse", async () => {
  // The two states have opposite remedies. "Empty" is answered with a number; "misaligned"
  // cannot be, and printing the command anyway sends the agent asking an athlete for a
  // weight that `saveGoalWeight` is about to reject.
  const sheet = fresh();
  goalGrid(sheet).splice(5, 0, []);
  const report = onboardingReport(await loadSeason(sheet));

  assert.equal(report.blocked, true);
  assert.equal(report.stage, "blocked");
  assert.deepEqual(report.blockReasons, ["goal-tab-misaligned"]);
  assert.equal(report.complete, false);
  assert.equal(report.progress.required.blocked, true);
  assert.deepEqual(
    report.missing.filter((m) => m.tier === "required"),
    [],
    "an unreachable cell is not a question",
  );
  assert.ok(report.misaligned.length > 0);

  // And the command really is refused, which is what makes suppressing it the honest call.
  const r = await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  assert.equal(r.code, 2, r.out);
});

test("a stray number on a misaligned goal tab is never read as a finished onboarding", async () => {
  // A column insert can slide an unrelated number into B6/C6. `filled === total` alone would
  // then call onboarding done on values nobody entered as a goal.
  const sheet = fresh();
  await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  await runCli(["goal", "--who", "b", "--weight", "76"], sheet, TODAY);
  for (const row of goalGrid(sheet)) if (row.length > 1) row.splice(1, 0, "82kg");

  const report = onboardingReport(await loadSeason(sheet));
  assert.equal(report.progress.required.filled, 2, "the cells do parse as weights");
  assert.equal(report.complete, false, "but the tab they sit on is not trustworthy");
  assert.equal(report.stage, "blocked");
});

test("a phase tab that could not be read is not eight questions", async () => {
  // parsePhases falls back to DEFAULT_PHASES, whose targets are all null. That emptiness is
  // an artefact of the failed read, not a fact about the sheet — and savePhaseTarget refuses.
  const sheet = fresh();
  sheet.tabs.delete(PHASE_TAB);
  const report = onboardingReport(await loadSeason(sheet));

  assert.deepEqual(report.blockReasons, ["phase-tab-unreadable"]);
  assert.equal(report.progress.recommended.blocked, true);
  assert.deepEqual(report.missing.filter((m) => m.tier === "recommended"), []);
  assert.equal(report.missing.filter((m) => m.tier === "required").length, 2, "the goal tab is fine");
  assert.equal(report.progress.required.blocked, false);
});

test("a row inserted in the phase tab is reported, and reported exactly once", async () => {
  // The row anchor is now part of loadSeason's sweep *and* recomputed here, so a hand-built
  // TargetSource still gets it. Merged rather than concatenated: naming the same cell twice
  // in the ⚠️ block would make one shifted row read like two separate problems.
  const sheet = fresh();
  sheet.tabs.get(PHASE_TAB)!.splice(3, 0, []);
  const season = await loadSeason(sheet);
  const report = onboardingReport(season);

  assert.deepEqual(report.blockReasons, ["phase-tab-misaligned"]);
  assert.deepEqual(report.missing.filter((m) => m.tier === "recommended"), []);
  assert.ok(
    report.misaligned.some((m) => m.tab === PHASE_TAB),
    "the shifted row has to show up in the ⚠️ block",
  );
  assert.deepEqual(
    report.misaligned,
    season.misalignedRows,
    "loadSeason already carries the row anchor, so folding it in must add nothing",
  );
  const cells = report.misaligned.map((m) => `${m.tab}!${m.column}${m.row}`);
  assert.equal(new Set(cells).size, cells.length, `the same cell is named twice: ${cells.join(", ")}`);
});

// ------------------------------------------------ ranges that read back empty
//
// The read path tolerates an empty range and the write path refuses on it. Both halves are
// deliberate; what was missing is the bridge, so `setup` printed commands that always exit 2.

test("an unreadable goal tab blocks the required tier instead of asking for two numbers", async () => {
  // Three ways to reach the same state, because the harm does not depend on how: a deleted
  // tab, a tab present with section 1 blanked (a fresh spreadsheet — init-sheet.mjs never
  // authors this tab), and the live API's own shape for an empty range.
  const edits: [string, (s: InstanceType<typeof FakeSheet>) => void][] = [
    ["tab deleted", (s) => void s.tabs.delete(SHEET_GOAL_TAB)],
    ["section 1 blanked", (s) => { for (let r = 4; r <= 10; r++) goalGrid(s)[r - 1] = []; }],
  ];
  for (const [label, edit] of edits) {
    const sheet = fresh();
    edit(sheet);
    assert.deepEqual(await goalValues(sheet), [], `${label}: the range really is empty`);

    const report = onboardingReport(await loadSeason(sheet));
    assert.deepEqual(report.blockReasons, ["goal-tab-unreadable"], label);
    assert.equal(report.blocked, true, label);
    assert.equal(report.stage, "blocked", label);
    assert.equal(report.progress.required.blocked, true, label);
    assert.deepEqual(
      report.missing.filter((m) => m.tier === "required"),
      [],
      `${label}: a cell no write can reach is not a question`,
    );

    const { code, out } = await runCli(["setup"], sheet, TODAY);
    assert.equal(code, 0, `${label}: setup is a read and still succeeds`);
    assert.match(out, /⚠️/, `${label}: the block must be visible in the text`);
    assert.ok(!out.includes("hyrox goal --who a --weight"), `${label}: the refused command is not printed\n${out}`);
    assert.ok(!out.includes("hyrox goal --who b --weight"), label);

    // And both commands really are refused, which is what makes suppressing them honest.
    for (const who of ["a", "b"]) {
      const w = await runCli(["goal", "--who", who, "--weight", "82"], sheet, TODAY);
      assert.equal(w.code, 2, `${label} ${who}: ${w.out}`);
    }
    assert.equal(sheet.writes, 0, label);
  }
});

test("the live API's empty-range shape blocks the goal tier exactly as an empty array does", async () => {
  const sheet = fresh();
  for (let r = 4; r <= 10; r++) goalGrid(sheet)[r - 1] = [];
  const client = withAbsentValues(sheet, GOAL_RANGE);

  const report = onboardingReport(await loadSeason(client));
  assert.deepEqual(report.blockReasons, ["goal-tab-unreadable"]);
  assert.equal(report.progress.required.blocked, true);

  const { out } = await runCli(["setup"], client, TODAY);
  assert.match(out, /⚠️/);
  const w = await runCli(["goal", "--who", "a", "--weight", "82"], client, TODAY);
  assert.equal(w.code, 2, w.out);
  assert.equal(sheet.writes, 0);
});

test("a blank phase header row blocks the eight phase commands it would refuse", async () => {
  // Clearing row 3's contents leaves rows 4-7 intact, so the body parses and every anchor
  // passes — but savePhaseTarget refuses, because nothing pins D and E to the right athlete.
  // Deleting the row instead shifts the phases and is caught by the row anchor; this is the
  // more common accident and the one that used to slip through.
  const sheet = fresh();
  sheet.tabs.get(PHASE_TAB)![2] = [];

  const report = onboardingReport(await loadSeason(sheet));
  assert.deepEqual(report.blockReasons, ["phase-header-unreadable"]);
  assert.equal(report.progress.recommended.blocked, true);
  assert.deepEqual(report.missing.filter((m) => m.tier === "recommended"), []);
  assert.equal(
    report.missing.filter((m) => m.tier === "required").length,
    2,
    "the goal tab is fine, so its two cells are still askable",
  );

  const { out } = await runCli(["setup"], sheet, TODAY);
  assert.match(out, /⚠️/);
  assert.ok(!out.includes("hyrox goal --who a --phase"), out);

  for (const n of ["1", "2", "3", "4"]) {
    for (const who of ["a", "b"]) {
      const w = await runCli(["goal", "--who", who, "--phase", n, "--weight", "80"], sheet, TODAY);
      assert.equal(w.code, 2, `--phase ${n} --who ${who}: ${w.out}`);
      assert.match(w.out, /헤더/);
    }
  }
  assert.equal(sheet.writes, 0);
});

test("the live API's empty-range shape blocks the phase tier exactly as an empty array does", async () => {
  const sheet = fresh();
  sheet.tabs.get(PHASE_TAB)![2] = [];
  const client = withAbsentValues(sheet, PHASE_HEADER_RANGE);

  const report = onboardingReport(await loadSeason(client));
  assert.deepEqual(report.blockReasons, ["phase-header-unreadable"]);
  assert.equal(report.progress.recommended.blocked, true);
  const w = await runCli(["goal", "--who", "a", "--phase", "1", "--weight", "80"], client, TODAY);
  assert.equal(w.code, 2, w.out);
  assert.equal(sheet.writes, 0);
});

test("an unreadable tab never reports a finished onboarding, however often setup is re-run", async () => {
  // The loop this closes: setup printed two commands, both exited 2, and re-running setup
  // printed the identical instruction — a checklist that could never go green and never
  // named the real cause.
  const sheet = fresh();
  sheet.tabs.delete(SHEET_GOAL_TAB);
  const first = await runCli(["setup"], sheet, TODAY);
  const again = await runCli(["setup"], sheet, TODAY);
  assert.equal(first.out, again.out, "a read command is stable");
  assert.match(first.out, /⚠️/, "and it says what is actually wrong");
  assert.equal(onboardingReport(await loadSeason(sheet)).complete, false);
});

// ------------------------------------------------ authored text in a target cell

test("a hand-authored goal cell is not counted as empty and is not offered as a gap", async () => {
  // parseWeight reads all of these as null, which makes them indistinguishable from the
  // shipped "[   ] kg" placeholder — so the report called the cell 미입력 and invited the
  // very overwrite that destroys what the athlete wrote.
  for (const authored of ["82 (10월까지)", "82~84", "현재 체중 유지", "-3kg 감량"]) {
    const sheet = fresh();
    sheet.set(SHEET_GOAL_TAB, 6, 1, authored);

    const report = onboardingReport(await loadSeason(sheet));
    assert.deepEqual(
      report.unreadableGoalCells.map((c) => [c.player, c.text]),
      [["A", authored]],
      authored,
    );
    assert.deepEqual(
      report.missing.filter((m) => m.tier === "required").map((m) => m.player),
      ["B"],
      `${authored}: A's cell is not a gap the agent can fill by asking`,
    );

    const { out } = await runCli(["setup"], sheet, TODAY);
    assert.match(out, /⚠️/, authored);
    assert.ok(out.includes(authored), `${authored}: the report has to quote what is in the cell\n${out}`);
    assert.ok(!out.includes("hyrox goal --who a --weight"), `${authored}: not offered as a gap\n${out}`);
    assert.doesNotMatch(out, /필수 목표는 다 채워졌어/, `${authored}: onboarding is not finished`);
  }
});

test("a write never silently replaces text a human typed into a target cell", async () => {
  const sheet = fresh();
  sheet.set(SHEET_GOAL_TAB, 6, 1, "82 (10월까지)");

  const r = await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /82 \(10월까지\)/, "the refusal quotes what it refused to destroy");
  assert.match(r.out, /--force/, "and names the one way through");
  assert.equal(sheet.get(SHEET_GOAL_TAB, 6, 1), "82 (10월까지)", "the cell is untouched");
  assert.equal(sheet.writes, 0);

  // Clearing is a write too, and would erase the same text.
  const cleared = await runCli(["goal", "--who", "a", "--weight", "none"], sheet, TODAY);
  assert.equal(cleared.code, 2, cleared.out);
  assert.equal(sheet.writes, 0);

  // --force is the documented override, and only then does the value change.
  const forced = await runCli(["goal", "--who", "a", "--weight", "82", "--force"], sheet, TODAY);
  assert.equal(forced.code, 0, forced.out);
  assert.equal(sheet.get(SHEET_GOAL_TAB, 6, 1), "82kg");
});

test("the placeholder and an empty cell are still ordinary gaps, not authored text", async () => {
  // The guard must not fire on the two states onboarding exists to fill, or it would refuse
  // every first write on a freshly authored sheet.
  for (const empty of ["[   ] kg", "[ ] kg", "[]", "", "   "]) {
    const sheet = fresh();
    sheet.set(SHEET_GOAL_TAB, 6, 1, empty);
    const report = onboardingReport(await loadSeason(sheet));
    assert.deepEqual(report.unreadableGoalCells, [], JSON.stringify(empty));
    const r = await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
    assert.equal(r.code, 0, `${JSON.stringify(empty)}: ${r.out}`);
    assert.equal(sheet.get(SHEET_GOAL_TAB, 6, 1), "82kg");
  }
});

test("a phase target cell with authored text is protected the same way", async () => {
  const sheet = fresh();
  sheet.set(PHASE_TAB, 4, 3, "감량 목표"); // Phase 1, 선수 A

  const r = await runCli(["goal", "--who", "a", "--phase", "1", "--weight", "84"], sheet, TODAY);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /감량 목표/);
  assert.equal(sheet.get(PHASE_TAB, 4, 3), "감량 목표");
  assert.equal(sheet.writes, 0);

  const forced = await runCli(["goal", "--who", "a", "--phase", "1", "--weight", "84", "--force"], sheet, TODAY);
  assert.equal(forced.code, 0, forced.out);
  assert.equal(sheet.get(PHASE_TAB, 4, 3), "84kg");
});

test("the per-day target on the log tab is protected exactly like the other two", async () => {
  // The third write path, and the one that had no guard at all. `saveLog` compares *parsed*
  // values, so "감량 후 재설정" parsed to null, differed from "84kg", and was overwritten —
  // while `before.targetKg` was null too, which made the confirmation say "미입력 → 84kg"
  // about a cell that was not 미입력. That false statement about a destroyed cell is the
  // exact failure the guard on the other two paths was written for, and 210 of the 220
  // writable target cells are on this one.
  const authored = "감량 후 재설정";
  const row = 44; // 2026-09-09
  const F = 5; // B 목표(kg)

  const sheet = fresh();
  sheet.set(SHEET_LOG_TAB, row, F, authored);

  const r = await runCli(["goal", "--who", "b", "--date", TODAY, "--weight", "84"], sheet, TODAY);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /감량 후 재설정/, "the refusal quotes what it refused to destroy");
  assert.match(r.out, /--force/);
  assert.doesNotMatch(r.out, /미입력/, "and never calls an authored cell empty");
  assert.equal(sheet.get(SHEET_LOG_TAB, row, F), authored, "the cell is untouched");
  assert.equal(sheet.writes, 0);

  // Clearing would erase the same text.
  assert.equal((await runCli(["goal", "--who", "b", "--date", TODAY, "--weight", "none"], sheet, TODAY)).code, 2);
  assert.equal(sheet.writes, 0);

  // --force is the documented override here too — and it was previously a silent no-op on
  // this path, because the flag was read and then never passed on.
  const forced = await runCli(["goal", "--who", "b", "--date", TODAY, "--weight", "84", "--force"], sheet, TODAY);
  assert.equal(forced.code, 0, forced.out);
  assert.equal(sheet.get(SHEET_LOG_TAB, row, F), "84kg");
});

test("all three target paths answer identically to the same authored text", async () => {
  // The defect was an asymmetry, so the property worth pinning is the symmetry: one text,
  // three semantically identical cells, three identical answers.
  const authored = "감량 후 재설정";
  const paths: [string, string[], () => InstanceType<typeof FakeSheet>][] = [
    [
      "season goal tab",
      ["goal", "--who", "b", "--weight", "84"],
      () => {
        const s = fresh();
        s.set(SHEET_GOAL_TAB, 6, 2, authored);
        return s;
      },
    ],
    [
      "phase tab",
      ["goal", "--who", "b", "--phase", "1", "--weight", "84"],
      () => {
        const s = fresh();
        s.set(PHASE_TAB, 4, 4, authored);
        return s;
      },
    ],
    [
      "log tab",
      ["goal", "--who", "b", "--date", TODAY, "--weight", "84"],
      () => {
        const s = fresh();
        s.set(SHEET_LOG_TAB, 44, 5, authored);
        return s;
      },
    ],
  ];
  for (const [label, argv, build] of paths) {
    const sheet = build();
    const r = await runCli(argv, sheet, TODAY);
    assert.equal(r.code, 2, `${label}: ${r.out}`);
    assert.equal(sheet.writes, 0, label);
    assert.ok(r.out.includes(authored), `${label}: ${r.out}`);
    assert.match(r.out, /--force/, label);

    const forced = await runCli([...argv, "--force"], sheet, TODAY);
    assert.equal(forced.code, 0, `${label}: ${forced.out}`);
    assert.equal(sheet.writes, 1, label);
  }
});

test("a shifted log row does not pretend the season goals are unwritable", async () => {
  // The tabs refuse independently (store.ts), and this report is about the goal cells. A
  // blanket "everything is broken" would tell the athletes onboarding is dead when the two
  // cells it needs are perfectly writable — and the ⚠️ block still names the real problem.
  const sheet = fresh();
  await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  await runCli(["goal", "--who", "b", "--weight", "76"], sheet, TODAY);
  sheet.set(SHEET_LOG_TAB, 30, 0, "1999-01-01");

  const report = onboardingReport(await loadSeason(sheet));
  assert.equal(report.complete, true, "both season goals really are set");
  assert.deepEqual(report.blockReasons, [], "the goal and phase tabs are intact");
  assert.ok(report.misaligned.length > 0, "but the log problem is still surfaced");

  const { out } = await runCli(["setup"], sheet, TODAY);
  assert.match(out, /⚠️/);
  assert.match(out, /일지|기록/, "the warning names what the log break actually blocks");
});

// ---------------------------------------------------------------- CLI surface

test("goal refuses an ambiguous target instead of picking one", async () => {
  const sheet = fresh();
  const r = await runCli(
    ["goal", "--who", "a", "--phase", "1", "--date", TODAY, "--weight", "80"],
    sheet,
    TODAY,
  );
  assert.equal(r.code, 1);
  assert.match(r.out, /--phase와 --date/);
  assert.equal(sheet.writes, 0);
});

test("goal refuses a phase number that is not a phase", async () => {
  for (const phase of ["0", "5", "9", "1.5", "one", "", "-1"]) {
    const sheet = fresh();
    const r = await runCli(["goal", "--who", "a", "--phase", phase, "--weight", "80"], sheet, TODAY);
    assert.equal(r.code, 1, `--phase ${phase} should have been refused: ${r.out}`);
    assert.match(r.out, /--phase는 1~4/);
    assert.equal(sheet.writes, 0);
  }
});

test("goal refuses an out-of-range or unreadable weight, and writes nothing", async () => {
  const cases: [string, RegExp][] = [
    ["820", /범위 밖/],
    ["12", /범위 밖/],
    ["여든둘", /숫자로 못 읽/],
  ];
  for (const [value, expected] of cases) {
    for (const scope of [[], ["--phase", "1"], ["--date", TODAY]]) {
      const sheet = fresh();
      const r = await runCli(["goal", "--who", "a", ...scope, "--weight", value], sheet, TODAY);
      assert.equal(r.code, 1, `${value} ${scope.join(" ")}: ${r.out}`);
      assert.match(r.out, expected);
      assert.equal(sheet.writes, 0);
    }
  }
});

test("goal needs to know whose target it is, and never guesses", async () => {
  const sheet = fresh();
  const missing = await runCli(["goal", "--weight", "82"], sheet, TODAY);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /--who|--telegram/);

  for (const who of ["j", "Ja", "Jay Lee", "정재", "c"]) {
    const r = await runCli(["goal", "--who", who, "--weight", "82"], sheet, TODAY);
    assert.equal(r.code, 1, `"${who}" should not have resolved: ${r.out}`);
  }
  assert.equal(sheet.writes, 0);
});

test("goal with no weight at all is refused rather than treated as a read", async () => {
  const sheet = fresh();
  const r = await runCli(["goal", "--who", "a"], sheet, TODAY);
  assert.equal(r.code, 1);
  assert.match(r.out, /목표 몸무게가 필요해/);
  assert.equal(sheet.writes, 0);
});

test("an unknown goal subcommand explains itself instead of writing", async () => {
  const sheet = fresh();
  const r = await runCli(["goal", "list"], sheet, TODAY);
  assert.equal(r.code, 1);
  assert.match(r.out, /show/);
  assert.equal(sheet.writes, 0);
});

test("a sheet that refuses the write is exit code 2, not bad input", async () => {
  // Code 1 would tell the agent to re-ask the athlete; code 2 tells it that retrying the
  // same command cannot help and a human has to fix the sheet.
  const sheet = fresh();
  goalGrid(sheet).splice(5, 0, []);
  const r = await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /행이나 열/);
  assert.equal(sheet.writes, 0);
});

test("goal --weight none clears each of the three places in that place's own idiom", async () => {
  const sheet = fresh();
  await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  await runCli(["goal", "--who", "a", "--phase", "1", "--weight", "84"], sheet, TODAY);
  await runCli(["goal", "--who", "a", "--date", TODAY, "--weight", "83"], sheet, TODAY);

  for (const scope of [[], ["--phase", "1"], ["--date", TODAY]]) {
    const r = await runCli(["goal", "--who", "a", ...scope, "--weight", "none"], sheet, TODAY);
    assert.equal(r.code, 0, r.out);
  }
  assert.equal(sheet.get(SHEET_GOAL_TAB, 6, 1), GOAL_WEIGHT_PLACEHOLDER, "goal tab keeps its authored look");
  assert.equal(sheet.get("15주 단계별 요약 (2인)", 4, 3), GOAL_WEIGHT_PLACEHOLDER, "so does the phase tab");
  assert.equal(sheet.get(SHEET_LOG_TAB, 40, 3), "", "the log tab clears to a blank column");
});

// ---------------------------------------------------------------- setup, scoped to a speaker

test("every blocked state carries a ⚠️ in the text, not only in --json", async () => {
  // The agent reads the text far more often than the JSON. A tab that could not be read at
  // all produces no mismatch to name a cell from, so without its own line it would refuse
  // every write while the printed report looked merely incomplete.
  const edits: [string, (s: InstanceType<typeof FakeSheet>) => void][] = [
    ["goal tab row insert", (s) => goalGrid(s).splice(5, 0, [])],
    ["goal tab deleted", (s) => void s.tabs.delete(SHEET_GOAL_TAB)],
    ["goal tab section 1 blanked", (s) => { for (let r = 4; r <= 10; r++) goalGrid(s)[r - 1] = []; }],
    ["phase tab deleted", (s) => void s.tabs.delete(PHASE_TAB)],
    ["phase tab row insert", (s) => s.tabs.get(PHASE_TAB)!.splice(3, 0, [])],
    ["phase tab header row cleared", (s) => void (s.tabs.get(PHASE_TAB)![2] = [])],
  ];
  for (const [label, edit] of edits) {
    const sheet = fresh();
    edit(sheet);
    const report = onboardingReport(await loadSeason(sheet));
    assert.equal(report.blocked, true, label);
    assert.ok(report.blockReasons.length > 0, label);
    const { code, out } = await runCli(["setup"], sheet, TODAY);
    assert.equal(code, 0, `${label}: setup itself is a read and must still succeed`);
    assert.match(out, /⚠️/, `${label}: the block has to be visible in the text`);
    assert.equal(sheet.writes, 0, label);
  }
});

test("every block reason has a ⚠️ line of its own, so none can be added without one", async () => {
  // The gap this closes was structural: `phase-tab-unreadable` had a line and its three
  // siblings did not, so a state that refused every write printed a merely-incomplete report.
  const seen = new Set<string>();
  const edits: ((s: InstanceType<typeof FakeSheet>) => void)[] = [
    (s) => goalGrid(s).splice(5, 0, []),
    (s) => void s.tabs.delete(SHEET_GOAL_TAB),
    (s) => void s.tabs.delete(PHASE_TAB),
    (s) => s.tabs.get(PHASE_TAB)!.splice(3, 0, []),
    (s) => void (s.tabs.get(PHASE_TAB)![2] = []),
  ];
  for (const edit of edits) {
    const sheet = fresh();
    edit(sheet);
    const report = onboardingReport(await loadSeason(sheet));
    for (const reason of report.blockReasons) seen.add(reason);
    const { out } = await runCli(["setup"], sheet, TODAY);
    assert.match(out, /⚠️/, report.blockReasons.join(","));
  }
  assert.deepEqual(
    [...seen].sort(),
    ["goal-tab-misaligned", "goal-tab-unreadable", "phase-header-unreadable", "phase-tab-misaligned", "phase-tab-unreadable"],
    "every BlockReason in the union must be exercised here",
  );
});

test("setup works without knowing who is asking", async () => {
  // Identity is required for a write and optional for this read: the report covers both
  // athletes either way, so demanding --who would just make the checklist harder to reach.
  const r = await runCli(["setup"], fresh(), TODAY);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /필수/);
});

test("setup --telegram addresses your own gap with the id you already sent", async () => {
  process.env.TELEGRAM_USER_A = "tg-jay";
  try {
    const sheet = fresh();
    const { code, out } = await runCli(["setup", "--telegram", "tg-jay"], sheet, TODAY);
    assert.equal(code, 0, out);
    assert.match(out, /네 거/, "the speaker's own gap is called out as theirs");
    assert.ok(out.includes("hyrox goal --telegram tg-jay --weight <kg>"), out);
    // The partner's gap is still listed — otherwise "뭐 남았어?" would never reveal it —
    // but as --who, because that number has to come from the partner.
    assert.ok(out.includes("hyrox goal --who b --weight <kg>"), out);
    assert.equal(sheet.writes, 0);
  } finally {
    delete process.env.TELEGRAM_USER_A;
  }
});

test("setup --who scopes the report without inventing a telegram id", async () => {
  const { out } = await runCli(["setup", "--who", "b"], fresh(), TODAY);
  assert.ok(out.includes("hyrox goal --who b --weight <kg>"), out);
  assert.match(out, /네 거/);
});

test("once your own goal is in, setup points at the partner rather than repeating yours", async () => {
  const sheet = fresh();
  await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  const { out } = await runCli(["setup", "--who", "a"], sheet, TODAY);
  assert.match(out, /네 건 다 됐어/);
  assert.match(out, /정재빈 것만 남았어/);
  assert.ok(out.includes("hyrox goal --who b --weight <kg>"), out);
  assert.doesNotMatch(out, /hyrox goal --who a --weight/, "a filled goal is not re-asked");
});

test("setup with an identity it cannot resolve refuses rather than answering for the wrong person", async () => {
  const sheet = fresh();
  for (const argv of [["setup", "--who", "정재"], ["setup", "--telegram", "nobody"]]) {
    const r = await runCli(argv, sheet, TODAY);
    assert.equal(r.code, 1, `${argv.join(" ")}: ${r.out}`);
  }
  assert.equal(sheet.writes, 0);
});

test("setup --json exposes the fields the agent branches on", async () => {
  const sheet = fresh();
  const report = JSON.parse((await runCli(["setup", "--json"], sheet, TODAY)).out);
  assert.equal(report.stage, "empty");
  assert.equal(report.complete, false);
  assert.equal(report.blocked, false);
  assert.deepEqual(report.blockReasons, []);
  assert.equal(report.progress.required.total, 2);
  assert.equal(report.speaker, null);
  for (const m of report.missing) assert.ok(m.tier === "required" || m.tier === "recommended", m.tier);

  const scoped = JSON.parse((await runCli(["setup", "--who", "a", "--json"], sheet, TODAY)).out);
  assert.equal(scoped.speaker, "A");
});

test("the phase ladder is presented as optional, never as an outstanding requirement", async () => {
  const sheet = fresh();
  await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  await runCli(["goal", "--who", "b", "--weight", "76"], sheet, TODAY);
  const { out } = await runCli(["setup"], sheet, TODAY);

  assert.match(out, /필수 목표는 다 채워졌어/, "two numbers finishes it");
  assert.match(out, /단계별 목표는 선택이야/);
  assert.doesNotMatch(out, /아직 필수/, "nothing outstanding may be claimed once it is done");
});

test("goal show and setup read the sheet without ever writing to it", async () => {
  const sheet = fresh();
  for (const argv of [["goal", "show"], ["goal", "show", "--json"], ["setup"], ["setup", "--json"]]) {
    const r = await runCli(argv, sheet, TODAY);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.out}`);
    assert.ok(r.out.length > 0);
  }
  assert.equal(sheet.writes, 0);
});

test("--json is parseable for both target read commands", async () => {
  const sheet = fresh();
  for (const argv of [["goal", "show", "--json"], ["setup", "--json"]]) {
    const r = await runCli(argv, sheet, TODAY);
    assert.doesNotThrow(() => JSON.parse(r.out), `${argv.join(" ")} was not valid JSON`);
  }
});

test("the text output stays plain, bounded, and free of leaked JS values", async () => {
  const sheet = fresh();
  await runCli(["goal", "--who", "a", "--weight", "82"], sheet, TODAY);
  for (const argv of [["goal", "show"], ["setup"], ["help"]]) {
    const { out } = await runCli(argv, sheet, TODAY);
    assert.ok(out.length <= 4096, `${argv.join(" ")}: ${out.length} chars`);
    assert.doesNotMatch(out, /undefined|NaN|\[object Object\]|null/, `${argv.join(" ")}: leaked a JS value`);
  }

  // Markup is checked only on the blocks the agent relays into chat. `help` is exempt on
  // purpose: its "--who <a|b|이름>" placeholder is a usage string, not an anchor tag, and
  // nobody forwards the help text to Telegram.
  for (const argv of [["goal", "show"], ["setup"]]) {
    const { out } = await runCli(argv, sheet, TODAY);
    assert.doesNotMatch(out, /<\/?(b|i|code|pre|a)\b/, `${argv.join(" ")}: emitted markup`);
  }
});

test("help mentions every new command", async () => {
  const { out } = await runCli(["help"], fresh(), TODAY);
  for (const fragment of ["setup", "goal show", "--phase"]) {
    assert.ok(out.includes(fragment), `help should mention ${fragment}`);
  }
});
