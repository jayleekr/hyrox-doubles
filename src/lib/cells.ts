// Round-trip encoding between typed log values and the human-readable cell text
// that already lives in the spreadsheet.
//
// The 실체중/완료 column is a single cell holding two facts (done + body weight),
// because that is how the sheet was built. We keep it human-readable so the sheet
// stays usable on its own, and parse it back liberally so hand-typed edits survive.

export const NOT_DONE_TEXT = "[ ] 미완료";
const DONE_MARK = "✅";

export type Status = { done: boolean; weightKg: number | null };

/**
 * English negations of "done", removed before the done-test runs.
 *
 * `done` is a documented hand-typed variant, so "not done" — its most natural negation — was
 * read as *complete*, silently inverting the sheet's most important boolean and every
 * completion rate, streak and nudge derived from it. Korean negations are stripped as bare
 * substrings because Korean has no word boundaries; the English ones need the negation to be
 * adjacent to the word it negates, so "not done" flips while "done" still matches.
 */
const ENGLISH_NEGATED_DONE = /\b(?:not|no|never|didn'?t|don'?t)\s+(?:done|complete[d]?|finish(?:ed)?)\b|\bundone\b|\bincomplete\b/gi;

export function parseStatusCell(raw: unknown): Status {
  const s = typeof raw === "string" ? raw.trim() : "";
  // Korean has no word boundaries, so "오늘완료" must match as readily as "완료".
  // Every 미완료 is removed first so its embedded 완료 cannot be mistaken for one.
  const withoutNegation = s
    .replaceAll("미완료", "")
    .replaceAll("안함", "")
    .replaceAll("못함", "")
    .replace(ENGLISH_NEGATED_DONE, "");
  const done = s.startsWith(DONE_MARK) || /(완료|done|완주)/i.test(withoutNegation);
  const weightKg = parseWeight(s);
  return { done, weightKg };
}

export function formatStatusCell(status: Status): string {
  const w = status.weightKg === null ? null : `${trimNum(status.weightKg)}kg`;
  if (status.done) return w ? `${DONE_MARK} ${w}` : `${DONE_MARK} 완료`;
  return w ? `${NOT_DONE_TEXT} · ${w}` : NOT_DONE_TEXT;
}

/**
 * Everything the app itself can put in a 실체중/완료 or 목표 몸무게 cell, plus the words a
 * person writes around a body weight. Removed before deciding whether a bare number is a
 * body weight, and before deciding whether a status cell holds authored prose.
 */
const STATUS_VOCABULARY = /(미완료|완료|완주|done|kg|킬로그램|킬로|체중|몸무게|목표|현재|✅|✔|✓|☑|☐)/gi;

/** Separators and brackets. Whatever is left after these is content somebody wrote. */
const CELL_PUNCTUATION = /[\s·•∙・,.\-–—:;/|*()[\]{}"'`…~＋+]/g;

/**
 * A noun naming a piece of equipment, sitting immediately before a number.
 *
 * "완료 슬레드 152kg" is a load, not an athlete, and 152 is inside the plausible body-weight
 * range — so the kg-tagged match would win and the sheet would carry 152kg as a measurement.
 * Only an immediately preceding noun disqualifies a match, so "완료 100회 82.4kg" still reads
 * 82.4: the discriminator is what the number is attached to, exactly as it is for a human.
 */
const EQUIPMENT_BEFORE_NUMBER =
  /(슬레드|썰매|케틀벨|케틀|kb|바벨|덤벨|월볼|메디신볼|샌드백|플레이트|원판|중량|무게추|조끼|베스트|sled|kettlebell|barbell|dumbbell|wall\s*ball|wallball|medicine\s*ball|sandbag|plate|vest)\s*[^0-9]{0,4}$/i;

/** What is left of a cell once every number and every known status word is taken out. */
function cellResidue(s: string, without: string[]): string {
  let rest = s;
  for (const token of without) rest = rest.replace(token, " ");
  return rest.replace(STATUS_VOCABULARY, " ").replace(CELL_PUNCTUATION, "");
}

/**
 * True when a hand-editable cell holds words this app cannot round-trip.
 *
 * Column E/G is documented as hand-editable, so people leave notes there — "아침 공복으로
 * 다시 잴 예정" — and the next `log --weight` replaces the whole cell with
 * "[ ] 미완료 · 109kg". The note is unrecoverable and the athlete is told the save succeeded.
 * The write still happens (a session record must never be blocked by a note), but the CLI
 * can at least quote back what it replaced.
 */
export function hasAuthoredStatusText(raw: unknown): boolean {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return false;
  const numbers = [...s.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
  return cellResidue(s, numbers) !== "";
}

/**
 * Body weight in kg, or null. Accepts "82.4kg", "82.4 kg", "✅ 82kg", "미완료 · 80.5kg".
 *
 * Two guards, both about the same failure: a number in this cell that is not the athlete.
 *
 * A kg-tagged number wins — except when an equipment noun sits directly in front of it, so
 * "슬레드 152kg" is not filed as a 152kg human.
 *
 * A number without a unit is accepted only when the cell holds *nothing else*: not merely
 * "only one number", which let "완료 · 월볼 50회" and "완료 (30 rounds)" through as 50kg and
 * 30kg. Both then appear in `stats` and the morning brief as real measurements, and both
 * become the baseline the equipment-load guard compares against — which is how a correct
 * weight ends up being the thing refused.
 */
export function parseWeight(raw: unknown): number | null {
  if (typeof raw === "number") return validWeight(raw);
  const s = typeof raw === "string" ? raw.replace(/,/g, "") : "";
  if (!s) return null;

  for (const m of s.matchAll(/(\d{2,3}(?:\.\d+)?)\s*(?:kg|킬로그램|킬로)/gi)) {
    if (EQUIPMENT_BEFORE_NUMBER.test(s.slice(0, m.index))) continue;
    const v = validWeight(Number(m[1]));
    if (v !== null) return v;
  }

  const numbers = [...s.matchAll(/\d+(?:\.\d+)?/g)];
  if (numbers.length !== 1) return null;
  if (cellResidue(s, [numbers[0][0]]) !== "") return null;
  return validWeight(Number(numbers[0][0]));
}

/**
 * The authored empty state of every 목표 몸무게 cell in the goal and phase tabs.
 * `parseWeight` already reads it as null (the bracket holds no digits and the bare-number
 * fallback finds none), so this constant exists only for the write side.
 */
export const GOAL_WEIGHT_PLACEHOLDER = "[   ] kg";

/** The authored empty state, in the shapes a human retypes it: "[   ] kg", "[] kg", "[ ]". */
function isWeightPlaceholder(s: string): boolean {
  return /^\[\s*\]\s*(?:kg)?$/i.test(s);
}

/**
 * True when a 목표 몸무게 cell holds something a human wrote that no parser reads back.
 *
 * An empty cell and the authored placeholder are deliberately *not* that: they mean
 * "nobody typed it yet", which is the state onboarding exists to ask about. Everything
 * else — "82 (10월까지)", "82~84", "현재 체중 유지" — is authored content that
 * `parseWeight` returns null for, which makes it indistinguishable from empty everywhere
 * downstream. Writing "82kg" over it destroys a nuance a human wrote while the
 * confirmation says the cell was 미입력, and that is the failure this project ranks worst.
 *
 * So the write path refuses on it and onboarding stops calling it a gap. `--force` is the
 * one documented way through, the same escape hatch the equipment-load guard uses.
 */
export function isUnreadableWeightCell(raw: unknown): boolean {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || isWeightPlaceholder(s)) return false;
  return parseWeight(s) === null;
}

/**
 * Render a *target* body weight.
 *
 * `blank` is what a null renders as, and it differs by tab on purpose: the log tab's 105
 * rows read better as an empty column, while the goal and phase tabs were authored with
 * "[   ] kg" in every slot — clearing one there should restore the sheet's own look rather
 * than gut it.
 */
export function formatWeightCell(kg: number | null, blank = ""): string {
  return kg === null ? blank : `${trimNum(kg)}kg`;
}

export function validWeight(n: unknown): number | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v < 30 || v > 250) return null;
  return Math.round(v * 10) / 10;
}

/**
 * Running pace as seconds per km. Accepts "4:22", "4'22\"", "4분22초", "262",
 * "4:22/km". Returns null when it is not a plausible pace.
 */
export function parsePace(raw: unknown): number | null {
  if (typeof raw === "number") return validPace(raw);
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const mmss = /(\d{1,2})\s*[:'분]\s*(\d{1,2})/.exec(s);
  if (mmss) return validPace(Number(mmss[1]) * 60 + Number(mmss[2]));
  const bare = /^(\d{2,4})(?:\s*초)?$/.exec(s);
  if (bare) return validPace(Number(bare[1]));
  return null;
}

/** 2:00/km is faster than any human sustains for 8km; 15:00/km is a walk. */
export const PACE_MIN_SEC = 120;
export const PACE_MAX_SEC = 900;

export function validPace(n: unknown): number | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  const secs = Math.round(v);
  if (secs < PACE_MIN_SEC || secs > PACE_MAX_SEC) return null;
  return secs;
}

export function formatPace(secs: number | null): string {
  if (secs === null) return "";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Session duration in minutes. */
export function parseDuration(raw: unknown): number | null {
  if (typeof raw === "number") return validDuration(raw);
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const m = /^(\d{1,3}(?:\.\d+)?)\s*(?:분|min|m)?$/i.exec(s);
  if (!m) return null;
  return validDuration(Number(m[1]));
}

export function validDuration(n: unknown): number | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  const mins = Math.round(v);
  if (mins < 1 || mins > 600) return null;
  return mins;
}

export function formatDuration(mins: number | null): string {
  return mins === null ? "" : String(mins);
}

/** Rate of perceived exertion, 1-10. */
export function parseRpe(raw: unknown): number | null {
  if (typeof raw === "number") return validRpe(raw);
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const m = /^(?:RPE\s*)?(\d{1,2})$/i.exec(s);
  if (!m) return null;
  return validRpe(Number(m[1]));
}

export function validRpe(n: unknown): number | null {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  const r = Math.round(v);
  if (r < 1 || r > 10) return null;
  return r;
}

export function formatRpe(rpe: number | null): string {
  return rpe === null ? "" : String(rpe);
}

/**
 * How much free text one cell holds.
 *
 * Exported because the CLI has to be able to *say* that it truncated. `cleanText` silently
 * kept a 500-character prefix, so an athlete who dictated a very long WOD was told it saved
 * and only found the missing half by reading the sheet.
 */
export const MAX_CELL_TEXT = 500;

/** Free text destined for a cell: trimmed, length-capped, newlines flattened. */
export function cleanText(raw: unknown, max = MAX_CELL_TEXT): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/**
 * Pull a pace range out of the free text in the paceTarget column.
 *
 * Real values from the sheet: "4:15~4:30/km (일정 유지)", "빌드업 (4:45 → 4:15/km)",
 * "3:40~4:00/km (동반 페이스)", and also "RPE 7~8 (근지구력)", "RPE 2~3 (회복 중심)", "Rest".
 *
 * The last three are the interesting ones: a recovery day is prescribed by effort, not pace,
 * and a rest day by nothing at all. Returning a number for those would invent a target the
 * programme never set and then report the athlete as behind it — so anything with no M:SS in
 * it is null, and callers must treat null as "no pace was asked for today".
 */
export function parsePaceTarget(raw: unknown): { fastSec: number; slowSec: number } | null {
  if (typeof raw !== "string") return null;
  const found: number[] = [];
  for (const m of raw.matchAll(/(\d{1,2}):([0-5]\d)/g)) {
    const secs = Number(m[1]) * 60 + Number(m[2]);
    // Same bounds as a logged pace: anything outside is some other number that happens to
    // look like a clock (a time of day, a total duration).
    if (secs >= PACE_MIN_SEC && secs <= PACE_MAX_SEC) found.push(secs);
  }
  if (found.length === 0) return null;
  return { fastSec: Math.min(...found), slowSec: Math.max(...found) };
}
