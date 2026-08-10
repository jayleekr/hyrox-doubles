import { NextResponse } from "next/server";
import { playerFromRequest } from "@/lib/auth.ts";
import { liveSheetsClient } from "@/lib/sheets.ts";
import { loadDay, saveLog } from "@/lib/store.ts";
import type { LogPatch } from "@/lib/grid.ts";
import { rowForDate } from "@/lib/season.ts";
import { validDuration, validPace, validRpe, validWeight } from "@/lib/cells.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accept only the fields we understand. A field that is explicitly null or empty means
 * "clear it"; a field that is present but unparseable is an error, not a clear — silently
 * wiping a real measurement because of a typo is worse than refusing the save.
 */
function readPatch(body: Record<string, unknown>): { patch: LogPatch; invalid: string[] } {
  const patch: LogPatch = {};
  const invalid: string[] = [];
  const p = body.patch;
  if (typeof p !== "object" || p === null) return { patch, invalid };
  const src = p as Record<string, unknown>;

  if ("done" in src) {
    if (typeof src.done === "boolean") patch.done = src.done;
    else invalid.push("done");
  }

  for (const key of ["weightKg", "paceSecPerKm", "durationMin", "rpe"] as const) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === null || v === "") {
      patch[key] = null;
      continue;
    }
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n)) {
      invalid.push(key);
      continue;
    }
    // Range-check here as well as downstream: applyPatch ignores an out-of-range value,
    // which would make the endpoint answer 200 for a save that stored nothing.
    const validators = {
      weightKg: validWeight,
      paceSecPerKm: validPace,
      durationMin: validDuration,
      rpe: validRpe,
    } as const;
    if (validators[key](n) === null) {
      invalid.push(key);
      continue;
    }
    patch[key] = n;
  }

  for (const key of ["altWorkout", "memo"] as const) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === null) patch[key] = null;
    else if (typeof v === "string") patch[key] = v;
    else invalid.push(key);
  }

  return { patch, invalid };
}

export async function POST(req: Request) {
  const me = playerFromRequest(req);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const date = typeof body.date === "string" ? body.date : "";
  if (rowForDate(date) === null) {
    return NextResponse.json({ error: "date is outside the 15-week season" }, { status: 400 });
  }

  const { patch, invalid } = readPatch(body);
  if (invalid.length > 0) {
    return NextResponse.json({ error: `잘못된 값: ${invalid.join(", ")}`, invalid }, { status: 400 });
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "empty patch" }, { status: 400 });
  }

  const client = liveSheetsClient();
  let written: number;
  try {
    written = (await saveLog(client, date, me, patch)).written;
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "sheet write failed" }, { status: 502 });
  }

  // The write is already committed. A failure on the confirmation read must not be
  // reported as a failed save — the client would show 저장 실패 for data that is in the sheet.
  try {
    const record = await loadDay(client, date);
    return NextResponse.json({ ok: true, written, record });
  } catch (err) {
    return NextResponse.json({
      ok: true,
      written,
      record: null,
      warning: err instanceof Error ? err.message : "saved, but re-reading the row failed",
    });
  }
}
