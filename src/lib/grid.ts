// Pure mapping between the spreadsheet grid (array of row arrays, A:T) and typed records.
// No I/O here so the whole layer is testable against synthetic grids.

import {
  COL,
  FIRST_ROW,
  LAST_ROW,
  SHEET_LOG_TAB,
  colIndex,
  dateForRow,
  weekForDate,
  weekdayKo,
} from "./season.ts";
import {
  cleanText,
  formatDuration,
  formatPace,
  formatRpe,
  formatStatusCell,
  formatWeightCell,
  parseDuration,
  parsePace,
  parseRpe,
  parseStatusCell,
  parseWeight,
  validDuration,
  validPace,
  validRpe,
  validWeight,
} from "./cells.ts";

export type PlayerId = "A" | "B";
export const PLAYER_IDS: PlayerId[] = ["A", "B"];

export type PlayerLog = {
  done: boolean;
  weightKg: number | null;
  targetKg: number | null;
  paceSecPerKm: number | null;
  durationMin: number | null;
  rpe: number | null;
  altWorkout: string;
  memo: string;
  /** What they said they would do today, and when. Empty when they never said. */
  commitment: string;
};

export type DayRecord = {
  date: string;
  row: number;
  week: number;
  weekday: string;
  area: string;
  plan: string;
  paceTarget: string;
  isRest: boolean;
  isRaceDay: boolean;
  A: PlayerLog;
  B: PlayerLog;
};

/** A partial edit. `undefined` leaves the field alone; `null` clears it. */
export type LogPatch = {
  done?: boolean;
  weightKg?: number | null;
  /** That day's *target* weight (column D/F), as opposed to what was measured. */
  targetKg?: number | null;
  paceSecPerKm?: number | null;
  durationMin?: number | null;
  rpe?: number | null;
  altWorkout?: string | null;
  memo?: string | null;
  commitment?: string | null;
};

export type CellUpdate = { range: string; value: string };

const COLS_BY_PLAYER = {
  A: {
    status: COL.aStatus,
    target: COL.aTargetKg,
    alt: COL.aAlt,
    memo: COL.aMemo,
    commit: COL.aCommit,
    pace: COL.aPace,
    duration: COL.aDuration,
    rpe: COL.aRpe,
  },
  B: {
    status: COL.bStatus,
    target: COL.bTargetKg,
    alt: COL.bAlt,
    memo: COL.bMemo,
    commit: COL.bCommit,
    pace: COL.bPace,
    duration: COL.bDuration,
    rpe: COL.bRpe,
  },
} as const;

function cell(row: string[], letter: string): string {
  const v = row[colIndex(letter)];
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

/**
 * Which columns hold one player's values.
 *
 * Exported because two guards need the *raw* text of a cell before it is overwritten, and
 * `PlayerLog` deliberately carries parsed values only — a parse that returns null is exactly
 * the case where the cell held something a human wrote.
 */
export function playerColumns(player: PlayerId): (typeof COLS_BY_PLAYER)[PlayerId] {
  return COLS_BY_PLAYER[player];
}

/** Untouched text of one cell in a raw row, by column letter. */
export function rawCell(row: string[], letter: string): string {
  return cell(row, letter);
}

export function emptyPlayerLog(): PlayerLog {
  return {
    done: false,
    weightKg: null,
    targetKg: null,
    paceSecPerKm: null,
    durationMin: null,
    rpe: null,
    altWorkout: "",
    commitment: "",
    memo: "",
  };
}

function readPlayer(row: string[], player: PlayerId): PlayerLog {
  const c = COLS_BY_PLAYER[player];
  const status = parseStatusCell(cell(row, c.status));
  return {
    done: status.done,
    weightKg: status.weightKg,
    targetKg: parseWeight(cell(row, c.target)),
    paceSecPerKm: parsePace(cell(row, c.pace)),
    durationMin: parseDuration(cell(row, c.duration)),
    rpe: parseRpe(cell(row, c.rpe)),
    altWorkout: cleanText(cell(row, c.alt)),
    commitment: cleanText(cell(row, c.commit)),
    memo: cleanText(cell(row, c.memo)),
  };
}

/**
 * Turn the raw A5:T109 value range into one record per season day.
 * The Sheets API truncates trailing empty cells and rows, so the grid is padded
 * and every date is derived from its row number rather than from column A —
 * column A is only used as a consistency check.
 */
export function parseGrid(values: unknown): DayRecord[] {
  const rows = Array.isArray(values) ? values : [];
  const out: DayRecord[] = [];
  for (let row = FIRST_ROW; row <= LAST_ROW; row++) {
    const raw = rows[row - FIRST_ROW];
    const cells: string[] = Array.isArray(raw) ? raw.map((v) => (v == null ? "" : String(v))) : [];
    const date = dateForRow(row)!;
    out.push({
      date,
      row,
      week: weekForDate(date)!,
      weekday: cell(cells, COL.weekday) || weekdayKo(date)!,
      area: cleanText(cell(cells, COL.area), 120),
      plan: cleanText(cell(cells, COL.plan), 1000),
      paceTarget: cleanText(cell(cells, COL.paceTarget), 200),
      isRest: /휴식/.test(cell(cells, COL.area)),
      isRaceDay: /RACE\s*DAY/i.test(cell(cells, COL.area)),
      A: readPlayer(cells, "A"),
      B: readPlayer(cells, "B"),
    });
  }
  return out;
}

/** `tab` is set only by checks on tabs other than the log tab, so a message can name it. */
export type GridMismatch = {
  row: number;
  column: string;
  expected: string;
  found: string;
  tab?: string;
};

/**
 * Header cells that pin the columns the app writes to.
 *
 * The date and weekday anchors only cover A..C, so they catch a column edit to the LEFT of
 * the data — which is the minority case. These check the block the app actually addresses,
 * matched on a substring so cosmetic wording changes are tolerated. A blank cell is skipped,
 * because O4..T4 do not exist until `init-sheet.mjs --apply` has run.
 */
const HEADER_ANCHORS: { row: number; column: string; contains: string }[] = [
  // D4/F4 read "A 목표(kg)" / "B 목표(kg)" in the live sheet. These are belt-and-braces:
  // an insert at or left of G already displaces one of the 실체중 anchors below, so a wrong
  // guess here could only ever cost a false refusal, never a wrong write. They stay under
  // the blank-skip rule for the same reason.
  { row: 4, column: COL.aTargetKg, contains: "A 목표" },
  { row: 4, column: COL.bTargetKg, contains: "B 목표" },
  { row: 4, column: COL.aStatus, contains: "실체중" },
  { row: 4, column: COL.bStatus, contains: "실체중" },
  { row: 4, column: COL.aMemo, contains: "메모" },
  { row: 4, column: COL.bMemo, contains: "메모" },
  { row: 4, column: COL.aPace, contains: "페이스" },
  { row: 4, column: COL.bPace, contains: "페이스" },
  { row: 4, column: COL.aRpe, contains: "RPE" },
  { row: 4, column: COL.bRpe, contains: "RPE" },
  // Pins the two rightmost columns from the left as well, so a delete at S or T is caught.
  { row: 4, column: COL.aDuration, contains: "시간" },
  { row: 4, column: COL.bDuration, contains: "시간" },
  // U/V, like O..T, do not exist until init-sheet has written them.
  { row: 4, column: COL.aCommit, contains: "약속" },
  { row: 4, column: COL.bCommit, contains: "약속" },
];

/**
 * Check the two-row header (A3:T4) still lines the columns up with what the app writes.
 * `values` is the raw A3:T4 range; an empty range is treated as "no header to check".
 */
export function headerMismatches(values: unknown): GridMismatch[] {
  const rows = Array.isArray(values) ? values : [];
  if (rows.length === 0) return [];

  const at = (row: number, column: string): string => {
    const raw = rows[row - 3];
    const cells: string[] = Array.isArray(raw) ? raw.map((v) => (v == null ? "" : String(v))) : [];
    return cell(cells, column).trim();
  };

  // Two blocks are added by `init-sheet.mjs --apply` rather than authored by hand, so on a
  // sheet that has not been initialised their headers are legitimately blank. Decide per
  // block whether it exists: if ANY header in a block is populated, a blank one *inside that
  // block* is a displaced column, not an un-initialised sheet. Skipping every blank would let
  // a delete at the block's rightmost column — which blanks that anchor — pass unnoticed.
  //
  // The blocks are checked separately because they arrive separately: O..T shipped first, and
  // a sheet can have those while U/V are still missing. Sharing one flag would make every
  // such sheet refuse all writes.
  const OPTIONAL_BLOCKS: string[][] = [
    [COL.aPace, COL.aDuration, COL.aRpe, COL.bPace, COL.bDuration, COL.bRpe],
    [COL.aCommit, COL.bCommit],
  ];
  const blockFor = (column: string): string[] | null =>
    OPTIONAL_BLOCKS.find((block) => block.includes(column)) ?? null;

  const bad: GridMismatch[] = [];
  for (const anchor of HEADER_ANCHORS) {
    const found = at(anchor.row, anchor.column);
    const block = blockFor(anchor.column);
    const blockExists = block !== null && block.some((column) => at(4, column) !== "");
    if (!found && (block === null || !blockExists)) continue;
    if (!found.includes(anchor.contains)) {
      bad.push({ row: anchor.row, column: anchor.column, expected: `…${anchor.contains}…`, found });
    }
  }
  return bad;
}

const WEEKDAY_ALIASES: Record<string, string> = {
  sun: "일", mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토",
  sunday: "일", monday: "월", tuesday: "화", wednesday: "수", thursday: "목", friday: "금", saturday: "토",
};

/**
 * Read a date cell by the day it denotes, not by its spelling. Google Sheets re-renders a
 * date the moment its number format is touched ("2026. 9. 5", "2026년 9월 5일"), and a
 * cosmetic reformat must not lock the athletes out of logging for the rest of the season.
 * Blank and unparseable stay mismatches, so an inserted row still fails closed.
 */
export function normaliseDateCell(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const parts = s.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/);
  if (parts) {
    return `${parts[1]}-${String(Number(parts[2])).padStart(2, "0")}-${String(Number(parts[3])).padStart(2, "0")}`;
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    return `${us[3]}-${String(Number(us[1])).padStart(2, "0")}-${String(Number(us[2])).padStart(2, "0")}`;
  }
  return null;
}

/** "토", "토요일", "Sat", "Saturday" all denote the same day. Blank stays blank. */
/** Exported so the 식단 tab checks its weekday column the same way the log tab does. */
export function normaliseWeekday(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return "";
  if (WEEKDAY_ALIASES[s]) return WEEKDAY_ALIASES[s];
  return s.replace(/요일$/, "");
}

/**
 * Structural check on the grid, run before every write.
 *
 * Two anchors, because they fail on different edits:
 *   column A (date)    catches an inserted or deleted ROW — the row arrives blank, which is
 *                      why a blank counts as a mismatch rather than as "aligned"
 *   column C (weekday) catches an inserted or deleted COLUMN — column A is untouched by a
 *                      column edit, so the date anchor alone would wave it through while
 *                      every write landed one column off.
 */
export function gridDateMismatches(values: unknown): GridMismatch[] {
  const rows = Array.isArray(values) ? values : [];
  const bad: GridMismatch[] = [];
  for (let row = FIRST_ROW; row <= LAST_ROW; row++) {
    const raw = rows[row - FIRST_ROW];
    const cells: string[] = Array.isArray(raw) ? raw.map((v) => (v == null ? "" : String(v))) : [];
    const expected = dateForRow(row)!;

    const found = cell(cells, COL.date).trim();
    if (normaliseDateCell(found) !== expected) {
      bad.push({ row, column: COL.date, expected, found });
      continue;
    }

    // Compared by the day it denotes, not by its spelling: "토", "토요일" and "Sat" are the
    // same Saturday, and reformatting a display column must not lock the athletes out of
    // logging. A blank or a genuinely different day still fails, which is what an inserted
    // column produces.
    const weekday = cell(cells, COL.weekday).trim();
    const expectedWeekday = weekdayKo(expected)!;
    if (normaliseWeekday(weekday) !== normaliseWeekday(expectedWeekday)) {
      bad.push({ row, column: COL.weekday, expected: expectedWeekday, found: weekday });
    }
  }
  return bad;
}

/**
 * Apply a patch to a log in memory. Used for both writes and optimistic UI.
 *
 * Three distinct cases per field, and the third is the one that matters:
 *   undefined      → leave the stored value alone
 *   null           → clear the stored value (an explicit instruction)
 *   invalid value  → leave the stored value alone
 *
 * An out-of-range number is a typo, not a request to erase a real measurement. Callers
 * that want a typo surfaced rather than ignored should validate before calling — the API
 * route does exactly that and answers 400.
 */
export function applyPatch(current: PlayerLog, patch: LogPatch): PlayerLog {
  const next: PlayerLog = { ...current };

  const put = <K extends "weightKg" | "targetKg" | "paceSecPerKm" | "durationMin" | "rpe">(
    key: K,
    value: number | null | undefined,
    validate: (n: unknown) => number | null,
  ) => {
    if (value === undefined) return;
    if (value === null) {
      next[key] = null;
      return;
    }
    const valid = validate(value);
    if (valid !== null) next[key] = valid;
  };

  if (patch.done !== undefined) next.done = !!patch.done;
  put("weightKg", patch.weightKg, validWeight);
  put("targetKg", patch.targetKg, validWeight);
  put("paceSecPerKm", patch.paceSecPerKm, validPace);
  put("durationMin", patch.durationMin, validDuration);
  put("rpe", patch.rpe, validRpe);
  if (patch.altWorkout !== undefined) next.altWorkout = patch.altWorkout === null ? "" : cleanText(patch.altWorkout);
  if (patch.commitment !== undefined) next.commitment = patch.commitment === null ? "" : cleanText(patch.commitment);
  if (patch.memo !== undefined) next.memo = patch.memo === null ? "" : cleanText(patch.memo);
  return next;
}

function a1(letter: string, row: number): string {
  return `'${SHEET_LOG_TAB}'!${letter}${row}`;
}

/**
 * Cell writes needed to move `current` to `applyPatch(current, patch)`.
 * Only cells whose rendered text actually changes are included, so a no-op save
 * costs zero Sheets writes.
 */
export function buildUpdates(
  row: number,
  player: PlayerId,
  current: PlayerLog,
  patch: LogPatch,
): { updates: CellUpdate[]; next: PlayerLog } {
  const next = applyPatch(current, patch);
  const c = COLS_BY_PLAYER[player];
  const updates: CellUpdate[] = [];

  const push = (letter: string, before: string, after: string) => {
    if (before !== after) updates.push({ range: a1(letter, row), value: after });
  };

  // Compared as *formatted* text on both sides, so a patch that omits targetKg can never
  // produce a spurious normalisation write — which is what keeps a no-op save free.
  push(c.target, formatWeightCell(current.targetKg), formatWeightCell(next.targetKg));
  push(
    c.status,
    formatStatusCell({ done: current.done, weightKg: current.weightKg }),
    formatStatusCell({ done: next.done, weightKg: next.weightKg }),
  );
  push(c.pace, formatPace(current.paceSecPerKm), formatPace(next.paceSecPerKm));
  push(c.duration, formatDuration(current.durationMin), formatDuration(next.durationMin));
  push(c.rpe, formatRpe(current.rpe), formatRpe(next.rpe));
  push(c.alt, current.altWorkout, next.altWorkout);
  push(c.commit, current.commitment, next.commitment);
  push(c.memo, current.memo, next.memo);

  return { updates, next };
}
