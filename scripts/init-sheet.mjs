// One-time (idempotent) preparation of the spreadsheet:
//   1. verifies rows 5-109 still line up with 2026-08-01 .. 2026-11-13
//   2. adds the O~V headers for the metric and commitment columns the app writes
//
//   node scripts/init-sheet.mjs           # report only
//   node scripts/init-sheet.mjs --apply   # write the headers

import { readFile } from "node:fs/promises";
import { JWT, UserRefreshClient } from "google-auth-library";

const SPREADSHEET_ID = process.env.SPREADSHEET_ID ?? "1nNDRGp-FY2DU7w3y_akDwIO2GD1HePaoi7gxxYAf4Rc";
const LOG_TAB = "15주 상세 일지 (2인 전용)";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const APPLY = process.argv.includes("--apply");

const HEADERS = [
  ["O3", "🏋️‍♂️ 선수 A 실측"],
  ["O4", "페이스(/km)"],
  ["P4", "시간(분)"],
  ["Q4", "RPE"],
  ["R3", "🏋️‍♀️ 선수 B 실측"],
  ["R4", "페이스(/km)"],
  ["S4", "시간(분)"],
  ["T4", "RPE"],
  // U/V hold each athlete's own if-then commitment for the day ("19:00 헬스장"), stated in
  // the morning and quoted back in the evening. Distinct from column I, which is the
  // prescribed session.
  ["U3", "🤝 오늘의 약속"],
  ["U4", "A 오늘 약속"],
  ["V4", "B 오늘 약속"],
];

async function auth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const creds = JSON.parse(raw);
    return new JWT({ email: creds.client_email, key: creds.private_key.replace(/\\n/g, "\n"), scopes: SCOPES });
  }
  const path = process.env.GOOGLE_OAUTH_CREDENTIALS_FILE ?? `${process.env.HOME}/.config/gws/credentials.json`;
  const creds = JSON.parse(await readFile(path, "utf8"));
  return new UserRefreshClient(creds.client_id, creds.client_secret, creds.refresh_token);
}

async function call(client, url, init = {}) {
  const { token } = await client.getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (res.status === 403) throw new Error(await explainForbidden(token));
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * A bare "The caller does not have permission" gives no way to act. The cause is almost
 * always that the authenticated account has no edit rights on the sheet — so name the
 * account, say what it can and cannot do, and give the fix.
 */
async function explainForbidden(token) {
  // A service account's identity is in the key itself; asking Drive would need a scope the
  // key does not carry, which is how this function used to end up reporting "(unknown)".
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let who = null;
  let isServiceAccount = false;
  if (raw) {
    try {
      who = JSON.parse(raw).client_email ?? null;
      isServiceAccount = true;
    } catch {
      /* fall through to the Drive lookup */
    }
  }

  const get = async (url) => {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };

  if (!who) who = (await get("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)"))?.user?.emailAddress ?? null;
  const meta = await get(
    `https://www.googleapis.com/drive/v3/files/${SPREADSHEET_ID}?fields=name,owners(emailAddress),capabilities(canEdit)&supportsAllDrives=true`,
  );
  const owner = meta?.owners?.[0]?.emailAddress ?? null;
  // undefined means "could not check" — never report that as "can edit".
  const canEdit = meta?.capabilities?.canEdit;

  const lines = ["Google refused the write (403)."];
  lines.push(`  authenticated as : ${who ?? "(could not determine)"}${isServiceAccount ? " (service account)" : ""}`);
  if (owner) lines.push(`  sheet owned by   : ${owner}`);
  lines.push(
    `  edit permission  : ${canEdit === false ? "NO" : canEdit === true ? "yes" : "could not check (read access only, or Drive scope missing)"}`,
  );
  lines.push("");

  if (canEdit === true) {
    lines.push("The account can edit the file, so the block is elsewhere: check that the Sheets");
    lines.push("API is enabled for this project and that the credential carries the");
    lines.push("https://www.googleapis.com/auth/spreadsheets scope.");
    return lines.join("\n");
  }

  lines.push("Grant this account edit access to the spreadsheet:");
  if (who) {
    lines.push(`  open the sheet → 공유 / Share → ${who} → 편집자 / Editor → 전송 / Send`);
    if (isServiceAccount) {
      lines.push("  (Google warns that this address will not receive an email — that is expected;");
      lines.push("   a service account is a program, not a person.)");
    }
  } else {
    lines.push("  open the sheet → 공유 / Share → add the account this app authenticates as → Editor");
  }
  lines.push("");
  lines.push("Then re-run:  npm run init-sheet -- --apply");
  return lines.join("\n");
}

function isoAddDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

const client = await auth();
const range = encodeURIComponent(`'${LOG_TAB}'!A5:T109`);
const body = await call(client, `${API}/${SPREADSHEET_ID}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
const rows = body.values ?? [];

const WEEKDAY_KO = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const weekdayOf = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAY_KO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};

// Two anchors, matching the app's own structural guard: column A catches a row edit,
// column C catches a column edit. Both must hold or the app refuses to write.
let mismatches = 0;
for (let i = 0; i < 105; i++) {
  const row = 5 + i;
  const expected = isoAddDays("2026-08-01", i);
  const found = (rows[i]?.[0] ?? "").trim();
  if (found !== expected) {
    console.error(`  row ${row} column A: expected ${expected}, found "${found}"`);
    mismatches++;
    continue;
  }
  const weekday = (rows[i]?.[2] ?? "").trim();
  if (weekday !== weekdayOf(expected)) {
    console.error(`  row ${row} column C: expected ${weekdayOf(expected)}, found "${weekday}"`);
    mismatches++;
  }
}
console.log(
  mismatches === 0
    ? "✓ rows 5-109 align with 2026-08-01 .. 2026-11-13 (date and weekday anchors)"
    : `✗ ${mismatches} misaligned cell(s)`,
);
if (mismatches > 0) {
  console.error("Refusing to continue: fix the date column first, or the app will write to the wrong days.");
  process.exit(1);
}

const headerRange = encodeURIComponent(`'${LOG_TAB}'!O3:V4`);
const existing = (await call(client, `${API}/${SPREADSHEET_ID}/values/${headerRange}`)).values ?? [];
const already = existing.flat().filter((v) => (v ?? "").trim() !== "").length;
console.log(already >= HEADERS.length ? "✓ metric column headers already present" : `· ${HEADERS.length - already} header cell(s) missing`);

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write the headers.");
  process.exit(0);
}

await call(client, `${API}/${SPREADSHEET_ID}/values:batchUpdate`, {
  method: "POST",
  body: JSON.stringify({
    valueInputOption: "RAW",
    data: HEADERS.map(([cell, value]) => ({ range: `'${LOG_TAB}'!${cell}`, values: [[value]] })),
  }),
});
console.log("✓ wrote metric + commitment column headers (O3:V4)");
