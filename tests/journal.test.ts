// The journal exists to make silence measurable. Every wiring break this project has had was
// invisible until a human said "it isn't answering" — so these tests are mostly about the
// journal staying usable in the conditions where it matters: a corrupt line, a missing file,
// a directory it cannot write to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "hyrox-journal-"));
process.env.HYROX_JOURNAL = join(dir, "journal.jsonl");
process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";

const { record, readJournal, trimJournal, hoursSince, lastOf, lastWrite, missedBriefDays, journalPath } =
  await import("../src/lib/journal.ts");
const { runCli } = await import("../src/lib/cli.ts");
const { loadSeason } = await import("../src/lib/store.ts");
const { syntheticSeason } = await import("./fake-sheet.ts");

const TODAY = "2026-09-09";
const fresh = (seed = 1) => syntheticSeason({ seed, upTo: "2026-09-08", metricsBlank: true });

async function reset() {
  await rm(journalPath(), { force: true });
}

test("a missing journal reads as empty rather than throwing", async () => {
  await reset();
  assert.deepEqual(await readJournal(), []);
});

test("events round-trip", async () => {
  await reset();
  await record({ at: "2026-09-09T01:00:00.000Z", kind: "pulse" });
  await record({ at: "2026-09-09T02:00:00.000Z", kind: "brief", brief: "nudge", date: "2026-09-09", emitted: false });
  const events = await readJournal();
  assert.equal(events.length, 2);
  assert.equal(lastOf(events, "pulse")!.at, "2026-09-09T01:00:00.000Z");
});

test("a half-written final line does not destroy the events before it", async () => {
  // Normal after a crash mid-append. Throwing here would lose the whole history at exactly
  // the moment the history is most wanted.
  await reset();
  await record({ at: "2026-09-09T01:00:00.000Z", kind: "pulse" });
  await writeFile(journalPath(), (await readFile(journalPath(), "utf8")) + '{"at":"2026-09', "utf8");

  const events = await readJournal();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "pulse");
});

test("recording never throws, even when the path cannot be written", async () => {
  const good = process.env.HYROX_JOURNAL;
  process.env.HYROX_JOURNAL = "/proc/definitely/not/writable/journal.jsonl";
  try {
    // A journal that can break the command it records would start refusing training logs on
    // a full disk. Best-effort by design.
    await record({ at: new Date().toISOString(), kind: "pulse" });
  } finally {
    process.env.HYROX_JOURNAL = good;
  }
});

test("trimming keeps the newest entries", async () => {
  await reset();
  for (let i = 0; i < 12; i++) {
    await record({ at: `2026-09-09T00:00:${String(i).padStart(2, "0")}.000Z`, kind: "pulse", note: String(i) });
  }
  await trimJournal(5);
  const events = await readJournal();
  assert.equal(events.length, 5);
  assert.equal((events.at(-1) as { note?: string }).note, "11");
});

test("hoursSince tolerates a missing or unparseable timestamp", () => {
  const now = new Date("2026-09-09T12:00:00.000Z");
  assert.equal(hoursSince("2026-09-09T06:00:00.000Z", now), 6);
  assert.equal(hoursSince(null, now), null);
  assert.equal(hoursSince("not a date", now), null);
});

// ---------------------------------------------------------------- missed scheduled runs

test("a brief that ran with nothing to say still counts as having run", () => {
  // A quiet rest day is a successful run. Counting it as a miss would report a problem every
  // Sunday and train everyone to ignore the report.
  const events = [
    { at: "x", kind: "brief" as const, brief: "nudge", date: "2026-09-07", emitted: false },
    { at: "x", kind: "brief" as const, brief: "nudge", date: "2026-09-08", emitted: true },
  ];
  assert.deepEqual(missedBriefDays(events, "nudge", "2026-09-07", "2026-09-08"), []);
});

test("missing days are named, and only for the brief asked about", () => {
  const events = [
    { at: "x", kind: "brief" as const, brief: "morning", date: "2026-09-07", emitted: true },
    { at: "x", kind: "brief" as const, brief: "morning", date: "2026-09-08", emitted: true },
    { at: "x", kind: "brief" as const, brief: "nudge", date: "2026-09-07", emitted: true },
  ];
  assert.deepEqual(missedBriefDays(events, "nudge", "2026-09-07", "2026-09-08"), ["2026-09-08"]);
  assert.deepEqual(missedBriefDays(events, "morning", "2026-09-07", "2026-09-08"), []);
});

// ---------------------------------------------------------------- the commands

test("pulse records liveness and says nothing more", async () => {
  await reset();
  const r = await runCli(["pulse"], fresh(), TODAY);
  assert.equal(r.code, 0);
  const events = await readJournal();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "pulse");
});

test("a brief records that it ran, whether or not it had anything to say", async () => {
  await reset();
  const sheet = fresh(2);
  await runCli(["brief", "nudge", "--date", "2026-09-06"], sheet, "2026-09-06"); // rest day: silent
  await runCli(["brief", "morning", "--date", TODAY], sheet, TODAY);

  const events = await readJournal();
  const briefs = events.filter((e) => e.kind === "brief");
  assert.equal(briefs.length, 2, "the silent one is recorded too");
});

test("a log write is journalled with the values it replaced", async () => {
  await reset();
  const sheet = fresh(3);
  await runCli(["log", "--who", "a", "--done", "--weight", "82"], sheet, TODAY);

  const w = lastWrite(await readJournal())!;
  assert.equal(w.target, "log");
  assert.equal(w.player, "A");
  assert.equal(w.date, TODAY);
  // The prior values of exactly the fields touched — not the whole row.
  assert.deepEqual(Object.keys(w.undo).sort(), ["done", "weightKg"]);
  assert.equal((w.undo as { weightKg: number | null }).weightKg, null);
});

test("undo puts back what the last write replaced", async () => {
  await reset();
  const sheet = fresh(4);
  await runCli(["log", "--who", "a", "--done", "--weight", "82"], sheet, TODAY);
  await runCli(["log", "--who", "a", "--weight", "91"], sheet, TODAY);

  const before = (await loadSeason(sheet)).records.find((r) => r.date === TODAY)!.A;
  assert.equal(before.weightKg, 91);

  const r = await runCli(["undo"], sheet, TODAY);
  assert.equal(r.code, 0, r.out);

  const after = (await loadSeason(sheet)).records.find((r) => r.date === TODAY)!.A;
  assert.equal(after.weightKg, 82, "back to the value the last write replaced");
  assert.equal(after.done, true, "and the field the last write did not touch is untouched");
});

test("undo only ever steps back one write, never toggles", async () => {
  // The undo is deliberately not journalled: recording it would make the next undo undo the
  // undo, which is a toggle rather than a history.
  await reset();
  const sheet = fresh(5);
  await runCli(["log", "--who", "a", "--weight", "82"], sheet, TODAY);
  await runCli(["log", "--who", "a", "--weight", "91"], sheet, TODAY);
  await runCli(["undo"], sheet, TODAY);
  await runCli(["undo"], sheet, TODAY);

  const after = (await loadSeason(sheet)).records.find((r) => r.date === TODAY)!.A;
  assert.equal(after.weightKg, 82, "a second undo does not put 91 back");
});

test("undo with nothing recorded refuses instead of guessing", async () => {
  await reset();
  const r = await runCli(["undo"], fresh(6), TODAY);
  assert.equal(r.code, 1);
  assert.match(r.out, /되돌릴 기록이 없어/);
});

test("undo --dry-run shows what it would restore and writes nothing", async () => {
  await reset();
  const sheet = fresh(7);
  await runCli(["log", "--who", "a", "--weight", "82"], sheet, TODAY);
  const writes = sheet.writes;

  const r = await runCli(["undo", "--dry-run"], sheet, TODAY);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /되돌릴 대상/);
  assert.equal(sheet.writes, writes, "a dry run writes nothing");
});

test("a meal write can be undone too", async () => {
  await reset();
  const sheet = fresh(8);
  await runCli(["meal", "--who", "a", "--저녁", "연어"], sheet, TODAY);
  await runCli(["meal", "--who", "a", "--저녁", "치킨"], sheet, TODAY);

  await runCli(["undo"], sheet, TODAY);
  const { loadDietDay } = await import("../src/lib/store.ts");
  assert.equal((await loadDietDay(sheet, TODAY))!.A.dinner, "연어");
});

test("a goal write is refused by undo rather than silently doing nothing", async () => {
  await reset();
  const sheet = fresh(9);
  await record({
    at: new Date().toISOString(),
    kind: "write",
    target: "goal",
    date: TODAY,
    player: "A",
    undo: {},
    patch: {},
    cells: 1,
  });
  const r = await runCli(["undo"], sheet, TODAY);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /직접 다시 넣어줘/);
});
