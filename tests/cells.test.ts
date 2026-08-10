import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HYROX_JOURNAL = `${process.env.TMPDIR ?? "/tmp"}/hyrox-journal-test-cells.jsonl`;
import {
  NOT_DONE_TEXT,
  cleanText,
  formatDuration,
  formatPace,
  formatRpe,
  formatStatusCell,
  hasAuthoredStatusText,
  parseDuration,
  parsePace,
  parseRpe,
  parseStatusCell,
  parseWeight,
  validDuration,
  validPace,
  validRpe,
  validWeight,
} from "../src/lib/cells.ts";
import { rng } from "./fake-sheet.ts";

test("status cell round-trips for every combination", () => {
  for (const done of [true, false]) {
    for (const weightKg of [null, 82, 82.4, 101.5]) {
      const text = formatStatusCell({ done, weightKg });
      assert.deepEqual(parseStatusCell(text), { done, weightKg }, `failed for ${text}`);
    }
  }
});

test("status cell reads the sheet's original untouched value", () => {
  assert.deepEqual(parseStatusCell("[ ] 미완료"), { done: false, weightKg: null });
  assert.deepEqual(parseStatusCell(""), { done: false, weightKg: null });
  assert.deepEqual(parseStatusCell(undefined), { done: false, weightKg: null });
  assert.deepEqual(parseStatusCell(123), { done: false, weightKg: null });
});

test("status cell tolerates hand-typed variants", () => {
  assert.equal(parseStatusCell("완료").done, true);
  assert.equal(parseStatusCell("done").done, true);
  assert.equal(parseStatusCell("미완료").done, false);
  assert.equal(parseStatusCell("[ ] 미완료 · 80.5kg").weightKg, 80.5);
  assert.equal(parseStatusCell("✅ 82kg").done, true);
  assert.equal(parseStatusCell("82.4kg").weightKg, 82.4);
});

test("'미완료' is never read as '완료'", () => {
  for (const text of ["미완료", "[ ] 미완료", "[ ] 미완료 · 79kg", "아직 미완료"]) {
    assert.equal(parseStatusCell(text).done, false, text);
  }
  assert.equal(formatStatusCell({ done: false, weightKg: null }), NOT_DONE_TEXT);
});

test("weights outside a human range are rejected", () => {
  assert.equal(validWeight(29), null);
  assert.equal(validWeight(251), null);
  assert.equal(validWeight(NaN), null);
  assert.equal(validWeight("abc"), null);
  assert.equal(validWeight(82.44), 82.4);
  assert.equal(validWeight("82.4"), 82.4);
});

test("pace parses every shape a person types", () => {
  assert.equal(parsePace("4:20"), 260);
  assert.equal(parsePace("4'20\""), 260);
  assert.equal(parsePace("4분20초"), 260);
  assert.equal(parsePace("4:20/km"), 260);
  assert.equal(parsePace(260), 260);
  assert.equal(parsePace("260"), 260);
  assert.equal(parsePace("12:05"), 725);
});

test("implausible paces are rejected rather than stored", () => {
  assert.equal(parsePace("0:30"), null); // 30s/km
  assert.equal(parsePace("20:00"), null); // 20min/km
  assert.equal(parsePace(""), null);
  assert.equal(parsePace("hello"), null);
  assert.equal(parsePace(null), null);
});

test("pace round-trips through its display form", () => {
  for (let secs = 120; secs <= 900; secs++) {
    assert.equal(parsePace(formatPace(secs)), secs, `failed at ${secs}`);
  }
  assert.equal(formatPace(null), "");
  assert.equal(formatPace(245), "4:05");
});

test("duration and RPE validate and round-trip", () => {
  assert.equal(parseDuration("55분"), 55);
  assert.equal(parseDuration("55 min"), 55);
  assert.equal(parseDuration("55"), 55);
  assert.equal(parseDuration("0"), null);
  assert.equal(parseDuration("601"), null);
  assert.equal(validDuration(55.4), 55);

  assert.equal(parseRpe("7"), 7);
  assert.equal(parseRpe("RPE 7"), 7);
  assert.equal(parseRpe("11"), null);
  assert.equal(parseRpe("0"), null);
  assert.equal(validRpe(7.6), 8);

  for (let m = 1; m <= 600; m++) assert.equal(parseDuration(formatDuration(m)), m);
  for (let r = 1; r <= 10; r++) assert.equal(parseRpe(formatRpe(r)), r);
});

test("free text is flattened, trimmed and capped", () => {
  assert.equal(cleanText("  a\n\nb  "), "a b");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(42), "");
  assert.equal(cleanText("x".repeat(900)).length, 500);
  assert.equal(cleanText("x".repeat(900), 10).length, 10);
});

test("fuzz: every generated status cell survives a write/read cycle", () => {
  const rand = rng(7);
  for (let i = 0; i < 2000; i++) {
    const done = rand() < 0.5;
    const weightKg = rand() < 0.3 ? null : Math.round((40 + rand() * 120) * 10) / 10;
    const encoded = formatStatusCell({ done, weightKg });
    const decoded = parseStatusCell(encoded);
    assert.equal(decoded.done, done);
    assert.equal(decoded.weightKg, weightKg);
    // Encoding is idempotent.
    assert.equal(formatStatusCell(decoded), encoded);
  }
});


test("a bare number in the composite cell is only trusted when it is the only number", () => {
  // Column E/G is human-readable, so people type into it. A lone number is a weight;
  // a number among others (reps, a date fragment) must not become one.
  assert.equal(parseWeight("82.4"), 82.4);
  assert.equal(parseWeight("82.4kg"), 82.4);
  assert.equal(parseWeight("완료 100회 82.4kg"), 82.4, "the kg-tagged value wins");
  assert.equal(parseWeight("월볼 100회 버피 20회"), null, "no weight here at all");
  assert.equal(parseWeight("2026-08-05"), null, "a date is not a body weight");
  assert.equal(parseWeight("[   ] kg"), null, "the untouched target cell");
  assert.equal(parseWeight(""), null);
});

test("a rep count alone in the composite cell is not a body weight", () => {
  // "only one number in the cell" was too weak a rule. Column E/G is documented as
  // hand-editable, and the notes people actually leave there — "완료 · 월볼 50회",
  // "완료 (30 rounds)" — carry exactly one number, so each became that athlete's body
  // weight: shown in `stats` and the morning brief as a real measurement, and then used as
  // the baseline that refuses their next *correct* weight.
  assert.equal(parseWeight("완료 · 월볼 50회"), null, "reps are not a body weight");
  assert.equal(parseWeight("완료 (30 rounds)"), null, "30 sits exactly on the accepted bound");
  assert.equal(parseWeight("버피 100개"), null);
  assert.equal(parseWeight("400m"), null);
  assert.equal(parseWeight("8세트"), null);

  // The hand-typed forms that must keep working: a bare weight, with or without a status.
  assert.equal(parseWeight("82.4"), 82.4);
  assert.equal(parseWeight("완료 82.4"), 82.4);
  assert.equal(parseWeight("✅ 82"), 82);
  assert.equal(parseWeight("[ ] 미완료 · 80.5"), 80.5);
});

test("an equipment load written into the composite cell is not read as the athlete", () => {
  // 152 is inside the plausible body-weight range, so the kg-tagged match won and the sheet
  // carried a 152kg human. Only a noun sitting immediately in front of the number
  // disqualifies it, which is the same discriminator a person uses.
  assert.equal(parseWeight("완료 슬레드 152kg"), null);
  assert.equal(parseWeight("케틀벨 32kg"), null);
  assert.equal(parseWeight("sled 152kg"), null);
  assert.equal(parseStatusCell("완료 슬레드 152kg").weightKg, null);

  // A kg-tagged number that is not attached to equipment is still the weight.
  assert.equal(parseWeight("완료 100회 82.4kg"), 82.4);
  assert.equal(parseWeight("체중 82.4kg"), 82.4);
});

test("an English negation is never read as completion", () => {
  // `done` is a documented hand-typed variant, so its most natural negation had to be
  // handled: /(완료|done)/ matched the `done` inside "not done" and flipped the sheet's
  // most important boolean, taking completion rate, streak, nudge and the weekly review
  // with it.
  for (const text of ["not done", "not Done", "NOT DONE", "didn't finish", "undone", "incomplete"]) {
    assert.equal(parseStatusCell(text).done, false, text);
  }
  for (const text of ["done", "Done", "완주", "✅ done"]) {
    assert.equal(parseStatusCell(text).done, true, text);
  }
});

test("a hand-written note in the composite cell is detectable before it is overwritten", () => {
  // The cell is hand-editable, so a `log --weight` replaces whatever a person left in it.
  // The write is allowed — a session record must never be blocked by a note — but the CLI
  // has to be able to say what it replaced.
  assert.equal(hasAuthoredStatusText("아침 공복으로 다시 잴 예정"), true);
  assert.equal(hasAuthoredStatusText("완료 · 월볼 50회"), true);
  assert.equal(hasAuthoredStatusText("완료 슬레드 152kg"), true);

  // Everything the app itself writes, and the sheet's own authored empty state, are not notes.
  assert.equal(hasAuthoredStatusText(""), false);
  assert.equal(hasAuthoredStatusText("   "), false);
  for (const done of [true, false]) {
    for (const weightKg of [null, 82, 82.4]) {
      const text = formatStatusCell({ done, weightKg });
      assert.equal(hasAuthoredStatusText(text), false, text);
    }
  }
  assert.equal(hasAuthoredStatusText("완료"), false);
  assert.equal(hasAuthoredStatusText("done"), false);
});

test("done detection works without whitespace boundaries", () => {
  // Korean is written without spaces between a noun and its particle, so a boundary
  // requirement silently misses the most natural hand-typed forms.
  for (const text of ["완료", "오늘완료", "완료함", "다완료", "✅완료"]) {
    assert.equal(parseStatusCell(text).done, true, text);
  }
  for (const text of ["미완료", "오늘미완료", "안함", "못함", "[ ] 미완료"]) {
    assert.equal(parseStatusCell(text).done, false, text);
  }
});
