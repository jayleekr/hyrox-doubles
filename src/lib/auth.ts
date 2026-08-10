// Two people, two secret URLs. No accounts, no sessions, no password reset.

import { accessKeys } from "./config.ts";
import type { PlayerId } from "./grid.ts";

/** Constant-time-ish comparison; lengths differ far more often than contents here. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function playerForKey(key: string | null): PlayerId | null {
  if (!key) return null;
  const keys = accessKeys();
  if (keys.A && sameSecret(key, keys.A)) return "A";
  if (keys.B && sameSecret(key, keys.B)) return "B";
  return null;
}

export function playerFromRequest(req: Request): PlayerId | null {
  const header = req.headers.get("x-hyrox-key");
  if (header) {
    const p = playerForKey(header);
    if (p) return p;
  }
  const url = new URL(req.url);
  return playerForKey(url.searchParams.get("k"));
}
