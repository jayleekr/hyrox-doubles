"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DayRecord, LogPatch, PlayerId } from "@/lib/grid.ts";
import type { Phase } from "@/lib/phases.ts";
import { formatPace, parsePace } from "@/lib/cells.ts";
import { addDays, rowForDate, weekdayKo } from "@/lib/season.ts";
import { phaseForWeek } from "@/lib/phases.ts";
import { summarize, weekSummaries } from "@/lib/stats.ts";

type State = {
  me: PlayerId;
  names: Record<PlayerId, string>;
  today: string;
  focusDate: string;
  dday: string;
  records: DayRecord[];
  phases: Phase[];
};

const KEY_STORAGE = "hyrox-key";

/** null unless the date exists in the 15-week programme. */
function inSeason(date: string | null): string | null {
  return date && rowForDate(date) !== null ? date : null;
}

function useAccessKey(): [string | null, (k: string) => void] {
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("k");
    if (fromUrl) {
      window.localStorage.setItem(KEY_STORAGE, fromUrl);
      url.searchParams.delete("k");
      window.history.replaceState({}, "", url.pathname + url.search);
      setKey(fromUrl);
      return;
    }
    setKey(window.localStorage.getItem(KEY_STORAGE));
  }, []);

  const save = useCallback((k: string) => {
    window.localStorage.setItem(KEY_STORAGE, k);
    setKey(k);
  }, []);

  return [key, save];
}

export default function Page() {
  const [key, saveKey] = useAccessKey();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"today" | "week" | "season">("today");
  const [date, setDate] = useState<string | null>(null);
  // The `today` the visible day was last synced to, so a deliberate step back through the
  // calendar is not undone by the next background refresh.
  const syncedTo = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!key) return;
    try {
      const res = await fetch("/api/state", { headers: { "x-hyrox-key": key }, cache: "no-store" });
      const body = await res.json();
      if (!res.ok) {
        // Keep whatever is already on screen; a transient 502 should not blank the app.
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      const next = body as State;
      setState(next);
      // Follow the clock across midnight — an installed PWA can sit backgrounded for days,
      // and a form still bound to yesterday would write the log to the wrong row.
      setDate((current) => {
        if (current === null) {
          syncedTo.current = next.today;
          return next.focusDate;
        }
        if (next.today !== syncedTo.current && current === syncedTo.current) {
          syncedTo.current = next.today;
          return next.focusDate;
        }
        return current;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "네트워크 오류");
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  // A home-screen PWA can sit in memory for days. Without this, `today` stays frozen at
  // whatever it was when the app was first opened and logs land on the wrong day.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  if (!key) return <KeyPrompt onSubmit={saveKey} />;
  if (!state || !date) {
    return (
      <>
        {error && <div className="notice">에러: {error}</div>}
        <div className="muted">불러오는 중…</div>
      </>
    );
  }

  const record = state.records.find((r) => r.date === date) ?? null;
  // The header line is about today, so it shows today's phase — not the phase of
  // whatever past day the user has navigated to.
  const todayRecord = state.records.find((r) => r.date === state.today) ?? null;
  const todayPhase = todayRecord ? phaseForWeek(state.phases, todayRecord.week) : null;

  return (
    <>
      <header>
        <div className="dday">{state.dday}</div>
        <div className="muted small">
          {state.today} ({weekdayKo(state.today)}) · 대회 2026-11-13
          {todayPhase ? ` · ${todayPhase.name}` : ""}
        </div>
      </header>

      {error && <div className="notice">에러: {error}</div>}

      <nav className="tabs">
        <button aria-selected={tab === "today"} onClick={() => setTab("today")}>
          오늘
        </button>
        <button aria-selected={tab === "week"} onClick={() => setTab("week")}>
          주간
        </button>
        <button aria-selected={tab === "season"} onClick={() => setTab("season")}>
          시즌
        </button>
      </nav>

      {/* All three panels stay mounted: switching tabs must not throw away a
          half-typed log. Only visibility changes. */}
      <div hidden={tab !== "today"}>
        {record ? (
          <TodayTab state={state} record={record} date={date} setDate={setDate} onSaved={load} accessKey={key} />
        ) : (
          <div className="notice">{date}는 프로그램 기간이 아니야.</div>
        )}
      </div>
      <div hidden={tab !== "week"}>
        <WeekTab state={state} date={date} />
      </div>
      <div hidden={tab !== "season"}>
        <SeasonTab state={state} />
      </div>
    </>
  );
}

function KeyPrompt({ onSubmit }: { onSubmit: (k: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="card">
      <p className="small">
        개인 링크(<code>?k=…</code>)로 열거나, 아래에 접근 키를 붙여넣어줘. 홈 화면 앱에서는 주소창이 없으니 이쪽이 편해.
      </p>
      <input
        type="text"
        value={value}
        placeholder="접근 키"
        onChange={(e) => setValue(e.target.value)}
        style={{ marginBottom: 10 }}
      />
      <button className="save" onClick={() => value.trim() && onSubmit(value.trim())} disabled={!value.trim()}>
        저장
      </button>
    </div>
  );
}

type FormValues = {
  done: boolean;
  weight: string;
  pace: string;
  duration: string;
  rpe: string;
  alt: string;
  memo: string;
};

function seedFrom(record: DayRecord, me: PlayerId): FormValues {
  const log = record[me];
  return {
    done: log.done,
    weight: log.weightKg === null ? "" : String(log.weightKg),
    pace: formatPace(log.paceSecPerKm),
    duration: log.durationMin === null ? "" : String(log.durationMin),
    rpe: log.rpe === null ? "" : String(log.rpe),
    alt: log.altWorkout,
    memo: log.memo,
  };
}

function TodayTab({
  state,
  record,
  date,
  setDate,
  onSaved,
  accessKey,
}: {
  state: State;
  record: DayRecord;
  date: string;
  setDate: (d: string) => void;
  onSaved: () => Promise<void>;
  accessKey: string;
}) {
  const me = state.me;
  const partner: PlayerId = me === "A" ? "B" : "A";
  const theirs = record[partner];

  const [form, setForm] = useState<FormValues>(() => seedFrom(record, me));
  // The values the form was seeded from. Only fields that differ from this are sent,
  // so a stale snapshot can never overwrite a field the user did not touch.
  const baseline = useRef<FormValues>(seedFrom(record, me));
  const seededFor = useRef<string>(record.date);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  // Re-seed only when the visible day changes. A background refresh must not overwrite
  // what the user is in the middle of typing.
  useEffect(() => {
    if (seededFor.current === record.date) return;
    seededFor.current = record.date;
    const seed = seedFrom(record, me);
    baseline.current = seed;
    setForm(seed);
    setSaveError(null);
    setSaveNote(null);
  }, [record, me]);

  const set = <K extends keyof FormValues>(field: K, value: FormValues[K]) =>
    setForm((f) => ({ ...f, [field]: value }));

  // A non-empty field that does not parse is a typo, not a request to clear the value.
  const invalidFields = useMemo(() => {
    const bad: string[] = [];
    if (form.weight.trim() !== "" && !Number.isFinite(Number(form.weight))) bad.push("체중");
    if (form.pace.trim() !== "" && parsePace(form.pace) === null) bad.push("페이스");
    if (form.duration.trim() !== "" && !Number.isFinite(Number(form.duration))) bad.push("시간");
    if (form.rpe.trim() !== "" && !Number.isFinite(Number(form.rpe))) bad.push("RPE");
    return bad;
  }, [form]);

  const patch: LogPatch = useMemo(() => {
    const base = baseline.current;
    const out: LogPatch = {};
    if (form.done !== base.done) out.done = form.done;
    if (form.weight !== base.weight) out.weightKg = form.weight.trim() === "" ? null : Number(form.weight);
    if (form.pace !== base.pace) out.paceSecPerKm = form.pace.trim() === "" ? null : parsePace(form.pace);
    if (form.duration !== base.duration) out.durationMin = form.duration.trim() === "" ? null : Number(form.duration);
    if (form.rpe !== base.rpe) out.rpe = form.rpe.trim() === "" ? null : Number(form.rpe);
    if (form.alt !== base.alt) out.altWorkout = form.alt;
    if (form.memo !== base.memo) out.memo = form.memo;
    return out;
  }, [form]);

  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveNote(null);
    try {
      const res = await fetch("/api/log", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hyrox-key": accessKey },
        body: JSON.stringify({ date, patch }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      // The save succeeded, so these values are now the server's values.
      baseline.current = { ...form };
      setSaveNote(body?.warning ? `저장됨 (${body.warning})` : "저장됨");
      await onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  };

  // Navigation is clamped to the season: stepping past either edge would render a
  // dead-end page with no way back.
  const prev = inSeason(addDays(date, -1));
  const next = inSeason(addDays(date, 1));

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="step" onClick={() => prev && setDate(prev)} disabled={!prev}>
          ◀ 이전
        </button>
        <strong>
          {record.date} ({record.weekday}) · W{record.week}
        </strong>
        <button className="step" onClick={() => next && setDate(next)} disabled={!next}>
          다음 ▶
        </button>
      </div>
      {date !== state.today && (
        <div className="notice small">
          오늘({state.today})이 아니라 {date} 기록 중이야.{" "}
          <button className="step" onClick={() => setDate(state.today)}>
            오늘로
          </button>
        </div>
      )}

      <div className="card">
        <h2>{record.area}</h2>
        {record.plan && (
          <p className="plan small muted" style={{ marginBottom: 0 }}>
            {record.plan}
          </p>
        )}
        {record.paceTarget && <p className="small" style={{ marginBottom: 0 }}>🎯 {record.paceTarget}</p>}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <strong>{state.names[me]}</strong>
          <span className="small muted">내 기록</span>
        </div>

        <button className="big" data-on={form.done} onClick={() => set("done", !form.done)} style={{ marginBottom: 12 }}>
          {form.done ? "✅ 완료" : "완료로 표시"}
        </button>

        <div className="grid2" style={{ marginBottom: 10 }}>
          <div>
            <label htmlFor="weight">체중 (kg)</label>
            <input
              id="weight"
              inputMode="decimal"
              value={form.weight}
              placeholder="82.4"
              onChange={(e) => set("weight", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="pace">페이스 (/km)</label>
            <input
              id="pace"
              inputMode="text"
              value={form.pace}
              placeholder="4:20"
              onChange={(e) => set("pace", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="duration">시간 (분)</label>
            <input
              id="duration"
              inputMode="numeric"
              value={form.duration}
              placeholder="55"
              onChange={(e) => set("duration", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="rpe">RPE (1-10)</label>
            <input
              id="rpe"
              inputMode="numeric"
              value={form.rpe}
              placeholder="7"
              onChange={(e) => set("rpe", e.target.value)}
            />
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label htmlFor="alt">대체/추가 운동</label>
          <input
            id="alt"
            type="text"
            value={form.alt}
            placeholder="크로스핏 WOD"
            onChange={(e) => set("alt", e.target.value)}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="memo">메모</label>
          <input
            id="memo"
            type="text"
            value={form.memo}
            placeholder="무릎 살짝 뻐근"
            onChange={(e) => set("memo", e.target.value)}
          />
        </div>

        {invalidFields.length > 0 && <div className="notice">{invalidFields.join(", ")} 값을 확인해줘.</div>}
        {saveError && <div className="notice">{saveError}</div>}
        {saveNote && !saveError && (
          <div className="notice small muted">{saveNote}</div>
        )}
        <button
          className="save"
          onClick={() => void save()}
          disabled={saving || invalidFields.length > 0 || !dirty}
        >
          {saving ? "저장 중…" : dirty ? "시트에 저장" : "변경 없음"}
        </button>
      </div>

      <div className="card">
        <div className="row">
          <strong>{state.names[partner]}</strong>
          <span>{record.isRest ? "휴식일" : theirs.done ? "✅ 완료" : "⬜️ 미기록"}</span>
        </div>
        <div className="small muted">
          {[
            theirs.weightKg !== null ? `${theirs.weightKg}kg` : null,
            theirs.paceSecPerKm !== null ? `${formatPace(theirs.paceSecPerKm)}/km` : null,
            theirs.rpe !== null ? `RPE ${theirs.rpe}` : null,
            theirs.altWorkout || null,
          ]
            .filter(Boolean)
            .join(" · ") || "기록 없음"}
        </div>
      </div>
    </>
  );
}

function WeekTab({ state, date }: { state: State; date: string }) {
  const current = state.records.find((r) => r.date === date);
  const week = current ? state.records.filter((r) => r.week === current.week) : [];
  if (week.length === 0) return <div className="muted">데이터 없음</div>;

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <strong>W{week[0].week}</strong>
        <span className="small muted">
          {week[0].date} ~ {week[week.length - 1].date}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>날짜</th>
            <th>세션</th>
            <th className="num">{state.names.A}</th>
            <th className="num">{state.names.B}</th>
          </tr>
        </thead>
        <tbody>
          {week.map((r) => (
            <tr key={r.date}>
              <td>{r.date.slice(5)}</td>
              <td style={{ whiteSpace: "normal" }}>{r.area}</td>
              <td className="num">{r.isRest ? "·" : r.A.done ? "✅" : "⬜️"}</td>
              <td className="num">{r.isRest ? "·" : r.B.done ? "✅" : "⬜️"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeasonTab({ state }: { state: State }) {
  const past = state.records.filter((r) => r.date <= state.today);
  const a = weekSummaries(past, "A");
  const b = weekSummaries(past, "B");
  if (a.length === 0) return <div className="muted">아직 지난 주가 없어.</div>;

  // Season-to-date, not just the current week.
  const seasonA = summarize(past, "A");
  const seasonB = summarize(past, "B");

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>주</th>
            <th className="num">{state.names.A}</th>
            <th className="num">체중</th>
            <th className="num">{state.names.B}</th>
            <th className="num">체중</th>
          </tr>
        </thead>
        <tbody>
          {a.map((wa, i) => {
            const wb = b[i];
            return (
              <tr key={wa.week}>
                <td>W{wa.week}</td>
                <td className="num">
                  {wa.done}/{wa.planned}
                </td>
                <td className="num">{wa.weightLast ?? "–"}</td>
                <td className="num">
                  {wb.done}/{wb.planned}
                </td>
                <td className="num">{wb.weightLast ?? "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small muted" style={{ marginBottom: 0 }}>
        시즌 평균 페이스 — {state.names.A}:{" "}
        {seasonA.avgPaceSecPerKm !== null ? `${formatPace(seasonA.avgPaceSecPerKm)}/km` : "기록 없음"} /{" "}
        {state.names.B}:{" "}
        {seasonB.avgPaceSecPerKm !== null ? `${formatPace(seasonB.avgPaceSecPerKm)}/km` : "기록 없음"}
      </p>
    </div>
  );
}
