'use client';
import { useEffect, useState } from 'react';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { ChevronDown, ChevronRight, CheckCircle, XCircle, Wrench, Clock } from 'lucide-react';

const ACTION_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  approved:           { label: 'Approved',     color: '#2a6b2e', bg: '#e8f5e9' },
  rejected:           { label: 'Rejected',     color: '#c0392b', bg: '#fdecea' },
  sent_for_correction:{ label: 'Sent for fix', color: '#7a4f00', bg: '#fff3e0' },
};

function fmt(sec: number | null) {
  if (!sec) return '—';
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function fmtDate(dt: string) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default function ReviewersPage() {
  const { user, token, ready } = useAuth('admin');
  const [reviewers, setReviewers] = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [expanded, setExpanded]   = useState<number | null>(null);
  const [history, setHistory]     = useState<Record<number, any[]>>({});
  const [loadingHistory, setLoadingHistory] = useState<number | null>(null);

  useEffect(() => {
    if (!ready || !token) return;
    fetch('/api/admin/reviewers', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setReviewers(d.reviewers || []))
      .finally(() => setLoading(false));
  }, [ready, token]);

  async function toggleReviewer(id: number) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (history[id]) return;
    setLoadingHistory(id);
    const res = await fetch(`/api/admin/reviewers?reviewer_id=${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    setHistory(h => ({ ...h, [id]: data.history || [] }));
    setLoadingHistory(null);
  }

  if (!ready || !user) return null;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role="admin" name={user.name} email={user.email} token={token} />
      <main style={{ flex: 1, padding: '2rem', overflowY: 'auto' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: '1.5rem' }}>Reviewer History</h1>

        {loading ? (
          <p style={{ color: '#888', fontSize: 14 }}>Loading...</p>
        ) : reviewers.length === 0 ? (
          <p style={{ color: '#888', fontSize: 14 }}>No reviewers found.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {reviewers.map(r => {
              const isOpen = expanded === r.id;
              const hist   = history[r.id] || [];
              const total  = Number(r.total_reviewed) || 0;

              return (
                <div key={r.id} style={{ background: 'white', borderRadius: 10, border: '1px solid #e8e8e8', overflow: 'hidden' }}>
                  {/* Reviewer header row */}
                  <button
                    onClick={() => toggleReviewer(r.id)}
                    style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}
                  >
                    <span style={{ color: '#aaa' }}>
                      {isOpen ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}
                    </span>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{r.full_name}</div>
                      <div style={{ fontSize: 12, color: '#888' }}>{r.email}</div>
                    </div>

                    <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexShrink: 0 }}>
                      <Stat label="Total" val={total} color="#333"/>
                      <Stat label="Approved"  val={Number(r.approved) || 0}  color="#2a6b2e"/>
                      <Stat label="Rejected"  val={Number(r.rejected) || 0}  color="#c0392b"/>
                      <Stat label="Sent fix"  val={Number(r.sent_for_correction) || 0} color="#e67e22"/>
                      <div style={{ textAlign: 'right', minWidth: 110 }}>
                        <div style={{ fontSize: 11, color: '#aaa' }}>Last active</div>
                        <div style={{ fontSize: 12, color: '#555' }}>
                          {r.last_action ? new Date(r.last_action).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never'}
                        </div>
                      </div>
                    </div>
                  </button>

                  {/* History list */}
                  {isOpen && (
                    <div style={{ borderTop: '1px solid #f0f0f0' }}>
                      {loadingHistory === r.id ? (
                        <p style={{ padding: '1rem 1.5rem', fontSize: 13, color: '#aaa' }}>Loading history…</p>
                      ) : hist.length === 0 ? (
                        <p style={{ padding: '1rem 1.5rem', fontSize: 13, color: '#aaa' }}>No actions recorded yet.</p>
                      ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <thead>
                            <tr style={{ background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}>
                              <th style={{ padding: '0.5rem 1.25rem', textAlign: 'left', fontWeight: 600, color: '#555', width: '40%' }}>Event</th>
                              <th style={{ padding: '0.5rem 1rem', textAlign: 'left', fontWeight: 600, color: '#555' }}>Source</th>
                              <th style={{ padding: '0.5rem 1rem', textAlign: 'left', fontWeight: 600, color: '#555' }}>Action</th>
                              <th style={{ padding: '0.5rem 1rem', textAlign: 'left', fontWeight: 600, color: '#555' }}>Time spent</th>
                              <th style={{ padding: '0.5rem 1.25rem', textAlign: 'left', fontWeight: 600, color: '#555' }}>Date</th>
                            </tr>
                          </thead>
                          <tbody>
                            {hist.map((h: any) => {
                              const style = ACTION_STYLES[h.action] ?? { label: h.action, color: '#555', bg: '#f5f5f5' };
                              return (
                                <tr key={h.id} style={{ borderBottom: '1px solid #f8f8f8' }}>
                                  <td style={{ padding: '0.6rem 1.25rem', maxWidth: 280 }}>
                                    <a href={`/events/${h.event_id}`} target="_blank" rel="noreferrer"
                                       style={{ color: '#1a1a1a', textDecoration: 'none', fontWeight: 500 }}
                                       title={h.event_title}>
                                      {(h.event_title || 'Untitled').length > 60
                                        ? (h.event_title || 'Untitled').slice(0, 60) + '…'
                                        : (h.event_title || 'Untitled')}
                                    </a>
                                  </td>
                                  <td style={{ padding: '0.6rem 1rem', color: '#666' }}>{h.source_name || '—'}</td>
                                  <td style={{ padding: '0.6rem 1rem' }}>
                                    <span style={{ background: style.bg, color: style.color, borderRadius: 20, padding: '2px 10px', fontWeight: 600, fontSize: 11 }}>
                                      {style.label}
                                    </span>
                                  </td>
                                  <td style={{ padding: '0.6rem 1rem', color: '#666', display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <Clock size={11} color="#aaa"/>
                                    {fmt(h.time_spent_sec)}
                                  </td>
                                  <td style={{ padding: '0.6rem 1.25rem', color: '#888', whiteSpace: 'nowrap' }}>
                                    {fmtDate(h.created_at)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({ label, val, color }: { label: string; val: number; color: string }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 50 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{val}</div>
      <div style={{ fontSize: 11, color: '#aaa' }}>{label}</div>
    </div>
  );
}
