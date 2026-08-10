// Creates (or refreshes) the "운영 방식 & 근거" tab: why the bot asks what it asks.
//
// This is documentation for the two athletes, not for the app — nothing reads it back.
// It exists because a system that nags is easier to live with when the reasoning is visible,
// and because six months from now nobody will remember why the team number is a minimum.
//
//   node --env-file-if-exists=.env.local scripts/add-approach-tab.mjs          # dry run
//   node --env-file-if-exists=.env.local scripts/add-approach-tab.mjs --apply

import { JWT, UserRefreshClient } from "google-auth-library";

const APPLY = process.argv.includes("--apply");
const TAB = "운영 방식 & 근거";
const SHEET_ID = process.env.SPREADSHEET_ID ?? "1nNDRGp-FY2DU7w3y_akDwIO2GD1HePaoi7gxxYAf4Rc";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

const ROWS = [
  ["🏃 HYROX DOUBLES — 이 봇이 왜 이렇게 물어보는가"],
  [""],
  ["대회 2026-11-13 · 15주 프로그램 · Jay + 정재빈"],
  ["이 탭은 사람이 읽는 문서다. 앱은 이 탭을 읽지도 쓰지도 않는다."],
  [""],
  ["1. 팀 숫자는 평균이 아니라 최솟값이다"],
  ["항목", "내용"],
  [
    "왜",
    "HYROX 더블은 8km를 둘이 처음부터 끝까지 함께 뛴다. 팀 기록은 느린 쪽에 묶인다. " +
      "즉 한 명이 아무리 잘해도 다른 한 명이 빠지면 팀은 0이다.",
  ],
  [
    "그래서",
    "브리핑의 '팀 N/M' 은 둘 다 완료한 날만 센다. 평균이 아니다. " +
      "한 명만 한 날은 '혼자 한 날' 로 따로 표시된다 — 운동은 했지만 팀은 못 얻은 날.",
  ],
  [
    "근거",
    "Köhler 효과: 팀 과제에서 약한 쪽이 '내가 없으면 팀이 안 된다' 는 조건일 때 " +
      "혼자일 때보다 더 노력한다. 이 효과는 팀 성과가 가장 약한 구성원에 의해 결정되는 " +
      "conjunctive 구조에서 가장 강하게 나타난다. 더블은 비유가 아니라 실제로 그 구조다.",
  ],
  ["출처", "Feltz & Kerr, Buddy up: the Köhler effect applied to health games"],
  [""],
  ["2. 아침에 '몇 시에, 어디서' 를 묻는다"],
  ["항목", "내용"],
  [
    "왜",
    "'오늘 템포런' 은 계획이 아니라 정보다. 실행 의도(if-then)는 언제·어디서·어떻게를 " +
      "정해야 성립한다.",
  ],
  [
    "그래서",
    "아침 06:00 브리핑이 각자에게 시간과 장소를 묻고, 그 답을 시트 U/V 열에 적는다. " +
      "저녁 21:00 넛지는 그 말을 그대로 되돌려준다 — \"19:00 헬스장 이라고 했어\".",
  ],
  [
    "근거",
    "실행 의도만으로는 신체활동 효과가 작다(d≈.14~.15). 되짚어주는 강화가 붙으면 d≈.25로 " +
      "올라간다. 되돌려주는 그 한 줄이 기제다.",
  ],
  ["출처", "da Silva et al. (2018), PLOS One · Sheeran et al. (2024)"],
  [""],
  ["3. 애매하면 기록하지 않는다"],
  ["항목", "내용"],
  [
    "왜",
    "한 메시지에 체중처럼 보이는 숫자가 여럿 나온다. " +
      "예: \"KB 스윙 30개 (16/24kg) ... 몸무게 109키로\" — 16, 24, 109 중 체중은 하나뿐이다.",
  ],
  [
    "그래서",
    "CLI가 값마다 범위를 검사하고, 직전 기록과 10kg 넘게 차이나면 거부한다(장비 무게 방지). " +
      "거부할 때는 그 명령의 유효한 부분까지 통째로 안 쓴다 — 일부만 들어가는 게 더 나쁘다.",
  ],
  [
    "원칙",
    "틀린 값이 조용히 남는 것이 최악이다. 105행짜리 시트에 취소 버튼은 없다. " +
      "그래서 봇은 자주 되묻는다. 귀찮은 게 아니라 설계다.",
  ],
  [""],
  ["4. 손으로 고쳐도 되는 칸 / 아닌 칸"],
  ["칸", "앱이 쓰는가"],
  ["A~C 날짜/주차/요일", "아니오 — 행 순서를 건드리면 시즌 날짜가 전부 어긋난다"],
  ["D, F 목표 체중", "예 (hyrox goal --date)"],
  ["E, G 실체중/완료", "예 — 여기 적은 메모는 기록 시 덮어써진다(확인 메시지에 원문이 남는다)"],
  ["H~J 훈련 영역/계획/페이스", "아니오 — 프로그램 원안"],
  ["K~N 대체운동/메모", "예"],
  ["O~T 실측 페이스/시간/RPE", "예"],
  ["U, V 오늘의 약속", "예 — 아침에 말한 시간·장소"],
  [""],
  ["5. 아직 안 한 것 (검토됨)"],
  ["항목", "왜 아직 아닌가"],
  [
    "금전 디파짓 (못 하면 돈 잃기)",
    "손실 회피 기반 디파짓은 효과가 입증돼 있다. 다만 이미 피드백과 책무 장치가 있는 " +
      "상태에 인센티브를 얹었을 때 추가 이득이 뚜렷하지 않았다는 결과도 있다. " +
      "위 1~2번 효과를 먼저 보고 판단한다. 둘 다 걸 의향이 있어야 의미가 있다.",
  ],
  [
    "예상 완주 기록 표시",
    "현재 페이스로 1:05~1:12 목표 대비 어디인지 보여주는 것. 팀 페이스가 쌓이면 붙일 수 있다.",
  ],
];

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

console.log(`탭 "${TAB}" — ${existing ? "이미 있음 (내용만 갱신)" : "새로 만들어야 함"}`);
console.log(`${ROWS.length}행을 쓸 예정`);

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

// Clear first: a shorter rewrite must not leave the tail of an older version behind.
await fetch(`${API}/${SHEET_ID}/values/${encodeURIComponent(`'${TAB}'!A1:Z200`)}:clear`, { method: "POST", headers });

const res = await fetch(
  `${API}/${SHEET_ID}/values/${encodeURIComponent(`'${TAB}'!A1`)}?valueInputOption=RAW`,
  { method: "PUT", headers, body: JSON.stringify({ values: ROWS }) },
);
if (!res.ok) throw new Error(`쓰기 실패: ${res.status} ${(await res.text()).slice(0, 300)}`);
console.log(`✓ "${TAB}" 탭에 ${ROWS.length}행 기록`);
