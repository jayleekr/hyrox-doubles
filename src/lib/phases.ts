// The "15주 단계별 요약 (2인)" tab: Phase 1-4 targets. Pure parsing plus the structural
// anchors that a write to D/E has to clear first.

import { cleanText, parseWeight } from "./cells.ts";
import type { GridMismatch } from "./grid.ts";
import {
  PHASE_COL,
  PHASE_COUNT,
  PHASE_FIRST_ROW,
  PHASE_HEADER_ROW,
  PHASE_LAST_ROW,
  SHEET_PHASE_TAB,
  colIndex,
} from "./season.ts";

/** 1..4. Anything else is not a phase in this programme. */
export type PhaseNumber = 1 | 2 | 3 | 4;

export type Phase = {
  /**
   * The sheet row this phase was read from, or 0 for a DEFAULT_PHASES fallback.
   *
   * Load-bearing: `parsePhases` skips rows it cannot read, so the array index does *not*
   * track the sheet row. A write keyed on the index would land on a different phase the
   * moment one row went unparseable, and on a sheet the app never read at all when the
   * fallback kicked in.
   */
  row: number;
  name: string;
  fromWeek: number;
  toWeek: number;
  period: string;
  focus: string;
  targetKgA: number | null;
  targetKgB: number | null;
  /**
   * D and E as raw text. `targetKg*` collapses "empty", "[   ] kg" and "감량 목표" into
   * null; a write has to tell the last one apart so it does not overwrite authored text.
   */
  targetTextA: string;
  targetTextB: string;
  paceTarget: string;
  ratio: string;
  checkpoint: string;
};

/** Fallback mirroring the spreadsheet as authored, used when the tab can't be read. */
export const DEFAULT_PHASES: Phase[] = [
  {
    row: 0,
    name: "Phase 1: 기초 & 스피드 구축",
    fromWeek: 1,
    toWeek: 4,
    period: "08/01 ~ 08/28",
    focus: "400m 동반 인터벌 적응 & 2인 스테이션 교대 호흡 체화",
    targetKgA: null,
    targetKgB: null,
    targetTextA: "",
    targetTextB: "",
    paceTarget: "4:40 ~ 5:00/km",
    ratio: "크로스핏 60% + 보조 40%",
    checkpoint: "400m 동반 인터벌 8회 완수",
  },
  {
    row: 0,
    name: "Phase 2: 페이스 업 & 교대 전략",
    fromWeek: 5,
    toWeek: 9,
    period: "08/29 ~ 10/02",
    focus: "러닝 페이스 단축 & 스테이션 강약점 분석",
    targetKgA: null,
    targetKgB: null,
    targetTextA: "",
    targetTextB: "",
    paceTarget: "4:15 ~ 4:35/km",
    ratio: "크로스핏 50% + 보조 50%",
    checkpoint: "5km 동반 템포런 유지 및 파머스 교대 완벽화",
  },
  {
    row: 0,
    name: "Phase 3: 실전 피크 & 더블 콤보",
    fromWeek: 10,
    toWeek: 13,
    period: "10/03 ~ 10/30",
    focus: "지친 상태 동반 러닝 & HYROX Doubles Full 시뮬레이션",
    targetKgA: null,
    targetKgB: null,
    targetTextA: "",
    targetTextB: "",
    paceTarget: "3:55 ~ 4:15/km",
    ratio: "크로스핏 50% + 보조 50%",
    checkpoint: "더블 시뮬레이션 목표 기록 달성",
  },
  {
    row: 0,
    name: "Phase 4: 테이퍼링 & 대회 컨디셔닝",
    fromWeek: 14,
    toWeek: 15,
    period: "10/31 ~ 11/13",
    focus: "볼륨 50% 감축, 2인 동시 피로 회복 및 글리코겐 충전",
    targetKgA: null,
    targetKgB: null,
    targetTextA: "",
    targetTextB: "",
    paceTarget: "대회 페이스 (4:00~4:15)",
    ratio: "크로스핏 30% + 회복/테이퍼링",
    checkpoint: "2026.11.13 최상의 호흡으로 완주",
  },
];

/** Parse the phase tab's A4:H7 value range. Falls back to DEFAULT_PHASES if unusable. */
export function parsePhases(values: unknown): Phase[] {
  const rows = Array.isArray(values) ? values : [];
  const out: Phase[] = [];
  for (let i = 0; i < rows.length; i++) {
    // Assigned before any `continue`, so a skipped row shifts the array but never the
    // row number a later write is addressed to.
    const row = PHASE_FIRST_ROW + i;
    const raw = rows[i];
    const r: string[] = Array.isArray(raw) ? raw.map((v) => (v == null ? "" : String(v))) : [];
    const name = cleanText(r[0], 120);
    const period = typeof r[1] === "string" ? r[1] : "";
    const m = /Week\s*(\d+)\s*[~-]\s*(\d+)/i.exec(period);
    if (!name || !m) continue;
    out.push({
      row,
      name,
      fromWeek: Number(m[1]),
      toWeek: Number(m[2]),
      period: cleanText(period.replace(/Week\s*\d+\s*[~-]\s*\d+/i, ""), 80).replace(/^[()\s]+|[()\s]+$/g, ""),
      focus: cleanText(r[2], 200),
      targetKgA: parseWeight(r[3]),
      targetKgB: parseWeight(r[4]),
      targetTextA: (r[3] ?? "").trim(),
      targetTextB: (r[4] ?? "").trim(),
      paceTarget: cleanText(r[5], 80),
      ratio: cleanText(r[6], 80),
      checkpoint: cleanText(r[7], 200),
    });
  }
  return out.length ? out : DEFAULT_PHASES;
}

export function phaseForWeek(phases: Phase[], week: number): Phase | null {
  return phases.find((p) => week >= p.fromWeek && week <= p.toWeek) ?? null;
}

/** True only for a phase that really came out of A4:H7. DEFAULT_PHASES are not. */
export function isSheetBacked(p: Phase): boolean {
  return p.row >= PHASE_FIRST_ROW && p.row <= PHASE_LAST_ROW;
}

/** The phase physically on the row Phase `n` belongs on — never `phases[n - 1]`. */
export function phaseByNumber(phases: Phase[], n: PhaseNumber): Phase | null {
  const row = PHASE_FIRST_ROW + n - 1;
  return phases.find((p) => p.row === row) ?? null;
}

/** A1 address of a phase's target-weight cell. */
export function phaseTargetCell(row: number, player: "A" | "B"): string {
  return `'${SHEET_PHASE_TAB}'!${player === "A" ? PHASE_COL.targetKgA : PHASE_COL.targetKgB}${row}`;
}

/**
 * Header cells that pin the two columns a phase write addresses.
 *
 * D3/E3 read "선수 A 목표몸무게" / "선수 B 목표몸무게", and the anchor is on the *player*
 * rather than on 목표 or 몸무게 — those match both columns, so they would wave through a
 * D↔E swap that files one athlete's target under the other's name.
 */
const PHASE_HEADER_ANCHORS: { column: string; contains: string }[] = [
  { column: PHASE_COL.name, contains: "단계" },
  { column: PHASE_COL.period, contains: "기간" },
  { column: PHASE_COL.targetKgA, contains: "선수 A" },
  { column: PHASE_COL.targetKgB, contains: "선수 B" },
  { column: PHASE_COL.paceTarget, contains: "페이스" },
];

/**
 * Did A3:H3 come back with anything in it at all?
 *
 * The single source of truth for the split between the read path, which tolerates a missing
 * header row, and `savePhaseTarget`, which refuses on it because nothing then pins D and E
 * to the right athlete. `onboardingReport` reads the same predicate, so it can no longer
 * offer eight phase commands the sheet is guaranteed to refuse.
 *
 * The live API omits `values` for an all-blank range, so `undefined` and `[]` both count
 * as unreadable.
 */
export function phaseHeaderReadable(values: unknown): boolean {
  return Array.isArray(values) && values.length > 0;
}

/** Does `name` identify itself as Phase `n`? The row anchor and every label share this. */
export function isPhaseNamed(n: number, name: string): boolean {
  return new RegExp(`^Phase\\s*${n}\\b`, "i").test(name);
}

/**
 * Check the phase tab's header row (A3:H3). An entirely empty range means "no header to
 * check" — the same tolerance the log tab's header check has, and what keeps a fixture
 * that never authored row 3 from looking misaligned. A *present* header with a blank or
 * shifted anchor is a mismatch: that is what a column insert looks like.
 */
export function phaseHeaderMismatches(values: unknown): GridMismatch[] {
  if (!phaseHeaderReadable(values)) return [];
  const rows = values as unknown[][];
  const raw = rows[0];
  const cells: string[] = Array.isArray(raw) ? raw.map((v) => (v == null ? "" : String(v))) : [];

  const bad: GridMismatch[] = [];
  for (const anchor of PHASE_HEADER_ANCHORS) {
    const found = (cells[colIndex(anchor.column)] ?? "").trim();
    if (!found.includes(anchor.contains)) {
      bad.push({
        tab: SHEET_PHASE_TAB,
        row: PHASE_HEADER_ROW,
        column: anchor.column,
        expected: `…${anchor.contains}…`,
        found,
      });
    }
  }
  return bad;
}

/**
 * The row anchor for the phase tab: Phase N must be on row 3+N.
 *
 * The header check only catches column edits. A row inserted above Phase 1 slides every
 * phase down one, and without this every `--phase 2` write would land on Phase 1.
 */
export function phaseRowMismatches(phases: Phase[]): GridMismatch[] {
  const bad: GridMismatch[] = [];
  for (let n = 1; n <= PHASE_COUNT; n++) {
    const row = PHASE_FIRST_ROW + n - 1;
    const found = phases.find((p) => p.row === row)?.name ?? "";
    if (!isPhaseNamed(n, found)) {
      bad.push({
        tab: SHEET_PHASE_TAB,
        row,
        column: PHASE_COL.name,
        expected: `Phase ${n}…`,
        found,
      });
    }
  }
  return bad;
}
