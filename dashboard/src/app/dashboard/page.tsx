"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";

interface SourceStats {
  pushed: number; skipped: number; failed: number; total: number; lastRun: string;
}

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function StatCard({ label, value, sub, highlight, dim }: { label: string; value: string; sub: string; highlight?: boolean; dim?: boolean }) {
  return (
    <div className={`bg-white/[0.03] border border-white/[0.07] rounded-xl p-5 ${dim ? "opacity-40" : ""}`}>
      <p className="text-zinc-500 text-xs font-medium uppercase tracking-wide mb-2">{label}</p>
      <p className={`text-3xl font-bold mb-1 ${highlight ? "text-emerald-400" : "text-white"}`}>{value}</p>
      <p className="text-zinc-600 text-xs">{sub}</p>
    </div>
  );
}

export default function OverviewPage() {
  const [localist, setLocalist] = useState<SourceStats | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "syncs", "localist"), (snap) => {
      if (snap.exists()) setLocalist(snap.data() as SourceStats);
    });
    return unsub;
  }, []);

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-white text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-zinc-500 text-sm mt-1">Oberlin Community Calendar Unification — AI Micro-Grant Research</p>
        </div>
        {localist && (
          <span className="inline-flex items-center gap-1.5 text-emerald-400 text-xs font-medium bg-emerald-400/10 border border-emerald-400/20 rounded-full px-3 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Events Submitted to CH Calendar"
          value={localist ? localist.total.toString() : "—"}
          sub={localist ? "across all runs" : "waiting for first run"}
        />
        <StatCard
          label="Active Sources"
          value="1"
          sub="Oberlin Localist"
        />
        <StatCard
          label="Last Run"
          value={localist ? timeAgo(localist.lastRun) : "—"}
          sub={localist ? new Date(localist.lastRun).toLocaleString() : "no sync run yet"}
          dim={!localist}
        />
        <StatCard
          label="Last Run Result"
          value={localist ? (localist.failed === 0 ? "Clean" : `${localist.failed} failed`) : "—"}
          sub={localist ? `${localist.pushed} pushed · ${localist.skipped} skipped` : "no sync run yet"}
          highlight={!!localist && localist.failed === 0}
          dim={!localist}
        />
      </div>
    </div>
  );
}
