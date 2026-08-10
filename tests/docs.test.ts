// The README is the only document that tells a future reader which cells this software owns,
// and it had drifted: it marked D and F "written by the app: no" while `goal --date` writes
// exactly those two columns, listed neither `goals.ts` nor the `goal` and `setup` commands,
// and quoted a test count that was 69 short.
//
// A stale document is not a code defect, but the column table is a safety artifact — someone
// reads it, concludes a column is theirs, and hand-edits a cell a later command overwrites.
// So the claims that can be checked mechanically are checked here rather than by eye.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.HYROX_JOURNAL = `${process.env.TMPDIR ?? "/tmp"}/hyrox-journal-test-docs.jsonl`;
process.env.PLAYER_A_NAME = "Jay";
process.env.PLAYER_B_NAME = "정재빈";

const { runCli } = await import("../src/lib/cli.ts");
const { runDoctor, renderDoctor } = await import("../src/lib/doctor.ts");
const { cliCommand } = await import("../src/lib/config.ts");
const { syntheticSeason } = await import("./fake-sheet.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

test("every src/lib module appears in the README's layout", async () => {
  // The layout block is what tells a reader where to start. A module missing from it is a
  // module nobody knows to look at — goals.ts, the entire target-weight surface, was absent.
  const modules = readdirSync(join(root, "src/lib")).filter((f) => f.endsWith(".ts"));
  assert.ok(modules.length >= 13, `expected the full module list, got ${modules.length}`);
  for (const m of modules) {
    assert.ok(readme.includes(m), `README does not mention src/lib/${m}`);
  }
});

test("every CLI command in HELP is documented in the README", async () => {
  // `goal` and `setup` shipped without a single mention outside the help text.
  const { out: help } = await runCli(["help"], syntheticSeason({ seed: 1 }), "2026-09-09");
  const commands = ["today", "day", "week", "stats", "setup", "goal show", "goal", "brief", "log", "doctor"];
  for (const c of commands) {
    assert.ok(help.includes(c), `help itself no longer mentions ${c}`);
    assert.ok(readme.includes(`hyrox ${c}`), `README does not document \`hyrox ${c}\``);
  }
});

test("the README's column table does not claim the app leaves D and F alone", async () => {
  // `goal --date` writes '15주 상세 일지 (2인 전용)'!D<row> and F<row>. A table saying
  // otherwise invites a hand-edit into a cell a later command silently replaces.
  const row = readme.split("\n").find((l) => /^\|\s*\*?\*?D,\s*F/.test(l.trim()));
  assert.ok(row, "the D/F row is gone from the sheet-usage table");
  assert.doesNotMatch(row!, /\|\s*no\s*\|?\s*$/, `D/F is still documented as unwritten: ${row}`);
  assert.match(row!, /goal --date/, "and the row should name the command that writes it");
});

test("the README quotes no test count, which is the only figure that cannot go stale", async () => {
  assert.doesNotMatch(
    readme,
    /\d+\s*tests/,
    "a hard-coded test count in the README goes stale on the next test added",
  );
});

// ---------------------------------------------------------------- runnable command strings
//
// Nothing installs `hyrox` onto PATH. The agent runs commands through OpenClaw's `exec` with
// `shell: false` and the gateway's own PATH, which contains no `hyrox`, so a bare name is
// exit 127 `command not found` — a code the CLI does not document, whose symptom ("기록했어"
// followed by an empty sheet) is indistinguishable from the inbound outage `doctor` exists to
// find. So every command string this program prints for someone to run must be absolute.

test("cliCommand resolves to the wrapper that actually exists", async () => {
  const cli = cliCommand();
  assert.ok(cli.startsWith("/"), `not an absolute path: ${cli}`);
  assert.ok(existsSync(cli), `${cli} does not exist — the printed commands would all fail`);
  assert.match(cli, /bin\/hyrox$/);
});

test("no command the CLI prints for a human to run starts with a bare `hyrox`", async () => {
  // `setup` prints its commands under "kg만 채워서 그대로 실행하면 돼" and the agent execs them
  // verbatim; `doctor` prints its own name in a fix line the agent is told to relay as-is.
  const sheet = syntheticSeason({ seed: 1, upTo: "2026-09-08" });
  const outputs: string[] = [];
  for (const argv of [["help"], ["setup"], ["setup", "--json"], ["goal", "show"], ["log"], ["day"], ["goal", "bogus"]]) {
    outputs.push((await runCli(argv, sheet, "2026-09-09")).out);
  }
  outputs.push(renderDoctor(await runDoctor(sheet, "2026-09-09", { now: new Date("2026-09-09T12:00:00+09:00") })));
  outputs.push(JSON.stringify(await runDoctor(sheet, "2026-09-09", { now: new Date("2026-09-09T12:00:00+09:00") })));

  for (const out of outputs) {
    for (const line of out.split("\n")) {
      // Any `hyrox <subcommand>` that is not preceded by a path separator is unrunnable.
      const bare = /(^|[^/\w])hyrox (today|day|week|stats|setup|goal|brief|log|doctor|help)\b/.exec(line);
      assert.equal(bare, null, `unrunnable bare command printed: ${line.trim()}`);
    }
  }
});

test("setup's --json commands are the ones an agent would exec, and they are absolute", async () => {
  const sheet = syntheticSeason({ seed: 1, upTo: "2026-09-08" });
  const { out } = await runCli(["setup", "--json"], sheet, "2026-09-09");
  const report = JSON.parse(out) as { missing: { command: string }[] };
  assert.ok(report.missing.length > 0, "the fixture should still have gaps to report");
  for (const m of report.missing) {
    assert.ok(m.command.startsWith(cliCommand()), m.command);
  }
});

// ---------------------------------------------------------------- the agent skill
//
// SKILL.md lives in the OpenClaw workspace rather than in this repo, but it is the document
// that turns this CLI's output into an action, and two of its statements were provably wrong
// about this code. It is checked here when present, and skipped where it is not installed.

const SKILL_MD =
  process.env.HYROX_SKILL_MD ?? `${process.env.HOME ?? ""}/.openclaw/workspace-hyrox/skills/hyrox/SKILL.md`;

test("SKILL.md teaches the invocation that works, not the one that exits 127", async (t) => {
  if (!existsSync(SKILL_MD)) return t.skip(`${SKILL_MD} not installed here`);
  const skill = readFileSync(SKILL_MD, "utf8");
  const cli = cliCommand();

  for (const line of skill.split("\n")) {
    const bare = /(^|[^/\w`])hyrox (today|day|week|stats|setup|goal|brief|log|doctor|help)\b/.exec(line);
    assert.equal(bare, null, `SKILL.md still shows a bare command: ${line.trim()}`);
  }
  assert.ok(skill.includes(cli), "SKILL.md must name the absolute path at least once");
  assert.match(skill, /127/, "and say what a 127 means, since the CLI's own codes do not cover it");
});

test("SKILL.md does not tell the agent that a doctor exit of 1 is its own to fix", async (t) => {
  if (!existsSync(SKILL_MD)) return t.skip(`${SKILL_MD} not installed here`);
  const skill = readFileSync(SKILL_MD, "utf8");

  // Every check `doctor` can fail is tagged `human`; there is no reachable agent-fixable
  // failure. The mapping that said otherwise sat one line below "(사람) means Jay has to
  // apply it", and applied to `inbound.freshness` — the single check written for the
  // incident that prompted the module, which exits 1.
  assert.doesNotMatch(
    skill,
    /Exit \*\*1\*\* → "고칠 수 있는 문제야"/,
    "the doctor section must not reuse the generic exit-1 meaning",
  );
  const doctorSection = skill.slice(skill.indexOf("How to relay it"));
  assert.match(doctorSection, /1과 2 (모두|다)|both 1 and 2/, "it has to say both codes are a human's");
});

test("every doctor failure really is a human's to fix, which is what SKILL.md now claims", async () => {
  // The assertion above is only safe while this stays true of the code.
  const doctorSource = readFileSync(join(root, "src/lib/doctor.ts"), "utf8");
  const owners = [...doctorSource.matchAll(/"(agent|human)"/g)].map((m) => m[1]);
  assert.ok(owners.length > 10, "expected the fixOwner literals to be found");
  assert.deepEqual(
    [...new Set(owners)],
    ["agent", "human"],
    "only the FixOwner type declaration should mention agent",
  );
  assert.equal(owners.filter((o) => o === "agent").length, 1, "and exactly once — the type, not a check");
});
