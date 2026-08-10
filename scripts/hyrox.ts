// CLI entry point. All logic lives in src/lib/cli.ts so that it can be tested against a
// synthetic sheet; this file only supplies the real sheet and the process exit code.

import { runCli } from "../src/lib/cli.ts";
import { liveSheetsClient } from "../src/lib/sheets.ts";

const result = await runCli(process.argv.slice(2), liveSheetsClient());

// Errors go to stderr so a caller that pipes stdout gets clean data, and an empty brief
// (nothing to nudge about) writes nothing at all rather than a blank line.
//
// `result.stdout` is the one exception: `doctor` exits non-zero precisely when it has
// something to report, so its report — and above all its `--json` — is data, not an error.
if (result.code === 0 || result.stdout) {
  if (result.out) console.log(result.out);
} else {
  console.error(result.out);
}
process.exit(result.code);
