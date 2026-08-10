import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDay, loadSeason, saveLog } from "../src/lib/store.ts";
import { syntheticSeason } from "./fake-sheet.ts";
import { SHEET_LOG_TAB } from "../src/lib/season.ts";

test("loadSeason reads both tabs in one round trip", async () => {
  const sheet = syntheticSeason({ seed: 11 });
  const season = await loadSeason(sheet);
  assert.equal(sheet.readGets, 1);
  assert.equal(season.records.length, 105);
  assert.equal(season.phases.length, 4);
  assert.equal(season.phases[0].fromWeek, 1);
  assert.equal(season.phases[3].toWeek, 15);
  assert.deepEqual(season.misalignedRows, []);
});

test("loadSeason reports a structurally edited sheet", async () => {
  const sheet = syntheticSeason({ seed: 21 });
  sheet.set(SHEET_LOG_TAB, 30, 0, "1999-01-01");
  const season = await loadSeason(sheet);
  assert.equal(season.misalignedRows.length, 1);
  assert.equal(season.misalignedRows[0].row, 30);
});

test("loadDay refuses a row whose date does not match", async () => {
  const sheet = syntheticSeason({ seed: 22 });
  sheet.set(SHEET_LOG_TAB, 9, 0, "2026-09-09");
  await assert.rejects(() => loadDay(sheet, "2026-08-05"), /row 9/);
});

test("saveLog persists and is immediately readable", async () => {
  const sheet = syntheticSeason({ seed: 12, upTo: "2026-08-01", metricsBlank: true });
  const result = await saveLog(sheet, "2026-08-05", "A", {
    done: true,
    weightKg: 83.1,
    paceSecPerKm: 262,
    durationMin: 48,
    rpe: 8,
    memo: "좋았음",
  });

  assert.equal(result.row, 9);
  assert.equal(result.after.done, true);
  assert.equal(result.written, 5);

  const day = await loadDay(sheet, "2026-08-05");
  assert.equal(day!.A.done, true);
  assert.equal(day!.A.weightKg, 83.1);
  assert.equal(day!.A.paceSecPerKm, 262);
  assert.equal(day!.A.durationMin, 48);
  assert.equal(day!.A.rpe, 8);
  assert.equal(day!.A.memo, "좋았음");
  assert.equal(sheet.get(SHEET_LOG_TAB, 9, 4), "✅ 83.1kg");
});

test("one player's save never touches the other's cells", async () => {
  const sheet = syntheticSeason({ seed: 13, upTo: "2026-08-10" });
  const before = await loadDay(sheet, "2026-08-05");
  await saveLog(sheet, "2026-08-05", "A", { done: true, weightKg: 80, memo: "mine" });
  const after = await loadDay(sheet, "2026-08-05");
  assert.deepEqual(after!.B, before!.B);
});

test("interleaved saves by both players both survive", async () => {
  const sheet = syntheticSeason({ seed: 14, upTo: "2026-08-01", metricsBlank: true });
  await saveLog(sheet, "2026-08-05", "A", { done: true, weightKg: 84 });
  await saveLog(sheet, "2026-08-05", "B", { done: true, weightKg: 77.5 });
  await saveLog(sheet, "2026-08-05", "A", { rpe: 9 });

  const day = await loadDay(sheet, "2026-08-05");
  assert.equal(day!.A.done, true);
  assert.equal(day!.A.weightKg, 84);
  assert.equal(day!.A.rpe, 9);
  assert.equal(day!.B.done, true);
  assert.equal(day!.B.weightKg, 77.5);
});

test("a partial patch preserves untouched fields", async () => {
  const sheet = syntheticSeason({ seed: 15, upTo: "2026-08-01", metricsBlank: true });
  await saveLog(sheet, "2026-08-06", "B", { done: true, weightKg: 78, memo: "first" });
  await saveLog(sheet, "2026-08-06", "B", { rpe: 6 });

  const day = await loadDay(sheet, "2026-08-06");
  assert.equal(day!.B.memo, "first");
  assert.equal(day!.B.weightKg, 78);
  assert.equal(day!.B.rpe, 6);
});

test("out-of-season saves are refused before any write", async () => {
  const sheet = syntheticSeason({ seed: 16 });
  await assert.rejects(() => saveLog(sheet, "2026-07-31", "A", { done: true }), /outside the 15-week season/);
  assert.equal(sheet.writes, 0);
});

test("a no-op save issues zero writes", async () => {
  const sheet = syntheticSeason({ seed: 17, upTo: "2026-08-10" });
  const day = await loadDay(sheet, "2026-08-05");
  const writesBefore = sheet.writes;
  await saveLog(sheet, "2026-08-05", "A", { done: day!.A.done, weightKg: day!.A.weightKg });
  assert.equal(sheet.writes, writesBefore);
});

test("a failed write leaves the sheet untouched", async () => {
  const sheet = syntheticSeason({ seed: 18, upTo: "2026-08-10" });
  const before = await loadDay(sheet, "2026-08-05");
  sheet.failNextWrite = "Sheets API 503";
  await assert.rejects(() => saveLog(sheet, "2026-08-05", "A", { done: !before!.A.done }), /503/);
  const after = await loadDay(sheet, "2026-08-05");
  assert.deepEqual(after, before);
});

test("loadDay returns null outside the season", async () => {
  const sheet = syntheticSeason({ seed: 19 });
  assert.equal(await loadDay(sheet, "2026-11-14"), null);
});

test("every season day is writable and re-readable", async () => {
  const sheet = syntheticSeason({ seed: 20, upTo: "2026-08-01", metricsBlank: true });
  const season = await loadSeason(sheet);
  for (const record of season.records) {
    await saveLog(sheet, record.date, "A", { done: true, rpe: 5 });
  }
  const after = await loadSeason(sheet);
  assert.equal(after.records.filter((r) => r.A.done).length, 105);
  assert.equal(after.records.filter((r) => r.A.rpe === 5).length, 105);
});

test("a blank column A is treated as misaligned, not as aligned", async () => {
  // An inserted row arrives *empty*, so a guard that only checks for a wrong date waves
  // through exactly the case it exists to catch.
  const sheet = syntheticSeason({ seed: 23, upTo: "2026-08-01" });
  sheet.set(SHEET_LOG_TAB, 9, 0, "");
  await assert.rejects(() => loadDay(sheet, "2026-08-05"), /\(blank\)/);
  assert.equal(sheet.writes, 0);

  const season = await loadSeason(sheet);
  assert.equal(season.misalignedRows.length, 1);
  assert.equal(season.misalignedRows[0].row, 9);
});

test("a real row insertion is caught end to end", async () => {
  const sheet = syntheticSeason({ seed: 24, upTo: "2026-08-20" });
  // Shift every row from 20 down by one, leaving row 20 blank — what Sheets does on insert.
  const grid = sheet.tabs.get(SHEET_LOG_TAB)!;
  grid.splice(19, 0, []);
  await assert.rejects(() => saveLog(sheet, "2026-08-16", "A", { done: true }));
  assert.equal(sheet.writes, 0);
});

test("a column inserted inside the data block refuses the write", async () => {
  const sheet = syntheticSeason({ seed: 25, upTo: "2026-08-10" });
  for (const row of sheet.tabs.get(SHEET_LOG_TAB)!) {
    if (row.length > 3) row.splice(3, 0, ""); // insert a column at D
  }
  await assert.rejects(() => saveLog(sheet, "2026-08-05", "A", { done: true }), /column/i);
  assert.equal(sheet.writes, 0);

  const season = await loadSeason(sheet);
  assert.ok(season.misalignedRows.length > 0, "and loadSeason reports it too");
});
