// Google Sheets v4 REST access.
//
// Two auth modes, chosen automatically:
//   1. GOOGLE_SERVICE_ACCOUNT_JSON  — production (Vercel). Share the sheet with the
//      service account's client_email as Editor.
//   2. ~/.config/gws/credentials.json — local dev, reusing the authorized_user
//      refresh token the `gws` CLI already stores on this machine.

import { JWT, UserRefreshClient } from "google-auth-library";
import { googleOAuthCredentialsFile, googleServiceAccountJson, spreadsheetId } from "./config.ts";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const API = "https://sheets.googleapis.com/v4/spreadsheets";

export type ValueRange = { range?: string; values?: unknown[][] };

export interface SheetsClient {
  batchGet(ranges: string[]): Promise<ValueRange[]>;
  batchUpdate(updates: { range: string; value: string }[]): Promise<void>;
}

let cachedClient: JWT | UserRefreshClient | null = null;

async function authClient(): Promise<JWT | UserRefreshClient> {
  if (cachedClient) return cachedClient;

  const raw = googleServiceAccountJson();
  if (raw) {
    let creds: { client_email?: string; private_key?: string };
    try {
      creds = JSON.parse(raw);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
    if (!creds.client_email || !creds.private_key) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
    }
    cachedClient = new JWT({
      email: creds.client_email,
      // Vercel env vars often carry literal \n sequences.
      key: creds.private_key.replace(/\\n/g, "\n"),
      scopes: SCOPES,
    });
    return cachedClient;
  }

  const path = googleOAuthCredentialsFile();
  const { readFile } = await import("node:fs/promises");
  let file: string;
  try {
    file = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `No Google credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON, or provide an authorized_user file at ${path}.`,
    );
  }
  const creds = JSON.parse(file) as { client_id?: string; client_secret?: string; refresh_token?: string };
  if (!creds.client_id || !creds.client_secret || !creds.refresh_token) {
    throw new Error(`${path} is not an authorized_user credential (need client_id, client_secret, refresh_token)`);
  }
  cachedClient = new UserRefreshClient(creds.client_id, creds.client_secret, creds.refresh_token);
  return cachedClient;
}

async function authHeader(): Promise<string> {
  const client = await authClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Google auth returned no access token");
  return `Bearer ${token}`;
}

async function request(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: await authHeader(),
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (res.status === 403) {
    // "The caller does not have permission" on its own gives nobody a way forward. The cause
    // is almost always that the authenticated account cannot edit the sheet.
    throw new Error(
      `Google refused the request (403): the account this app authenticates as cannot edit the spreadsheet. ` +
        `Share it with that account as Editor — for a service account, that is its client_email. ` +
        `Run \`npm run init-sheet\` to see which account is in use.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Sheets API ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

export function liveSheetsClient(id: string = spreadsheetId()): SheetsClient {
  return {
    async batchGet(ranges) {
      const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
      const body = (await request(`${API}/${id}/values:batchGet?${qs}&valueRenderOption=FORMATTED_VALUE`)) as {
        valueRanges?: ValueRange[];
      };
      return body.valueRanges ?? [];
    },

    async batchUpdate(updates) {
      if (updates.length === 0) return;
      await request(`${API}/${id}/values:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({
          valueInputOption: "RAW",
          data: updates.map((u) => ({ range: u.range, values: [[u.value]] })),
        }),
      });
    },
  };
}
