import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HYROX_JOURNAL = `${process.env.TMPDIR ?? "/tmp"}/hyrox-journal-test-grid.jsonl`;
import {
  applyPatch,
  buildUpdates,
  emptyPlayerLog,
  gridDateMismatches,
  parseGrid,
  type PlayerLog,
} from "../src/lib/grid.ts";
import { FIRST_ROW, LAST_ROW, SEASON_START, RACE_DATE } from "../src/lib/season.ts";
import { FakeSheet, syntheticSeason } from "./fake-sheet.ts";
import { SHEET_LOG_TAB } from "../src/lib/season.ts";
import { LOG_RANGE } from "../src/lib/store.ts";

async function gridFrom(sheet: FakeSheet) {
  const [range] = await sheet.batchGet([LOG_RANGE]);
  return range.values;
}

test("an empty sheet still yields one record per season day", () => {
  const records = parseGrid([]);
  assert.equal(records.length, 105);
  assert.equal(records[0].date, SEASON_START);
  assert.equal(records[0].row, FIRST_ROW);
  assert.equal(records.at(-1)!.date, RACE_DATE);
  assert.equal(records.at(-1)!.row, LAST_ROW);
  assert.deepEqual(records[0].A, emptyPlayerLog());
});

test("truncated rows from the API do not shift columns", async () => {
  const sheet = syntheticSeason({ seed: 1, upTo: "2026-08-03" });
  const values = await gridFrom(sheet);
  // The API drops trailing empties, so later rows are short.
  assert.ok((values as unknown[][]).some((r) => r.length < 20));
  const records = parseGrid(values);
  assert.equal(records.length, 105);
  assert.equal(records[0].date, "2026-08-01");
  assert.equal(records[0].area, "HYROX 더블 콤보");
  assert.equal(records[1].isRest, true);
});

test("dates come from the row number, and column A is only a cross-check", async () => {
  const sheet = syntheticSeason({ seed: 2 });
  assert.deepEqual(gridDateMismatches(await gridFrom(sheet)), []);

  sheet.set(SHEET_LOG_TAB, 10, 0, "1999-01-01");
  const bad = gridDateMismatches(await gridFrom(sheet));
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0], { row: 10, column: "A", expected: "2026-08-06", found: "1999-01-01" });
  // The record still uses the row-derived date.
  const records = parseGrid(await gridFrom(sheet));
  assert.equal(records.find((r) => r.row === 10)!.date, "2026-08-06");
});

test("rest days and race day are flagged", async () => {
  const records = parseGrid(await gridFrom(syntheticSeason({ seed: 3 })));
  assert.equal(records.find((r) => r.date === "2026-08-02")!.isRest, true);
  assert.equal(records.find((r) => r.date === "2026-08-03")!.isRest, false);
  const race = records.at(-1)!;
  assert.equal(race.isRaceDay, true);
  assert.equal(race.isRest, false);
});

test("applyPatch: undefined leaves alone, null clears, invalid preserves", () => {
  const base: PlayerLog = {
    done: true,
    weightKg: 82,
    targetKg: null,
    paceSecPerKm: 260,
    durationMin: 55,
    rpe: 7,
    altWorkout: "wod",
    memo: "ok",
    commitment: "",
  };
  assert.deepEqual(applyPatch(base, {}), base);
  assert.equal(applyPatch(base, { weightKg: null }).weightKg, null);
  // An out-of-range number is a typo, not an instruction to erase a real measurement.
  assert.equal(applyPatch(base, { weightKg: 999 }).weightKg, 82, "out-of-range leaves the stored value alone");
  assert.equal(applyPatch(base, { rpe: 99 }).rpe, 7);
  assert.equal(applyPatch(base, { paceSecPerKm: 5 }).paceSecPerKm, 260);
  assert.equal(applyPatch(base, { durationMin: 9999 }).durationMin, 55);
  // Clearing still works, and is distinct from an invalid value.
  assert.equal(applyPatch(base, { rpe: null }).rpe, null);
  assert.equal(applyPatch(base, { rpe: 9 }).rpe, 9);
  assert.equal(applyPatch(base, { memo: null }).memo, "");
  assert.equal(applyPatch(base, { done: false }).done, false);
  assert.deepEqual(base.memo, "ok", "input is not mutated");
});

test("buildUpdates writes only the cells that actually change", () => {
  const before: PlayerLog = { ...emptyPlayerLog(), done: false };
  const { updates, next } = buildUpdates(9, "A", before, { done: true, weightKg: 82.4 });
  assert.equal(next.done, true);
  assert.deepEqual(updates, [{ range: `'${SHEET_LOG_TAB}'!E9`, value: "✅ 82.4kg" }]);

  const noop = buildUpdates(9, "A", next, { done: true, weightKg: 82.4 });
  assert.deepEqual(noop.updates, [], "re-saving identical values costs zero writes");
});

test("buildUpdates targets the right columns per player", () => {
  const before = emptyPlayerLog();
  const patch = { done: true, weightKg: 80, paceSecPerKm: 260, durationMin: 50, rpe: 7, altWorkout: "x", memo: "y" };

  const a = buildUpdates(20, "A", before, patch).updates.map((u) => u.range);
  assert.deepEqual(a, [
    `'${SHEET_LOG_TAB}'!E20`,
    `'${SHEET_LOG_TAB}'!O20`,
    `'${SHEET_LOG_TAB}'!P20`,
    `'${SHEET_LOG_TAB}'!Q20`,
    `'${SHEET_LOG_TAB}'!K20`,
    `'${SHEET_LOG_TAB}'!L20`,
  ]);

  const b = buildUpdates(20, "B", before, patch).updates.map((u) => u.range);
  assert.deepEqual(b, [
    `'${SHEET_LOG_TAB}'!G20`,
    `'${SHEET_LOG_TAB}'!R20`,
    `'${SHEET_LOG_TAB}'!S20`,
    `'${SHEET_LOG_TAB}'!T20`,
    `'${SHEET_LOG_TAB}'!M20`,
    `'${SHEET_LOG_TAB}'!N20`,
  ]);

  assert.equal(new Set([...a, ...b]).size, 12, "the two players never share a cell");
});

test("clearing a field writes an empty string, not the word null", () => {
  const before: PlayerLog = { ...emptyPlayerLog(), paceSecPerKm: 260, memo: "old" };
  const { updates } = buildUpdates(11, "B", before, { paceSecPerKm: null, memo: null });
  assert.deepEqual(updates, [
    { range: `'${SHEET_LOG_TAB}'!R11`, value: "" },
    { range: `'${SHEET_LOG_TAB}'!N11`, value: "" },
  ]);
});


test("an inserted column is caught by the weekday anchor", async () => {
  // A column edit leaves column A perfectly intact, so the date anchor alone passes while
  // every fixed column index now points one cell to the left.
  const sheet = syntheticSeason({ seed: 4, upTo: "2026-08-10" });
  for (const row of sheet.tabs.get(SHEET_LOG_TAB)!) {
    if (row.length > 0) row.splice(2, 0, "");
  }

  const bad = gridDateMismatches(await gridFrom(sheet));
  assert.ok(bad.length > 0, "a column shift must not pass the structural check");
  assert.equal(bad[0].column, "C");
});

test("a blank weekday counts as a mismatch, like a blank date", async () => {
  const sheet = syntheticSeason({ seed: 5, upTo: "2026-08-10" });
  sheet.set(SHEET_LOG_TAB, 12, 2, "");
  const bad = gridDateMismatches(await gridFrom(sheet));
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0], { row: 12, column: "C", expected: "토요일", found: "" });
});

test("a cosmetic weekday reformat does not lock out logging", async () => {
  // Round 4 caught the previous version of this anchor blocking every write when the
  // weekday column was shortened to 토/일 — a display change the app never depends on.
  const sheet = syntheticSeason({ seed: 6, upTo: "2026-08-10" });
  for (const row of sheet.tabs.get(SHEET_LOG_TAB)!) {
    if (row.length > 2 && row[2]) row[2] = row[2].replace("요일", "");
  }
  assert.deepEqual(gridDateMismatches(await gridFrom(sheet)), [], "토 and 토요일 are the same day");

  const english = syntheticSeason({ seed: 7, upTo: "2026-08-10" });
  const map: Record<string, string> = { 일요일: "Sun", 월요일: "Mon", 화요일: "Tue", 수요일: "Wed", 목요일: "Thu", 금요일: "Fri", 토요일: "Sat" };
  for (const row of english.tabs.get(SHEET_LOG_TAB)!) {
    if (row.length > 2 && map[row[2]]) row[2] = map[row[2]];
  }
  assert.deepEqual(gridDateMismatches(await gridFrom(english)), [], "Sat is also Saturday");
});

test("a column inserted inside the data block is caught by the header anchors", async () => {
  // The date and weekday anchors sit left of every column the app writes, so on their own
  // they miss an insert at D or later — which is where the damage happens.
  const { headerMismatches } = await import("../src/lib/grid.ts");
  const { HEADER_RANGE } = await import("../src/lib/store.ts");

  for (const at of [3, 5, 10, 14]) {
    const sheet = syntheticSeason({ seed: 8, upTo: "2026-08-10" });
    for (const row of sheet.tabs.get(SHEET_LOG_TAB)!) {
      if (row.length > at) row.splice(at, 0, "");
    }
    const [header] = await sheet.batchGet([HEADER_RANGE]);
    assert.ok(headerMismatches(header.values).length > 0, `insert at column index ${at} must be caught`);
  }
});

test("an unprepared header (no metric columns yet) does not block logging", async () => {
  const { headerMismatches } = await import("../src/lib/grid.ts");
  const { HEADER_RANGE } = await import("../src/lib/store.ts");

  const sheet = syntheticSeason({ seed: 9, upTo: "2026-08-10" });
  for (const col of [14, 15, 16, 17, 18, 19]) sheet.set(SHEET_LOG_TAB, 4, col, "");
  const [header] = await sheet.batchGet([HEADER_RANGE]);
  assert.deepEqual(headerMismatches(header.values), [], "blank metric headers are skipped, not failed");
});

test("a deleted column at the right edge is caught even though it leaves an anchor blank", async () => {
  // Deleting S shifts T into S and blanks T. Treating a blank anchor as "not initialised"
  // let exactly this through — the write then landed in the wrong player's column.
  const { headerMismatches } = await import("../src/lib/grid.ts");
  const { HEADER_RANGE } = await import("../src/lib/store.ts");

  for (const at of [18, 19]) {
    const sheet = syntheticSeason({ seed: 10, upTo: "2026-08-10" });
    for (const row of sheet.tabs.get(SHEET_LOG_TAB)!) {
      if (row.length > at) row.splice(at, 1);
    }
    const [header] = await sheet.batchGet([HEADER_RANGE]);
    assert.ok(headerMismatches(header.values).length > 0, `delete at column index ${at} must be caught`);
  }
});

test("a cosmetically reformatted date column does not lock out logging", async () => {
  // Google Sheets re-renders a date the moment its number format is touched. Round 6 caught
  // the previous exact-string anchor refusing every write for the rest of the season.
  const { normaliseDateCell } = await import("../src/lib/grid.ts");
  assert.equal(normaliseDateCell("2026-08-05"), "2026-08-05");
  assert.equal(normaliseDateCell("2026. 8. 5"), "2026-08-05");
  assert.equal(normaliseDateCell("2026. 08. 05"), "2026-08-05");
  assert.equal(normaliseDateCell("2026년 8월 5일"), "2026-08-05");
  assert.equal(normaliseDateCell("8/5/2026"), "2026-08-05");
  assert.equal(normaliseDateCell(""), null, "blank is still a mismatch");
  assert.equal(normaliseDateCell("W1"), null, "and so is a shifted cell");

  const sheet = syntheticSeason({ seed: 11, upTo: "2026-08-10" });
  for (let row = 5; row <= 109; row++) {
    const iso = sheet.get(SHEET_LOG_TAB, row, 0);
    const [y, m, d] = iso.split("-").map(Number);
    sheet.set(SHEET_LOG_TAB, row, 0, `${y}. ${m}. ${d}`);
  }
  assert.deepEqual(await gridFrom(sheet).then(gridDateMismatches), []);
});
