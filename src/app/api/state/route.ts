import { NextResponse } from "next/server";
import { playerFromRequest } from "@/lib/auth.ts";
import { playerNames } from "@/lib/config.ts";
import { liveSheetsClient } from "@/lib/sheets.ts";
import { loadSeason } from "@/lib/store.ts";
import { clampToSeason, todayInSeasonTz } from "@/lib/season.ts";
import { formatDday } from "@/lib/messages.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = playerFromRequest(req);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const season = await loadSeason(liveSheetsClient());
    const today = todayInSeasonTz();
    return NextResponse.json({
      me,
      names: playerNames(),
      today,
      focusDate: clampToSeason(today),
      dday: formatDday(today),
      records: season.records,
      phases: season.phases,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "sheet read failed" }, { status: 502 });
  }
}
