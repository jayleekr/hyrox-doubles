// Self-diagnosis for the whole path between a Telegram message and a cell in the sheet.
//
// Why this exists: every wiring break this project has actually suffered was silent. The
// group was missing from OpenClaw's `groups` map and every message was dropped as
// `not-allowed`; a mention gate ate the photos before they were downloaded; the bot was
// removed from the group and sends 403'd; Telegram privacy mode was toggled on a group the
// bot had already joined. In all four cases the sheet simply stopped filling up, and nobody
// noticed until a human went log-diving days later.
//
// The CLI cannot observe the inbound path directly — a broken inbound path is exactly the
// condition under which the CLI is never invoked. So this module does two different things:
//
//   1. checks everything DOWNSTREAM of the agent, which it can see: node, environment,
//      identity mapping, credentials, sheet reachability, structural anchors, the clock
//   2. detects the one thing an inbound break leaves behind that IS visible here — a
//      player's rows going quiet — and, critically, measures it PER ATHLETE. Every
//      historical break was one-sided, and a combined "last activity" counter would have
//      reported green throughout the incident that prompted this file.
//
// Four rules, in order of how much they matter:
//   · A check never throws. An exception becomes that check's FAIL line. A doctor that
//     reports nothing is the worst possible doctor.
//   · Cheap checks first, network last, so a sheet timeout still leaves the local truth on
//     screen.
//   · Nothing is written unless `--write-probe` is passed explicitly.
//   · What cannot be seen from here is stated as unverifiable rather than omitted. A green
//     verdict must never read as "the bot is alive".

import type { SheetsClient } from "./sheets.ts";
import { loadSeason, type Season } from "./store.ts";
import { PLAYER_IDS, type PlayerId } from "./grid.ts";
import {
  cliCommand,
  googleOAuthCredentialsFile,
  googleServiceAccountJson,
  playerNames,
  spreadsheetId,
  telegramUsers,
} from "./config.ts";
import {
  PHASE_FIRST_ROW,
  PHASE_HEADER_ROW,
  PHASE_LAST_ROW,
  RACE_DATE,
  SEASON_START,
  SHEET_GOAL_TAB,
  SHEET_LOG_TAB,
  SHEET_PHASE_TAB,
  TIMEZONE,
  daysBetween,
  rowForDate,
  todayInSeasonTz,
} from "./season.ts";
import { isSheetBacked } from "./phases.ts";
import { COL } from "./season.ts";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

/**
 * Who applies the fix.
 *
 * Carried per check because the agent relays these lines into a group chat, and "I will fix
 * it" versus "Jay has to fix it" is the only part of a diagnosis the reader acts on.
 */
export type FixOwner = "agent" | "human";

/**
 * Which exit code a FAIL maps to.
 *
 * Deliberately the same two buckets the rest of the CLI already uses: `local` is the
 * existing "1 = bad input, fixable, try again", `sheet` is the existing "2 = the sheet said
 * no, retrying will not help". No new exit code is invented.
 */
export type Severity = "local" | "sheet";

export type DoctorCheck = {
  /** Stable and greppable. Never translated, never reordered. */
  id: string;
  status: CheckStatus;
  /** One Korean sentence the agent can paste into the group verbatim. */
  title: string;
  /** Extra evidence — cell addresses, counts, versions. Never a secret. */
  detail?: string;
  /** Present on every non-PASS check. Names the exact file and key to change. */
  fix?: string;
  fixOwner?: FixOwner;
  severity?: Severity;
};

export type DoctorReport = {
  ok: boolean;
  exitCode: number;
  verdict: string;
  today: string;
  checks: DoctorCheck[];
  /** Facts this CLI is structurally incapable of checking, plus the command that can. */
  unverifiable: string[];
};

export type DoctorOptions = {
  /** A sender id to resolve, so the agent can verify the id it actually holds. */
  telegram?: string | null;
  /** Opt-in write test. Off by default: a diagnostic must not have side effects. */
  writeProbe?: boolean;
  now?: Date;
};

// ---------------------------------------------------------------- helpers

function pass(id: string, title: string, detail?: string): DoctorCheck {
  return { id, status: "PASS", title, ...(detail ? { detail } : {}) };
}

function warn(id: string, title: string, fix: string, fixOwner: FixOwner, detail?: string): DoctorCheck {
  return { id, status: "WARN", title, fix, fixOwner, ...(detail ? { detail } : {}) };
}

function fail(
  id: string,
  title: string,
  fix: string,
  fixOwner: FixOwner,
  severity: Severity,
  detail?: string,
): DoctorCheck {
  return { id, status: "FAIL", title, fix, fixOwner, severity, ...(detail ? { detail } : {}) };
}

function skip(id: string, title: string, fix?: string): DoctorCheck {
  return { id, status: "SKIP", title, ...(fix ? { fix, fixOwner: "human" as FixOwner } : {}) };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One line, no newlines: every check line has to survive being pasted into a chat message. */
function oneLine(text: string, max = 300): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function env(name: string): string {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

// ---------------------------------------------------------------- local checks

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;

function checkNode(): DoctorCheck {
  const raw = process.version.replace(/^v/, "");
  const [major, minor] = raw.split(".").map((n) => Number(n));
  const supported =
    Number.isFinite(major) &&
    (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && Number(minor) >= MIN_NODE_MINOR));
  if (!supported) {
    return fail(
      "node.version",
      `node ${process.version}는 TypeScript를 직접 실행하지 못해 (${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} 이상 필요).`,
      `bin/hyrox가 고른 node가 너무 낮아. HYROX_NODE 환경변수로 새 node 경로를 지정해줘.`,
      "human",
      "local",
      process.execPath,
    );
  }
  return pass("node.version", `node ${process.version} — 타입 스트리핑 가능`, process.execPath);
}

/**
 * Did `bin/hyrox --env-file-if-exists=.env.local` actually find the file?
 *
 * `--env-file-if-exists` is silent when the file is missing, so a renamed or moved
 * `.env.local` produces no error anywhere: identity stops resolving, the sheet id falls back
 * to the built-in default, and every symptom looks like an athlete or a sheet problem.
 */
const ENV_KEYS = [
  "SPREADSHEET_ID",
  "PLAYER_A_NAME",
  "PLAYER_B_NAME",
  "TELEGRAM_USER_A",
  "TELEGRAM_USER_B",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_OAUTH_CREDENTIALS_FILE",
  "PLAYER_A_KEY",
  "PLAYER_B_KEY",
];

function checkEnvFile(): DoctorCheck {
  const present = ENV_KEYS.filter((k) => env(k) !== "");
  if (present.length === 0) {
    return fail(
      "env.file",
      ".env.local에서 아무 설정도 안 읽혔어 — 파일이 없거나 비어 있어.",
      "hyrox 저장소 루트에 .env.local이 있는지 확인해줘 (.env.example을 복사하면 돼).",
      "human",
      "local",
    );
  }
  return pass("env.file", `설정 ${present.length}개 로드됨`, present.join(", "));
}

function checkIdentity(): DoctorCheck {
  const a = env("TELEGRAM_USER_A");
  const b = env("TELEGRAM_USER_B");
  const names = playerNames();
  const missing = [a ? null : "TELEGRAM_USER_A", b ? null : "TELEGRAM_USER_B"].filter(Boolean);
  if (missing.length > 0) {
    return fail(
      "env.identity",
      `${missing.join(", ")}가 비어 있어 — 그 사람의 --telegram은 영원히 거부돼.`,
      ".env.local에 두 사람의 숫자 텔레그램 id를 넣어줘.",
      "human",
      "local",
    );
  }
  const bad = [!/^\d+$/.test(a) ? "TELEGRAM_USER_A" : null, !/^\d+$/.test(b) ? "TELEGRAM_USER_B" : null].filter(
    Boolean,
  );
  if (bad.length > 0) {
    return fail(
      "env.identity",
      `${bad.join(", ")}가 숫자가 아니야 — 텔레그램 sender id는 숫자만이야.`,
      "@username이 아니라 숫자 user id를 넣어줘.",
      "human",
      "local",
    );
  }
  if (a === b) {
    return fail(
      "env.identity",
      `두 사람의 텔레그램 id가 같아 (${a}) — 두 사람 기록이 한 칸에 겹쳐.`,
      ".env.local의 TELEGRAM_USER_A / TELEGRAM_USER_B를 서로 다른 id로 고쳐줘.",
      "human",
      "local",
    );
  }
  return pass("env.identity", `A=${a}(${names.A}) B=${b}(${names.B})`);
}

function checkNames(): DoctorCheck {
  const a = env("PLAYER_A_NAME");
  const b = env("PLAYER_B_NAME");
  if (!a || !b) {
    const which = [a ? null : "PLAYER_A_NAME", b ? null : "PLAYER_B_NAME"].filter(Boolean).join(", ");
    return warn(
      "env.names",
      `${which}가 비어 있어 — 그 사람은 모든 문구에서 "선수 A/B"로 나오고 --who <이름>도 안 먹혀.`,
      ".env.local에 이름을 넣어줘.",
      "human",
    );
  }
  return pass("env.names", `A=${a} / B=${b}`);
}

/**
 * Which Google credential is in play, and whether it is structurally usable.
 *
 * Prints `client_email` and nothing else. That address is not a secret — `sheets.ts` already
 * tells a 403'd user to share the sheet with it — while the private key and the refresh
 * token must never reach a chat message, which is where this output ends up.
 */
async function checkCredentials(): Promise<DoctorCheck> {
  const raw = googleServiceAccountJson();
  if (raw) {
    let creds: { client_email?: string; private_key?: string };
    try {
      creds = JSON.parse(raw) as typeof creds;
    } catch {
      return fail(
        "env.credentials",
        "GOOGLE_SERVICE_ACCOUNT_JSON이 JSON으로 안 읽혀 — 시트에 아예 붙을 수 없어.",
        ".env.local의 GOOGLE_SERVICE_ACCOUNT_JSON을 한 줄짜리 서비스 계정 JSON으로 다시 넣어줘.",
        "human",
        "local",
      );
    }
    if (!creds.client_email || !creds.private_key) {
      return fail(
        "env.credentials",
        "서비스 계정 JSON에 client_email 또는 private_key가 없어.",
        "서비스 계정 키를 다시 발급해서 .env.local에 넣어줘.",
        "human",
        "local",
      );
    }
    return pass("env.credentials", `서비스 계정 — ${creds.client_email}`);
  }

  const path = googleOAuthCredentialsFile();
  try {
    const { readFile } = await import("node:fs/promises");
    const file = await readFile(path, "utf8");
    const creds = JSON.parse(file) as { client_id?: string; client_secret?: string; refresh_token?: string };
    if (!creds.client_id || !creds.client_secret || !creds.refresh_token) {
      return fail(
        "env.credentials",
        `${path}가 authorized_user 자격증명이 아니야 (client_id / client_secret / refresh_token 필요).`,
        "GOOGLE_SERVICE_ACCOUNT_JSON을 쓰거나 gws CLI로 다시 로그인해줘.",
        "human",
        "local",
      );
    }
    return pass("env.credentials", `로컬 OAuth 자격증명 — ${path}`);
  } catch {
    return fail(
      "env.credentials",
      `구글 자격증명이 없어 — GOOGLE_SERVICE_ACCOUNT_JSON도 비어 있고 ${path}도 못 읽었어.`,
      ".env.local에 서비스 계정 JSON을 넣거나, 그 경로에 authorized_user 자격증명을 만들어줘.",
      "human",
      "local",
    );
  }
}

function checkSeasonWindow(today: string): DoctorCheck {
  const row = rowForDate(today);
  if (row === null) {
    return fail(
      "season.window",
      `오늘(${today})은 15주 프로그램 밖이야 (${SEASON_START} ~ ${RACE_DATE}) — today/log 계열이 전부 거부돼.`,
      today < SEASON_START
        ? "시즌 시작 전이야. 8/1부터 기록이 열려."
        : "시즌이 끝났어. 기록하려면 날짜를 시즌 안으로 줘.",
      "human",
      "local",
    );
  }
  const left = daysBetween(today, RACE_DATE) ?? 0;
  return pass("season.window", `${today} · ${SHEET_LOG_TAB} ${row}행 · 대회까지 D-${left}`);
}

function checkClock(today: string, now: Date): DoctorCheck {
  let seasonToday: string;
  try {
    seasonToday = todayInSeasonTz(now);
  } catch (err) {
    return fail(
      "clock.timezone",
      `${TIMEZONE} 타임존을 못 읽었어 — 이 런타임에 타임존 데이터가 없어.`,
      "full-icu가 포함된 node로 실행해줘.",
      "human",
      "local",
      messageOf(err),
    );
  }
  const hostToday = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(
    now,
  );
  if (today !== seasonToday) {
    return warn(
      "clock.timezone",
      `이 명령이 쓰는 오늘(${today})이 서울 기준 오늘(${seasonToday})과 달라.`,
      "--date를 직접 준 게 아니라면 시스템 시계를 확인해줘.",
      "human",
      `host=${hostToday}`,
    );
  }
  return pass("clock.timezone", `${seasonToday} (${TIMEZONE}) · 호스트 ${hostToday}`);
}

/**
 * The only check the agent can drive with a value it actually holds.
 *
 * Given `--telegram <id>` it answers "this id writes into this athlete's column", which is
 * the one question `.env.local` cannot answer on its own: an id that is merely *plausible*
 * — a copy-paste from the wrong chat, a bot id, a channel id — is indistinguishable from a
 * correct one until it is resolved.
 */
function checkTelegramRoundtrip(telegram: string | null | undefined): DoctorCheck {
  const users = telegramUsers();
  const names = playerNames();
  const configured = Object.entries(users)
    .map(([id, player]) => `${id}→${names[player]}`)
    .join(" · ");

  if (!telegram || telegram.trim() === "") {
    if (configured === "") {
      return skip("identity.roundtrip", "확인할 텔레그램 id가 하나도 설정돼 있지 않아.");
    }
    return pass(
      "identity.roundtrip",
      `설정된 id — ${configured}`,
      `${cliCommand()} doctor --telegram <id>로 직접 확인할 수 있어`,
    );
  }

  const found = users[telegram.trim().toLowerCase()];
  if (!found) {
    return fail(
      "identity.roundtrip",
      `텔레그램 id ${telegram.trim()}는 누구인지 몰라 — 이 사람 기록은 전부 거부돼.`,
      ".env.local의 TELEGRAM_USER_A / TELEGRAM_USER_B에 이 id가 있는지 확인해줘.",
      "human",
      "local",
      configured ? `설정된 id — ${configured}` : undefined,
    );
  }
  return pass("identity.roundtrip", `${telegram.trim()} → ${names[found]} (${found}열)`);
}

// ---------------------------------------------------------------- sheet checks

function checkAnchors(season: Season): DoctorCheck {
  const problems = season.misalignedRows;
  if (problems.length === 0) {
    return pass("sheet.anchors", "세 탭의 행/열 앵커가 전부 맞아");
  }
  const shown = problems
    .slice(0, 3)
    .map((m) => `${m.tab ?? SHEET_LOG_TAB} ${m.column}${m.row}: "${m.found || "(비어 있음)"}" ≠ ${m.expected}`)
    .join(" | ");
  const more = problems.length > 3 ? ` (외 ${problems.length - 3}건)` : "";
  return fail(
    "sheet.anchors",
    `시트 구조가 어긋났어 — 어긋난 칸 ${problems.length}개. 고치기 전까지 해당 탭 쓰기가 거부돼.`,
    "시트에서 추가/삭제된 행이나 열을 되돌려줘. 그 전에는 어떤 값을 줘도 쓰이지 않아.",
    "human",
    "sheet",
    `${shown}${more}`,
  );
}

/**
 * Can the goal-weight write paths actually run?
 *
 * The predicate has to be the *write path's own* predicate, not a cheaper one that usually
 * agrees with it. `phaseHeaderReadable` only asks whether row 3 came back non-empty, so a
 * phase tab whose four body rows were cleared — or whose 기간 column was retyped in Korean,
 * "Week 1 ~ 4" → "1~4주차", which `parsePhases` cannot match — passed this check while
 * `savePhaseTarget` refused every write with exit 2. On top of that, `loadSeason` skips the
 * phase row anchors entirely on the DEFAULT_PHASES fallback, so `sheet.anchors` went green
 * too and the whole report read "다 정상이야". An agent refused a phase target and then asked
 * doctor, which told it the sheet was fine and the input must be at fault.
 *
 * `setup` already reported this state correctly. So did `goal show` ("Phase 1 (시트에서 못
 * 읽음)"). Doctor was the only one that did not know, on the one command whose entire job is
 * to be believed about this.
 */
function checkTabs(season: Season): DoctorCheck {
  const broken: string[] = [];
  if (!season.goalTabReadable) broken.push(`${SHEET_GOAL_TAB} (1번 표)`);
  if (!season.phaseHeaderReadable) broken.push(`${SHEET_PHASE_TAB} (헤더 ${PHASE_HEADER_ROW}행)`);
  // Exactly `savePhaseTarget`'s refusal condition, and `onboardingReport`'s block condition.
  else if (!season.phases.some(isSheetBacked)) {
    broken.push(`${SHEET_PHASE_TAB} (본문 ${PHASE_FIRST_ROW}~${PHASE_LAST_ROW}행)`);
  }
  if (broken.length === 0) {
    return pass("sheet.tabs", "목표 탭과 단계 탭 모두 읽혀 — goal 계열 쓰기 가능");
  }
  return fail(
    "sheet.tabs",
    `${broken.join(", ")}을 읽지 못했어 — 목표 몸무게 쓰기가 거부돼 (일지 기록은 정상).`,
    "탭 이름이 바뀌었거나 비어 있어. 시트에서 확인해줘.",
    "human",
    "sheet",
  );
}

/**
 * Does this credential actually have Editor rights?
 *
 * Reads succeed for anyone with view access, so the whole system looks healthy right up
 * until the first write 403s. The probe is off by default and, when on, writes the cell's
 * own current text back to it byte for byte — the one write that cannot change anything.
 * A formula is skipped rather than round-tripped, because a formula reads back as its
 * rendered value and writing that back would replace the formula with a constant.
 */
async function checkWriteProbe(client: SheetsClient, today: string, enabled: boolean): Promise<DoctorCheck> {
  if (!enabled) {
    return skip(
      "sheet.write",
      "쓰기 권한은 확인하지 않았어 — 읽기만으로는 Editor 권한이 있는지 알 수 없어.",
      `확인하려면 ${cliCommand()} doctor --write-probe (같은 값을 그대로 되써서 내용은 안 바뀌어).`,
    );
  }
  const row = rowForDate(today);
  if (row === null) {
    return skip("sheet.write", `오늘(${today})이 시즌 밖이라 되쓸 칸이 없어 — 쓰기 확인을 건너뛰었어.`);
  }
  const range = `'${SHEET_LOG_TAB}'!${COL.aMemo}${row}`;
  try {
    const [current] = await client.batchGet([range]);
    const value = current?.values?.[0]?.[0];
    const text = value === undefined || value === null ? "" : String(value);
    if (text.startsWith("=")) {
      return skip("sheet.write", `${range}에 수식이 들어 있어 — 되쓰면 수식이 사라져서 확인을 건너뛰었어.`);
    }
    await client.batchUpdate([{ range, value: text }]);
    return pass("sheet.write", `쓰기 권한 있음 — ${range}을 같은 값으로 되썼어 (내용 변화 없음)`);
  } catch (err) {
    return fail(
      "sheet.write",
      "시트에 쓸 수 없어 — 읽기는 되는데 쓰기가 거부됐어.",
      oneLine(messageOf(err)),
      "human",
      "sheet",
      range,
    );
  }
}

// ---------------------------------------------------------------- liveness

/** Anything the athlete themselves put in a row. `targetKg` is a plan, so it does not count. */
function hasPlayerData(log: {
  done: boolean;
  weightKg: number | null;
  paceSecPerKm: number | null;
  durationMin: number | null;
  rpe: number | null;
  altWorkout: string;
  memo: string;
}): boolean {
  return (
    log.done ||
    log.weightKg !== null ||
    log.paceSecPerKm !== null ||
    log.durationMin !== null ||
    log.rpe !== null ||
    log.altWorkout !== "" ||
    log.memo !== ""
  );
}

export const FRESHNESS_WARN_DAYS = 3;
export const FRESHNESS_FAIL_DAYS = 7;

/**
 * Days since each athlete last put anything in the sheet — measured separately, on purpose.
 *
 * This is the only symptom of a broken inbound path that is visible from inside the CLI, and
 * it must be per-player because every wiring break this project has had was one-sided: one
 * athlete's messages kept landing while the other's were dropped at the gateway. A combined
 * counter would have shown green for the entire incident this check was written for.
 *
 * It is deliberately a weak signal. Someone can simply not train for a week. That is why the
 * fix line points at the inbound path as a *suspicion* rather than a conclusion.
 */
function checkFreshness(season: Season, today: string): DoctorCheck {
  if (rowForDate(today) === null) {
    return skip("inbound.freshness", "시즌 밖이라 기록 신선도를 볼 수 없어.");
  }
  const names = playerNames();
  const upto = season.records.filter((r) => r.date <= today);

  const perPlayer = PLAYER_IDS.map((p: PlayerId) => {
    const last = upto.filter((r) => hasPlayerData(r[p])).at(-1) ?? null;
    const since = last === null ? daysBetween(SEASON_START, today) : daysBetween(last.date, today);
    return { player: p, name: names[p], last: last?.date ?? null, days: since ?? 0 };
  });

  const describe = (x: (typeof perPlayer)[number]) =>
    x.last === null
      ? `${x.name}: 시즌 시작 이후 기록 없음 (${x.days}일)`
      : x.days === 0
        ? `${x.name}: 오늘`
        : x.days === 1
          ? `${x.name}: 어제`
          : `${x.name}: ${x.days}일째 기록 없음 (마지막 ${x.last})`;

  const summary = perPlayer.map(describe).join(" / ");
  const worst = Math.max(...perPlayer.map((x) => x.days));

  if (worst >= FRESHNESS_FAIL_DAYS) {
    return fail(
      "inbound.freshness",
      summary,
      "텔레그램 수신 경로가 끊겼을 수 있어. openclaw channels status --probe 를 돌려보고, " +
        "게이트웨이 로그에서 not-allowed / no-mention 드롭을 찾아봐. 그냥 안 쉰 거면 무시해도 돼.",
      "human",
      "local",
    );
  }
  if (worst >= FRESHNESS_WARN_DAYS) {
    return warn(
      "inbound.freshness",
      summary,
      "며칠 조용해. 쉬는 중이면 정상이고, 아니면 수신 경로를 의심해줘 (openclaw channels status --probe).",
      "human",
    );
  }
  return pass("inbound.freshness", summary);
}

/**
 * What this CLI structurally cannot see, and the exact command that can.
 *
 * Never a failure and never omitted. Its whole job is to stop a green verdict being read as
 * "messages are arriving" — which is precisely the inference that let four separate outages
 * run for days.
 */
export function unverifiableNotes(chatHint = "-5135679803"): string[] {
  return [
    "텔레그램 수신 경로 — 이 CLI는 메시지가 도착했는지 자체를 볼 수 없어 (안 도착하면 애초에 실행도 안 돼).",
    "openclaw channels status --probe — 폴링 생존 / 그룹 도달성 / canReadAllGroupMessages",
    `게이트웨이 로그에서 chatId ${chatHint} 의 드롭 사유: "not-allowed" (groups 맵에 없음), "no-mention" (멘션 게이트 — 텍스트와 '다운로드 전 미디어' 양쪽)`,
    "openclaw sessions — 그 그룹 세션의 activation:mention 여부 (세션 값이 그룹 설정을 이겨)",
    "봇이 그룹에서 빠졌는지 — 전송 403은 게이트웨이 로그에만 남아",
  ];
}

// ---------------------------------------------------------------- runner

/** Run one check, turning any exception into that check's FAIL line rather than a crash. */
async function guard(id: string, run: () => DoctorCheck | Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await run();
  } catch (err) {
    return fail(
      id,
      `${id} 점검 자체가 실패했어.`,
      "이 메시지를 Jay에게 그대로 전달해줘.",
      "human",
      "local",
      oneLine(messageOf(err)),
    );
  }
}

export async function runDoctor(
  client: SheetsClient,
  today: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const now = options.now ?? new Date();
  const checks: DoctorCheck[] = [];

  // Local first: if the sheet call hangs or throws, everything above it is already known.
  checks.push(await guard("node.version", () => checkNode()));
  checks.push(await guard("env.file", () => checkEnvFile()));
  checks.push(await guard("env.identity", () => checkIdentity()));
  checks.push(await guard("env.names", () => checkNames()));
  checks.push(await guard("env.credentials", () => checkCredentials()));
  checks.push(await guard("season.window", () => checkSeasonWindow(today)));
  checks.push(await guard("clock.timezone", () => checkClock(today, now)));
  checks.push(await guard("identity.roundtrip", () => checkTelegramRoundtrip(options.telegram)));

  let season: Season | null = null;
  let readCheck: DoctorCheck;
  try {
    season = await loadSeason(client);
    readCheck = pass("sheet.read", `시트 읽기 성공 — ${season.records.length}일치`, spreadsheetId());
  } catch (err) {
    readCheck = fail(
      "sheet.read",
      "시트를 읽지 못했어.",
      oneLine(messageOf(err)),
      "human",
      "sheet",
      spreadsheetId(),
    );
  }
  checks.push(readCheck);

  if (season === null) {
    const blocked = "시트를 못 읽어서 확인 못 했어.";
    checks.push(skip("sheet.anchors", blocked));
    checks.push(skip("sheet.tabs", blocked));
    checks.push(skip("sheet.write", blocked));
    checks.push(skip("inbound.freshness", blocked));
  } else {
    const loaded = season;
    checks.push(await guard("sheet.anchors", () => checkAnchors(loaded)));
    checks.push(await guard("sheet.tabs", () => checkTabs(loaded)));
    checks.push(await guard("sheet.write", () => checkWriteProbe(client, today, options.writeProbe === true)));
    checks.push(await guard("inbound.freshness", () => checkFreshness(loaded, today)));
  }

  const fails = checks.filter((c) => c.status === "FAIL");
  const warns = checks.filter((c) => c.status === "WARN");
  // Both kinds present resolves to 2, because "stop retrying and get a human" is the correct
  // instruction in both cases and it is the stronger of the two.
  const exitCode = fails.some((c) => c.severity === "sheet") ? 2 : fails.length > 0 ? 1 : 0;

  const verdict =
    fails.length === 0 && warns.length === 0
      ? "다 정상이야"
      : `문제 ${fails.length}건, 주의 ${warns.length}건`;

  return {
    ok: fails.length === 0,
    exitCode,
    verdict,
    today,
    checks,
    unverifiable: unverifiableNotes(),
  };
}

// ---------------------------------------------------------------- rendering

const OWNER_KO: Record<FixOwner, string> = { agent: "에이전트", human: "사람" };

/**
 * One line per check, `STATUS  id  한국어 한 문장`.
 *
 * The id is stable and greppable; the sentence is written so the agent can paste it into the
 * group without rewriting it. Non-PASS checks get an indented `→ 고치는 법:` naming the exact
 * file and key, and who applies it.
 */
export function renderDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.id.length));
  const lines: string[] = [];

  for (const c of report.checks) {
    lines.push(`${c.status.padEnd(4)}  ${c.id.padEnd(width)}  ${oneLine(c.title)}`);
    if (c.detail) lines.push(`${" ".repeat(6 + width + 2)}${oneLine(c.detail)}`);
    if (c.fix && c.status !== "PASS") {
      const owner = c.fixOwner ? ` (${OWNER_KO[c.fixOwner]})` : "";
      lines.push(`${" ".repeat(6)}→ 고치는 법: ${oneLine(c.fix)}${owner}`);
    }
  }

  lines.push("----");
  lines.push("확인 못 하는 것:");
  for (const note of report.unverifiable) lines.push(`  · ${note}`);
  lines.push(`판정: ${report.verdict} (종료코드 ${report.exitCode})`);

  return lines.join("\n");
}
