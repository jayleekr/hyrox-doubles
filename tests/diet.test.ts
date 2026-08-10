// The 식단 tab. Same discipline as the log tab, because a meal filed against the wrong row
// is quieter than a wrong weight — nobody notices that Tuesday's dinner sits on Wednesday.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";

const { runCli } = await import("../src/lib/cli.ts");
const { loadDietDay } = await import("../src/lib/store.ts");
const { dietDateMismatches, dietHeaderMismatches, describeMeals, mealsLogged } = await import("../src/lib/diet.ts");
const { SHEET_DIET_TAB, FIRST_ROW } = await import("../src/lib/season.ts");
const { syntheticSeason } = await import("./fake-sheet.ts");

const TODAY = "2026-09-09";
const ROW = FIRST_ROW + 39; // 2026-09-09
const fresh = (seed = 1) => syntheticSeason({ seed, upTo: "2026-09-08" });

test("a meal round-trips, per athlete and per slot", async () => {
  const sheet = fresh();
  const r = await runCli(["meal", "--who", "a", "--저녁", "닭가슴살 200g + 현미밥"], sheet, TODAY);
  assert.equal(r.code, 0, r.out);

  const day = (await loadDietDay(sheet, TODAY))!;
  assert.equal(day.A.dinner, "닭가슴살 200g + 현미밥");
  assert.equal(day.A.lunch, "", "only the slot named was written");
  assert.equal(day.B.dinner, "", "and nothing landed in the partner's column");
});

test("English and Korean slot names are the same flag", async () => {
  const a = fresh(2);
  const b = fresh(2);
  await runCli(["meal", "--who", "a", "--dinner", "삼겹살"], a, TODAY);
  await runCli(["meal", "--who", "a", "--저녁", "삼겹살"], b, TODAY);
  assert.equal((await loadDietDay(a, TODAY))!.A.dinner, (await loadDietDay(b, TODAY))!.A.dinner);
});

test("meals accumulate across messages instead of replacing each other", async () => {
  //食事 arrive one at a time through the day, exactly like a training session's numbers.
  const sheet = fresh(3);
  await runCli(["meal", "--who", "a", "--아침", "계란 3개"], sheet, TODAY);
  await runCli(["meal", "--who", "a", "--점심", "김치찌개"], sheet, TODAY);
  await runCli(["meal", "--who", "a", "--저녁", "연어"], sheet, TODAY);

  const day = (await loadDietDay(sheet, TODAY))!;
  assert.equal(day.A.breakfast, "계란 3개");
  assert.equal(day.A.lunch, "김치찌개");
  assert.equal(day.A.dinner, "연어");
  assert.equal(mealsLogged(day.A), 3);
});

test("a repeated identical meal costs no writes", async () => {
  const sheet = fresh(4);
  await runCli(["meal", "--who", "a", "--저녁", "연어"], sheet, TODAY);
  const writes = sheet.writes;
  await runCli(["meal", "--who", "a", "--저녁", "연어"], sheet, TODAY);
  assert.equal(sheet.writes, writes);
});

test("identity is resolved exactly here too", async () => {
  const sheet = fresh(5);
  const both = await runCli(["meal", "--who", "a", "--who", "b", "--저녁", "연어"], sheet, TODAY);
  assert.equal(both.code, 1, both.out);
  assert.equal(sheet.writes, 0);

  const nobody = await runCli(["meal", "--저녁", "연어"], sheet, TODAY);
  assert.equal(nobody.code, 1);
  assert.equal(sheet.writes, 0);
});

test("a meal command with no slot is refused and names the slots", async () => {
  const sheet = fresh(6);
  const r = await runCli(["meal", "--who", "a"], sheet, TODAY);
  assert.equal(r.code, 1);
  assert.match(r.out, /아침/);
  assert.match(r.out, /저녁/);
  assert.equal(sheet.writes, 0);
});

test("out-of-season dates are refused", async () => {
  const sheet = fresh(7);
  const r = await runCli(["meal", "--who", "a", "--date", "2026-07-31", "--저녁", "연어"], sheet, TODAY);
  assert.equal(r.code, 1);
  assert.match(r.out, /프로그램 밖/);
  assert.equal(sheet.writes, 0);
});

test("`none` clears one slot and leaves the rest", async () => {
  const sheet = fresh(8);
  await runCli(["meal", "--who", "a", "--아침", "계란", "--저녁", "연어"], sheet, TODAY);
  await runCli(["meal", "--who", "a", "--저녁", "none"], sheet, TODAY);

  const day = (await loadDietDay(sheet, TODAY))!;
  assert.equal(day.A.dinner, "");
  assert.equal(day.A.breakfast, "계란");
});

test("a bare slot flag erases loudly, quoting what it removed", async () => {
  const sheet = fresh(9);
  await runCli(["meal", "--who", "a", "--저녁", "닭가슴살 200g"], sheet, TODAY);
  const r = await runCli(["meal", "--who", "a", "--저녁", "--json"], sheet, TODAY);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /닭가슴살 200g|"dinner": ""/);
});

// ---------------------------------------------------------------- structural anchors

test("a row inserted in the diet tab is caught before any write", async () => {
  const sheet = fresh(10);
  // Push every row down by one, the way an insert above the data does.
  const grid = sheet.tabs.get(SHEET_DIET_TAB)!;
  grid.splice(FIRST_ROW - 1, 0, []);

  await assert.rejects(() => loadDietDay(sheet, TODAY), /행이 추가.삭제/);
  const r = await runCli(["meal", "--who", "a", "--저녁", "연어"], sheet, TODAY);
  assert.equal(r.code, 2, r.out);
});

test("a shifted meal block is caught, so one athlete's dinner never lands in the other's column", async () => {
  // The eight meal headers repeat 아침/점심/저녁/간식 twice, so a shift still finds plausible
  // words in some positions. The check has to be positional and total.
  const sheet = fresh(11);
  sheet.set(SHEET_DIET_TAB, 4, 7, "아침"); // H4 (정재빈 아침) overwritten as if the block moved
  sheet.set(SHEET_DIET_TAB, 4, 6, "아침"); // G4 (Jay 간식) too

  const [header] = await sheet.batchGet([`'${SHEET_DIET_TAB}'!A4:K4`]);
  assert.ok(dietHeaderMismatches(header.values).length > 0, "the displaced boundary is detected");
});

test("an entirely blank diet header is 'not set up', not 'displaced'", async () => {
  assert.deepEqual(dietHeaderMismatches([[]]), []);
  assert.deepEqual(dietHeaderMismatches([]), []);
});

test("a blank date cell counts as misaligned, because an inserted row arrives blank", () => {
  assert.ok(dietDateMismatches([[""]], ROW).length > 0);
});

test("describeMeals reads back what is there and says so when nothing is", () => {
  assert.equal(describeMeals({ breakfast: "", lunch: "", dinner: "", snack: "" }), "기록 없음");
  assert.match(describeMeals({ breakfast: "계란", lunch: "", dinner: "연어", snack: "" }), /아침 계란 · 저녁 연어/);
});

test("the diet read command never writes", async () => {
  const sheet = fresh(12);
  const r = await runCli(["diet"], sheet, TODAY);
  assert.equal(r.code, 0, r.out);
  assert.equal(sheet.writes, 0);
});
