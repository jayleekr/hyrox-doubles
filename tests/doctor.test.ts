// `doctor` is the command that runs when everything else has already gone wrong, so the
// property that matters most is that it *always answers*. These tests are therefore mostly
// about the degraded cases: an unreadable sheet, a missing identity, a check that throws.
//
// The second theme is the per-athlete split in `inbound.freshness`. Every wiring break this
// project has had was one-sided — one person's messages kept landing while the other's were
// dropped at the gateway — so a combined counter would have read green throughout. That is
// pinned here rather than left to the rendering.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HYROX_JOURNAL = `${process.env.TMPDIR ?? "/tmp"}/hyrox-journal-test-doctor.jsonl`;
process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";
process.env.TELEGRAM_USER_A = "514675395";
process.env.TELEGRAM_USER_B = "6677345020";
process.env.SPREADSHEET_ID = "test-spreadsheet-id";
// Structurally valid but entirely fake: `doctor` only ever parses it, and FakeSheet needs no
// credential at all. Pinned so the check cannot fall through to whatever real credential
// happens to sit in ~/.config on the machine running the suite.
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "hyrox-bot@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----\\n",
});

const { runDoctor, renderDoctor, FRESHNESS_FAIL_DAYS } = await import("../src/lib/doctor.ts");
const { runCli } = await import("../src/lib/cli.ts");
const { FakeSheet, syntheticSeason } = await import("./fake-sheet.ts");
const { loadSeason } = await import("../src/lib/store.ts");
const { FIRST_ROW, LAST_ROW, SHEET_LOG_TAB, SHEET_PHASE_TAB, dateForRow } = await import("../src/lib/season.ts");
const { PLAYER_IDS } = await import("../src/lib/grid.ts");

const TODAY = "2026-09-09";
/** Noon KST on TODAY, so `clock.timezone` agrees with the date the test is driving. */
const NOW = new Date("2026-09-09T12:00:00+09:00");

type Sheet = ReturnType<typeof syntheticSeason>;

const healthy = (seed = 1) => syntheticSeason({ seed, upTo: "2026-09-08" });

function check(report: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `no check with id ${id}`);
  return found!;
}

/** Blank everything that athlete puts in a row, from `from` onward. */
function silenceFrom(sheet: Sheet, player: "A" | "B", from: string) {
  const cols =
    player === "A"
      ? { status: 4, alt: 10, memo: 11, pace: 14 }
      : { status: 6, alt: 12, memo: 13, pace: 17 };
  for (let row = FIRST_ROW; row <= LAST_ROW; row++) {
    if (dateForRow(row)! < from) continue;
    sheet.set(SHEET_LOG_TAB, row, cols.status, "[ ] 미완료");
    sheet.set(SHEET_LOG_TAB, row, cols.alt, "");
    sheet.set(SHEET_LOG_TAB, row, cols.memo, "");
    for (const c of [cols.pace, cols.pace + 1, cols.pace + 2]) sheet.set(SHEET_LOG_TAB, row, c, "");
  }
}

// ---------------------------------------------------------------- the healthy case

test("a healthy setup passes everything, exits 0, and writes nothing", async () => {
  const sheet = healthy();
  const report = await runDoctor(sheet, TODAY, { now: NOW });

  const bad = report.checks.filter((c) => c.status === "FAIL" || c.status === "WARN");
  assert.deepEqual(bad, [], `unexpected findings: ${JSON.stringify(bad, null, 2)}`);
  assert.equal(report.exitCode, 0);
  assert.equal(report.ok, true);
  assert.equal(sheet.writes, 0, "a diagnostic must not have side effects");
  assert.equal(sheet.writtenCells.length, 0);
});

test("every check runs in a fixed order and every one is reported", async () => {
  // The ids are the grep handle and the agent's stable reference, so their presence and
  // order is part of the contract rather than an implementation detail.
  const report = await runDoctor(healthy(), TODAY, { now: NOW });
  assert.deepEqual(
    report.checks.map((c) => c.id),
    [
      "node.version",
      "env.file",
      "env.identity",
      "env.names",
      "env.credentials",
      "season.window",
      "clock.timezone",
      "identity.roundtrip",
      "agent.pulse",
      "agent.scheduled",
      "sheet.read",
      "sheet.anchors",
      "sheet.tabs",
      "sheet.write",
      "inbound.freshness",
    ],
  );
});

test("the report always states what it cannot verify, even when everything passes", async () => {
  // The whole point: a green verdict must never be read as "messages are arriving". The CLI
  // is structurally blind to the inbound path — a break there is exactly what stops it being
  // invoked — so the boundary has to be printed, not inferred.
  const report = await runDoctor(healthy(), TODAY, { now: NOW });
  assert.equal(report.exitCode, 0);
  assert.ok(report.unverifiable.length >= 3);
  const text = renderDoctor(report);
  assert.match(text, /확인 못 하는 것/);
  assert.match(text, /openclaw channels status --probe/);
  assert.match(text, /no-mention/, "the drop reason a human has to grep for");
});

test("the write probe is skipped by default and says so rather than passing quietly", async () => {
  const report = await runDoctor(healthy(), TODAY, { now: NOW });
  const write = check(report, "sheet.write");
  assert.equal(write.status, "SKIP");
  assert.match(write.fix ?? "", /--write-probe/);
});

test("--write-probe proves Editor rights by writing the cell's own value back", async () => {
  const sheet = healthy();
  const before = JSON.stringify((await loadSeason(sheet)).records);

  const report = await runDoctor(sheet, TODAY, { now: NOW, writeProbe: true });
  assert.equal(check(report, "sheet.write").status, "PASS");
  assert.equal(report.exitCode, 0);
  assert.equal(sheet.writes, 1, "the probe must actually hit the write path");
  assert.equal(sheet.writtenCells.length, 1, "and exactly one cell");
  assert.equal(
    JSON.stringify((await loadSeason(sheet)).records),
    before,
    "while changing nothing that can be read back",
  );
});

test("a write probe that is refused is a sheet failure, not bad input", async () => {
  const sheet = healthy();
  sheet.failNextWrite = "Google refused the request (403)";
  const report = await runDoctor(sheet, TODAY, { now: NOW, writeProbe: true });
  const write = check(report, "sheet.write");
  assert.equal(write.status, "FAIL");
  assert.equal(write.severity, "sheet");
  assert.equal(report.exitCode, 2);
  assert.match(write.fix ?? "", /403/);
});

// ---------------------------------------------------------------- degraded cases

test("an unreadable sheet fails once, and the checks below it say SKIP rather than FAIL", async () => {
  // Four cascading FAILs would bury the one fact that matters. A check that could not run is
  // not a check that found a problem.
  const sheet = healthy();
  sheet.failNextRead = "Google refused the request (403): the account cannot edit the spreadsheet";
  const report = await runDoctor(sheet, TODAY, { now: NOW });

  const read = check(report, "sheet.read");
  assert.equal(read.status, "FAIL");
  assert.equal(read.severity, "sheet");
  assert.match(read.fix ?? "", /403/, "the 403 guidance has to survive into the report");
  assert.equal(report.exitCode, 2);

  for (const id of ["sheet.anchors", "sheet.tabs", "sheet.write", "inbound.freshness"]) {
    assert.equal(check(report, id).status, "SKIP", id);
  }
  // And the local checks above it still reported, which is the reason they run first.
  assert.equal(check(report, "env.identity").status, "PASS");
});

test("a structurally edited sheet fails with code 2 and names the offending cell", async () => {
  const sheet = healthy();
  sheet.set(SHEET_LOG_TAB, 30, 0, "1999-01-01");
  const report = await runDoctor(sheet, TODAY, { now: NOW });

  const anchors = check(report, "sheet.anchors");
  assert.equal(anchors.status, "FAIL");
  assert.equal(anchors.severity, "sheet");
  assert.match(anchors.detail ?? "", /A30/);
  assert.equal(report.exitCode, 2);
});

test("an unreadable phase header is reported as a goal-write problem, not as a dead sheet", async () => {
  // The three tabs fail independently, and saying "the sheet is broken" when daily logging
  // still works is how the athletes learn to ignore this output.
  const sheet = healthy();
  sheet.tabs.get(SHEET_PHASE_TAB)![2] = [];
  const report = await runDoctor(sheet, TODAY, { now: NOW });

  const tabs = check(report, "sheet.tabs");
  assert.equal(tabs.status, "FAIL");
  assert.match(tabs.title, /일지 기록은 정상/);
  assert.equal(check(report, "inbound.freshness").status, "PASS", "logging is unaffected");
});

test("doctor never says the phase tab is writable when savePhaseTarget would refuse it", async () => {
  // The lie this pins down: `phaseHeaderReadable` only asks whether row 3 came back
  // non-empty, so with the header intact and the body gone, doctor printed
  // "목표 탭과 단계 탭 모두 읽혀 — goal 계열 쓰기 가능" and "판정: 다 정상이야 (종료코드 0)"
  // on all 13 checks — while `goal --phase` on the same sheet exited 2. An agent refused a
  // phase target and then asked doctor, which told it the sheet was fine and the fault must
  // lie with the athlete or the input. `sheet.anchors` was green too, because `loadSeason`
  // skips the phase row anchors entirely on the DEFAULT_PHASES fallback.
  //
  // The third scenario is the likely one: this is a Korean spreadsheet and `parsePhases`
  // needs the literal English "Week N ~ M" in the 기간 column. Retyping it as "1~4주차"
  // leaves the header untouched and breaks every body row at once.
  const scenarios: [string, (s: Sheet) => void][] = [
    [
      "body rows blanked",
      (s) => {
        for (let row = 4; row <= 7; row++) for (let col = 0; col <= 7; col++) s.set(SHEET_PHASE_TAB, row, col, "");
      },
    ],
    [
      "body rows deleted outright, header kept",
      (s) => {
        s.tabs.set(SHEET_PHASE_TAB, s.tabs.get(SHEET_PHASE_TAB)!.slice(0, 3));
      },
    ],
    [
      "기간 column retyped in Korean",
      (s) => {
        for (let row = 4; row <= 7; row++) s.set(SHEET_PHASE_TAB, row, 1, `${row - 3}~${row}주차`);
      },
    ],
  ];

  for (const [label, mutate] of scenarios) {
    const sheet = healthy();
    mutate(sheet);

    const report = await runDoctor(sheet, TODAY, { now: NOW });
    const tabs = check(report, "sheet.tabs");
    assert.equal(tabs.status, "FAIL", `${label}: ${tabs.title}`);
    assert.match(tabs.title, /본문/, `${label}: the line has to name the body, not the header`);
    assert.equal(tabs.severity, "sheet");
    assert.equal(report.exitCode, 2, label);
    assert.equal(report.ok, false, label);
    assert.doesNotMatch(report.verdict, /다 정상/, label);

    // The whole point: doctor's verdict and the write path's verdict are the same verdict.
    const write = await runCli(["goal", "--who", "a", "--phase", "2", "--weight", "82"], sheet, TODAY);
    assert.equal(write.code, 2, `${label}: ${write.out}`);

    // And daily logging is untouched, which is why this is not "the sheet is dead".
    assert.equal(check(report, "inbound.freshness").status, "PASS", label);
    const logged = await runCli(["log", "--who", "a", "--done"], sheet, TODAY);
    assert.equal(logged.code, 0, `${label}: ${logged.out}`);
  }

  // Control: on an untouched sheet the same check passes and the same write succeeds, so the
  // three failures above are not an artefact of the fixture.
  const intact = healthy();
  const report = await runDoctor(intact, TODAY, { now: NOW });
  assert.equal(check(report, "sheet.tabs").status, "PASS");
  assert.equal(report.exitCode, 0);
  assert.equal((await runCli(["goal", "--who", "a", "--phase", "2", "--weight", "82"], intact, TODAY)).code, 0);
});

test("a broken identity is a local failure — code 1, never code 2", async () => {
  // The distinction is the whole contract: 1 means someone can fix it and retry, 2 means stop
  // and fetch a human. A missing env var is emphatically the first.
  const saved = process.env.TELEGRAM_USER_B;
  try {
    delete process.env.TELEGRAM_USER_B;
    const report = await runDoctor(healthy(), TODAY, { now: NOW });
    const identity = check(report, "env.identity");
    assert.equal(identity.status, "FAIL");
    assert.equal(identity.severity, "local");
    assert.match(identity.title, /TELEGRAM_USER_B/);
    assert.equal(report.exitCode, 1);
  } finally {
    process.env.TELEGRAM_USER_B = saved;
  }
});

test("two athletes sharing one telegram id is caught, because it silently merges their columns", async () => {
  const saved = process.env.TELEGRAM_USER_B;
  try {
    process.env.TELEGRAM_USER_B = process.env.TELEGRAM_USER_A;
    const report = await runDoctor(healthy(), TODAY, { now: NOW });
    const identity = check(report, "env.identity");
    assert.equal(identity.status, "FAIL");
    assert.match(identity.title, /같아/);
  } finally {
    process.env.TELEGRAM_USER_B = saved;
  }
});

test("a non-numeric telegram id is refused rather than accepted as a username", async () => {
  const saved = process.env.TELEGRAM_USER_A;
  try {
    process.env.TELEGRAM_USER_A = "@jay";
    const report = await runDoctor(healthy(), TODAY, { now: NOW });
    assert.equal(check(report, "env.identity").status, "FAIL");
  } finally {
    process.env.TELEGRAM_USER_A = saved;
  }
});

test("--telegram resolves the id the agent is actually holding, and refuses one it is not", async () => {
  const mine = await runDoctor(healthy(), TODAY, { now: NOW, telegram: "6677345020" });
  const okCheck = check(mine, "identity.roundtrip");
  assert.equal(okCheck.status, "PASS");
  assert.match(okCheck.title, /정재빈/);

  const stranger = await runDoctor(healthy(), TODAY, { now: NOW, telegram: "123456" });
  const bad = check(stranger, "identity.roundtrip");
  assert.equal(bad.status, "FAIL");
  assert.equal(bad.severity, "local");
  assert.equal(stranger.exitCode, 1);
});

test("a missing player name is a warning, not a failure — logging still works without it", async () => {
  const saved = process.env.PLAYER_B_NAME;
  try {
    delete process.env.PLAYER_B_NAME;
    const report = await runDoctor(healthy(), TODAY, { now: NOW });
    assert.equal(check(report, "env.names").status, "WARN");
    assert.equal(report.exitCode, 0, "a WARN must never change the exit code");
    assert.match(report.verdict, /주의 1건/);
  } finally {
    process.env.PLAYER_B_NAME = saved;
  }
});

test("an environment with nothing loaded at all is caught at env.file", async () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
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
  try {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Point the OAuth fallback at a path that cannot exist, so the credential check is about
    // this test's environment and not about whatever the host machine happens to have.
    process.env.GOOGLE_OAUTH_CREDENTIALS_FILE = "/nonexistent/hyrox-doctor-test/credentials.json";
    const report = await runDoctor(healthy(), TODAY, { now: NOW });
    // env.file itself sees the one key we just set, so the real signal here is that a broken
    // environment produces local failures and never crashes.
    assert.equal(check(report, "env.identity").status, "FAIL");
    assert.equal(check(report, "env.credentials").status, "FAIL");
    assert.equal(report.exitCode, 1);
    assert.ok(renderDoctor(report).length > 0);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
});

test("a malformed service-account credential is named exactly, and no key material is printed", async () => {
  const saved = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  try {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "{not json";
    const report = await runDoctor(healthy(), TODAY, { now: NOW });
    const cred = check(report, "env.credentials");
    assert.equal(cred.status, "FAIL");
    assert.match(cred.title, /JSON/);
  } finally {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = saved;
  }

  // The healthy path prints the client_email — which `sheets.ts` already tells a 403'd user
  // to share the sheet with — and nothing else. This output ends up in a group chat.
  const good = await runDoctor(healthy(), TODAY, { now: NOW });
  const text = renderDoctor(good);
  assert.match(text, /hyrox-bot@example\.iam\.gserviceaccount\.com/);
  assert.doesNotMatch(text, /PRIVATE KEY/);
});

test("a date outside the season fails locally and does not drag the sheet checks down with it", async () => {
  const sheet = healthy();
  const report = await runDoctor(sheet, "2026-11-14", { now: new Date("2026-11-14T12:00:00+09:00") });
  const window = check(report, "season.window");
  assert.equal(window.status, "FAIL");
  assert.equal(window.severity, "local");
  assert.equal(check(report, "sheet.read").status, "PASS", "the sheet is still perfectly readable");
  assert.equal(check(report, "inbound.freshness").status, "SKIP");
  assert.equal(report.exitCode, 1);
});

test("a clock that disagrees with Seoul is a warning with both dates named", async () => {
  const report = await runDoctor(healthy(), "2026-09-08", { now: NOW });
  const clock = check(report, "clock.timezone");
  assert.equal(clock.status, "WARN");
  assert.match(clock.title, /2026-09-08/);
  assert.match(clock.title, /2026-09-09/);
});

// ---------------------------------------------------------------- the one-sided break

test("one athlete going quiet is visible while the other is fresh", async () => {
  // The shape of the incident this check exists for: 정재빈's messages were dropped at the
  // OpenClaw ingress for over a week while Jay's kept landing. A combined "last activity"
  // counter reports green for the whole of that, which is why this is measured per athlete.
  const sheet = healthy();
  silenceFrom(sheet, "B", "2026-08-25");
  const report = await runDoctor(sheet, TODAY, { now: NOW });

  const fresh = check(report, "inbound.freshness");
  assert.equal(fresh.status, "FAIL");
  assert.match(fresh.title, /정재빈/);
  assert.match(fresh.title, /Jay/, "the healthy athlete is named too, so the split is visible");
  assert.match(fresh.title, /16일째/);
  assert.match(fresh.fix ?? "", /openclaw channels status --probe/);
  assert.equal(report.exitCode, 1, "a wiring suspicion is fixable, so it is a 1 and not a 2");
});

test("freshness thresholds: fresh passes, a few days warns, a week fails", async () => {
  for (const [quietFor, expected] of [
    [0, "PASS"],
    [1, "PASS"],
    [FRESHNESS_FAIL_DAYS - 4, "WARN"],
    [FRESHNESS_FAIL_DAYS - 1, "WARN"],
    [FRESHNESS_FAIL_DAYS, "FAIL"],
    [FRESHNESS_FAIL_DAYS + 5, "FAIL"],
  ] as const) {
    const sheet = healthy();
    const last = dateForRow(FIRST_ROW + 39 - quietFor)!; // 2026-09-09 is row 44
    silenceFrom(sheet, "A", dateForRow(FIRST_ROW + 40 - quietFor)!);
    silenceFrom(sheet, "B", dateForRow(FIRST_ROW + 40 - quietFor)!);
    const report = await runDoctor(sheet, TODAY, { now: NOW });
    assert.equal(
      check(report, "inbound.freshness").status,
      expected,
      `quiet for ${quietFor} days (last ${last}): ${check(report, "inbound.freshness").title}`,
    );
  }
});

test("an athlete who has never logged anything is reported as such, not as 0 days", async () => {
  const sheet = syntheticSeason({ seed: 4, upTo: "2026-07-31", metricsBlank: true });
  const report = await runDoctor(sheet, TODAY, { now: NOW });
  const fresh = check(report, "inbound.freshness");
  assert.equal(fresh.status, "FAIL");
  assert.match(fresh.title, /시즌 시작 이후 기록 없음/);
});

test("a target weight written by the partner does not count as that athlete logging", async () => {
  // `goal --date` fills column D/F. It is a plan somebody typed, not evidence that this
  // athlete's messages are still arriving — counting it would mask exactly the break we look for.
  const sheet = healthy();
  silenceFrom(sheet, "B", "2026-08-25");
  await runCli(["goal", "--who", "b", "--date", TODAY, "--weight", "75"], sheet, TODAY);

  const report = await runDoctor(sheet, TODAY, { now: NOW });
  assert.equal(check(report, "inbound.freshness").status, "FAIL");
});

// ---------------------------------------------------------------- robustness and wiring

test("doctor never throws: a client that explodes on every call still produces a full report", async () => {
  const exploding = {
    async batchGet(): Promise<never> {
      throw new Error("boom");
    },
    async batchUpdate(): Promise<never> {
      throw new Error("boom");
    },
  };
  const report = await runDoctor(exploding, TODAY, { now: NOW, writeProbe: true });
  assert.equal(report.checks.length, 15, "every check still reported");
  assert.equal(check(report, "sheet.read").status, "FAIL");
  assert.equal(report.exitCode, 2);
  assert.ok(renderDoctor(report).includes("판정:"));
});

test("an empty sheet is diagnosed rather than crashing the report", async () => {
  const report = await runDoctor(new FakeSheet(), TODAY, { now: NOW });
  assert.equal(check(report, "sheet.read").status, "PASS", "an empty range reads fine");
  assert.equal(check(report, "sheet.tabs").status, "FAIL", "but the goal and phase tabs are unreadable");
  assert.equal(report.exitCode, 2);
});

test("the rendered report is one line per check, greppable by id, and chat-sized", async () => {
  const sheet = healthy();
  silenceFrom(sheet, "B", "2026-08-25");
  const text = renderDoctor(await runDoctor(sheet, TODAY, { now: NOW }));

  for (const id of ["node.version", "sheet.anchors", "inbound.freshness"]) {
    assert.ok(new RegExp(`^(PASS|WARN|FAIL|SKIP)\\s+${id.replace(".", "\\.")}\\s`, "m").test(text), id);
  }
  assert.match(text, /→ 고치는 법:/);
  assert.match(text, /판정: 문제 1건/);
  assert.ok(text.split("\n").length <= 40, `report is ${text.split("\n").length} lines`);
  // The same rule every other emitted string follows: OpenClaw composes the outgoing message.
  assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/);
  assert.doesNotMatch(text, /<\/?(b|i|code|pre|a)\b/);
});

test("--json carries the whole report and nothing that has to be parsed out of prose", async () => {
  const sheet = healthy();
  const r = await runCli(["doctor", "--json"], sheet, TODAY);
  const parsed = JSON.parse(r.out) as {
    ok: boolean;
    exitCode: number;
    verdict: string;
    today: string;
    checks: { id: string; status: string }[];
    unverifiable: string[];
  };
  assert.equal(parsed.today, TODAY);
  assert.equal(parsed.exitCode, r.code);
  assert.equal(parsed.checks.length, 15);
  assert.ok(parsed.unverifiable.length > 0);
  assert.equal(typeof parsed.ok, "boolean");
});

test("runCli wires doctor to its own exit code and keeps the report on stdout", async () => {
  // A non-zero exit is doctor's *successful* outcome, so `hyrox doctor --json | jq` must still
  // receive the report. Every other command sends a non-zero result to stderr.
  const sheet = healthy();
  sheet.set(SHEET_LOG_TAB, 30, 0, "1999-01-01");
  const r = await runCli(["doctor"], sheet, TODAY);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, true);
  assert.match(r.out, /sheet\.anchors/);
});

test("doctor is a read: it never writes unless the probe is asked for", async () => {
  const sheet = healthy();
  await runCli(["doctor"], sheet, TODAY);
  await runCli(["doctor", "--json"], sheet, TODAY);
  await runCli(["doctor", "--telegram", "514675395"], sheet, TODAY);
  assert.equal(sheet.writes, 0);
});

test("doctor covers both athletes, so neither can be diagnosed as the other", async () => {
  const report = await runDoctor(healthy(), TODAY, { now: NOW });
  const fresh = check(report, "inbound.freshness");
  for (const p of PLAYER_IDS) {
    const name = p === "A" ? "Jay" : "정재빈";
    assert.ok(fresh.title.includes(name), `${name} missing from the freshness line`);
  }
});
