// Read/write orchestration on top of a SheetsClient. The client is injected so the
// whole flow can run against a synthetic in-memory sheet in tests.

import type { SheetsClient } from "./sheets.ts";
import {
  FIRST_ROW,
  GOAL_ROW,
  LAST_ROW,
  PHASE_FIRST_ROW,
  PHASE_HEADER_ROW,
  PHASE_LAST_ROW,
  SHEET_GOAL_TAB,
  SHEET_LOG_TAB,
  SHEET_PHASE_TAB,
  rowForDate,
} from "./season.ts";
import {
  buildUpdates,
  gridDateMismatches,
  headerMismatches,
  parseGrid,
  playerColumns,
  rawCell,
  type DayRecord,
  type LogPatch,
  type PlayerId,
  type GridMismatch,
  type PlayerLog,
} from "./grid.ts";
import {
  isSheetBacked,
  parsePhases,
  phaseByNumber,
  phaseHeaderMismatches,
  phaseHeaderReadable,
  phaseRowMismatches,
  phaseTargetCell,
  type Phase,
  type PhaseNumber,
} from "./phases.ts";
import { goalMismatches, goalRangeReadable, goalWeightCell, parseGoals, type Goals } from "./goals.ts";
import { GOAL_WEIGHT_PLACEHOLDER, formatWeightCell, isUnreadableWeightCell } from "./cells.ts";

export const LOG_RANGE = `'${SHEET_LOG_TAB}'!A${FIRST_ROW}:V${LAST_ROW}`;
export const PHASE_RANGE = `'${SHEET_PHASE_TAB}'!A${PHASE_FIRST_ROW}:H${PHASE_LAST_ROW}`;
export const PHASE_HEADER_RANGE = `'${SHEET_PHASE_TAB}'!A${PHASE_HEADER_ROW}:H${PHASE_HEADER_ROW}`;
export const HEADER_RANGE = `'${SHEET_LOG_TAB}'!A3:V4`;
/**
 * Section 1 of the goal tab only. Section 2 (rows 12-18) is authored prose the app has no
 * business touching, and leaving it out of every range means no code path can name it.
 */
export const GOAL_RANGE = `'${SHEET_GOAL_TAB}'!A${GOAL_ROW.header}:F${GOAL_ROW.finishTarget}`;

export type Season = {
  records: DayRecord[];
  phases: Phase[];
  goals: Goals;
  /** Rows failing a structural anchor. Non-empty means the sheet was edited structurally. */
  misalignedRows: GridMismatch[];
  /**
   * False when the range came back empty. Distinct from `misalignedRows`, which is about a
   * range we *could* read: an empty read is not a mismatch (there is no cell to name), but
   * every write to that range is refused, so a report built on mismatches alone would offer
   * commands that always fail. Carried on `Season` so both facts travel together.
   */
  goalTabReadable: boolean;
  phaseHeaderReadable: boolean;
};

export async function loadSeason(client: SheetsClient): Promise<Season> {
  const [log, phase, header, goal, phaseHeader] = await client.batchGet([
    LOG_RANGE,
    PHASE_RANGE,
    HEADER_RANGE,
    GOAL_RANGE,
    PHASE_HEADER_RANGE,
  ]);
  const phases = parsePhases(phase?.values);
  return {
    records: parseGrid(log?.values),
    phases,
    goals: parseGoals(goal?.values),
    // Row anchors (date, weekday) catch an edit left of the data; the header anchors catch
    // one inside it. Both are needed: a column inserted at D leaves A and C untouched.
    // The two other tabs are checked here as well so a structural edit anywhere shows up
    // in one read — but only the log-tab checks gate a daily log, because a mangled goal
    // tab must not stop the athletes from recording sessions.
    misalignedRows: [
      ...gridDateMismatches(log?.values),
      ...headerMismatches(header?.values),
      ...goalMismatches(goal?.values),
      ...phaseHeaderMismatches(phaseHeader?.values),
      // The phase tab's row anchor belongs in the sweep too, not only inside the onboarding
      // report: `goal show` renders this list, and without it a row inserted in that tab
      // would re-slot three phase names by one position and report a structurally clean
      // sheet — on the one command whose job is to say which phase is which. Guarded by
      // `isSheetBacked` because on the DEFAULT_PHASES fallback all four rows mismatch
      // trivially, and that emptiness is an artefact of the failed read.
      ...(phases.some(isSheetBacked) ? phaseRowMismatches(phases) : []),
    ],
    goalTabReadable: goalRangeReadable(goal?.values),
    phaseHeaderReadable: phaseHeaderReadable(phaseHeader?.values),
  };
}

function refuse(problems: GridMismatch[], tab: string): never {
  const p = problems[0];
  throw new Error(
    `${tab} 시트의 ${p.column}${p.row} 칸이 "${p.found || "(비어 있음)"}"인데 ${p.expected}이어야 해. ` +
      `행이나 열이 추가/삭제된 것 같아. 시트를 고치기 전에는 목표 몸무게를 쓰지 않을게 — 엉뚱한 칸에 들어가.`,
  );
}


export function rowRange(row: number): string {
  // Must span every column a log can write, U/V included. A short range here does not fail
  // loudly — it silently hands `saveLog` a "before" snapshot in which the missing columns
  // read as empty, which defeats both the no-op check and every guard that asks "was there
  // authored text here?". Keep this in step with LOG_RANGE.
  return `'${SHEET_LOG_TAB}'!A${row}:V${row}`;
}

/**
 * Read one day fresh from the sheet, so writes are always applied to current values.
 *
 * The row is derived from the date, but column A is then checked against it. If someone
 * inserts or deletes a row in the log tab, every subsequent write would otherwise land
 * silently on the wrong day — so a mismatch is a hard error, not a warning.
 */
export async function loadDay(client: SheetsClient, date: string): Promise<DayRecord | null> {
  return (await loadDayRaw(client, date))?.record ?? null;
}

/**
 * `loadDay`, plus the row's untouched cell text.
 *
 * The parsed record cannot answer "what did a human write here?" — every guard against
 * destroying authored text needs the string the parser gave up on, and by definition that
 * string is absent from the parse. Same read, same anchors, so no caller pays for it twice.
 */
export async function loadDayRaw(
  client: SheetsClient,
  date: string,
): Promise<{ record: DayRecord; cells: string[] } | null> {
  const row = rowForDate(date);
  if (row === null) return null;
  const [range, header] = await client.batchGet([rowRange(row), HEADER_RANGE]);
  const cells = (range?.values?.[0] as unknown[]) ?? [];

  const headerProblems = headerMismatches(header?.values);
  if (headerProblems.length > 0) {
    const h = headerProblems[0];
    throw new Error(
      `Header cell ${h.column}${h.row} holds "${h.found}" but should contain ${h.expected}. ` +
        `A column was inserted or deleted in "${SHEET_LOG_TAB}" — fix the sheet before logging, or writes will land on the wrong cell.`,
    );
  }

  // Two anchors, checked before every write. Column A catches a row edit (an inserted row
  // arrives blank, so blank is a mismatch, not "aligned"); the weekday column catches a
  // column edit, which leaves column A perfectly intact while shifting everything else.
  const grid: unknown[][] = [];
  grid[row - FIRST_ROW] = cells;
  const problems = gridDateMismatches(grid).filter((p) => p.row === row);
  if (problems.length > 0) {
    const p = problems[0];
    throw new Error(
      `Sheet row ${row} column ${p.column} holds ${p.found ? p.found : "(blank)"} but should hold ${p.expected}. ` +
        `A row or column was inserted or deleted in "${SHEET_LOG_TAB}" — fix the sheet before logging, or writes will land on the wrong cell.`,
    );
  }

  const record = parseGrid(grid).find((r) => r.row === row) ?? null;
  if (!record) return null;
  return { record, cells: cells.map((v) => (v == null ? "" : String(v))) };
}

export type SaveResult = {
  date: string;
  row: number;
  player: PlayerId;
  before: PlayerLog;
  after: PlayerLog;
  written: number;
  /**
   * Untouched text of the two hand-editable cells, as they were before this write. Carried
   * so a caller can say what it replaced — `before` holds the parse, and a note a human left
   * is precisely what the parse throws away.
   */
  beforeText: { status: string; target: string };
};

/**
 * Apply a patch to one player's log for one day. Reads the row first (never derives
 * the row from a cached grid) and writes only the cells that actually change.
 */
export async function saveLog(
  client: SheetsClient,
  date: string,
  player: PlayerId,
  patch: LogPatch,
): Promise<SaveResult> {
  const row = rowForDate(date);
  if (row === null) throw new Error(`${date} is outside the 15-week season`);

  const raw = await loadDayRaw(client, date);
  if (!raw) throw new Error(`Could not read row ${row} for ${date}`);

  const before = raw.record[player];
  const columns = playerColumns(player);
  const { updates, next } = buildUpdates(row, player, before, patch);
  await client.batchUpdate(updates);

  return {
    date,
    row,
    player,
    before,
    after: next,
    written: updates.length,
    beforeText: {
      status: rawCell(raw.cells, columns.status),
      target: rawCell(raw.cells, columns.target),
    },
  };
}

// ---------------------------------------------------------------- target weights
//
// Three places hold a 목표 몸무게, and all three are written the same way: read the block,
// check its anchors, refuse on any mismatch, then write exactly one cell. Nothing is
// written when the rendered text would not change, so re-running a command is free.

export type TargetSaveResult = {
  where: "goal" | "phase" | "log";
  range: string;
  player: PlayerId;
  before: number | null;
  after: number | null;
  written: number;
  /** Set for `where: "phase"`. */
  phase?: { number: PhaseNumber; row: number; name: string };
  /** Set for `where: "log"`. */
  date?: string;
};

/**
 * Options every target write shares.
 *
 * `force` overrides the authored-text guard below, and nothing else. It is the same escape
 * hatch the equipment-load check uses: the guard asks a question, it does not decide that
 * the athlete is wrong.
 */
export type TargetWriteOptions = { force?: boolean };

/**
 * Refuse to overwrite a target cell a human wrote something unparseable into.
 *
 * `parseWeight` returning null makes "82 (10월까지)" indistinguishable from the authored
 * "[   ] kg" placeholder everywhere downstream, so without this the write reports
 * "미입력 → 82kg" while destroying a deadline note — a false statement about the prior
 * contents of the one cell on this tab the app is allowed to touch.
 */
function refuseAuthoredText(text: string, cell: string): never {
  throw new Error(
    `${cell} 칸에 "${text}"가 적혀 있는데 숫자로 못 읽겠어. 덮어쓰면 사람이 쓴 내용이 사라져서 그대로 둘게 — ` +
      `시트에서 직접 고치거나, 지워도 되는 내용이면 --force를 붙여.`,
  );
}

/** The season-long target on the goal tab — B6 for A, C6 for B. */
export async function saveGoalWeight(
  client: SheetsClient,
  player: PlayerId,
  kg: number | null,
  options: TargetWriteOptions = {},
): Promise<TargetSaveResult> {
  const [goal] = await client.batchGet([GOAL_RANGE]);
  const values = goal?.values;

  // `goalMismatches` treats a wholly empty range as "nothing to check" so that reading a
  // season without this tab is not reported as broken. A *write* cannot be that relaxed:
  // an empty read means we do not know where row 6 is, and B6 on an unread tab is exactly
  // the blind write these anchors exist to prevent.
  if (!goalRangeReadable(values)) {
    throw new Error(
      `"${SHEET_GOAL_TAB}" 탭을 읽지 못했어 (비어 있거나 이름이 바뀐 것 같아). 목표 몸무게를 쓰지 않을게.`,
    );
  }
  const problems = goalMismatches(values);
  if (problems.length > 0) refuse(problems, SHEET_GOAL_TAB);

  const goals = parseGoals(values);
  const before = goals.bodyWeightKg[player];
  const range = goalWeightCell(player);
  if (!options.force && isUnreadableWeightCell(goals.bodyWeightText[player])) {
    refuseAuthoredText(goals.bodyWeightText[player], range);
  }
  const beforeText = formatWeightCell(before, GOAL_WEIGHT_PLACEHOLDER);
  const afterText = formatWeightCell(kg, GOAL_WEIGHT_PLACEHOLDER);
  const updates = beforeText === afterText ? [] : [{ range, value: afterText }];
  await client.batchUpdate(updates);

  return { where: "goal", range, player, before, after: kg, written: updates.length };
}

/** A phase's target on the phase tab — D or E, on the row Phase N actually occupies. */
export async function savePhaseTarget(
  client: SheetsClient,
  phaseNumber: PhaseNumber,
  player: PlayerId,
  kg: number | null,
  options: TargetWriteOptions = {},
): Promise<TargetSaveResult> {
  const [body, header] = await client.batchGet([PHASE_RANGE, PHASE_HEADER_RANGE]);

  // Same reasoning as the goal tab: the read path tolerates a missing header row, the
  // write path does not. Without row 3 there is nothing pinning D and E, so a column
  // inserted in this tab would be invisible and the write would land one column over.
  if (!phaseHeaderReadable(header?.values)) {
    throw new Error(
      `"${SHEET_PHASE_TAB}" 탭의 헤더(${PHASE_HEADER_ROW}행)를 읽지 못했어. 어느 열이 누구 목표인지 확인할 수 없어서 쓰지 않을게.`,
    );
  }
  const headerProblems = phaseHeaderMismatches(header.values);
  if (headerProblems.length > 0) refuse(headerProblems, SHEET_PHASE_TAB);

  const phases = parsePhases(body?.values);
  if (!phases.some(isSheetBacked)) {
    throw new Error(
      `"${SHEET_PHASE_TAB}" 탭을 읽지 못해서 기본값으로 대체됐어. 시트에서 읽지 않은 단계에는 목표 몸무게를 쓰지 않을게.`,
    );
  }
  const rowProblems = phaseRowMismatches(phases);
  if (rowProblems.length > 0) refuse(rowProblems, SHEET_PHASE_TAB);

  const phase = phaseByNumber(phases, phaseNumber);
  if (!phase || !isSheetBacked(phase)) {
    throw new Error(`Phase ${phaseNumber}을 "${SHEET_PHASE_TAB}" 탭에서 찾지 못했어. 쓰지 않을게.`);
  }

  const before = player === "A" ? phase.targetKgA : phase.targetKgB;
  const range = phaseTargetCell(phase.row, player);
  const authored = player === "A" ? phase.targetTextA : phase.targetTextB;
  if (!options.force && isUnreadableWeightCell(authored)) refuseAuthoredText(authored, range);
  const beforeText = formatWeightCell(before, GOAL_WEIGHT_PLACEHOLDER);
  const afterText = formatWeightCell(kg, GOAL_WEIGHT_PLACEHOLDER);
  const updates = beforeText === afterText ? [] : [{ range, value: afterText }];
  await client.batchUpdate(updates);

  return {
    where: "phase",
    range,
    player,
    before,
    after: kg,
    written: updates.length,
    phase: { number: phaseNumber, row: phase.row, name: phase.name },
  };
}

/**
 * One day's target on the log tab — D or F. Goes through `saveLog`, so it inherits the
 * date and header anchors that already guard every daily write.
 *
 * The authored-text guard has to be repeated here rather than inherited. `saveLog` compares
 * *parsed* values, so "감량 후 재설정" parses to null, differs from "84kg", and is overwritten
 * unconditionally — while `before.targetKg` is null too, which makes the confirmation say
 * "미입력 → 84kg" about a cell that was not 미입력. That is the false statement the guard on
 * the other two target paths exists to prevent, and 210 of the 220 writable target cells are
 * on this one. Same predicate, same `--force` escape hatch, so all three behave alike.
 */
export async function saveLogTarget(
  client: SheetsClient,
  date: string,
  player: PlayerId,
  kg: number | null,
  options: TargetWriteOptions = {},
): Promise<TargetSaveResult> {
  const row = rowForDate(date);
  if (row === null) throw new Error(`${date} is outside the 15-week season`);
  const column = playerColumns(player).target;
  const range = `'${SHEET_LOG_TAB}'!${column}${row}`;

  if (!options.force) {
    // Reads the row through the same anchors `saveLog` uses, so a structurally edited sheet
    // is still refused first and this guard never inspects a cell from the wrong row.
    const raw = await loadDayRaw(client, date);
    if (!raw) throw new Error(`Could not read row ${row} for ${date}`);
    const authored = rawCell(raw.cells, column);
    if (isUnreadableWeightCell(authored)) refuseAuthoredText(authored, range);
  }

  const result = await saveLog(client, date, player, { targetKg: kg });
  return {
    where: "log",
    range,
    player,
    before: result.before.targetKg,
    after: result.after.targetKg,
    written: result.written,
    date: result.date,
  };
}
