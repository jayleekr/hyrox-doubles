// The CLI is the boundary between OpenClaw's natural-language understanding and the
// sheet. Everything upstream of it is a language model; everything downstream is
// permanent. So these tests are mostly about what it *refuses*: a sentence the model
// misread should fail loudly here rather than quietly writing a wrong number into a
// season that nobody re-reads.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HYROX_JOURNAL = `${process.env.TMPDIR ?? "/tmp"}/hyrox-journal-test-cli.jsonl`;
process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";
process.env.TELEGRAM_USER_A = "514675395";
process.env.TELEGRAM_USER_B = "999888777";

const { runCli } = await import("../src/lib/cli.ts");
const { loadSeason } = await import("../src/lib/store.ts");
const { syntheticSeason } = await import("./fake-sheet.ts");
const { SHEET_LOG_TAB } = await import("../src/lib/season.ts");

const TODAY = "2026-09-09";
const fresh = (seed = 1) => syntheticSeason({ seed, upTo: "2026-09-08" });
/** A season with no history at all — the state a newly added athlete is actually in. */
const cold = (seed = 30) => syntheticSeason({ seed, upTo: "2026-07-31", metricsBlank: true });

/**
 * One real session, exactly as it was dictated into the group: a run, a partner WOD carrying
 * two kettlebell loads, and a body weight — followed by the fatigue score and the pace in two
 * further messages. This is the session that went missing, so it is the fixture.
 */
const WOD =
  "런 2.2km / 10 rounds for time with a partner: 30 KB swings (16/24 kg) / " +
  ":30 bottoms-up KB hold (16/24 kg) / Partners alternate rounds / " +
  "Nonworking partner accumulates time in an L-sit";

async function log(sheet: ReturnType<typeof fresh>, args: string[], today = TODAY) {
  return runCli(["log", ...args], sheet, today);
}

// ---------------------------------------------------------------- identity

test("a player can be named by id or by exact configured name", async () => {
  for (const who of ["a", "A", "Jay", "jay"]) {
    const r = await log(fresh(), ["--who", who, "--done"]);
    assert.equal(r.code, 0, `${who}: ${r.out}`);
    assert.match(r.out, /Jay/);
  }
  const b = await log(fresh(), ["--who", "정재빈", "--done"]);
  assert.equal(b.code, 0, b.out);
});

test("identity is never guessed: no prefixes, no substrings, no near misses", async () => {
  // Writing to the wrong athlete's column is silent and effectively permanent, so a
  // name that is merely close must be rejected rather than resolved.
  for (const who of ["j", "Ja", "Jay Lee", "정재", "정재빈님", "c", ""]) {
    const r = await log(fresh(), ["--who", who, "--done"]);
    assert.equal(r.code, 1, `"${who}" should not have resolved: ${r.out}`);
    assert.match(r.out, /누구인지 몰라|--who/);
  }
});

test("a telegram id resolves to its player, and an unknown id is refused", async () => {
  const a = await log(fresh(), ["--telegram", "514675395", "--done"]);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /Jay/);

  const b = await log(fresh(), ["--telegram", "999888777", "--done"]);
  assert.equal(b.code, 0, b.out);
  assert.match(b.out, /정재빈/);

  const stranger = await log(fresh(), ["--telegram", "123", "--done"]);
  assert.equal(stranger.code, 1);
  assert.match(stranger.out, /누구인지 몰라/);

  // An id that collides with an Object prototype key must not resolve to anything.
  const proto = await log(fresh(), ["--telegram", "constructor", "--done"]);
  assert.equal(proto.code, 1, proto.out);
});

test("logging with no subject at all is refused", async () => {
  const r = await log(fresh(), ["--done"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /--who|--telegram/);
});

// ---------------------------------------------------------------- validation

test("out-of-range values are refused rather than stored", async () => {
  const cases: [string, string, RegExp][] = [
    ["--weight", "820", /범위 밖/],
    ["--weight", "12", /범위 밖/],
    ["--weight", "여든둘", /숫자로 못 읽/],
    ["--pace", "4:75", /초가 60/],
    ["--pace", "420", /M:SS/],
    ["--pace", "1:30", /범위 밖/],
    ["--pace", "25:00", /범위 밖/],
    ["--duration", "0", /범위 밖/],
    ["--duration", "900", /범위 밖/],
    ["--duration", "45.5", /정수/],
    ["--rpe", "0", /범위 밖/],
    ["--rpe", "11", /범위 밖/],
    ["--rpe", "7.5", /정수/],
  ];
  for (const [flag, value, expected] of cases) {
    const sheet = fresh();
    const r = await log(sheet, ["--who", "a", "--done", flag, value]);
    assert.equal(r.code, 1, `${flag} ${value} should have been refused: ${r.out}`);
    assert.match(r.out, expected, `${flag} ${value}`);
    assert.equal(sheet.writes, 0, `${flag} ${value}: nothing may be written on a refusal`);
  }
});

test("a refused value blocks the whole log, including the valid parts of it", async () => {
  // Partial application would be worse than refusal: the athlete is told the log failed
  // while some of it silently landed.
  const sheet = fresh();
  const r = await log(sheet, ["--who", "a", "--done", "--weight", "82.4", "--rpe", "99"]);
  assert.equal(r.code, 1);
  assert.equal(sheet.writes, 0);
  const record = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!;
  assert.equal(record.A.done, false, "the --done flag must not have been applied either");
  assert.equal(record.A.weightKg, null);
});

test("an equipment load mistaken for body weight is caught by the jump check", async () => {
  // "슬레드 152kg 밀었어" is the sentence that breaks naive parsing: 152 is a perfectly
  // plausible weight in isolation, so only the athlete's own history reveals it is wrong.
  const sheet = fresh();
  await log(sheet, ["--who", "a", "--done", "--weight", "82.4", "--date", "2026-09-08"], "2026-09-08");

  const sled = await log(sheet, ["--who", "a", "--done", "--weight", "152"]);
  assert.equal(sled.code, 1, sled.out);
  assert.match(sled.out, /장비 무게/);
  assert.match(sled.out, /82\.4kg/, "the refusal names what it compared against");

  const after = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A;
  assert.equal(after.weightKg, null, "nothing was written");

  // A real 10kg+ change is still recordable — the check asks a question, it does not
  // decide that the athlete is wrong.
  const forced = await log(sheet, ["--who", "a", "--done", "--weight", "152", "--force"]);
  assert.equal(forced.code, 0, forced.out);
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A.weightKg, 152);
});

test("the weight jump check allows normal drift and the first-ever entry", async () => {
  const sheet = fresh();
  // Nothing to compare against yet: a first weight must not be blocked.
  const first = await log(sheet, ["--who", "a", "--done", "--weight", "82.4", "--date", "2026-09-07"], "2026-09-07");
  assert.equal(first.code, 0, first.out);

  for (const w of ["83.1", "81.0", "84.9"]) {
    const r = await log(sheet, ["--who", "a", "--weight", w]);
    assert.equal(r.code, 0, `${w}: ${r.out}`);
  }
});

test("on a first record, the athlete's own declared goal weight is the backstop", async () => {
  // The gap this closes. 정재빈 has zero records since the season started, so the jump check
  // — which needs a previous weight — did nothing, and `--weight 30` from "30 KB swings"
  // saved at exit 0 (30 is exactly the accepted lower bound). The damage is second-order:
  // that 30 becomes the baseline, so the *correct* 109 is then the thing refused, with a
  // message that tells the agent to suspect the correct number of being equipment. First
  // number wins, and only a human reading the confirmation line would ever notice.
  //
  // The signal was already loaded: the guard calls `loadSeason`, which carries the goal
  // weight the athlete declared on the goal tab.
  const sheet = cold();
  const goal = await runCli(["goal", "--telegram", "999888777", "--weight", "100"], sheet, TODAY);
  assert.equal(goal.code, 0, goal.out);

  const kettlebell = await log(sheet, ["--telegram", "999888777", "--done", "--weight", "30"]);
  assert.equal(kettlebell.code, 1, kettlebell.out);
  assert.match(kettlebell.out, /장비 무게/);
  assert.match(kettlebell.out, /100kg/, "the refusal names what it compared against");
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B.weightKg, null);

  // The real weight goes in on the first try, because it is near the declared goal.
  const real = await log(sheet, ["--telegram", "999888777", "--done", "--weight", "109"]);
  assert.equal(real.code, 0, real.out);
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B.weightKg, 109);
});

test("a phase goal alone is enough of a backstop, and --force still gets through", async () => {
  const sheet = cold();
  assert.equal((await runCli(["goal", "--who", "b", "--phase", "1", "--weight", "100"], sheet, TODAY)).code, 0);

  const refused = await log(sheet, ["--who", "b", "--weight", "30"]);
  assert.equal(refused.code, 1, refused.out);
  assert.equal(sheet.writes, 1, "only the goal write happened");

  const forced = await log(sheet, ["--who", "b", "--weight", "30", "--force"]);
  assert.equal(forced.code, 0, forced.out);
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B.weightKg, 30);
});

test("with no goal weight on the sheet a first record is still accepted", async () => {
  // The documented limit, pinned so the new backstop cannot quietly become a gate: an
  // athlete who has declared nothing has nothing to be compared against, and refusing their
  // very first log would be worse than the failure this guard is for.
  const sheet = cold();
  const r = await log(sheet, ["--telegram", "999888777", "--done", "--weight", "109"]);
  assert.equal(r.code, 0, r.out);
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B.weightKg, 109);

  // A weight sitting far from the goal is a fact about the athlete, not a parse error: the
  // band is wide because a goal is a plan.
  const far = cold();
  assert.equal((await runCli(["goal", "--who", "b", "--weight", "75"], far, TODAY)).code, 0);
  assert.equal((await log(far, ["--who", "b", "--weight", "95"])).code, 0, "20kg from a goal is an athlete");
});

test("the jump check does not call today's own row a previous record", async () => {
  // A session arrives across several messages, so the baseline deliberately includes the day
  // being written. Calling that "직전 기록(<today>)" misstated the one fact a reader needs to
  // judge the refusal: it is this athlete's own row, written seconds ago.
  const sheet = cold();
  assert.equal((await log(sheet, ["--who", "b", "--weight", "109"])).code, 0);

  const r = await log(sheet, ["--who", "b", "--weight", "30"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /오늘 이미 기록된 값\(109kg\)/, r.out);
  assert.doesNotMatch(r.out, /직전 기록/, r.out);

  // A genuinely earlier day is still named as one, with its date.
  const warm = fresh();
  const yesterday = await log(warm, ["--who", "a", "--weight", "150"]);
  assert.equal(yesterday.code, 1, yesterday.out);
  assert.match(yesterday.out, /직전 기록\(2026-09-08 /, yesterday.out);
});

test("dates outside the 15-week programme are refused", async () => {
  for (const date of ["2026-07-31", "2026-11-14", "2025-09-09"]) {
    const r = await log(fresh(), ["--who", "a", "--done", "--date", date]);
    assert.equal(r.code, 1, `${date}: ${r.out}`);
    assert.match(r.out, /프로그램 밖/);
  }
});

test("malformed and impossible dates are refused", async () => {
  for (const date of ["2026-9-9", "09-09-2026", "2026-02-30", "오늘", ""]) {
    const r = await log(fresh(), ["--who", "a", "--done", "--date", date]);
    assert.equal(r.code, 1, `"${date}" should have been refused: ${r.out}`);
  }
});

test("--done and --not-done together is a contradiction, not a coin flip", async () => {
  const sheet = fresh();
  const r = await log(sheet, ["--who", "a", "--done", "--not-done"]);
  assert.equal(r.code, 1);
  assert.equal(sheet.writes, 0);
});

test("a log with nothing to store is refused", async () => {
  const r = await log(fresh(), ["--who", "a"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /저장할 내용이 없어/);
});

// ---------------------------------------------------------------- writing

test("values round-trip through the sheet exactly", async () => {
  const sheet = fresh();
  const r = await log(sheet, [
    "--who", "a", "--done",
    "--weight", "82.4", "--pace", "4:20", "--duration", "55", "--rpe", "7",
    "--memo", "컨디션 좋았음", "--alt", "로잉 2km",
  ]);
  assert.equal(r.code, 0, r.out);

  const log_ = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A;
  assert.equal(log_.done, true);
  assert.equal(log_.weightKg, 82.4);
  assert.equal(log_.paceSecPerKm, 260);
  assert.equal(log_.durationMin, 55);
  assert.equal(log_.rpe, 7);
  assert.equal(log_.memo, "컨디션 좋았음");
  assert.equal(log_.altWorkout, "로잉 2km");
});

test("`none` clears a stored value without touching the others", async () => {
  const sheet = fresh();
  await log(sheet, ["--who", "a", "--done", "--weight", "82.4", "--pace", "4:20", "--rpe", "7"]);
  const cleared = await log(sheet, ["--who", "a", "--pace", "none"]);
  assert.equal(cleared.code, 0, cleared.out);

  const after = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A;
  assert.equal(after.paceSecPerKm, null, "pace cleared");
  assert.equal(after.weightKg, 82.4, "weight untouched");
  assert.equal(after.rpe, 7, "rpe untouched");
  assert.equal(after.done, true, "done untouched");
});

test("the confirmation reports the sheet's state, including the partner", async () => {
  const sheet = fresh();
  await log(sheet, ["--who", "b", "--done", "--weight", "76.5"]);
  const r = await log(sheet, ["--who", "a", "--done", "--weight", "82.4"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Jay/);
  assert.match(r.out, /82\.4kg/);
  assert.match(r.out, /정재빈은 이미 완료/, "the partner's real status, and the right particle");
});

// ---------------------------------------------------------------- argument parsing

test("--flag=value and --flag value are equivalent", async () => {
  const a = fresh();
  const b = fresh();
  await log(a, ["--who=a", "--done", "--weight=82.4", "--memo=좋았음"]);
  await log(b, ["--who", "a", "--done", "--weight", "82.4", "--memo", "좋았음"]);
  assert.equal(
    JSON.stringify((await loadSeason(a)).records),
    JSON.stringify((await loadSeason(b)).records),
  );
});

test("a bare value flag clears that field, which is how a boolean-looking flag reads", async () => {
  // `--memo --done` parses as "clear the memo, and mark done". Documented, and tested so
  // it stays deliberate: OpenClaw should use --memo=<text> for text that may start with
  // a dash.
  const sheet = fresh();
  await log(sheet, ["--who", "a", "--memo", "먼저 쓴 메모"]);
  const r = await log(sheet, ["--who", "a", "--memo", "--done"]);
  assert.equal(r.code, 0, r.out);

  const after = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A;
  assert.equal(after.memo, "");
  assert.equal(after.done, true);
});

test("a value attached to --done is refused, never ignored", async () => {
  // `flagBool` looked only at presence, and `parseArgs` swallows the next non-`--` token as
  // this flag's value. So `--done false` wrote ✅ 완료 at exit 0 — the sheet's most important
  // boolean, inverted, and carried straight into completion rate, streak, nudge and the
  // weekly review. `--done 109` was worse: the 109 was eaten as the flag's value and the
  // athlete was told the session saved with no weight in it at all.
  //
  // The argv here is written by a language model from free-form Korean, and `--flag false`
  // is one of the two dominant CLI conventions. `--done ""` needs no model error at all —
  // an unset shell variable produces it.
  const cases: string[][] = [
    ["--telegram", "999888777", "--done", "false"],
    ["--telegram", "999888777", "--done", "no"],
    ["--telegram", "999888777", "--done", "0"],
    ["--telegram", "999888777", "--done=false"],
    ["--telegram", "999888777", "--done", "109"],
    ["--telegram", "999888777", "--done", ""],
    ["--telegram", "999888777", "--not-done", "true"],
    ["--telegram", "999888777", "--done", "--force", "yes"],
  ];
  for (const args of cases) {
    const sheet = cold();
    const r = await log(sheet, args);
    assert.equal(r.code, 1, `${args.join(" ")} should have been refused: ${r.out}`);
    assert.equal(sheet.writes, 0, `${args.join(" ")}: nothing may be written on a refusal`);
    assert.match(r.out, /값을 받지 않는/, args.join(" "));
    const after = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B;
    assert.equal(after.done, false, `${args.join(" ")}: the boolean must not have flipped`);
    assert.equal(after.weightKg, null, args.join(" "));
  }

  // The forms that mean something still work, so this is a closed hole and not a closed door.
  const sheet = cold();
  const ok = await log(sheet, ["--telegram", "999888777", "--done", "--weight", "109"]);
  assert.equal(ok.code, 0, ok.out);
  const saved = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B;
  assert.equal(saved.done, true);
  assert.equal(saved.weightKg, 109);

  const skipped = await log(cold(), ["--telegram", "999888777", "--not-done"]);
  assert.equal(skipped.code, 0, skipped.out);
});

test("every valueless flag refuses a value, on every command that takes one", async () => {
  // `--done` is the one that inverts meaning, but the same hole existed on all of them, and
  // a `--json` that quietly ate the next token is how a read turns into a different read.
  const cases: string[][] = [
    ["today", "--json", "yes"],
    ["stats", "--who", "a", "--json", "true"],
    ["doctor", "--write-probe", "false"],
    ["goal", "--who", "a", "--weight", "82", "--force", "no"],
    ["log", "--who", "a", "--weight", "152", "--force", "true"],
  ];
  for (const argv of cases) {
    const sheet = fresh();
    const r = await runCli(argv, sheet, TODAY);
    assert.equal(r.code, 1, `${argv.join(" ")} should have been refused: ${r.out}`);
    assert.equal(sheet.writes, 0, argv.join(" "));
    assert.match(r.out, /값을 받지 않는/, argv.join(" "));
  }
  // And the bare forms are untouched.
  assert.equal((await runCli(["today", "--json"], fresh(), TODAY)).code, 0);
  assert.equal((await runCli(["goal", "--who", "a", "--weight", "82", "--force"], fresh(), TODAY)).code, 0);
});

test("a flag given twice is refused, never resolved to the last one", async () => {
  // The regression: flags live in a Map, so `--who a --who b` silently became `--who b` and
  // filed Jay's session under 정재빈 — while the identical disagreement spelled across two
  // flag names (`--telegram <B> --who a`) was already refused by name. "둘 다 82kg으로 하자"
  // is exactly the sentence that makes an agent emit two identity flags in one command, and
  // a plural sentence is two writes or none.
  const cases: string[][] = [
    ["goal", "--who", "a", "--who", "b", "--weight", "82"],
    ["goal", "--who=a", "--who=b", "--weight", "82"],
    ["goal", "--who", "a", "--who=b", "--weight", "82"],
    ["goal", "--telegram", "514675395", "--telegram", "999888777", "--weight", "82"],
    ["goal", "--who", "a", "--weight", "82", "--weight", "91"],
    ["goal", "--who", "a", "--phase", "1", "--phase", "4", "--weight", "82"],
    ["goal", "--who", "a", "--date", "2026-09-14", "--date", "2026-08-05", "--weight", "82"],
    ["log", "--who", "a", "--who", "b", "--done", "--weight", "80"],
    ["log", "--who", "a", "--done", "--rpe", "7", "--rpe", "9"],
    ["setup", "--who", "a", "--who", "b"],
    ["stats", "--who", "a", "--who", "b"],
  ];
  for (const argv of cases) {
    const sheet = fresh();
    const r = await runCli(argv, sheet, TODAY);
    assert.equal(r.code, 1, `${argv.join(" ")} should have been refused: ${r.out}`);
    assert.match(r.out, /두 번 줬어/, argv.join(" "));
    assert.equal(sheet.writes, 0, `${argv.join(" ")}: nothing may be written on a refusal`);
  }
});

test("the repeat check names the flag and does not fire on distinct flags", async () => {
  const sheet = fresh();
  const r = await runCli(["log", "--who", "a", "--who", "b", "--done"], sheet, TODAY);
  assert.match(r.out, /--who/, "the message has to name which flag was doubled");
  assert.doesNotMatch(r.out, /--done/, "and only the doubled one");

  // The ordinary case must stay untouched: many different flags in one command is normal.
  const fine = await runCli(
    ["log", "--who", "a", "--done", "--weight", "82.4", "--pace", "4:20", "--rpe", "7", "--memo", "ok"],
    sheet,
    TODAY,
  );
  assert.equal(fine.code, 0, fine.out);
});

test("a memo that begins with a dash survives the = form", async () => {
  const sheet = fresh();
  const r = await log(sheet, ["--who", "a", "--memo=--이건 메모야"]);
  assert.equal(r.code, 0, r.out);
  const after = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A;
  assert.equal(after.memo, "--이건 메모야");
});

// ---------------------------------------------------------------- read commands

test("today, day and week describe the sheet without changing it", async () => {
  const sheet = fresh();
  for (const argv of [["today"], ["day", TODAY], ["week"], ["week", TODAY]]) {
    const r = await runCli(argv, sheet, TODAY);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.out}`);
    assert.ok(r.out.length > 0);
  }
  assert.equal(sheet.writes, 0, "read commands must never write");
});

test("--json emits parseable output for every read command", async () => {
  const sheet = fresh();
  for (const argv of [["today", "--json"], ["day", TODAY, "--json"], ["week", "--json"], ["stats", "--who", "a", "--json"]]) {
    const r = await runCli(argv, sheet, TODAY);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.out}`);
    assert.doesNotThrow(() => JSON.parse(r.out), `${argv.join(" ")} was not valid JSON`);
  }
});

test("stats needs to know whose stats, and reports them", async () => {
  const sheet = fresh();
  const missing = await runCli(["stats"], sheet, TODAY);
  assert.equal(missing.code, 1);

  const r = await runCli(["stats", "--who", "a"], sheet, TODAY);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /완료 \d+\/\d+/);
  assert.match(r.out, /연속 \d+일/);
});

test("briefs that have nothing to say emit nothing at all", async () => {
  // A rest day has no nudge. Emitting a blank line would make OpenClaw send an empty
  // message; emitting an error would make a routine day look like a failure.
  const sheet = syntheticSeason({ seed: 3, upTo: "2026-09-05" });
  const r = await runCli(["brief", "nudge", "--date", "2026-09-06"], sheet, "2026-09-06");
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
});

test("an unknown command or brief kind explains itself instead of guessing", async () => {
  const sheet = fresh();
  const bad = await runCli(["frobnicate"], sheet, TODAY);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /모르는 명령/);

  const kind = await runCli(["brief", "afternoon"], sheet, TODAY);
  assert.equal(kind.code, 1);
  assert.match(kind.out, /morning \| nudge \| weekly/);

  const help = await runCli(["help"], sheet, TODAY);
  assert.equal(help.code, 0);
  assert.match(help.out, /--telegram/);
});

// ---------------------------------------------------------------- one session, several messages

test("a session split across several messages accumulates into one row", async () => {
  // The reported failure: 정재빈 sent the workout, then "오늘의 피로도는 9/10 이야", then
  // "런은 7분페이스로 뛰었어" — three messages, one session. Each one is its own `log` call,
  // and an undefined field must leave the stored value alone rather than blank it.
  const sheet = cold();
  const B = ["--telegram", "999888777"];

  const first = await log(sheet, [...B, "--done", "--weight", "109", "--alt", WOD]);
  assert.equal(first.code, 0, first.out);
  const afterFirst = sheet.writtenCells.length;

  const second = await log(sheet, [...B, "--rpe", "9"]);
  assert.equal(second.code, 0, second.out);
  assert.equal(sheet.writtenCells.length - afterFirst, 1, "the RPE message writes one cell, not the row");

  const third = await log(sheet, [...B, "--pace", "7:00"]);
  assert.equal(third.code, 0, third.out);

  const day = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!;
  assert.equal(day.B.done, true);
  assert.equal(day.B.weightKg, 109, "the weight from message 1 survived messages 2 and 3");
  assert.equal(day.B.altWorkout, WOD, "and so did the workout description");
  assert.equal(day.B.rpe, 9);
  assert.equal(day.B.paceSecPerKm, 420);

  // The partner's half of the row is untouched throughout.
  assert.equal(day.A.done, false);
  assert.equal(day.A.weightKg, null);
});

test("accumulation works in any order, and re-sending an earlier message changes nothing", async () => {
  const sheet = cold(31);
  const B = ["--telegram", "999888777"];
  await log(sheet, [...B, "--rpe", "9"]);
  await log(sheet, [...B, "--pace", "7:00"]);
  await log(sheet, [...B, "--done", "--weight", "109"]);
  const writes = sheet.writes;

  const repeat = await log(sheet, [...B, "--rpe", "9"]);
  assert.equal(repeat.code, 0, repeat.out);
  assert.equal(sheet.writes, writes, "a repeated value costs no write");

  const day = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B;
  assert.equal(day.done, true);
  assert.equal(day.weightKg, 109);
  assert.equal(day.rpe, 9);
  assert.equal(day.paceSecPerKm, 420);
});

test("a kettlebell load in the same sentence as a body weight cannot be logged as one", async () => {
  // "30 KB swings (16/24 kg) … 몸무게 109키로" carries three numbers that all look like weights.
  // 16 and 24 are outside any human's range, so they fail closed without needing any history.
  for (const load of ["16", "24"]) {
    const sheet = cold();
    const r = await log(sheet, ["--telegram", "999888777", "--done", "--weight", load]);
    assert.equal(r.code, 1, `${load}kg should have been refused: ${r.out}`);
    assert.match(r.out, /범위 밖/);
    assert.equal(sheet.writes, 0);
  }
});

test("a load mistaken for body weight is caught against the weight from the same session", async () => {
  // The guard used to compare only against *previous* days, so within one session — which is
  // exactly where the equipment numbers arrive — a second message could overwrite a correct
  // 109kg with a mis-parsed 152kg at exit 0.
  const sheet = cold(32);
  const B = ["--telegram", "999888777"];
  const real = await log(sheet, [...B, "--done", "--weight", "109"]);
  assert.equal(real.code, 0, real.out);

  const sled = await log(sheet, [...B, "--weight", "152"]);
  assert.equal(sled.code, 1, sled.out);
  assert.match(sled.out, /장비 무게/);
  assert.match(sled.out, /109kg/, "the refusal names what it compared against");

  const after = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B;
  assert.equal(after.weightKg, 109, "the correct weight is still there");
});

test("the Korean surface forms the skill has to normalise are exactly the ones refused here", async () => {
  // SKILL.md tells the agent to turn 피로도 9/10 into `--rpe 9`, 109키로 into `--weight 109`
  // and 7분페이스 into `--pace 7:00`. That instruction is only worth writing down because the
  // raw forms fail closed — this pins both halves so the document cannot quietly go stale.
  for (const [flag, raw] of [
    ["--weight", "109키로"],
    ["--weight", "109킬로"],
    ["--rpe", "9/10"],
    ["--pace", "7분"],
    ["--pace", "7"],
    ["--duration", "2.2"], // "런 2.2km" is a distance, and there is no distance column
  ] as const) {
    const sheet = cold();
    const r = await log(sheet, ["--who", "a", flag, raw]);
    assert.equal(r.code, 1, `${flag} ${raw} should have been refused: ${r.out}`);
    assert.equal(sheet.writes, 0, `${flag} ${raw}: nothing may be written`);
  }

  // And the normalised forms, plus the two spellings the CLI does tolerate on its own.
  for (const [flag, raw, read] of [
    ["--weight", "109", 109],
    ["--weight", "109kg", 109],
    ["--weight", "109 kg", 109],
    ["--rpe", "9", 9],
    ["--pace", "7:00", 420],
  ] as const) {
    const sheet = cold();
    const r = await log(sheet, ["--who", "a", flag, raw]);
    assert.equal(r.code, 0, `${flag} ${raw}: ${r.out}`);
    const a = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A;
    const stored = flag === "--weight" ? a.weightKg : flag === "--rpe" ? a.rpe : a.paceSecPerKm;
    assert.equal(stored, read, `${flag} ${raw}`);
  }
});

test("only a doubled dash needs the = form; a single leading dash is an ordinary value", async () => {
  // The skill used to say "text that starts with a dash" needs `--memo=…`, which is wider
  // than the truth and costs a round trip on perfectly ordinary text.
  const sheet = cold(37);
  const single = await log(sheet, ["--who", "a", "--memo", "-5분 늦게 시작"]);
  assert.equal(single.code, 0, single.out);
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A.memo, "-5분 늦게 시작");

  const double = await log(sheet, ["--who", "a", "--memo=--두 개 대시"]);
  assert.equal(double.code, 0, double.out);
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A.memo, "--두 개 대시");
});

// ---------------------------------------------------------------- silent-loss regressions

test("every pace the CLI accepts survives the round trip, and the rest are refused outright", async () => {
  // The invariant, not the boundary: the CLI used to accept up to 20:00 while the cell caps at
  // 15:00, so a 16-minute pace exited 0, wrote zero cells, and was confirmed as saved. Any
  // future drift between cli.ts and cells.ts fails here rather than in the sheet.
  for (const raw of ["2:00", "4:20", "7:00", "9:59", "12:30", "14:59", "15:00"]) {
    const sheet = fresh();
    const r = await log(sheet, ["--who", "a", "--pace", raw]);
    assert.equal(r.code, 0, `${raw}: ${r.out}`);
    const [m, s] = raw.split(":").map(Number);
    const stored = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.A.paceSecPerKm;
    assert.equal(stored, m * 60 + s, `${raw} did not survive the round trip`);
  }
  for (const raw of ["15:01", "16:00", "20:00", "20:01"]) {
    const sheet = fresh();
    const r = await log(sheet, ["--who", "a", "--pace", raw]);
    assert.equal(r.code, 1, `${raw} should have been refused: ${r.out}`);
    assert.match(r.out, /범위 밖/);
    assert.equal(sheet.writes, 0);
  }
});

test("a bare --alt says what it erased instead of dropping the workout silently", async () => {
  // `--alt "$WOD"` with an empty variable becomes `--alt --done`, which parses as "clear the
  // alt workout". That stays true — it is documented and tested — but it may not be silent:
  // the erased text is quoted back, so the athlete can restore it from the reply alone.
  const sheet = cold(33);
  await log(sheet, ["--who", "b", "--alt", WOD]);

  const r = await log(sheet, ["--who", "b", "--alt", "--done"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /지웠어/);
  assert.ok(r.out.includes("10 rounds for time"), "the erased text is quoted back verbatim");
  assert.match(r.out, /--alt none/, "and the deliberate way to clear it is named");

  const after = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B;
  assert.equal(after.altWorkout, "");
  assert.equal(after.done, true);
});

test("an explicit --alt none clears without the warning, because nothing was lost by accident", async () => {
  const sheet = cold(34);
  await log(sheet, ["--who", "b", "--alt", WOD]);
  const r = await log(sheet, ["--who", "b", "--alt", "none"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /지웠어/);
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B.altWorkout, "");
});

test("a note someone hand-wrote in the 실체중/완료 cell is quoted back when it is overwritten", async () => {
  // README marks E and G hand-editable, so people leave notes in them — and a single
  // `--weight` replaces the whole cell with "[ ] 미완료 · 109kg" at exit 0 with nothing said.
  // The write must still happen (a session record is never blocked by a note), but the same
  // rule as a cleared --memo applies: quote it back, so it can be restored from the reply.
  const sheet = cold(36);
  const note = "아침 공복으로 다시 잴 예정";
  sheet.set(SHEET_LOG_TAB, 44, 6, note); // G44 — B's 실체중/완료 on 2026-09-09

  const r = await log(sheet, ["--who", "b", "--weight", "109"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(note), `the replaced text is quoted verbatim\n${r.out}`);
  assert.match(r.out, /⚠️/);
  assert.equal((await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B.weightKg, 109);

  // And the ordinary case stays silent: what the app itself wrote is not a note.
  const plain = cold(37);
  const quiet = await log(plain, ["--who", "b", "--done", "--weight", "109"]);
  assert.equal(quiet.code, 0, quiet.out);
  assert.doesNotMatch(quiet.out, /⚠️/, quiet.out);

  const again = await log(plain, ["--who", "b", "--weight", "108.5"]);
  assert.doesNotMatch(again.out, /⚠️/, "overwriting the app's own value is not a warning");
});

test("a description longer than the cell is truncated out loud, not quietly", async () => {
  const sheet = cold(35);
  const long = `${WOD} `.repeat(6);
  const r = await log(sheet, ["--who", "b", "--done", "--alt", long]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /500자를 넘어서/);

  const stored = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B.altWorkout;
  assert.equal(stored.length, 500);
  assert.ok(long.startsWith(stored));
});

test("--alt replaces rather than appends, which a follow-up message has to account for", async () => {
  // Pinned because it is the trap in a multi-message session: a second message that restates
  // part of the workout replaces the whole cell, and the confirmation looks correct because it
  // echoes the shorter value.
  const sheet = cold(36);
  await log(sheet, ["--who", "b", "--alt", "런 2.2km"]);
  await log(sheet, ["--who", "b", "--alt", "10 rounds KB swings"]);
  const stored = (await loadSeason(sheet)).records.find((x) => x.date === TODAY)!.B.altWorkout;
  assert.equal(stored, "10 rounds KB swings", "the run is gone — the skill must send the combined text");
});

test("a sheet error is reported as a sheet error, not as bad input", async () => {
  // Exit code 2 tells OpenClaw that retrying the same command will not help, so it
  // should surface the problem rather than re-asking the athlete to rephrase.
  const sheet = fresh();
  sheet.failNextWrite = "Google refused the request (403)";
  const r = await log(sheet, ["--who", "a", "--done"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /403/);
});
