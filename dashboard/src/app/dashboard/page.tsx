"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot, collection, query, where, getCountFromServer } from "firebase/firestore";
import { db } from "@/lib/firebase";

interface SyncStats {
  queued: number;
  skipped: number;
  analyzed: number;
  duplicatesFlagged: number;
  rejectedPrivate: number;
  lastRun: string;
  geminiEnabled: boolean;
  source?: string;
}

interface GlobalStats {
  totalPushed: number;
  lastPushedAt: string;
}

const SOURCES = [
  { id: "localist",        label: "Oberlin Localist"         },
  { id: "amam",            label: "Allen Memorial Art Museum" },
  { id: "heritage_center", label: "Oberlin Heritage Center"  },
  { id: "apollo_theatre",  label: "Apollo Theatre"           },
  { id: "oberlin_libcal", label: "Oberlin College Libraries" },
];

function timeAgo(iso: string) {
  if (!iso) return "—";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function StatCard({ label, value, sub, highlight, dim }: {
  label: string; value: string; sub?: string; highlight?: boolean; dim?: boolean;
}) {
  return (
    <div className={`bg-white/[0.03] border border-white/[0.07] rounded-xl p-5 ${dim ? "opacity-40" : ""}`}>
      <p className="text-zinc-500 text-[10px] font-semibold uppercase tracking-wide mb-2">{label}</p>
      <p className={`text-3xl font-bold mb-1 ${highlight ? "text-emerald-400" : "text-white"}`}>{value}</p>
      {sub && <p className="text-zinc-600 text-xs">{sub}</p>}
    </div>
  );
}

export default function OverviewPage() {
  const [allStats, setAllStats]   = useState<Record<string, SyncStats>>({});
  const [global, setGlobal]       = useState<GlobalStats | null>(null);
  const [pendingCount, setPending] = useState<number | null>(null);

  // Live sync stats for each source
  useEffect(() => {
    const unsubs = SOURCES.map(s =>
      onSnapshot(doc(db, "syncs", s.id), snap => {
        if (snap.exists()) {
          setAllStats(prev => ({ ...prev, [s.id]: snap.data() as SyncStats }));
        }
      })
    );
    return () => unsubs.forEach(u => u());
  }, []);

  // Real push counter
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "syncs", "global"), snap => {
      if (snap.exists()) setGlobal(snap.data() as GlobalStats);
    });
    return unsub;
  }, []);

  // Pending review count (live)
  useEffect(() => {
    const q = query(collection(db, "review_queue"), where("status", "==", "pending"));
    const unsub = onSnapshot(q, snap => setPending(snap.size));
    return unsub;
  }, []);

  // Most recent run across all sources
  const allRuns = Object.values(allStats).filter(s => s?.lastRun);
  const latestRun = allRuns.sort((a, b) =>
    new Date(b.lastRun).getTime() - new Date(a.lastRun).getTime()
  )[0] ?? null;

  const activeSources = SOURCES.filter(s => allStats[s.id]);

  return (
    <div className="p-8 max-w-5xl">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-white text-2xl font-bold tracking-tight">Overview</h1>
        <p className="text-zinc-500 text-sm mt-1">
          Oberlin Community Calendar Unification — AI Micro-Grant Research
        </p>
      </div>

      {/* ── Top row: pipeline totals ── */}
      <p className="text-zinc-400 text-xs font-semibold uppercase tracking-wide mb-3">Pipeline totals</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Pushed to CommunityHub"
          value={global?.totalPushed != null ? String(global.totalPushed) : "—"}
          sub={global?.lastPushedAt ? `last ${timeAgo(global.lastPushedAt)}` : "no pushes yet"}
          highlight={!!global?.totalPushed && global.totalPushed > 0}
        />
        <StatCard
          label="Pending review"
          value={pendingCount != null ? String(pendingCount) : "—"}
          sub="waiting for approval"
        />
        <StatCard
          label="Active sources"
          value={String(activeSources.length || SOURCES.length)}
          sub={activeSources.length > 0
            ? activeSources.map(s => s.label).join(" · ")
            : SOURCES.map(s => s.label).join(" · ")}
        />
        <StatCard
          label="Last sync"
          value={latestRun ? timeAgo(latestRun.lastRun) : "—"}
          sub={latestRun
            ? new Date(latestRun.lastRun).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
            : "no sync run yet"}
          dim={!latestRun}
        />
      </div>

      {/* ── Per-source last run stats ── */}
      <p className="text-zinc-400 text-xs font-semibold uppercase tracking-wide mb-3">Last run per source</p>
      <div className="space-y-3">
        {SOURCES.map(s => {
          const st = allStats[s.id];
          return (
            <div key={s.id} className={`bg-white/[0.03] border border-white/[0.07] rounded-xl px-5 py-4 ${!st ? "opacity-40" : ""}`}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-white text-sm font-medium">{s.label}</p>
                <p className="text-zinc-600 text-xs">
                  {st ? timeAgo(st.lastRun) : "never run"}
                </p>
              </div>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: "Analyzed",   value: st?.analyzed          ?? "—" },
                  { label: "Queued",     value: st?.queued            ?? "—" },
                  { label: "Duplicates", value: st?.duplicatesFlagged ?? "—" },
                  { label: "Rejected",   value: st?.rejectedPrivate   ?? "—" },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="text-zinc-500 text-[10px] uppercase tracking-wide">{label}</p>
                    <p className="text-white text-lg font-semibold mt-0.5">{String(value)}</p>
                  </div>
                ))}
              </div>
              {st && (
                <div className="mt-3 flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${st.geminiEnabled ? "bg-emerald-400" : "bg-zinc-600"}`} />
                  <p className="text-zinc-600 text-[10px]">
                    Gemini {st.geminiEnabled ? "active" : "not configured"}
                    {" · "}{st.skipped} skipped (already processed)
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
