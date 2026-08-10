// Season constants + date/row arithmetic.
//
// Every fact here is derived from the live spreadsheet
// "HYROX_2026_Doubles_With_Alt_Exercise", tab "15주 상세 일지 (2인 전용)":
//   row 3/4 = two-level header, row 5 = 2026-08-01, row 109 = 2026-11-13.
// The date column is contiguous with no gaps, so row = FIRST_ROW + dayOffset.

export const SHEET_LOG_TAB = "15주 상세 일지 (2인 전용)";
export const SHEET_PHASE_TAB = "15주 단계별 요약 (2인)";
export const SHEET_DIET_TAB = "식단 기록";
export const SHEET_GOAL_TAB = "목표 및 더블 운영 원칙";

export const SEASON_START = "2026-08-01";
export const RACE_DATE = "2026-11-13";
export const FIRST_ROW = 5;
export const LAST_ROW = 109;

export const TIMEZONE = "Asia/Seoul";

/** Column letters of the log tab, by field. */
export const COL = {
  date: "A",
  week: "B",
  weekday: "C",
  aTargetKg: "D",
  aStatus: "E",
  bTargetKg: "F",
  bStatus: "G",
  area: "H",
  plan: "I",
  paceTarget: "J",
  aAlt: "K",
  aMemo: "L",
  bAlt: "M",
  bMemo: "N",
  aPace: "O",
  aDuration: "P",
  aRpe: "Q",
  bPace: "R",
  bDuration: "S",
  bRpe: "T",
  // The athlete's own if-then commitment for the day ("19:00 헬스장"), distinct from `plan`,
  // which is the prescribed session. Stated in the morning, read back in the evening.
  aCommit: "U",
  bCommit: "V",
} as const;

/**
 * The 식단 tab's columns. It shares the log tab's rows exactly — same FIRST_ROW/LAST_ROW,
 * same A/B/C date-week-weekday prefix — so `rowForDate` and the date/weekday anchors apply
 * unchanged. A second row convention would be a second way to file a meal against the wrong
 * day, which is the one failure this design refuses to introduce twice.
 */
export const DIET_COL = {
  date: "A",
  week: "B",
  weekday: "C",
  A: { breakfast: "D", lunch: "E", dinner: "F", snack: "G" },
  B: { breakfast: "H", lunch: "I", dinner: "J", snack: "K" },
} as const;

export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type Meal = (typeof MEALS)[number];

/** What each meal is called in the sheet and in conversation. */
export const MEAL_KO: Record<Meal, string> = {
  breakfast: "아침",
  lunch: "점심",
  dinner: "저녁",
  snack: "간식",
};

/**
 * Geometry of "15주 단계별 요약 (2인)". Row 3 is the header, rows 4-7 are Phase 1-4.
 * Read from the live sheet, so D3/E3 really are "선수 A 목표몸무게" / "선수 B 목표몸무게".
 */
export const PHASE_HEADER_ROW = 3;
export const PHASE_FIRST_ROW = 4;
export const PHASE_LAST_ROW = 7;
export const PHASE_COUNT = PHASE_LAST_ROW - PHASE_FIRST_ROW + 1;

export const PHASE_COL = {
  name: "A",
  period: "B",
  focus: "C",
  targetKgA: "D",
  targetKgB: "E",
  paceTarget: "F",
  ratio: "G",
  checkpoint: "H",
} as const;

/**
 * Geometry of "목표 및 더블 운영 원칙", section 1 ("D-Day 및 더블(2인) 핵심 목표 설정").
 * Row 4 is the header; rows 5-10 are one goal each.
 *
 * Section 2 (rows 12-18, the 운영 원칙 prose) is deliberately *not* named here. It is
 * authored reference material that the app only ever needs to leave alone, and a constant
 * naming those rows is the first step towards a write path that can reach them.
 */
export const GOAL_ROW = {
  header: 4,
  raceDate: 5,
  bodyWeight: 6,
  soloPace: 7,
  hyroxPace: 8,
  stationStrategy: 9,
  finishTarget: 10,
} as const;

export const GOAL_COL = {
  label: "A",
  A: "B",
  B: "C",
  team: "D",
  strategy: "E",
  note: "F",
} as const;

/**
 * Zero-based index into a row array read as A:T.
 *
 * Single letter only — "AA" would silently give the wrong index. Every range this app
 * addresses stays inside A..T, and any new one must too.
 */
export function colIndex(letter: string): number {
  return letter.charCodeAt(0) - 65;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse "YYYY-MM-DD" into a UTC epoch-day count. Returns null if malformed or not a real date. */
export function toEpochDay(iso: string): number | null {
  const m = ISO_DATE.exec(iso.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Rejects 2026-02-30 and friends, which Date.UTC would silently roll over.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return Math.floor(ms / 86_400_000);
}

export function fromEpochDay(day: number): string {
  const d = new Date(day * 86_400_000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

export function addDays(iso: string, n: number): string | null {
  const day = toEpochDay(iso);
  if (day === null) return null;
  return fromEpochDay(day + n);
}

export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = toEpochDay(fromIso);
  const b = toEpochDay(toIso);
  if (a === null || b === null) return null;
  return b - a;
}

/** Sheet row number for a date, or null if the date is outside the 15-week season. */
export function rowForDate(iso: string): number | null {
  const offset = daysBetween(SEASON_START, iso);
  if (offset === null) return null;
  const row = FIRST_ROW + offset;
  if (row < FIRST_ROW || row > LAST_ROW) return null;
  return row;
}

export function dateForRow(row: number): string | null {
  if (!Number.isInteger(row) || row < FIRST_ROW || row > LAST_ROW) return null;
  return addDays(SEASON_START, row - FIRST_ROW);
}

/** Week number 1..15, or null outside the season. */
export function weekForDate(iso: string): number | null {
  const offset = daysBetween(SEASON_START, iso);
  if (offset === null || offset < 0 || offset > LAST_ROW - FIRST_ROW) return null;
  return Math.floor(offset / 7) + 1;
}

/** Days remaining until race day. Negative once the race has passed. */
export function daysToRace(iso: string): number | null {
  return daysBetween(iso, RACE_DATE);
}

/** Today's date in the season's timezone, as YYYY-MM-DD. */
export function todayInSeasonTz(now: Date = new Date()): string {
  // en-CA gives ISO-shaped YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const WEEKDAY_KO = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

export function weekdayKo(iso: string): string | null {
  const day = toEpochDay(iso);
  if (day === null) return null;
  // 1970-01-01 (epoch day 0) was a Thursday.
  return WEEKDAY_KO[(((day + 4) % 7) + 7) % 7];
}

/** Inclusive date list for the week containing `iso`, Saturday-first (the season starts on a Saturday). */
export function weekDates(iso: string): string[] {
  const offset = daysBetween(SEASON_START, iso);
  if (offset === null) return [];
  const weekStart = Math.floor(offset / 7) * 7;
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(SEASON_START, weekStart + i);
    if (d && rowForDate(d) !== null) out.push(d);
  }
  return out;
}

/** Clamp any date into the season, so out-of-range "today" still renders something useful. */
export function clampToSeason(iso: string): string {
  const day = toEpochDay(iso);
  if (day === null) return SEASON_START;
  const start = toEpochDay(SEASON_START)!;
  const end = toEpochDay(RACE_DATE)!;
  if (day < start) return SEASON_START;
  if (day > end) return RACE_DATE;
  return iso;
}
