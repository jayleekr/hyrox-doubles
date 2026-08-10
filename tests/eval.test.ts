// Full-season simulation.
//
// Plays all 105 days through the CLI — the exact surface OpenClaw drives: the morning
// brief, both athletes logging, the evening nudge, the Sunday review. An independent
// expectation model tracks what *should* be stored, and the sheet is diffed against it
// at the end. Every emitted string is checked for the failure modes that only show up in
// aggregate: stray markup, "undefined"/"NaN" leaking into user-visible text, and
// unbounded length.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HYROX_JOURNAL = `${process.env.TMPDIR ?? "/tmp"}/hyrox-journal-test-eval.jsonl`;
process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";

const { runCli } = await import("../src/lib/cli.ts");
const { loadSeason, LOG_RANGE } = await import("../src/lib/store.ts");
const { MAX_MESSAGE_CHARS } = await import("../src/lib/messages.ts");
const { gridDateMismatches } = await import("../src/lib/grid.ts");
const { rng, syntheticSeason } = await import("./fake-sheet.ts");
const { FIRST_ROW, LAST_ROW, dateForRow } = await import("../src/lib/season.ts");
const { formatPace } = await import("../src/lib/cells.ts");

type Expected = {
  done: boolean;
  weightKg: number | null;
  paceSecPerKm: number | null;
  durationMin: number | null;
  rpe: number | null;
  memo: string | null;
};

/**
 * One plausible log, as the argv OpenClaw would produce from a chat message, plus what
 * it must leave in the sheet.
 */
function makeLog(
  rand: () => number,
  isRest: boolean,
  body: { weight: number },
): { argv: string[]; expected: Expected } | null {
  if (rand() < 0.08) return null; // silence: nothing logged that day

  const expected: Expected = {
    done: false,
    weightKg: null,
    paceSecPerKm: null,
    durationMin: null,
    rpe: null,
    memo: null,
  };

  if (isRest || rand() < 0.15) {
    return { argv: ["--not-done"], expected };
  }

  expected.done = true;
  const argv: string[] = ["--done"];

  if (rand() < 0.8) {
    // Body weight drifts; it does not resample uniformly overnight. Feeding the CLI
    // implausible jumps would exercise the equipment-load guard instead of the logging
    // path this test is about.
    body.weight = Math.round(Math.min(90, Math.max(70, body.weight + (rand() - 0.5) * 0.6)) * 10) / 10;
    expected.weightKg = body.weight;
    argv.push("--weight", String(body.weight));
  }
  if (rand() < 0.7) {
    const secs = 210 + Math.floor(rand() * 120);
    expected.paceSecPerKm = secs;
    argv.push("--pace", formatPace(secs));
  }
  if (rand() < 0.5) {
    const mins = 30 + Math.floor(rand() * 60);
    expected.durationMin = mins;
    argv.push("--duration", String(mins));
  }
  if (rand() < 0.6) {
    const rpe = 3 + Math.floor(rand() * 8);
    expected.rpe = rpe;
    argv.push("--rpe", String(rpe));
  }
  if (rand() < 0.2) {
    const memo = "컨디션 좋았음";
    expected.memo = memo;
    argv.push("--memo", memo);
  }

  return { argv, expected };
}

function assertEmittable(text: string, where: string) {
  assert.ok(text.length <= MAX_MESSAGE_CHARS, `${where}: ${text.length} chars`);
  assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/, `${where}: leaked a JS value`);
  assert.doesNotMatch(text, /null(?!이|을|은)/, `${where}: leaked a null`);
  // Plain text only: OpenClaw composes the outgoing message, so any tag we emit would
  // either be shown literally or have to be stripped again downstream.
  assert.doesNotMatch(text, /<\/?(b|i|code|pre|a)\b/, `${where}: emitted markup`);
}

test("full 15-week simulation: every logged value lands in the sheet unchanged", async () => {
  const rand = rng(20260801);
  const sheet = syntheticSeason({ seed: 5, upTo: "2026-07-31", metricsBlank: true });
  const emitted: string[] = [];
  const expectations = new Map<string, Expected>();
  const bodies = { a: { weight: 84.0 }, b: { weight: 78.0 } };

  for (let row = FIRST_ROW; row <= LAST_ROW; row++) {
    const date = dateForRow(row)!;

    const morning = await runCli(["brief", "morning", "--date", date], sheet, date);
    assert.equal(morning.code, 0, `morning ${date}: ${morning.out}`);
    assertEmittable(morning.out, `morning ${date}`);
    emitted.push(morning.out);

    const season = await loadSeason(sheet);
    const record = season.records.find((r) => r.date === date)!;

    for (const player of ["a", "b"] as const) {
      const log = makeLog(rand, record.isRest, bodies[player]);
      if (!log) continue;
      const result = await runCli(["log", "--who", player, "--date", date, ...log.argv], sheet, date);
      assert.equal(result.code, 0, `log ${date} ${player}: ${result.out}`);
      assertEmittable(result.out, `log ${date} ${player}`);
      expectations.set(`${date}|${player.toUpperCase()}`, log.expected);
    }

    const nudge = await runCli(["brief", "nudge", "--date", date], sheet, date);
    assert.equal(nudge.code, 0, `nudge ${date}: ${nudge.out}`);
    if (nudge.out) {
      assertEmittable(nudge.out, `nudge ${date}`);
      emitted.push(nudge.out);
    }
  }

  // The sheet must still be row-aligned after ~200 writes.
  const [range] = await sheet.batchGet([LOG_RANGE]);
  assert.deepEqual(gridDateMismatches(range.values), [], "row/date alignment drifted");

  // Diff the sheet against the independent model.
  const final = await loadSeason(sheet);
  let checked = 0;
  for (const [key, expected] of expectations) {
    const [date, player] = key.split("|") as [string, "A" | "B"];
    const log = final.records.find((r) => r.date === date)![player];
    assert.equal(log.done, expected.done, `${key} done`);
    assert.equal(log.weightKg, expected.weightKg, `${key} weight`);
    assert.equal(log.paceSecPerKm, expected.paceSecPerKm, `${key} pace`);
    assert.equal(log.durationMin, expected.durationMin, `${key} duration`);
    assert.equal(log.rpe, expected.rpe, `${key} rpe`);
    assert.equal(log.memo, expected.memo ?? "", `${key} memo`);
    checked++;
  }

  assert.ok(checked > 150, `expected a substantial sample, got ${checked}`);
  assert.ok(emitted.length > 105, "the agent should have had something to say most days");
});

test("re-running the same log is idempotent and costs no extra writes", async () => {
  const sheet = syntheticSeason({ seed: 6, upTo: "2026-07-31", metricsBlank: true });
  const argv = ["log", "--who", "a", "--date", "2026-09-09", "--done", "--weight", "82.4", "--pace", "4:20", "--rpe", "7", "--duration", "55"];

  await runCli(argv, sheet, "2026-09-09");
  const writesAfterFirst = sheet.writes;
  const snapshot = JSON.stringify((await loadSeason(sheet)).records);

  await runCli(argv, sheet, "2026-09-09");
  assert.equal(sheet.writes, writesAfterFirst, "a repeated identical log should write nothing");
  assert.equal(JSON.stringify((await loadSeason(sheet)).records), snapshot);
});

test("a mid-season sheet survives a full read/write/read cycle unchanged where untouched", async () => {
  const sheet = syntheticSeason({ seed: 7, upTo: "2026-10-01" });
  const before = await loadSeason(sheet);

  await runCli(["log", "--who", "b", "--date", "2026-10-02", "--done", "--weight", "76.5"], sheet, "2026-10-02");

  const after = await loadSeason(sheet);
  for (const b of before.records) {
    const a = after.records.find((r) => r.date === b.date)!;
    if (b.date === "2026-10-02") continue;
    assert.deepEqual(a, b, `${b.date} changed but should not have`);
  }
  assert.deepEqual(after.phases, before.phases);
});

test("briefs stay emittable across every day of the season", async () => {
  const sheet = syntheticSeason({ seed: 8, upTo: "2026-11-13", complianceA: 0.5, complianceB: 0.9 });

  for (let row = FIRST_ROW; row <= LAST_ROW; row++) {
    const date = dateForRow(row)!;
    for (const kind of ["morning", "nudge", "weekly"]) {
      const r = await runCli(["brief", kind, "--date", date], sheet, date);
      assert.equal(r.code, 0, `${kind} ${date}: ${r.out}`);
      if (r.out) assertEmittable(r.out, `${kind} ${date}`);
    }
  }
});

test("a pathological free-text memo is capped on the way into the sheet", async () => {
  // Memos are free text typed by the athletes, so nothing upstream bounds their length.
  // The cell encoder caps them at 500 characters, which is what keeps a brief bounded —
  // the message-level clamp is a backstop, not the primary defence.
  const sheet = syntheticSeason({ seed: 10, upTo: "2026-08-31" });
  const memo = "긴 메모입니다. ".repeat(1200);

  const result = await runCli(["log", "--who", "a", "--date", "2026-09-01", "--done", "--memo", memo], sheet, "2026-09-01");
  assert.equal(result.code, 0, result.out);
  assert.ok(result.out.length <= MAX_MESSAGE_CHARS, `reply was ${result.out.length} chars`);

  const stored = (await loadSeason(sheet)).records.find((r) => r.date === "2026-09-01")!.A.memo;
  assert.equal(stored.length, 500, "capped, not stored whole and not rejected");
  assert.ok(memo.startsWith(stored), "the cap keeps a prefix of what was written");
});

test("the sheet stays row-aligned after a full season of agent traffic", async () => {
  const sheet = syntheticSeason({ seed: 9, upTo: "2026-09-01" });
  for (let row = FIRST_ROW; row <= LAST_ROW; row += 7) {
    const date = dateForRow(row)!;
    await runCli(["log", "--who", "a", "--date", date, "--done", "--weight", "82", "--pace", "4:30", "--rpe", "7"], sheet, date);
    await runCli(["log", "--who", "b", "--date", date, "--done", "--weight", "77"], sheet, date);
  }
  const [range] = await sheet.batchGet([LOG_RANGE]);
  assert.deepEqual(gridDateMismatches(range.values), []);
  assert.deepEqual((await loadSeason(sheet)).misalignedRows, []);
});
