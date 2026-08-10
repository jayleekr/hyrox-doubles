// The 식단 tab: four meals a day, per athlete, as free text.
//
// Deliberately text and not numbers. A calorie figure lifted off a photo is a guess wearing
// a number's clothes, and once it is in a column it gets averaged and trended as though it
// were measured. "닭가슴살 200g + 현미밥" is honest about being a description, and it is what
// the athletes can actually produce every day for fifteen weeks.
//
// The tab shares the log tab's rows exactly, so a date maps to one row by arithmetic and
// column A is only ever a check on that — the same rule as everywhere else here.

import { cleanText } from "./cells.ts";
import type { PlayerId } from "./grid.ts";
import { PLAYER_IDS, normaliseDateCell, normaliseWeekday, type GridMismatch } from "./grid.ts";
import {
  DIET_COL,
  MEALS,
  MEAL_KO,
  SHEET_DIET_TAB,
  type Meal,
  colIndex,
  dateForRow,
  weekdayKo,
} from "./season.ts";

export type MealLog = Record<Meal, string>;
export type DietDay = { date: string; row: number; A: MealLog; B: MealLog };
/** `undefined` leaves a meal alone; `null` clears it. */
export type DietPatch = Partial<Record<Meal, string | null>>;

const EMPTY: MealLog = { breakfast: "", lunch: "", dinner: "", snack: "" };

function cell(row: string[], letter: string): string {
  const v = row[colIndex(letter)];
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function readMeals(row: string[], player: PlayerId): MealLog {
  const cols = DIET_COL[player];
  return {
    breakfast: cleanText(cell(row, cols.breakfast)),
    lunch: cleanText(cell(row, cols.lunch)),
    dinner: cleanText(cell(row, cols.dinner)),
    snack: cleanText(cell(row, cols.snack)),
  };
}

export function parseDietRow(raw: unknown, row: number): DietDay | null {
  const date = dateForRow(row);
  if (!date) return null;
  const cells: string[] = Array.isArray(raw) ? raw.map((v) => (v == null ? "" : String(v))) : [];
  return { date, row, A: readMeals(cells, "A"), B: readMeals(cells, "B") };
}

export function parseDietGrid(values: unknown, firstRow: number): DietDay[] {
  const rows = Array.isArray(values) ? values : [];
  const out: DietDay[] = [];
  for (let i = 0; i < rows.length; i++) {
    const day = parseDietRow(rows[i], firstRow + i);
    if (day) out.push(day);
  }
  return out;
}

/**
 * Row alignment for the 식단 tab, checked the same way as the log tab.
 *
 * A blank column A counts as a mismatch rather than "nothing there": an inserted row arrives
 * blank, and treating blank as acceptable is exactly how an insert would slip through and
 * push every later day onto the wrong row.
 */
export function dietDateMismatches(values: unknown, firstRow: number): GridMismatch[] {
  const rows = Array.isArray(values) ? values : [];
  const bad: GridMismatch[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = firstRow + i;
    const expected = dateForRow(row);
    if (!expected) continue;
    const cells: string[] = Array.isArray(rows[i]) ? (rows[i] as unknown[]).map((v) => (v == null ? "" : String(v))) : [];

    const found = cell(cells, DIET_COL.date).trim();
    if (normaliseDateCell(found) !== expected) {
      bad.push({ tab: SHEET_DIET_TAB, row, column: DIET_COL.date, expected, found });
      continue;
    }
    const day = cell(cells, DIET_COL.weekday).trim();
    const wanted = weekdayKo(expected);
    if (day && wanted && normaliseWeekday(day) !== normaliseWeekday(wanted)) {
      bad.push({ tab: SHEET_DIET_TAB, row, column: DIET_COL.weekday, expected: wanted, found: day });
    }
  }
  return bad;
}

const HEADER_ANCHORS: { column: string; contains: string }[] = [
  { column: DIET_COL.A.breakfast, contains: MEAL_KO.breakfast },
  { column: DIET_COL.A.lunch, contains: MEAL_KO.lunch },
  { column: DIET_COL.A.dinner, contains: MEAL_KO.dinner },
  { column: DIET_COL.A.snack, contains: MEAL_KO.snack },
  { column: DIET_COL.B.breakfast, contains: MEAL_KO.breakfast },
  { column: DIET_COL.B.lunch, contains: MEAL_KO.lunch },
  { column: DIET_COL.B.dinner, contains: MEAL_KO.dinner },
  { column: DIET_COL.B.snack, contains: MEAL_KO.snack },
];

/**
 * Header row (row 4) anchors: eight identical-looking meal names, four per athlete.
 *
 * Because 아침/점심/저녁/간식 repeat across D..G and H..K, a *shifted* block would still find
 * a plausible word in some positions. So the check is positional and total — every one of the
 * eight has to be the meal it should be, which pins the boundary between the two athletes at
 * G|H. Getting that boundary wrong writes one person's dinner into the other's column.
 */
export function dietHeaderMismatches(values: unknown): GridMismatch[] {
  const rows = Array.isArray(values) ? values : [];
  if (rows.length === 0) return [];
  const raw = rows[0];
  const cells: string[] = Array.isArray(raw) ? raw.map((v) => (v == null ? "" : String(v))) : [];

  // An un-initialised tab has no header at all; that is "not set up", not "displaced".
  if (HEADER_ANCHORS.every((a) => cell(cells, a.column).trim() === "")) return [];

  const bad: GridMismatch[] = [];
  for (const anchor of HEADER_ANCHORS) {
    const found = cell(cells, anchor.column).trim();
    if (!found.includes(anchor.contains)) {
      bad.push({ tab: SHEET_DIET_TAB, row: 4, column: anchor.column, expected: `…${anchor.contains}…`, found });
    }
  }
  return bad;
}

export function applyDietPatch(current: MealLog, patch: DietPatch): MealLog {
  const next: MealLog = { ...current };
  for (const meal of MEALS) {
    const v = patch[meal];
    if (v === undefined) continue;
    next[meal] = v === null ? "" : cleanText(v);
  }
  return next;
}

export type DietCellUpdate = { range: string; value: string };

/** Only the meals that actually change, so a repeated log costs no writes. */
export function buildDietUpdates(
  row: number,
  player: PlayerId,
  current: MealLog,
  patch: DietPatch,
): { updates: DietCellUpdate[]; next: MealLog } {
  const next = applyDietPatch(current, patch);
  const cols = DIET_COL[player];
  const updates: DietCellUpdate[] = [];
  for (const meal of MEALS) {
    if (next[meal] === current[meal]) continue;
    updates.push({ range: `'${SHEET_DIET_TAB}'!${cols[meal]}${row}`, value: next[meal] });
  }
  return { updates, next };
}

/** How much of the day is written down, for the nudge and the weekly review. */
export function mealsLogged(log: MealLog): number {
  return MEALS.filter((m) => log[m] !== "").length;
}

export function describeMeals(log: MealLog): string {
  const parts = MEALS.filter((m) => log[m]).map((m) => `${MEAL_KO[m]} ${log[m]}`);
  return parts.length === 0 ? "기록 없음" : parts.join(" · ");
}

export { EMPTY as EMPTY_MEALS, PLAYER_IDS };
