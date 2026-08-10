// Environment configuration. Reads are lazy so that importing a module in a test
// never requires a fully-populated environment.

import type { PlayerId } from "./grid.ts";

export const DEFAULT_SPREADSHEET_ID = "1nNDRGp-FY2DU7w3y_akDwIO2GD1HePaoi7gxxYAf4Rc";

function env(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export function spreadsheetId(): string {
  return env("SPREADSHEET_ID") ?? DEFAULT_SPREADSHEET_ID;
}

export function playerName(player: PlayerId): string {
  return (player === "A" ? env("PLAYER_A_NAME") : env("PLAYER_B_NAME")) ?? (player === "A" ? "선수 A" : "선수 B");
}

export function playerNames(): Record<PlayerId, string> {
  return { A: playerName("A"), B: playerName("B") };
}

export function otherPlayer(player: PlayerId): PlayerId {
  return player === "A" ? "B" : "A";
}

export function accessKeys(): { A: string | null; B: string | null } {
  return { A: env("PLAYER_A_KEY"), B: env("PLAYER_B_KEY") };
}

/**
 * Telegram user id → player. OpenClaw knows which account sent a message, so it can pass
 * `--telegram <id>` and never has to infer from the text who is logging.
 *
 * Null-prototype so an id like "constructor" cannot resolve to an inherited property.
 */
export function telegramUsers(): Record<string, PlayerId> {
  const users: Record<string, PlayerId> = Object.create(null);
  const a = env("TELEGRAM_USER_A");
  const b = env("TELEGRAM_USER_B");
  if (a) users[a.toLowerCase()] = "A";
  if (b) users[b.toLowerCase()] = "B";
  return users;
}

export function googleServiceAccountJson(): string | null {
  return env("GOOGLE_SERVICE_ACCOUNT_JSON");
}

export function googleOAuthCredentialsFile(): string {
  return env("GOOGLE_OAUTH_CREDENTIALS_FILE") ?? `${process.env.HOME ?? ""}/.config/gws/credentials.json`;
}

/**
 * How to invoke this CLI, as an absolute path — never the bare word `hyrox`.
 *
 * Nothing installs `hyrox` onto PATH. The live agent runs commands through OpenClaw's
 * `exec` with `shell: false` and the gateway's own PATH, which contains no `hyrox`, so a
 * bare name exits 127 `command not found`. That is the worst possible failure here: 127 is
 * not one of the exit codes this CLI documents, and its symptom — "I recorded it" followed
 * by an empty sheet — is indistinguishable from a broken inbound path.
 *
 * So every command string this program *prints for someone to run* is built from here.
 * `bin/hyrox` exists precisely to be called by absolute path from any directory, and
 * `HYROX_CLI` overrides it for an installation that puts the wrapper somewhere else.
 */
export function cliCommand(): string {
  const override = env("HYROX_CLI");
  if (override) return override;
  // Resolved from this module rather than from cwd: the agent's working directory is its
  // own workspace, not the repo.
  return decodeURIComponent(new URL("../../bin/hyrox", import.meta.url).pathname);
}

export function appUrl(): string | null {
  const explicit = env("APP_URL");
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = env("VERCEL_PROJECT_PRODUCTION_URL") ?? env("VERCEL_URL");
  return vercel ? `https://${vercel}` : null;
}
