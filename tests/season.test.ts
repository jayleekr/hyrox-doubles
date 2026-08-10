import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIRST_ROW,
  LAST_ROW,
  RACE_DATE,
  SEASON_START,
  addDays,
  clampToSeason,
  dateForRow,
  daysBetween,
  daysToRace,
  fromEpochDay,
  rowForDate,
  toEpochDay,
  todayInSeasonTz,
  weekDates,
  weekForDate,
  weekdayKo,
} from "../src/lib/season.ts";

test("the season is exactly the sheet's 105 rows", () => {
  assert.equal(rowForDate(SEASON_START), FIRST_ROW);
  assert.equal(rowForDate(RACE_DATE), LAST_ROW);
  assert.equal(LAST_ROW - FIRST_ROW + 1, 105);
  assert.equal(daysBetween(SEASON_START, RACE_DATE), 104);
});

test("dates outside the season have no row", () => {
  assert.equal(rowForDate("2026-07-31"), null);
  assert.equal(rowForDate("2026-11-14"), null);
  assert.equal(rowForDate("not-a-date"), null);
  assert.equal(rowForDate(""), null);
});

test("row <-> date is a bijection across the whole season", () => {
  for (let row = FIRST_ROW; row <= LAST_ROW; row++) {
    const date = dateForRow(row);
    assert.ok(date, `row ${row} should map to a date`);
    assert.equal(rowForDate(date), row);
  }
  assert.equal(dateForRow(FIRST_ROW - 1), null);
  assert.equal(dateForRow(LAST_ROW + 1), null);
  assert.equal(dateForRow(4.5), null);
});

test("invalid calendar dates are rejected rather than rolled over", () => {
  assert.equal(toEpochDay("2026-02-30"), null);
  assert.equal(toEpochDay("2026-13-01"), null);
  assert.equal(toEpochDay("2026-00-10"), null);
  assert.equal(toEpochDay("2026-1-1"), null);
  assert.notEqual(toEpochDay("2028-02-29"), null); // real leap day
});

test("epoch-day conversion round-trips", () => {
  for (let i = 0; i < 400; i++) {
    const iso = addDays("2026-01-01", i)!;
    assert.equal(fromEpochDay(toEpochDay(iso)!), iso);
  }
});

test("month and year boundaries are handled", () => {
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-08-01", "2026-09-01"), 31);
});

test("weeks are 15 blocks of 7 starting on the season's Saturday", () => {
  assert.equal(weekdayKo(SEASON_START), "토요일");
  assert.equal(weekForDate("2026-08-01"), 1);
  assert.equal(weekForDate("2026-08-07"), 1);
  assert.equal(weekForDate("2026-08-08"), 2);
  assert.equal(weekForDate(RACE_DATE), 15);
  assert.equal(weekForDate("2026-07-31"), null);
  assert.equal(weekForDate("2026-11-14"), null);
});

test("weekdayKo agrees with the calendar", () => {
  assert.equal(weekdayKo("2026-08-05"), "수요일");
  assert.equal(weekdayKo("2026-11-13"), "금요일");
  assert.equal(weekdayKo("2026-01-01"), "목요일");
});

test("weekDates returns the containing week, clipped to the season", () => {
  assert.deepEqual(weekDates("2026-08-05").length, 7);
  assert.equal(weekDates("2026-08-05")[0], "2026-08-01");
  // The final week is short: 11/07..11/13 is exactly 7 days, so nothing is clipped.
  assert.equal(weekDates(RACE_DATE).at(-1), RACE_DATE);
  assert.deepEqual(weekDates("2027-01-01"), []);
});

test("D-day counts down to race day", () => {
  assert.equal(daysToRace(RACE_DATE), 0);
  assert.equal(daysToRace("2026-08-05"), 100);
  assert.equal(daysToRace("2026-11-14"), -1);
});

test("clampToSeason keeps out-of-range days renderable", () => {
  assert.equal(clampToSeason("2026-01-01"), SEASON_START);
  assert.equal(clampToSeason("2027-01-01"), RACE_DATE);
  assert.equal(clampToSeason("2026-09-09"), "2026-09-09");
  assert.equal(clampToSeason("garbage"), SEASON_START);
});

test("today is computed in Seoul time, not the server's zone", () => {
  // 2026-08-05T20:00Z is already 2026-08-06 in Seoul (UTC+9).
  assert.equal(todayInSeasonTz(new Date("2026-08-05T20:00:00Z")), "2026-08-06");
  assert.equal(todayInSeasonTz(new Date("2026-08-05T14:00:00Z")), "2026-08-05");
  // ...and just after Seoul midnight.
  assert.equal(todayInSeasonTz(new Date("2026-08-05T15:00:00Z")), "2026-08-06");
});
