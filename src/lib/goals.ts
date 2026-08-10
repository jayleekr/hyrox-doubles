// The "목표 및 더블 운영 원칙" tab, section 1 — the season-long targets that are authored
// once at the start and then only referred to. Pure parsing, structural anchors, and the
// onboarding report that says which of them are still empty. No I/O.
//
// Only one row of this tab is writable: 몸무게 (row 6). The pace rows hold authored prose
// ("5분대 / km", "5분대 후반") that no parser round-trips — pushing "4:40/km" over "5분대
// 후반" would destroy a nuance a human wrote, which is exactly the failure this project
// ranks worst. They are read as text and never re-rendered.

import { isUnreadableWeightCell, parseWeight } from "./cells.ts";
import { cliCommand } from "./config.ts";
import type { DayRecord, GridMismatch, PlayerId } from "./grid.ts";
import { PLAYER_IDS } from "./grid.ts";
import { isSheetBacked, phaseRowMismatches, type Phase } from "./phases.ts";
import {
  GOAL_COL,
  GOAL_ROW,
  PHASE_COUNT,
  PHASE_FIRST_ROW,
  SHEET_GOAL_TAB,
  SHEET_PHASE_TAB,
  colIndex,
} from "./season.ts";

export type WeightPair = { A: number | null; B: number | null };
export type GoalRow = { A: string; B: string; team: string };

export type Goals = {
  /** Row 6, B/C. The only cells on this tab the app ever writes. */
  bodyWeightKg: WeightPair;
  /**
   * The same two cells as raw text.
   *
   * `bodyWeightKg` collapses "empty", "[   ] kg" and "82 (10월까지)" all into null, which
   * is the right reading but loses the one distinction a write has to make: whether a
   * human already wrote something here. Kept alongside so the write path can refuse to
   * overwrite authored text instead of reporting it as 미입력.
   */
  bodyWeightText: { A: string; B: string };
  /** Rows 7-10, read as authored text. Read-only. */
  soloPace: GoalRow;
  hyroxPace: GoalRow;
  finish: GoalRow;
};

export function emptyGoals(): Goals {
  const blank: GoalRow = { A: "", B: "", team: "" };
  return {
    bodyWeightKg: { A: null, B: null },
    bodyWeightText: { A: "", B: "" },
    soloPace: { ...blank },
    hyroxPace: { ...blank },
    finish: { ...blank },
  };
}

/** Rows of the A4:F10 range, indexed by sheet row. */
function reader(values: unknown): (row: number, column: string) => string {
  const rows = Array.isArray(values) ? values : [];
  return (row, column) => {
    const raw = rows[row - GOAL_ROW.header];
    if (!Array.isArray(raw)) return "";
    const v = raw[colIndex(column)];
    return v === undefined || v === null ? "" : String(v);
  };
}

/**
 * Parse the A4:F10 range. Nothing throws and nothing is inferred: a cell that does not
 * hold a plain weight reads as null, which is what "[   ] kg" does today.
 *
 * `parseWeight` takes the *first* valid match, so "목표 82kg (현재 95kg)" reads as 82.
 * That is the right reading for a goal cell — the goal is stated first — but it is worth
 * knowing at this call site, because B6 is free text a human may append to.
 */
export function parseGoals(values: unknown): Goals {
  const at = reader(values);
  const text = (row: number): GoalRow => ({
    A: at(row, GOAL_COL.A).trim(),
    B: at(row, GOAL_COL.B).trim(),
    team: at(row, GOAL_COL.team).trim(),
  });
  return {
    bodyWeightKg: {
      A: parseWeight(at(GOAL_ROW.bodyWeight, GOAL_COL.A)),
      B: parseWeight(at(GOAL_ROW.bodyWeight, GOAL_COL.B)),
    },
    bodyWeightText: {
      A: at(GOAL_ROW.bodyWeight, GOAL_COL.A).trim(),
      B: at(GOAL_ROW.bodyWeight, GOAL_COL.B).trim(),
    },
    soloPace: text(GOAL_ROW.soloPace),
    hyroxPace: text(GOAL_ROW.hyroxPace),
    finish: text(GOAL_ROW.finishTarget),
  };
}

/** A1 address of a player's 몸무게 goal cell — B6 or C6. */
export function goalWeightCell(player: PlayerId): string {
  return `'${SHEET_GOAL_TAB}'!${player === "A" ? GOAL_COL.A : GOAL_COL.B}${GOAL_ROW.bodyWeight}`;
}

/**
 * Anchors for A4:F10, quoted from the live sheet.
 *
 * The header row pins the two write columns (a column inserted at B would slide 선수 A
 * into C, so C4 would read "선수 A" where "선수 B" is expected). The label column pins the
 * write *row*: 몸무게 must be on row 6, and every neighbour is checked too, because a
 * single inserted row shifts several labels at once and any one of them catching it is
 * enough. 단독 and 1km rather than 페이스, since rows 7 and 8 both contain 페이스.
 */
const GOAL_ANCHORS: { row: number; column: string; contains: string }[] = [
  { row: GOAL_ROW.header, column: GOAL_COL.label, contains: "구분" },
  { row: GOAL_ROW.header, column: GOAL_COL.A, contains: "선수 A" },
  { row: GOAL_ROW.header, column: GOAL_COL.B, contains: "선수 B" },
  { row: GOAL_ROW.raceDate, column: GOAL_COL.label, contains: "대회" },
  { row: GOAL_ROW.bodyWeight, column: GOAL_COL.label, contains: "몸무게" },
  { row: GOAL_ROW.soloPace, column: GOAL_COL.label, contains: "단독" },
  { row: GOAL_ROW.hyroxPace, column: GOAL_COL.label, contains: "1km" },
  { row: GOAL_ROW.stationStrategy, column: GOAL_COL.label, contains: "스테이션" },
  { row: GOAL_ROW.finishTarget, column: GOAL_COL.label, contains: "완주" },
];

/**
 * Did A4:F10 come back with anything in it at all?
 *
 * The single source of truth for a distinction two layers disagreed about. `goalMismatches`
 * tolerates an empty range so a season read is not called structurally damaged; the write
 * path refuses on it, because an empty read means we do not know where row 6 is. Both the
 * refusal in `saveGoalWeight` and the block reason in `onboardingReport` are derived from
 * this one predicate, so the report can no longer print a command the sheet always refuses.
 *
 * The live API omits `values` entirely for an all-blank range, so `undefined` and `[]` must
 * both count as unreadable.
 */
export function goalRangeReadable(values: unknown): boolean {
  return Array.isArray(values) && values.length > 0;
}

/**
 * Structural check on the goal tab, run before any write to it.
 *
 * An entirely empty range returns [] — the tab is missing or was never authored, and a
 * read of the season must not be reported as structurally broken just because of that.
 * The write path checks for emptiness separately and refuses, because writing B6 on a tab
 * we could not read is exactly the blind write this whole layer exists to prevent.
 *
 * A blank cell inside a *present* range is a mismatch, not a skip: an inserted row arrives
 * blank, so skipping blanks would wave through the one edit these anchors exist to catch.
 */
export function goalMismatches(values: unknown): GridMismatch[] {
  if (!goalRangeReadable(values)) return [];
  const at = reader(values);

  const bad: GridMismatch[] = [];
  for (const anchor of GOAL_ANCHORS) {
    const found = at(anchor.row, anchor.column).trim();
    if (!found.includes(anchor.contains)) {
      bad.push({
        tab: SHEET_GOAL_TAB,
        row: anchor.row,
        column: anchor.column,
        expected: `…${anchor.contains}…`,
        found,
      });
    }
  }
  return bad;
}

// ---------------------------------------------------------------- onboarding

/**
 * Structurally what `Season` is, spelled out rather than imported so this module stays
 * below `store.ts` in the dependency order.
 */
export type TargetSource = {
  goals: Goals;
  phases: Phase[];
  records: DayRecord[];
  misalignedRows: GridMismatch[];
  /**
   * Whether each range came back with anything in it. An empty read produces no mismatch —
   * there is no cell to name — but every write to it is refused, so a report derived from
   * `misalignedRows` alone would print commands the sheet always rejects. These two carry
   * that fact the mismatch list structurally cannot.
   */
  goalTabReadable: boolean;
  phaseHeaderReadable: boolean;
};

/**
 * Which tier a gap belongs to.
 *
 * Only `required` gates "done". The three tiers are 2 cells, 8 cells and 210 cells, and
 * treating them alike is what made this report unfinishable: a pair who set their two
 * season goals and declined a phase ladder — which the skill explicitly tells the agent to
 * allow — would sit at 8 outstanding commands forever. A checklist that can never go green
 * is one everybody learns to ignore, and that costs the two cells that actually matter.
 */
export type Tier = "required" | "recommended";

export type MissingTarget = {
  where: "goal" | "phase";
  tier: Tier;
  player: PlayerId;
  /** Phase number for `where: "phase"`, otherwise 0. */
  phase: number;
  /** The exact command that fills this in. */
  command: string;
};

/**
 * Why a tier's cells cannot be written at all. Structural, never "nobody typed it yet".
 *
 * The `-unreadable` reasons exist because a range that came back empty produces no mismatch
 * to hang a line off, while the write path refuses on it outright. Every reason here has a
 * matching refusal in `store.ts` and a matching ⚠️ line in `describeSetup`.
 */
export type BlockReason =
  | "goal-tab-misaligned"
  | "goal-tab-unreadable"
  | "phase-tab-misaligned"
  | "phase-tab-unreadable"
  | "phase-header-unreadable";

export type TierProgress = {
  filled: number;
  total: number;
  /** True when a structural problem refuses every write to this tier — no number helps. */
  blocked: boolean;
};

export type PlayerProgress = {
  goalKg: number | null;
  required: TierProgress;
  recommended: TierProgress;
  /** Per-day targets this athlete has filled in. Counted, never demanded. */
  optionalFilled: number;
};

/** Who is asking, so their own gaps can be addressed with the id they already sent. */
export type Speaker = { player: PlayerId; telegram: string | null };

export type Onboarding = {
  /**
   * The headline state.
   *
   * `blocked` wins over everything: it is the one case where the remedy is to repair the
   * sheet rather than to ask a human for a number, and relaying it as an unfinished
   * checklist would send the agent asking for values every write is about to refuse.
   */
  stage: "empty" | "partial" | "ready" | "blocked";
  /**
   * The required tier only: both season goal weights are set. Deliberately *not* folded
   * together with sheet health — see `blocked`. Derived from the sheet on every run and
   * never stored, so clearing a goal by hand correctly un-finishes onboarding.
   */
  complete: boolean;
  /** True when at least one writable tier is structurally unreachable. */
  blocked: boolean;
  /** Every structural reason found. A list rather than one value: both tabs can break. */
  blockReasons: BlockReason[];
  goal: WeightPair;
  phases: { phase: number; row: number; name: string; A: number | null; B: number | null }[];
  /** Per-day targets in the log tab: optional, so counted rather than demanded. */
  log: { days: number; filled: { A: number; B: number } };
  progress: {
    required: TierProgress;
    recommended: TierProgress;
    optional: { filled: { A: number; B: number }; total: number };
  };
  byPlayer: Record<PlayerId, PlayerProgress>;
  /** Set when the caller identified themselves, so a headline can say "네 것". */
  speaker: PlayerId | null;
  /**
   * Gaps that can actually be filled right now. A tier whose tab is structurally broken
   * contributes nothing here: printing a command the sheet is guaranteed to refuse is how
   * the agent ends up asking an athlete for a number that cannot land anywhere.
   */
  missing: MissingTarget[];
  /**
   * Goal cells holding text no parser reads as a weight — "82 (10월까지)", "현재 체중 유지".
   *
   * Not a gap and not a filled value: a human wrote something there, so asking for a number
   * and writing it would destroy what they wrote. Listed separately so the report can name
   * the cell and its contents instead of counting it as 미입력.
   */
  unreadableGoalCells: { player: PlayerId; cell: string; text: string }[];
  /** Structural problems found while reading. Non-empty means some writes are refused. */
  misaligned: GridMismatch[];
};

const flag = (player: PlayerId) => (player === "A" ? "a" : "b");

/**
 * What is still empty, in three tiers, and the command that fills each gap.
 *
 * Onboarding is *finished* at two cells: one season goal weight per athlete. That is the
 * smallest input that makes the morning brief, the weekly review and the weight trend mean
 * anything, and each person can supply theirs with a single number. The eight phase cells
 * are offered once and then dropped; the 210 per-day cells are counted and never asked for.
 *
 * @param speaker when known, that athlete's own commands are addressed with the id they
 *   already sent, so the printed line does not teach `--who` for one's own rows. The
 *   partner's gaps are still listed — otherwise "뭐 남았어?" would never reveal them.
 */
export function onboardingReport(source: TargetSource, speaker: Speaker | null = null): Onboarding {
  // A tab whose anchors failed is one where every write lands somewhere unintended, so its
  // cells are neither "filled" nor "askable" — they are unreachable until a human repairs
  // the sheet. Splitting these out of `complete` is the point: one state is answered with a
  // number, the other cannot be, and relaying them identically sends the agent asking Jay
  // for a goal weight when the real answer is that the sheet is shifted.
  // A range that read back empty is the other half of the same story, and the half a
  // mismatch list cannot tell: `goalMismatches` returns [] for it on purpose, while
  // `saveGoalWeight` refuses on it outright. Deriving the block only from mismatches is what
  // let `setup` print two required commands that always exit 2.
  const goalTabUnreadable = !source.goalTabReadable;
  const goalTabMisaligned = source.misalignedRows.some((m) => m.tab === SHEET_GOAL_TAB);
  const goalTabBroken = goalTabUnreadable || goalTabMisaligned;

  // The DEFAULT_PHASES fallback carries row 0, so nothing is sheet-backed and every phase
  // reads as empty. That emptiness is an artefact of the failed read, not a fact about the
  // sheet, and `savePhaseTarget` refuses on it — so it must not become eight questions.
  const phaseUnreadable = !source.phases.some(isSheetBacked);
  // Row 3 cleared but rows 4-7 intact: the body parses, the anchors all pass, and the write
  // path still refuses because nothing pins D and E to the right athlete.
  const phaseHeaderUnreadable = !source.phaseHeaderReadable;
  // Only meaningful once something was read: on the fallback every row mismatches trivially.
  const phaseRowProblems = phaseUnreadable ? [] : phaseRowMismatches(source.phases);
  const phaseTabMisaligned =
    source.misalignedRows.some((m) => m.tab === SHEET_PHASE_TAB) || phaseRowProblems.length > 0;
  const phaseTabBroken = phaseUnreadable || phaseHeaderUnreadable || phaseTabMisaligned;

  const blockReasons: BlockReason[] = [];
  if (goalTabUnreadable) blockReasons.push("goal-tab-unreadable");
  else if (goalTabMisaligned) blockReasons.push("goal-tab-misaligned");
  if (phaseUnreadable) blockReasons.push("phase-tab-unreadable");
  else if (phaseHeaderUnreadable) blockReasons.push("phase-header-unreadable");
  else if (phaseTabMisaligned) blockReasons.push("phase-tab-misaligned");

  // A cell holding authored text is neither filled nor askable: `saveGoalWeight` refuses to
  // overwrite it, and calling it 미입력 is what invites the overwrite in the first place.
  // Scoped to the one athlete, not the tier — the partner's cell is still perfectly writable.
  const unreadableGoalCells = PLAYER_IDS.filter(
    (p) => !goalTabBroken && isUnreadableWeightCell(source.goals.bodyWeightText[p]),
  ).map((player) => ({
    player,
    cell: goalWeightCell(player),
    text: source.goals.bodyWeightText[player],
  }));
  const hasUnreadableCell = (player: PlayerId) => unreadableGoalCells.some((c) => c.player === player);

  /** How to address a player on the command line, given who is asking. */
  const target = (player: PlayerId): string =>
    speaker && speaker.player === player && speaker.telegram
      ? `--telegram ${speaker.telegram}`
      : `--who ${flag(player)}`;

  const missing: MissingTarget[] = [];

  for (const player of PLAYER_IDS) {
    if (source.goals.bodyWeightKg[player] === null && !goalTabBroken && !hasUnreadableCell(player)) {
      missing.push({
        where: "goal",
        tier: "required",
        player,
        phase: 0,
        command: `${cliCommand()} goal ${target(player)} --weight <kg>`,
      });
    }
  }

  const phases: Onboarding["phases"] = [];
  for (let n = 1; n <= PHASE_COUNT; n++) {
    const row = PHASE_FIRST_ROW + n - 1;
    const phase = source.phases.find((p) => p.row === row) ?? null;
    phases.push({
      phase: n,
      row,
      name: phase?.name ?? "",
      A: phase?.targetKgA ?? null,
      B: phase?.targetKgB ?? null,
    });
    for (const player of PLAYER_IDS) {
      const value = player === "A" ? phase?.targetKgA ?? null : phase?.targetKgB ?? null;
      if (value === null && !phaseTabBroken) {
        missing.push({
          where: "phase",
          tier: "recommended",
          player,
          phase: n,
          command: `${cliCommand()} goal ${target(player)} --phase ${n} --weight <kg>`,
        });
      }
    }
  }

  const filledGoal = (player: PlayerId) => (source.goals.bodyWeightKg[player] !== null ? 1 : 0);
  const filledPhases = (player: PlayerId) => phases.filter((p) => p[player] !== null).length;
  const filledDays = (player: PlayerId) => source.records.filter((r) => r[player].targetKg !== null).length;

  const required: TierProgress = {
    filled: PLAYER_IDS.reduce((n, p) => n + filledGoal(p), 0),
    total: PLAYER_IDS.length,
    blocked: goalTabBroken,
  };
  const recommended: TierProgress = {
    filled: PLAYER_IDS.reduce((n, p) => n + filledPhases(p), 0),
    total: PHASE_COUNT * PLAYER_IDS.length,
    blocked: phaseTabBroken,
  };
  const optional = {
    filled: { A: filledDays("A"), B: filledDays("B") },
    total: source.records.length * PLAYER_IDS.length,
  };

  const byPlayer = Object.fromEntries(
    PLAYER_IDS.map((player) => [
      player,
      {
        goalKg: source.goals.bodyWeightKg[player],
        required: { filled: filledGoal(player), total: 1, blocked: goalTabBroken },
        recommended: { filled: filledPhases(player), total: PHASE_COUNT, blocked: phaseTabBroken },
        optionalFilled: filledDays(player),
      } satisfies PlayerProgress,
    ]),
  ) as Record<PlayerId, PlayerProgress>;

  // Not `filled === total` alone: on a misaligned goal tab the parse reads whatever now sits
  // at B6/C6, so a stray number there must never be reported as a finished onboarding.
  const complete = required.filled === required.total && !goalTabBroken;
  const blocked = blockReasons.length > 0;
  const anythingFilled = required.filled > 0 || recommended.filled > 0 || optional.filled.A + optional.filled.B > 0;

  return {
    stage: blocked ? "blocked" : complete ? "ready" : anythingFilled ? "partial" : "empty",
    complete,
    blocked,
    blockReasons,
    goal: { ...source.goals.bodyWeightKg },
    phases,
    log: {
      days: source.records.length,
      filled: { ...optional.filled },
    },
    progress: { required, recommended, optional },
    byPlayer,
    speaker: speaker?.player ?? null,
    missing,
    unreadableGoalCells,
    // `loadSeason` folds the phase tab's row anchor in already. It is recomputed here so a
    // `TargetSource` assembled by hand still gets it, and merged rather than concatenated so
    // the ⚠️ block does not name the same cell twice.
    misaligned: mergeMismatches(source.misalignedRows, phaseRowProblems),
  };
}

/** Append only the mismatches not already present, keyed by the cell they name. */
function mergeMismatches(base: GridMismatch[], extra: GridMismatch[]): GridMismatch[] {
  const out = [...base];
  const key = (m: GridMismatch) => `${m.tab ?? ""}!${m.column}${m.row}`;
  const seen = new Set(out.map(key));
  for (const m of extra) {
    if (seen.has(key(m))) continue;
    seen.add(key(m));
    out.push(m);
  }
  return out;
}
