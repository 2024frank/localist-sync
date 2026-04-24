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
  id: string; localistId?: string; source: string; source_id?: string;
  status: string; detectedAt: string; original: Original;
  writerPayload: WriterPayload;
  publicCheck: { isPublic: boolean; confidence: number; reason: string };
}

const SOURCE_LABEL: Record<string, string> = {
  localist:       "Oberlin Localist",
  amam:           "Allen Memorial Art Museum",
  heritage_center: "Oberlin Heritage Center",
};

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

type PushResult =
  | { state: "success"; chId?: string | number }
  | { state: "error"; message: string; raw?: string };

type SaveState = "idle" | "saving" | "saved" | "error";

export default function ReviewPage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Edits>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pushing, setPushing] = useState<Set<string>>(new Set());
  const [pushResults, setPushResults] = useState<Record<string, PushResult>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  // Persists across save() — tracks whether the user ever edited this item
  const [everEdited, setEverEdited] = useState<Set<string>>(new Set());
  const [everEditedFields, setEverEditedFields] = useState<Record<string, Set<string>>>({});

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

  // Save edits to Firestore — merges pending edits into writerPayload and
  // persists. Clears local edits so the form now shows the saved values.
  async function save(item: QueueItem) {
    setSaveStates(prev => ({ ...prev, [item.id]: "saving" }));
    try {
      const merged = getPayload(item); // edits merged over base
      await updateDoc(doc(db, "review_queue", item.id), { writerPayload: merged });
      // Clear local edits — Firestore snapshot will push back the saved values
      setEdits(prev => { const s = { ...prev }; delete s[item.id]; return s; });
      setSaveStates(prev => ({ ...prev, [item.id]: "saved" }));
      // Auto-reset "saved" badge after 3 s
      setTimeout(() => setSaveStates(prev => ({ ...prev, [item.id]: "idle" })), 3000);
    } catch {
      setSaveStates(prev => ({ ...prev, [item.id]: "error" }));
    }
  }

  async function approve(item: QueueItem) {
    if (pushing.has(item.id)) return;
    setPushing(prev => new Set(prev).add(item.id));
    // Clear any previous result for this item
    setPushResults(prev => { const s = { ...prev }; delete s[item.id]; return s; });

    try {
      const payload = getPayload(item);
      const res = await fetch("/api/push-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      });

      // Always read body — even on error we want the full CommunityHub response
      let data: Record<string, unknown> = {};
      const rawText = await res.text();
      try { data = JSON.parse(rawText); } catch { /* keep empty */ }

      if (!res.ok) {
        // Dig out the most useful error string from the response
        const message =
          (data.error as string) ||
          (data.message as string) ||
          rawText.slice(0, 300) ||
          `HTTP ${res.status}`;
        setPushResults(prev => ({
          ...prev,
          [item.id]: { state: "error", message, raw: rawText.slice(0, 1000) },
        }));
        return;
      }

      // Success — mark as approved (keep in Firestore for stats/analysis)
      const chId = (data as Record<string, unknown>).id ?? (data as Record<string, unknown>).postId;
      const writerEdited = everEdited.has(item.id);
      const writerEditedFields = [...(everEditedFields[item.id] || [])];
      await updateDoc(doc(db, "review_queue", item.id), {
        status: "approved",
        approvedAt: new Date().toISOString(),
        chPostId: chId ?? null,
        writerEdited,
        writerEditedFields,
      });
      setPushResults(prev => ({
        ...prev,
        [item.id]: { state: "success", chId: chId as string | number | undefined },
      }));
    } catch (err: unknown) {
      setPushResults(prev => ({
        ...prev,
        [item.id]: { state: "error", message: err instanceof Error ? err.message : String(err) },
      }));
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
    setEverEdited(prev => new Set(prev).add(id));
    setEverEditedFields(prev => {
      const fields = new Set(prev[id] || []);
      fields.add(field);
      return { ...prev, [id]: fields };
    });
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
            const isExpanded  = expanded === item.id;
            const isSelected  = selected.has(item.id);
            const isPushing   = pushing.has(item.id);
            const pushResult  = pushResults[item.id] ?? null;
            const saveState   = saveStates[item.id] ?? "idle";
            const e           = edits[item.id] || {};
            const wp          = item.writerPayload || {} as WriterPayload;
            const session     = wp.sessions?.[0];
            const hasUnsaved  = Object.keys(e).length > 0;

            // Helper: returns amber ring class if this field has a pending unsaved edit
            const changed = (field: string) =>
              e[field as keyof Edits] !== undefined
                ? "border-amber-400/60 focus:border-amber-400"
                : "border-white/[0.08] focus:border-emerald-500/50";

            const borderColor = pushResult?.state === "error"
              ? "border-red-500/40"
              : pushResult?.state === "success"
              ? "border-emerald-500/40"
              : isSelected
              ? "border-emerald-500/30"
              : "border-white/[0.07]";

            return (
              <div key={item.id} className={`bg-white/[0.03] border rounded-xl overflow-hidden transition ${borderColor}`}>
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
                      <div className="flex items-center gap-2">
                        <p className="text-white text-sm font-medium">{item.original.title}</p>
                        {item.original.url && (
                          <a
                            href={item.original.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={e => e.stopPropagation()}
                            title="View original source event"
                            className="text-zinc-600 hover:text-zinc-300 transition shrink-0"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                          </a>
                        )}
                      </div>
                      <p className="text-zinc-500 text-xs mt-0.5">
                        {session ? fmt(session.startTime) : "—"}
                        {item.original.location ? ` · ${item.original.location}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-zinc-500 text-[10px] border border-white/[0.08] rounded-full px-2 py-0.5">
                        {SOURCE_LABEL[item.source_id || item.source] ?? item.source ?? "—"}
                      </span>
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

                {/* ── Push result banner ── */}
                {pushResult && (
                  <div className={`px-5 py-3 border-t flex items-start gap-3 ${
                    pushResult.state === "success"
                      ? "border-emerald-500/20 bg-emerald-500/[0.06]"
                      : "border-red-500/20 bg-red-500/[0.06]"
                  }`}>
                    {pushResult.state === "success" ? (
                      <>
                        <span className="text-emerald-400 text-sm mt-0.5">✓</span>
                        <div>
                          <p className="text-emerald-400 text-xs font-medium">
                            Pushed to CommunityHub — awaiting their moderation
                            {pushResult.chId ? ` · ID ${pushResult.chId}` : ""}
                          </p>
                          <p className="text-emerald-600 text-[10px] mt-0.5">
                            Events appear publicly once a CommunityHub admin approves them.
                          </p>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="text-red-400 text-sm mt-0.5 shrink-0">✗</span>
                        <div className="min-w-0">
                          <p className="text-red-400 text-xs font-medium">Push failed</p>
                          <p className="text-red-300 text-xs mt-1 break-words">{pushResult.message}</p>
                          {pushResult.raw && pushResult.raw !== pushResult.message && (
                            <details className="mt-2">
                              <summary className="text-zinc-500 text-[10px] cursor-pointer hover:text-zinc-400">
                                Full response ▸
                              </summary>
                              <pre className="text-zinc-500 text-[10px] mt-1 whitespace-pre-wrap break-all font-mono bg-black/20 rounded p-2">
                                {pushResult.raw}
                              </pre>
                            </details>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Expanded: original vs writer side-by-side */}
                {isExpanded && (
                  <div className="border-t border-white/[0.06]">

                    {/* ── Unsaved-changes bar ─────────────────────────────── */}
                    {(hasUnsaved || saveState !== "idle") && (
                      <div className={`flex items-center justify-between gap-4 px-5 py-2.5 border-b ${
                        saveState === "saved"
                          ? "border-emerald-500/20 bg-emerald-500/[0.05]"
                          : saveState === "error"
                          ? "border-red-500/20 bg-red-500/[0.05]"
                          : "border-amber-400/20 bg-amber-400/[0.04]"
                      }`}>
                        <p className={`text-xs font-medium ${
                          saveState === "saved"   ? "text-emerald-400" :
                          saveState === "error"   ? "text-red-400"     :
                          saveState === "saving"  ? "text-zinc-400"    :
                                                    "text-amber-400"
                        }`}>
                          {saveState === "saved"  && "✓ Changes saved — Approve will use this version"}
                          {saveState === "error"  && "✗ Save failed — try again"}
                          {saveState === "saving" && "Saving…"}
                          {saveState === "idle" && hasUnsaved && `${Object.keys(e).length} unsaved change${Object.keys(e).length > 1 ? "s" : ""} — save before approving`}
                        </p>
                        {(hasUnsaved || saveState === "error") && (
                          <button
                            onClick={() => save(item)}
                            disabled={saveState === "saving"}
                            className="text-xs font-semibold text-white bg-amber-500 hover:bg-amber-400 disabled:opacity-50 px-3 py-1 rounded-lg transition shrink-0"
                          >
                            {saveState === "saving" ? "Saving…" : "Save changes"}
                          </button>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-2 divide-x divide-white/[0.06]">
                    {/* Original */}
                    <div className="px-5 py-5 space-y-4">
                      <p className="text-zinc-500 text-xs font-semibold uppercase tracking-wide">
                        Original ({SOURCE_LABEL[item.source_id || item.source] ?? item.source ?? "Source"})
                      </p>

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
                          View on {SOURCE_LABEL[item.source_id || item.source] ?? "source"} ↗
                        </a>
                      )}
                    </div>

                    {/* Writer's version — editable, amber border = unsaved */}
                    <div className="px-5 py-5 space-y-4">
                      <p className="text-zinc-400 text-xs font-semibold uppercase tracking-wide">
                        Writer&apos;s Version
                        <span className="text-zinc-600 normal-case font-normal"> (editable — </span>
                        <span className="text-amber-400 normal-case font-normal">amber = unsaved</span>
                        <span className="text-zinc-600 normal-case font-normal">)</span>
                      </p>

                      {item.original.photoUrl && (
                        <img
                          src={item.original.photoUrl}
                          alt={item.original.title}
                          className="w-full h-36 object-cover rounded-lg opacity-60"
                        />
                      )}

                      <EditField
                        label="Title" value={e.title ?? wp.title}
                        onChange={v => setEdit(item.id, "title", v)} maxLen={60}
                        borderClass={changed("title")}
                      />

                      <div>
                        <label className="text-zinc-500 text-[10px] uppercase tracking-wide block mb-1">Start Time</label>
                        <input
                          type="datetime-local"
                          value={e.startTime ?? (session ? toLocal(session.startTime) : "")}
                          onChange={ev => setEdit(item.id, "startTime", ev.target.value)}
                          className={`w-full bg-white/[0.04] border rounded-lg px-3 py-2 text-white text-xs focus:outline-none transition ${changed("startTime")}`}
                        />
                      </div>
                      <div>
                        <label className="text-zinc-500 text-[10px] uppercase tracking-wide block mb-1">End Time</label>
                        <input
                          type="datetime-local"
                          value={e.endTime ?? (session ? toLocal(session.endTime) : "")}
                          onChange={ev => setEdit(item.id, "endTime", ev.target.value)}
                          className={`w-full bg-white/[0.04] border rounded-lg px-3 py-2 text-white text-xs focus:outline-none transition ${changed("endTime")}`}
                        />
                      </div>

                      {(wp.locationType === "ph2" || wp.locationType === "bo") && (
                        <EditField label="Location" value={e.location ?? wp.location ?? ""}
                          onChange={v => setEdit(item.id, "location", v)} borderClass={changed("location")} />
                      )}
                      {(wp.locationType === "on" || wp.locationType === "bo") && (
                        <EditField label="Stream URL" value={e.urlLink ?? wp.urlLink ?? ""}
                          onChange={v => setEdit(item.id, "urlLink", v)} borderClass={changed("urlLink")} />
                      )}

                      <EditArea
                        label={`Short Description (${(e.description ?? wp.description ?? "").length}/200)`}
                        value={e.description ?? wp.description ?? ""}
                        onChange={v => setEdit(item.id, "description", v)} rows={3}
                        borderClass={changed("description")}
                      />
                      <EditArea
                        label={`Extended Description (${(e.extendedDescription ?? wp.extendedDescription ?? "").length}/1000)`}
                        value={e.extendedDescription ?? wp.extendedDescription ?? ""}
                        onChange={v => setEdit(item.id, "extendedDescription", v)} rows={5}
                        borderClass={changed("extendedDescription")}
                      />

                      <EditField
                        label="Sponsors (comma-separated)"
                        value={e.sponsors ? (e.sponsors as string[]).join(", ") : (wp.sponsors || []).join(", ")}
                        onChange={v => setEdit(item.id, "sponsors", v.split(",").map((s: string) => s.trim()).filter(Boolean))}
                        borderClass={changed("sponsors")}
                      />
                      <EditField label="Contact Email" value={e.contactEmail ?? wp.contactEmail ?? ""}
                        onChange={v => setEdit(item.id, "contactEmail", v)} borderClass={changed("contactEmail")} />
                      <EditField label="Phone" value={e.phone ?? wp.phone ?? ""}
                        onChange={v => setEdit(item.id, "phone", v)} borderClass={changed("phone")} />
                      <EditField label="Website" value={e.website ?? wp.website ?? ""}
                        onChange={v => setEdit(item.id, "website", v)} borderClass={changed("website")} />
                    </div>
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

function EditField({ label, value, onChange, maxLen, borderClass }: {
  label: string; value: string; onChange: (v: string) => void;
  maxLen?: number; borderClass?: string;
}) {
  return (
    <div>
      <label className="text-zinc-500 text-[10px] uppercase tracking-wide block mb-1">{label}</label>
      <input
        type="text"
        value={value}
        maxLength={maxLen}
        onChange={e => onChange(e.target.value)}
        className={`w-full bg-white/[0.04] border rounded-lg px-3 py-2 text-white text-xs focus:outline-none transition ${borderClass ?? "border-white/[0.08] focus:border-emerald-500/50"}`}
      />
    </div>
  );
}

function EditArea({ label, value, onChange, rows, borderClass }: {
  label: string; value: string; onChange: (v: string) => void;
  rows: number; borderClass?: string;
}) {
  return (
    <div>
      <label className="text-zinc-500 text-[10px] uppercase tracking-wide block mb-1">{label}</label>
      <textarea
        value={value}
        rows={rows}
        onChange={e => onChange(e.target.value)}
        className={`w-full bg-white/[0.04] border rounded-lg px-3 py-2 text-white text-xs focus:outline-none resize-y transition ${borderClass ?? "border-white/[0.08] focus:border-emerald-500/50"}`}
      />
    </div>
  );
}
