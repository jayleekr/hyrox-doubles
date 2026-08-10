// Creates the "식단 기록" tab, laid out exactly like the log tab so the same row
// arithmetic and the same date/weekday anchors apply: rows 5..109 = 2026-08-01..2026-11-13,
// headers on rows 3-4, A/B/C = 날짜/주차/요일.
//
// Sharing the shape is the point. A second tab with its own row convention is a second way
// to file a meal against the wrong day, and the whole design here is that a date resolves to
// exactly one row by arithmetic, with column A only ever used to check that assumption.
//
//   node --env-file-if-exists=.env.local scripts/init-diet-tab.mjs          # dry run
//   node --env-file-if-exists=.env.local scripts/init-diet-tab.mjs --apply

import { JWT, UserRefreshClient } from "google-auth-library";

const APPLY = process.argv.includes("--apply");
const TAB = "식단 기록";
const SHEET_ID = process.env.SPREADSHEET_ID ?? "1nNDRGp-FY2DU7w3y_akDwIO2GD1HePaoi7gxxYAf4Rc";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

const SEASON_START = "2026-08-01";
const FIRST_ROW = 5;
const LAST_ROW = 109;
const NAME_A = process.env.PLAYER_A_NAME ?? "선수 A";
const NAME_B = process.env.PLAYER_B_NAME ?? "선수 B";
const WEEKDAYS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

function dateForRow(row) {
  const d = new Date(`${SEASON_START}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (row - FIRST_ROW));
  return d;
}

async function auth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const c = JSON.parse(raw);
    return new JWT({
      email: c.client_email,
      key: c.private_key.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }
  const path = process.env.GOOGLE_OAUTH_CREDENTIALS_FILE ?? `${process.env.HOME}/.config/gws/credentials.json`;
  const { readFile } = await import("node:fs/promises");
  const c = JSON.parse(await readFile(path, "utf8"));
  return new UserRefreshClient(c.client_id, c.client_secret, c.refresh_token);
}

const client = await auth();
const { token } = await client.getAccessToken();
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const meta = await (await fetch(`${API}/${SHEET_ID}?fields=sheets.properties`, { headers })).json();
const existing = (meta.sheets ?? []).find((s) => s.properties?.title === TAB);

// Rows 1..4: title and the two header rows, mirroring the log tab's shape.
const rows = [
  ["🥗 식단 기록 — 하루 한 행, 일지 탭과 같은 행 번호"],
  [],
  ["날짜 (Date)", "주차", "요일", `${NAME_A} 식단`, "", "", "", `${NAME_B} 식단`, "", "", ""],
  ["날짜 (Date)", "주차", "요일", "아침", "점심", "저녁", "간식", "아침", "점심", "저녁", "간식"],
];

for (let row = FIRST_ROW; row <= LAST_ROW; row++) {
  const d = dateForRow(row);
  const iso = d.toISOString().slice(0, 10);
  const week = Math.floor((row - FIRST_ROW) / 7) + 1;
  rows.push([iso, `W${week}`, WEEKDAYS[d.getUTCDay()], "", "", "", "", "", "", "", ""]);
}

console.log(`탭 "${TAB}" — ${existing ? "이미 있음" : "새로 만들어야 함"}`);
console.log(`${rows.length}행 (헤더 4 + ${LAST_ROW - FIRST_ROW + 1}일)`);
console.log(`컬럼: A 날짜 · B 주차 · C 요일 · D~G ${NAME_A} 아침/점심/저녁/간식 · H~K ${NAME_B} 아침/점심/저녁/간식`);

if (existing) {
  // Never clobber meals somebody already logged.
  const res = await fetch(
    `${API}/${SHEET_ID}/values/${encodeURIComponent(`'${TAB}'!D${FIRST_ROW}:K${LAST_ROW}`)}`,
    { headers },
  );
  const body = await res.json();
  const filled = (body.values ?? []).flat().filter((v) => String(v ?? "").trim() !== "").length;
  if (filled > 0) {
    console.log(`\n⚠️ 이미 ${filled}칸에 식단이 적혀 있어. 덮어쓰지 않고 그대로 둘게.`);
    process.exit(0);
  }
}

if (!APPLY) {
  console.log("\nDry run. --apply 를 붙이면 실제로 씁니다.");
  process.exit(0);
}

if (!existing) {
  const res = await fetch(`${API}/${SHEET_ID}:batchUpdate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] }),
  });
  if (!res.ok) throw new Error(`addSheet 실패: ${res.status} ${(await res.text()).slice(0, 300)}`);
  console.log("✓ 탭 생성");
}

const res = await fetch(
  `${API}/${SHEET_ID}/values/${encodeURIComponent(`'${TAB}'!A1`)}?valueInputOption=RAW`,
  { method: "PUT", headers, body: JSON.stringify({ values: rows }) },
);
if (!res.ok) throw new Error(`쓰기 실패: ${res.status} ${(await res.text()).slice(0, 300)}`);
console.log(`✓ "${TAB}" 탭 초기화 (${rows.length}행)`);
