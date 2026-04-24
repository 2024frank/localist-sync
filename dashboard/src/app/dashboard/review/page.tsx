"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

interface Original {
  title: string; date: string; endDate: string; location: string;
  description: string; sponsors: string[]; url: string;
  photoUrl: string | null; experience: string;
}
interface WriterPayload {
  title: string; description: string; extendedDescription: string;
  location?: string; urlLink?: string; sponsors: string[];
  contactEmail: string; phone: string; website?: string;
  sessions: { startTime: number; endTime: number }[];
  locationType: string; _photoUrl?: string | null;
  [key: string]: unknown;
}
interface QueueItem {
  id: string; localistId: string; source: string; status: string;
  detectedAt: string; original: Original; writerPayload: WriterPayload;
  publicCheck: { isPublic: boolean; confidence: number; reason: string };
}

function fmt(ts: number) {
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}
function toLocal(ts: number) {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocal(s: string) { return Math.floor(new Date(s).getTime() / 1000); }

type Edits = Partial<WriterPayload & { startTime: string; endTime: string }>;

export default function ReviewPage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Edits>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pushing, setPushing] = useState<Set<string>>(new Set());

  useEffect(() => {
    const q = query(collection(db, "review_queue"), where("status", "==", "pending"));
    const unsub = onSnapshot(q, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() } as QueueItem));
      docs.sort((a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime());
      setItems(docs);
      setLoading(false);
    });
    return unsub;
  }, []);

  function getPayload(item: QueueItem): WriterPayload {
    const e = edits[item.id] || {};
    const base = { ...(item.writerPayload || {}) } as WriterPayload;
    if (e.title !== undefined) base.title = e.title as string;
    if (e.description !== undefined) base.description = e.description as string;
    if (e.extendedDescription !== undefined) base.extendedDescription = e.extendedDescription as string;
    if (e.location !== undefined) base.location = e.location as string;
    if (e.urlLink !== undefined) base.urlLink = e.urlLink as string;
    if (e.sponsors !== undefined) base.sponsors = e.sponsors as string[];
    if (e.contactEmail !== undefined) base.contactEmail = e.contactEmail as string;
    if (e.phone !== undefined) base.phone = e.phone as string;
    if (e.website !== undefined) base.website = e.website as string;
    if (e.startTime !== undefined || e.endTime !== undefined) {
      const start = e.startTime ? fromLocal(e.startTime) : base.sessions[0].startTime;
      const end = e.endTime ? fromLocal(e.endTime) : base.sessions[0].endTime;
      base.sessions = [{ startTime: start, endTime: end }];
    }
    return base;
  }

  async function approve(item: QueueItem) {
    if (pushing.has(item.id)) return;
    setPushing(prev => new Set(prev).add(item.id));
    try {
      const payload = getPayload(item);
      const res = await fetch("/api/push-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(`Failed: ${data.error}`);
        return;
      }
      await updateDoc(doc(db, "review_queue", item.id), { status: "approved", approvedAt: new Date().toISOString() });
    } catch (err: unknown) {
      alert(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPushing(prev => { const s = new Set(prev); s.delete(item.id); return s; });
    }
  }

  async function reject(item: QueueItem) {
    await updateDoc(doc(db, "review_queue", item.id), { status: "rejected_manual", rejectedAt: new Date().toISOString() });
  }

  async function approveSelected() {
    for (const id of selected) {
      const item = items.find(i => i.id === id);
      if (item) await approve(item);
    }
    setSelected(new Set());
  }

  function setEdit(id: string, field: string, value: unknown) {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }

  if (loading) return <div className="p-8"><p className="text-zinc-500 text-sm">Loading…</p></div>;

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-white text-2xl font-bold tracking-tight">Review Queue</h1>
          <p className="text-zinc-500 text-sm mt-1">
            Events cleaned by the Writer Agent. Review, edit if needed, then approve to push to CommunityHub.
          </p>
        </div>
        {selected.size > 0 && (
          <button
            onClick={approveSelected}
            className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-semibold px-4 py-2 rounded-lg transition"
          >
            Approve {selected.size} selected
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="bg-white/[0.03] border border-white/[0.07] rounded-xl flex flex-col items-center justify-center py-20 text-center">
          <p className="text-white font-medium mb-2">Queue is empty</p>
          <p className="text-zinc-500 text-sm max-w-sm">New events will appear here after the hourly sync runs and passes them through the AI pipeline.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(item => {
            const isExpanded = expanded === item.id;
            const isSelected = selected.has(item.id);
            const isPushing = pushing.has(item.id);
            const e = edits[item.id] || {};
            const wp = item.writerPayload || {} as WriterPayload;
            const session = wp.sessions?.[0];

            return (
              <div key={item.id} className={`bg-white/[0.03] border rounded-xl overflow-hidden transition ${isSelected ? "border-emerald-500/40" : "border-white/[0.07]"}`}>
                {/* Row header */}
                <div className="flex items-center gap-3 px-5 py-4">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(item.id)}
                    className="w-4 h-4 accent-emerald-500 shrink-0"
                  />
                  <button
                    onClick={() => setExpanded(isExpanded ? null : item.id)}
                    className="flex-1 flex items-start gap-4 text-left"
                  >
                    <div className="flex-1">
                      <p className="text-white text-sm font-medium">{item.original.title}</p>
                      <p className="text-zinc-500 text-xs mt-0.5">
                        {session ? fmt(session.startTime) : "—"}
                        {item.original.location ? ` · ${item.original.location}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {item.publicCheck && (
                        <span className="text-emerald-400 text-xs border border-emerald-400/30 rounded-full px-2 py-0.5">
                          Public {item.publicCheck.confidence}%
                        </span>
                      )}
                      <svg className={`w-4 h-4 text-zinc-600 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
                      </svg>
                    </div>
                  </button>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => reject(item)}
                      className="text-xs text-zinc-500 hover:text-white border border-white/[0.08] hover:border-white/20 px-3 py-1.5 rounded-lg transition"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => approve(item)}
                      disabled={isPushing}
                      className="text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-1.5 rounded-lg transition"
                    >
                      {isPushing ? "Pushing…" : "Approve →"}
                    </button>
                  </div>
                </div>

                {/* Expanded: original vs writer side-by-side */}
                {isExpanded && (
                  <div className="border-t border-white/[0.06] grid grid-cols-2 divide-x divide-white/[0.06]">
                    {/* Original */}
                    <div className="px-5 py-5 space-y-4">
                      <p className="text-zinc-500 text-xs font-semibold uppercase tracking-wide">Original (Localist)</p>

                      {item.original.photoUrl && (
                        <img
                          src={item.original.photoUrl}
                          alt={item.original.title}
                          className="w-full h-36 object-cover rounded-lg"
                        />
                      )}

                      <Field label="Title" value={item.original.title} />
                      <Field label="Date" value={session ? `${fmt(session.startTime)} → ${fmt(session.endTime)}` : "—"} />
                      <Field label="Location" value={item.original.location || "—"} />
                      <Field label="Sponsors" value={item.original.sponsors?.join(", ") || "—"} />
                      <Field label="Website" value={item.original.url || "—"} />
                      <div>
                        <p className="text-zinc-500 text-[10px] uppercase tracking-wide mb-1">Description (raw)</p>
                        <p className="text-zinc-400 text-xs leading-relaxed whitespace-pre-wrap break-words">{item.original.description || "—"}</p>
                      </div>
                      {item.original.url && (
                        <a href={item.original.url} target="_blank" rel="noreferrer" className="text-[#C8102E] text-xs hover:underline">
                          View on Localist ↗
                        </a>
                      )}
                    </div>

                    {/* Writer's version — editable */}
                    <div className="px-5 py-5 space-y-4">
                      <p className="text-zinc-400 text-xs font-semibold uppercase tracking-wide">Writer's Version <span className="text-zinc-600 normal-case font-normal">(editable)</span></p>

                      {item.original.photoUrl && (
                        <img
                          src={item.original.photoUrl}
                          alt={item.original.title}
                          className="w-full h-36 object-cover rounded-lg opacity-60"
                        />
                      )}

                      <EditField label="Title" value={e.title ?? wp.title} onChange={v => setEdit(item.id, "title", v)} maxLen={60} />

                      <div>
                        <label className="text-zinc-500 text-[10px] uppercase tracking-wide block mb-1">Start Time</label>
                        <input
                          type="datetime-local"
                          value={e.startTime ?? (session ? toLocal(session.startTime) : "")}
                          onChange={ev => setEdit(item.id, "startTime", ev.target.value)}
                          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500/50"
                        />
                      </div>
                      <div>
                        <label className="text-zinc-500 text-[10px] uppercase tracking-wide block mb-1">End Time</label>
                        <input
                          type="datetime-local"
                          value={e.endTime ?? (session ? toLocal(session.endTime) : "")}
                          onChange={ev => setEdit(item.id, "endTime", ev.target.value)}
                          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500/50"
                        />
                      </div>

                      {(wp.locationType === "ph2" || wp.locationType === "bo") && (
                        <EditField label="Location" value={e.location ?? wp.location ?? ""} onChange={v => setEdit(item.id, "location", v)} />
                      )}
                      {(wp.locationType === "on" || wp.locationType === "bo") && (
                        <EditField label="Stream URL" value={e.urlLink ?? wp.urlLink ?? ""} onChange={v => setEdit(item.id, "urlLink", v)} />
                      )}

                      <EditArea label={`Short Description (${(e.description ?? wp.description ?? "").length}/200)`} value={e.description ?? wp.description ?? ""} onChange={v => setEdit(item.id, "description", v)} rows={3} />
                      <EditArea label={`Extended Description (${(e.extendedDescription ?? wp.extendedDescription ?? "").length}/1000)`} value={e.extendedDescription ?? wp.extendedDescription ?? ""} onChange={v => setEdit(item.id, "extendedDescription", v)} rows={5} />

                      <EditField
                        label="Sponsors (comma-separated)"
                        value={e.sponsors ? (e.sponsors as string[]).join(", ") : (wp.sponsors || []).join(", ")}
                        onChange={v => setEdit(item.id, "sponsors", v.split(",").map((s: string) => s.trim()).filter(Boolean))}
                      />
                      <EditField label="Contact Email" value={e.contactEmail ?? wp.contactEmail ?? ""} onChange={v => setEdit(item.id, "contactEmail", v)} />
                      <EditField label="Phone" value={e.phone ?? wp.phone ?? ""} onChange={v => setEdit(item.id, "phone", v)} />
                      <EditField label="Website" value={e.website ?? wp.website ?? ""} onChange={v => setEdit(item.id, "website", v)} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-zinc-500 text-[10px] uppercase tracking-wide mb-1">{label}</p>
      <p className="text-zinc-300 text-xs">{value}</p>
    </div>
  );
}

function EditField({ label, value, onChange, maxLen }: { label: string; value: string; onChange: (v: string) => void; maxLen?: number }) {
  return (
    <div>
      <label className="text-zinc-500 text-[10px] uppercase tracking-wide block mb-1">{label}</label>
      <input
        type="text"
        value={value}
        maxLength={maxLen}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500/50"
      />
    </div>
  );
}

function EditArea({ label, value, onChange, rows }: { label: string; value: string; onChange: (v: string) => void; rows: number }) {
  return (
    <div>
      <label className="text-zinc-500 text-[10px] uppercase tracking-wide block mb-1">{label}</label>
      <textarea
        value={value}
        rows={rows}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-emerald-500/50 resize-y"
      />
    </div>
  );
}
