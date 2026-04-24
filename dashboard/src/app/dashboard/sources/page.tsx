"use client";

import { useEffect, useState, useCallback } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/context/AuthContext";

interface SyncStats {
  queued: number;
  skipped: number;
  analyzed: number;
  duplicatesFlagged: number;
  rejectedPrivate: number;
  total: number;
  lastRun: string;
  geminiEnabled: boolean;
}

interface RunStatus {
  run_id?: number;
  status: "queued" | "in_progress" | "completed" | "unknown" | "never_run";
  conclusion?: "success" | "failure" | "cancelled" | null;
  startedAt?: string;
  updatedAt?: string;
  url?: string;
}

const SOURCES = [
  {
    id: "localist",
    name: "Oberlin Localist",
    url: "calendar.oberlin.edu",
    workflow: "sync.yml",
    firestoreDoc: "localist",
    description: "Oberlin College's official event calendar",
  },
  {
    id: "amam",
    name: "Allen Memorial Art Museum",
    url: "amam.oberlin.edu",
    workflow: "sync-amam.yml",
    firestoreDoc: "amam",
    description: "AMAM public exhibitions and events",
  },
  {
    id: "heritage_center",
    name: "Oberlin Heritage Center",
    url: "oberlinheritagecenter.org",
    workflow: "sync-heritage-center.yml",
    firestoreDoc: "heritage_center",
    description: "Heritage Center tours, workshops, and community events",
  },
];

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function StatusDot({ run }: { run: RunStatus | null }) {
  if (!run || run.status === "unknown" || run.status === "never_run") {
    return <span className="w-2 h-2 rounded-full bg-zinc-600 shrink-0" />;
  }
  if (run.status === "in_progress" || run.status === "queued") {
    return <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />;
  }
  if (run.conclusion === "success") {
    return <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />;
  }
  return <span className="w-2 h-2 rounded-full bg-red-400 shrink-0" />;
}

export default function SourcesPage() {
  const { user, isAdmin } = useAuth();
  const [stats, setStats] = useState<Record<string, SyncStats | null>>({});
  const [runs, setRuns] = useState<Record<string, RunStatus | null>>({});
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [actionMsg, setActionMsg] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearMsg, setClearMsg] = useState("");

  // Live Firestore stats
  useEffect(() => {
    const unsubs = SOURCES.map(s =>
      onSnapshot(doc(db, "syncs", s.firestoreDoc), snap => {
        setStats(prev => ({ ...prev, [s.id]: snap.exists() ? (snap.data() as SyncStats) : null }));
      })
    );
    return () => unsubs.forEach(u => u());
  }, []);

  // Poll GitHub run status every 10s while any run is active, 30s otherwise
  const fetchRuns = useCallback(async () => {
    for (const s of SOURCES) {
      try {
        const res = await fetch(`/api/sync/trigger?workflow=${s.workflow}`);
        const data: RunStatus = await res.json();
        setRuns(prev => ({ ...prev, [s.id]: data }));
      } catch { /* ignore */ }
    }
  }, []);

  useEffect(() => {
    fetchRuns();
    const anyRunning = Object.values(runs).some(
      r => r?.status === "in_progress" || r?.status === "queued"
    );
    const interval = setInterval(fetchRuns, anyRunning ? 10000 : 30000);
    return () => clearInterval(interval);
  }, [fetchRuns, runs]);

  // Start a workflow run
  async function handleStart(source: typeof SOURCES[0]) {
    if (!user) return;
    setActionLoading(prev => ({ ...prev, [source.id]: true }));
    setActionMsg(prev => ({ ...prev, [source.id]: "" }));
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/sync/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: source.workflow, idToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionMsg(prev => ({ ...prev, [source.id]: data.error || "Failed to start" }));
      } else {
        setActionMsg(prev => ({ ...prev, [source.id]: "Started — fetching status…" }));
        // Poll aggressively right after dispatch so the button flips quickly
        setTimeout(fetchRuns, 3000);
        setTimeout(fetchRuns, 7000);
      }
    } catch {
      setActionMsg(prev => ({ ...prev, [source.id]: "Something went wrong" }));
    } finally {
      setActionLoading(prev => ({ ...prev, [source.id]: false }));
    }
  }

  // Cancel a running workflow run
  async function handleStop(source: typeof SOURCES[0]) {
    if (!user) return;
    const run = runs[source.id];
    if (!run?.run_id) return;

    setActionLoading(prev => ({ ...prev, [source.id]: true }));
    setActionMsg(prev => ({ ...prev, [source.id]: "" }));
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/sync/trigger", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: run.run_id, idToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionMsg(prev => ({ ...prev, [source.id]: data.error || "Failed to stop" }));
      } else {
        setActionMsg(prev => ({ ...prev, [source.id]: "Cancelling…" }));
        setTimeout(fetchRuns, 5000);
      }
    } catch {
      setActionMsg(prev => ({ ...prev, [source.id]: "Something went wrong" }));
    } finally {
      setActionLoading(prev => ({ ...prev, [source.id]: false }));
    }
  }

  // Clear all Firestore event data
  async function handleClear() {
    if (!user) return;
    if (!confirm("Delete ALL review queue, rejected, duplicate, and sync data? This cannot be undone.")) return;
    setClearing(true);
    setClearMsg("");
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/clear-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setClearMsg(data.error || "Failed to clear data");
      } else {
        const total = Object.values(data.deleted as Record<string, number>).reduce((a, b) => a + b, 0);
        setClearMsg(`Cleared ${total} documents`);
      }
    } catch {
      setClearMsg("Something went wrong");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="p-8 max-w-4xl">
      {/* Page header */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-white text-2xl font-bold tracking-tight">Sources</h1>
          <p className="text-zinc-500 text-sm mt-1">
            Calendar sources feeding into the review pipeline.
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-3">
            {clearMsg && <p className="text-zinc-400 text-xs">{clearMsg}</p>}
            <button
              onClick={handleClear}
              disabled={clearing}
              className="text-xs font-medium text-zinc-500 hover:text-red-400 border border-white/[0.07] hover:border-red-400/30 px-3 py-2 rounded-lg transition disabled:opacity-40"
            >
              {clearing ? "Clearing…" : "Clear all data"}
            </button>
          </div>
        )}
      </div>

      {/* Source cards */}
      <div className="space-y-3">
        {SOURCES.map(source => {
          const stat = stats[source.id];
          const run = runs[source.id];
          const loading = actionLoading[source.id];
          const msg = actionMsg[source.id];
          const isExpanded = expanded === source.id;
          const isRunning = run?.status === "in_progress" || run?.status === "queued";

          return (
            <div key={source.id} className="bg-white/[0.03] border border-white/[0.07] rounded-xl overflow-hidden">

              {/* ── Main row ── */}
              <div className="px-5 py-4 flex items-center gap-4">

                {/* Status dot + name */}
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <StatusDot run={run} />
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium">{source.name}</p>
                    <p className="text-zinc-600 text-xs truncate">{source.url}</p>
                  </div>
                </div>

                {/* Stats strip */}
                <div className="hidden sm:flex items-center gap-6">
                  <div className="text-center">
                    <p className="text-zinc-500 text-[10px] uppercase tracking-wide">Queued</p>
                    <p className="text-emerald-400 text-sm font-semibold mt-0.5">{stat?.queued ?? "—"}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-zinc-500 text-[10px] uppercase tracking-wide">Skipped</p>
                    <p className="text-zinc-300 text-sm font-semibold mt-0.5">{stat?.skipped ?? "—"}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-zinc-500 text-[10px] uppercase tracking-wide">Last run</p>
                    <p className="text-zinc-300 text-sm font-semibold mt-0.5">
                      {stat?.lastRun ? timeAgo(stat.lastRun) : run?.updatedAt ? timeAgo(run.updatedAt) : "—"}
                    </p>
                  </div>
                  <div className="text-center min-w-[56px]">
                    <p className="text-zinc-500 text-[10px] uppercase tracking-wide">Status</p>
                    <p className="text-sm font-semibold mt-0.5">
                      {!run || run.status === "unknown" || run.status === "never_run"
                        ? <span className="text-zinc-600">—</span>
                        : isRunning
                        ? <span className="text-amber-400">Running</span>
                        : run.conclusion === "success"
                        ? <span className="text-emerald-400">Done</span>
                        : run.conclusion === "cancelled"
                        ? <span className="text-zinc-400">Stopped</span>
                        : run.conclusion === "failure"
                        ? <span className="text-red-400">Failed</span>
                        : <span className="text-zinc-400 capitalize">{run.conclusion ?? run.status}</span>
                      }
                    </p>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2 shrink-0">
                  {isAdmin && (
                    isRunning ? (
                      <button
                        onClick={() => handleStop(source)}
                        disabled={loading}
                        className="flex items-center gap-1.5 text-xs font-medium text-red-400 border border-red-400/30 hover:bg-red-400/10 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg transition"
                      >
                        {/* Stop icon */}
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="4" y="4" width="16" height="16" rx="2" />
                        </svg>
                        {loading ? "Stopping…" : "Stop"}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleStart(source)}
                        disabled={loading}
                        className="flex items-center gap-1.5 text-xs font-medium text-white bg-[#C8102E]/80 hover:bg-[#C8102E] disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg transition"
                      >
                        {/* Play icon */}
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M5 3l14 9-14 9V3z" />
                        </svg>
                        {loading ? "Starting…" : "Start"}
                      </button>
                    )
                  )}

                  {/* Expand toggle */}
                  <button
                    onClick={() => setExpanded(isExpanded ? null : source.id)}
                    className="text-zinc-600 hover:text-zinc-400 transition p-1"
                  >
                    <svg
                      className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Inline feedback message */}
              {msg && (
                <div className="px-5 pb-3">
                  <p className="text-zinc-400 text-xs">{msg}</p>
                </div>
              )}

              {/* ── Expanded details ── */}
              {isExpanded && (
                <div className="border-t border-white/[0.06] px-5 py-5">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                    <div className="bg-white/[0.03] rounded-lg p-3.5">
                      <p className="text-zinc-500 text-[10px] uppercase tracking-wide mb-1">Analyzed</p>
                      <p className="text-white text-sm font-semibold">{stat?.analyzed ?? "—"}</p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3.5">
                      <p className="text-zinc-500 text-[10px] uppercase tracking-wide mb-1">Duplicates flagged</p>
                      <p className="text-white text-sm font-semibold">{stat?.duplicatesFlagged ?? "—"}</p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3.5">
                      <p className="text-zinc-500 text-[10px] uppercase tracking-wide mb-1">Rejected (private)</p>
                      <p className="text-white text-sm font-semibold">{stat?.rejectedPrivate ?? "—"}</p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3.5">
                      <p className="text-zinc-500 text-[10px] uppercase tracking-wide mb-1">Workflow file</p>
                      <p className="text-zinc-300 text-sm font-mono">{source.workflow}</p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3.5">
                      <p className="text-zinc-500 text-[10px] uppercase tracking-wide mb-1">Gemini</p>
                      <p className="text-sm font-semibold">
                        {stat
                          ? stat.geminiEnabled
                            ? <span className="text-emerald-400">Active</span>
                            : <span className="text-amber-400">Not configured</span>
                          : <span className="text-zinc-600">—</span>
                        }
                      </p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3.5">
                      <p className="text-zinc-500 text-[10px] uppercase tracking-wide mb-1">Run ID</p>
                      <p className="text-zinc-300 text-sm">{run?.run_id ?? "—"}</p>
                    </div>
                  </div>

                  {run?.url && (
                    <a
                      href={run.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-zinc-500 hover:text-white transition underline"
                    >
                      View run on GitHub →
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
