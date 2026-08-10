// An in-memory Google Sheet good enough to run the whole app against.
// It mimics the two behaviours that actually bite: A1 range semantics, and the
// API's habit of truncating trailing empty cells and rows.

import type { SheetsClient, ValueRange } from "../src/lib/sheets.ts";
import {
  FIRST_ROW,
  LAST_ROW,
  SHEET_GOAL_TAB,
  SHEET_LOG_TAB,
  SHEET_PHASE_TAB,
  dateForRow,
  weekForDate,
  weekdayKo,
} from "../src/lib/season.ts";

export type A1 = { tab: string; startCol: number; startRow: number; endCol: number; endRow: number };

const A1_RE = /^(?:'([^']+)'|([^'!]+))!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/;

export function parseA1(range: string): A1 {
  const m = A1_RE.exec(range.trim());
  if (!m) throw new Error(`unparseable range: ${range}`);
  const tab = m[1] ?? m[2];
  const startCol = colNum(m[3]);
  const startRow = Number(m[4]);
  return {
    tab,
    startCol,
    startRow,
    endCol: m[5] ? colNum(m[5]) : startCol,
    endRow: m[6] ? Number(m[6]) : startRow,
  };
}

function colNum(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // zero-based
}

export class FakeSheet implements SheetsClient {
  readonly tabs = new Map<string, string[][]>();
  readGets = 0;
  writes = 0;
  writtenCells: { range: string; value: string }[] = [];
  failNextWrite: string | null = null;
  /**
   * Symmetric with `failNextWrite`, and needed for the same reason.
   *
   * A read that fails is not a read that returns nothing: `doctor` has to distinguish "the
   * sheet says the goal tab is empty" from "the sheet is unreachable", because the first is
   * an onboarding gap and the second is a 403 that no number will fix.
   */
  failNextRead: string | null = null;

  constructor(tabs?: Record<string, string[][]>) {
    for (const [name, rows] of Object.entries(tabs ?? {})) this.tabs.set(name, rows);
  }

  private grid(tab: string): string[][] {
    let g = this.tabs.get(tab);
    if (!g) {
      g = [];
      this.tabs.set(tab, g);
    }
    return g;
  }

  /** 1-based row/col access, mirroring A1. */
  get(tab: string, row: number, col: number): string {
    const g = this.tabs.get(tab);
    return g?.[row - 1]?.[col] ?? "";
  }

  set(tab: string, row: number, col: number, value: string): void {
    const g = this.grid(tab);
    while (g.length < row) g.push([]);
    const line = g[row - 1];
    while (line.length <= col) line.push("");
    line[col] = value;
  }

  async batchGet(ranges: string[]): Promise<ValueRange[]> {
    if (this.failNextRead) {
      const msg = this.failNextRead;
      this.failNextRead = null;
      throw new Error(msg);
    }
    this.readGets++;
    return ranges.map((range) => {
      const a = parseA1(range);
      const rows: unknown[][] = [];
      for (let r = a.startRow; r <= a.endRow; r++) {
        const line: string[] = [];
        for (let c = a.startCol; c <= a.endCol; c++) line.push(this.get(a.tab, r, c));
        // Google truncates trailing empties.
        while (line.length && line[line.length - 1] === "") line.pop();
        rows.push(line);
      }
      while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
      return { range, values: rows };
    });
  }

  async batchUpdate(updates: { range: string; value: string }[]): Promise<void> {
    if (this.failNextWrite) {
      const msg = this.failNextWrite;
      this.failNextWrite = null;
      throw new Error(msg);
    }
    if (updates.length === 0) return;
    this.writes++;
    for (const u of updates) {
      const a = parseA1(u.range);
      if (a.startRow !== a.endRow || a.startCol !== a.endCol) {
        throw new Error(`single-cell write expected, got ${u.range}`);
      }
      this.set(a.tab, a.startRow, a.startCol, u.value);
      this.writtenCells.push(u);
    }
  }
}

/** Deterministic PRNG so synthetic seasons are reproducible across runs. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

const WEEKLY_TEMPLATE: Record<string, { area: string; plan: string; pace: string }> = {
  토요일: {
    area: "HYROX 더블 콤보",
    plan: "[더블 동반 세션] 2km 러닝 + 런지 50m(교대) + 월볼 30회(교대) → 2km 러닝 + 버피 20회 + 파머스 100m",
    pace: "빌드업 (4:45 → 4:15/km)",
  },
  일요일: { area: "휴식", plan: "충분히 쉬면서 다음 주 훈련을 위한 완전 회복", pace: "Rest" },
  월요일: {
    area: "HYROX 종목 훈련",
    plan: "달리기 1km + 슬레드 푸시/풀 + 버피 브로드점프 + 로잉 1km + 파머스 캐리 + 런지 + 월볼",
    pace: "4:30~4:45/km (빠른 교대)",
  },
  화요일: { area: "러닝 인터벌", plan: "트랙 400m x 8~10회 동반 인터벌", pace: "3:40~4:00/km (동반 페이스)" },
  수요일: { area: "상체 + 코어", plan: "풀업 + 프레스 + 푸시업 + 파머스 캐리 + 코어", pace: "RPE 7~8 (근지구력)" },
  목요일: { area: "회복 및 개인 운동", plan: "가벼운 유산소(Zone2) 20~30분 + 스트레칭", pace: "RPE 2~3 (회복 중심)" },
  금요일: { area: "템포런 + 하체", plan: "5~6km 동반 템포런 + 스플릿 스쿼트 + 케틀벨 스윙", pace: "4:15~4:30/km" },
};

export type SyntheticOptions = {
  seed?: number;
  /** Log data is generated for days up to and including this date. */
  upTo?: string;
  /** Probability each player completes a given trainable day. */
  complianceA?: number;
  complianceB?: number;
  /** Leave metric columns empty, as they are before the first save. */
  metricsBlank?: boolean;
};

/** Build a full 15-week log tab that matches the real spreadsheet's shape. */
export function syntheticSeason(opts: SyntheticOptions = {}): FakeSheet {
  const rand = rng(opts.seed ?? 42);
  const upTo = opts.upTo ?? "2026-08-04";
  const complianceA = opts.complianceA ?? 0.85;
  const complianceB = opts.complianceB ?? 0.7;

  const sheet = new FakeSheet();
  sheet.set(SHEET_LOG_TAB, 1, 0, "🗓️ 2026년 8월 1일 ~ 11월 13일 (15주) HYROX DOUBLES 2인 통합 체크리스트 & 운동일지");
  sheet.set(SHEET_LOG_TAB, 3, 0, "날짜 (Date)");
  // The two-row header, as authored in the real sheet plus the metric columns init-sheet adds.
  for (const [col, text] of [
    [3, "A 목표(kg)"],
    [4, "A 실체중/완료"],
    [5, "B 목표(kg)"],
    [6, "B 실체중/완료"],
    [11, "선수 A 메모"],
    [13, "선수 B 메모"],
    [14, "페이스(/km)"],
    [15, "시간(분)"],
    [16, "RPE"],
    [17, "페이스(/km)"],
    [18, "시간(분)"],
    [19, "RPE"],
    [20, "A 오늘 약속"],
    [21, "B 오늘 약속"],
  ] as [number, string][]) {
    sheet.set(SHEET_LOG_TAB, 4, col, text);
  }

  let weightA = 84.0;
  let weightB = 78.0;

  for (let row = FIRST_ROW; row <= LAST_ROW; row++) {
    const date = dateForRow(row)!;
    const weekday = weekdayKo(date)!;
    const isRace = date === "2026-11-13";
    const tpl = WEEKLY_TEMPLATE[weekday];

    sheet.set(SHEET_LOG_TAB, row, 0, date);
    sheet.set(SHEET_LOG_TAB, row, 1, `W${weekForDate(date)}`);
    sheet.set(SHEET_LOG_TAB, row, 2, weekday);
    sheet.set(SHEET_LOG_TAB, row, 7, isRace ? "🚨 HYROX DOUBLES RACE DAY" : tpl.area);
    sheet.set(SHEET_LOG_TAB, row, 8, isRace ? "🏆 하이록스 더블 대회 출전!" : tpl.plan);
    sheet.set(SHEET_LOG_TAB, row, 9, isRace ? "대회 페이스 (4:00~4:15/km)" : tpl.pace);

    const rest = tpl.area === "휴식";
    const past = date <= upTo;

    for (const [player, col, compliance] of [
      ["A", 4, complianceA],
      ["B", 6, complianceB],
    ] as const) {
      if (!past) {
        sheet.set(SHEET_LOG_TAB, row, col, "[ ] 미완료");
        continue;
      }
      const done = !rest && rand() < compliance;
      const drift = (rand() - 0.55) * 0.4;
      if (player === "A") weightA = Math.round((weightA + drift) * 10) / 10;
      else weightB = Math.round((weightB + drift) * 10) / 10;
      const weight = player === "A" ? weightA : weightB;

      sheet.set(SHEET_LOG_TAB, row, col, done ? `✅ ${weight}kg` : `[ ] 미완료 · ${weight}kg`);

      if (!opts.metricsBlank && done && !rest) {
        const paceSecs = 250 + Math.floor(rand() * 60);
        const paceCol = player === "A" ? 14 : 17;
        sheet.set(SHEET_LOG_TAB, row, paceCol, `${Math.floor(paceSecs / 60)}:${String(paceSecs % 60).padStart(2, "0")}`);
        sheet.set(SHEET_LOG_TAB, row, paceCol + 1, String(40 + Math.floor(rand() * 40)));
        sheet.set(SHEET_LOG_TAB, row, paceCol + 2, String(5 + Math.floor(rand() * 5)));
      }
    }
  }

  // Phase tab, matching the real sheet's A3:H7 block — header row included, because the
  // header is what pins D and E to the right athlete before a target weight is written.
  for (const [col, text] of [
    [0, "단계 (Phase)"],
    [1, "기간 (Period)"],
    [2, "주요 훈련 포커스"],
    [3, "선수 A 목표몸무게"],
    [4, "선수 B 목표몸무게"],
    [5, "더블 목표 페이스"],
    [6, "크로스핏 & 보조 비율"],
    [7, "단계별 달성 체크포인트"],
  ] as [number, string][]) {
    sheet.set(SHEET_PHASE_TAB, 3, col, text);
  }

  const phases = [
    ["Phase 1: 기초 & 스피드 구축", "Week 1 ~ 4\n(08/01 ~ 08/28)", "400m 동반 인터벌 적응", "[   ] kg", "[   ] kg", "4:40 ~ 5:00/km", "크로스핏 60% + 보조 40%", "400m 동반 인터벌 8회 완수"],
    ["Phase 2: 페이스 업 & 교대 전략", "Week 5 ~ 9\n(08/29 ~ 10/02)", "러닝 페이스 단축", "[   ] kg", "[   ] kg", "4:15 ~ 4:35/km", "크로스핏 50% + 보조 50%", "5km 동반 템포런 유지"],
    ["Phase 3: 실전 피크 & 더블 콤보", "Week 10 ~ 13\n(10/03 ~ 10/30)", "지친 상태 동반 러닝", "[   ] kg", "[   ] kg", "3:55 ~ 4:15/km", "크로스핏 50% + 보조 50%", "더블 시뮬레이션 목표 기록 달성"],
    ["Phase 4: 테이퍼링 & 대회 컨디셔닝", "Week 14 ~ 15\n(10/31 ~ 11/13)", "볼륨 50% 감축", "[   ] kg", "[   ] kg", "대회 페이스 (4:00~4:15)", "크로스핏 30% + 회복/테이퍼링", "2026.11.13 최상의 호흡으로 완주"],
  ];
  phases.forEach((cols, i) => {
    cols.forEach((v, c) => sheet.set(SHEET_PHASE_TAB, 4 + i, c, v));
  });

  // Goal tab, section 1 (A4:F10) verbatim from the live sheet, plus the two section titles
  // above it so the fixture is recognisable when a test dumps it. Section 2 (rows 12-18)
  // is left out: the app has no range that reaches it, and the fixture should not either.
  sheet.set(SHEET_GOAL_TAB, 1, 0, "🏋️‍♂️ 2026 HYROX DOUBLES (11/13) 2인 전용 목표 설정 & 운영 원칙");
  sheet.set(SHEET_GOAL_TAB, 3, 0, "1. D-Day 및 더블(2인) 핵심 목표 설정 (Target Goals)");
  const goalRows: [number, string[]][] = [
    [4, ["구분", "선수 A (Player A)", "선수 B (Player B)", "더블 팀 목표 (Team Target)", "달성 전략 및 핵심 요인", "비고"]],
    [5, ["대회 일정", "2026.08.01 시작", "2026.08.01 시작", "2026년 11월 13일 (금)", "15주 동시 병행 프로그램", "D-Day 타겟"]],
    [6, ["몸무게 (Body Weight)", "[   ] kg", "[   ] kg", "팀 최적 레이스 체중 유지", "러닝 경량화 & 파머스/슬레드 분담", "개별 체중 관리"]],
    [7, ["단독 러닝 페이스", "5분대 / km", "5분대 / km", "3분대 후반 ~ 4분대 초반", "동반 러닝 (더블은 함께 레이스)", "페이스 동기화"]],
    [8, ["HYROX 중 1km 페이스", "5분대 후반", "5분대 후반", "4분대 초반 ~ 중반 (4:15~4:30)", "인터벌 및 콤보 런 교대 적응", "피로 상태 페이스"]],
    [9, ["스테이션 교대 전략", "강점 종목 위주 배치", "강점 종목 위주 배치", "스테이션 무휴식 교대 완수", "더블 룰: 스테이션 분할 수행", "스테이션 전략"]],
    [10, ["HYROX 더블 완주 기록", "개인 완주 대비 10분+ 단축", "개인 완주 대비 10분+ 단축", "1시간 05분 ~ 1시간 12분 완주", "빠른 스테이션 교대 + 페이스 교속", "최종 목표 기록"]],
  ];
  for (const [row, cols] of goalRows) {
    cols.forEach((v, c) => sheet.set(SHEET_GOAL_TAB, row, c, v));
  }

  return sheet;
}

/** Collects messages the agent would have sent. */
export function recorder() {
  const sent: string[] = [];
  return {
    sent,
    send: async (text: string) => {
      sent.push(text);
      return { ok: true };
    },
  };
}
