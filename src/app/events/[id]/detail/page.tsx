'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import Sidebar from '@/components/layout/Sidebar';
import { ExternalLink, Edit2, Save, X, Check, ArrowLeft } from 'lucide-react';
import { formatSessionRange, getTimezoneLabel } from '@/lib/timezone';

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  pending:     { bg: '#fff3e0', color: '#c05e00', label: 'Pending review' },
  approved:    { bg: '#e8f5e9', color: '#2a6b2e', label: 'Published'      },
  rejected:    { bg: '#fdecea', color: '#c0392b', label: 'Rejected'       },
  resubmitted: { bg: '#e3f2fd', color: '#1565c0', label: 'Resubmitted'    },
};

const GEO_LABELS: Record<string, string> = {
  hyper_local: 'Hyper-local', city_wide: 'City-wide', county: 'County', regional: 'Regional',
};

const REASON_LABELS: Record<string, string> = {
  wrong_audience:           'Wrong audience (staff/students only)',
  bad_date_parse:           'Date or time extracted incorrectly',
  duplicate_missed:         'Duplicate — already in CommunityHub',
  description_hallucinated: 'Description has invented details',
  missing_fields:           'Required fields left empty',
  wrong_geo_scope:          'Geographic scope tagged incorrectly',
  not_public_event:         'Private or invitation-only',
  wrong_post_type:          'Post type category incorrect',
  bad_location:             'Location missing or wrong',
  field_correction:         'Fields were corrected',
  other:                    'Other',
};

export default function EventDetailPage() {
  const { id }  = useParams();
  const router  = useRouter();
  const { user, token, ready, getFreshToken } = useAuth();
  const [event, setEvent]         = useState<any>(null);
  const [rejection, setRejection] = useState<any>(null);
  const [edits, setEdits]         = useState<Record<string, any>>({});
  const [editing, setEditing]     = useState(false);
  const [saving, setSaving]       = useState(false);
  const [toast, setToast]         = useState('');
  const [tzLabel, setTzLabel]     = useState('');

  useEffect(() => {
    setTzLabel(getTimezoneLabel());
    if (!ready || !token) return;
    fetch(`/api/events/${id}`)
      .then(r => r.json())
      .then(setEvent);

    // Fetch rejection reason if any
    fetch(`/api/events/${id}/rejection`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setRejection(d); })
      .catch(() => {});
  }, [ready, token, id]);

  function showToast(msg: string, error = false) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  function field(key: string) {
    return edits[key] !== undefined ? edits[key] : (event?.[key] ?? '');
  }
  function set(key: string, val: any) { setEdits(e => ({ ...e, [key]: val })); }
  function pj(val: any) {
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val); } catch { return []; }
  }

  async function saveEdits() {
    setSaving(true);
    try {
      const freshToken = await getFreshToken();
      const res = await fetch(`/api/events/${id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` },
        body: JSON.stringify({ edits }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Save failed', true); return; }
      setEvent((e: any) => ({ ...e, ...edits }));
      setEdits({});
      setEditing(false);
      showToast(`✓ Saved — ${data.changed_fields?.length || 0} field(s) updated. Agent will learn from this.`);
    } catch (err: any) {
      showToast(`Error: ${err.message}`, true);
    } finally {
      setSaving(false);
    }
  }

  if (!ready || !user || !event) return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar role={user?.role || 'reviewer'} name={user?.name || ''} email={user?.email} token={token}/>
      <main style={{ flex: 1, padding: '2rem', color: '#888' }}>{event === null ? 'Loading…' : 'Event not found'}</main>
    </div>
  );

  const sessions  = pj(event.sessions);
  const sponsors  = pj(event.sponsors);
  const buttons   = pj(event.buttons);
  const st        = STATUS_STYLES[event.status] || STATUS_STYLES.pending;
  const canEdit   = user.role === 'admin' || event.status !== 'approved';

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={token}/>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, background: '#3a8c3f', color: 'white', padding: '0.75rem 1.25rem', borderRadius: 8, fontSize: 13, fontWeight: 500, zIndex: 999, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', maxWidth: 360 }}>
          {toast}
        </div>
      )}

      <main style={{ flex: 1, padding: '2rem', maxWidth: 800 }}>
        {/* Back + header */}
        <div style={{ marginBottom: '1.25rem' }}>
          <button onClick={() => router.back()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', fontSize: 12, padding: 0, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
            <ArrowLeft size={12}/> Back
          </button>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                <span style={{ background: st.bg, color: st.color, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>{st.label}</span>
                {event.geo_scope && (
                  <span style={{ background: '#e8f5e9', color: '#2a6b2e', fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20 }}>
                    {GEO_LABELS[event.geo_scope] || event.geo_scope}
                  </span>
                )}
                <span style={{ fontSize: 11, color: '#aaa' }}>ID: {event.id} · {event.source_name}</span>
              </div>
              <h1 style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.3 }}>{event.title}</h1>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              {canEdit && !editing && (
                <button onClick={() => setEditing(true)} className="btn-ghost" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Edit2 size={13}/> Edit
                </button>
              )}
              {editing && (
                <>
                  <button onClick={() => { setEditing(false); setEdits({}); }} className="btn-ghost" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <X size={13}/> Cancel
                  </button>
                  <button onClick={saveEdits} disabled={saving || Object.keys(edits).length === 0} className="btn-primary" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Save size={13}/> {saving ? 'Saving…' : 'Save changes'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Rejection reason box */}
        {event.status === 'rejected' && rejection && (
          <div style={{ background: '#fdecea', border: '1px solid #f5c6cb', borderRadius: 8, padding: '1rem', marginBottom: '1.25rem' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#c0392b', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <X size={14}/> Rejected
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: rejection.reviewer_note ? 8 : 0 }}>
              {pj(rejection.reason_codes).map((code: string) => (
                <span key={code} style={{ background: 'white', border: '1px solid #f5c6cb', color: '#c0392b', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20 }}>
                  {REASON_LABELS[code] || code}
                </span>
              ))}
            </div>
            {rejection.reviewer_note && (
              <div style={{ fontSize: 12, color: '#c0392b', marginTop: 6, fontStyle: 'italic' }}>
                "{rejection.reviewer_note}"
              </div>
            )}
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>
              Rejected {new Date(rejection.created_at).toLocaleDateString()} · {rejection.reviewer_name}
            </div>
          </div>
        )}

        {/* Approved — show CommunityHub link */}
        {event.status === 'approved' && event.communityhub_post_id && (
          <div style={{ background: '#e8f5e9', border: '1px solid #c8e6c9', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Check size={16} color="#3a8c3f"/>
            <span style={{ fontSize: 13, color: '#2a6b2e', fontWeight: 600 }}>Published to CommunityHub</span>
            <span style={{ fontSize: 11, color: '#aaa', marginLeft: 'auto' }}>Post ID: {event.communityhub_post_id}</span>
          </div>
        )}

        {/* Main fields */}
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

            <Field label="Title">
              {editing
                ? <input value={field('title')} onChange={e => set('title', e.target.value)} maxLength={60} style={inputStyle} placeholder="Event title (max 60 chars)"/>
                : <p style={valueStyle}>{event.title}</p>}
            </Field>

            <Field label="Short description">
              {editing
                ? <textarea value={field('description')} onChange={e => set('description', e.target.value)} maxLength={200} rows={2} style={{ ...inputStyle, resize: 'vertical' }}/>
                : <p style={valueStyle}>{event.description}</p>}
            </Field>

            <Field label="Long description">
              {editing
                ? <textarea value={field('extended_description') || ''} onChange={e => set('extended_description', e.target.value)} maxLength={1000} rows={4} style={{ ...inputStyle, resize: 'vertical' }}/>
                : <p style={{ ...valueStyle, color: event.extended_description ? '#333' : '#aaa' }}>{event.extended_description || 'None'}</p>}
            </Field>

            {/* Date/time — editable as unix timestamps */}
            <Field label={`Date & time${tzLabel ? ` · ${tzLabel}` : ''}`}>
              {sessions.map((s: any, i: number) => {
                const editKey = `session_${i}`;
                const editedSessions = edits.sessions ? pj(edits.sessions) : sessions;
                const cur = editedSessions[i] || s;

                if (!editing) {
                  return (
                    <div key={i} style={{ fontSize: 13, color: '#333', padding: '0.35rem 0' }}>
                      {formatSessionRange(s.startTime, s.endTime)}
                    </div>
                  );
                }

                // Convert unix to datetime-local string
                function toLocal(unix: number) {
                  const d = new Date(unix * 1000);
                  const pad = (n: number) => String(n).padStart(2, '0');
                  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                }
                function fromLocal(str: string) { return Math.floor(new Date(str).getTime() / 1000); }

                return (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ flex: 1 }}>
                      <label style={subLabel}>Start</label>
                      <input type="datetime-local" defaultValue={toLocal(s.startTime)}
                        onChange={e => {
                          const updated = [...pj(edits.sessions || event.sessions)];
                          updated[i] = { ...updated[i], startTime: fromLocal(e.target.value) };
                          set('sessions', updated);
                        }}
                        style={inputStyle}/>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={subLabel}>End</label>
                      <input type="datetime-local" defaultValue={toLocal(s.endTime)}
                        onChange={e => {
                          const updated = [...pj(edits.sessions || event.sessions)];
                          updated[i] = { ...updated[i], endTime: fromLocal(e.target.value) };
                          set('sessions', updated);
                        }}
                        style={inputStyle}/>
                    </div>
                  </div>
                );
              })}
            </Field>

            <Field label="Location">
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {['ph2','on','bo','ne'].map(lt => (
                      <button key={lt} onClick={() => set('location_type', lt)}
                        style={{ padding: '0.3rem 0.65rem', borderRadius: 6, border: '1.5px solid', fontSize: 11, cursor: 'pointer',
                          borderColor: field('location_type') === lt ? '#3a8c3f' : '#ddd',
                          background:  field('location_type') === lt ? '#e8f5e9' : 'white',
                          color:       field('location_type') === lt ? '#2a6b2e' : '#666',
                          fontWeight:  field('location_type') === lt ? 700 : 400 }}>
                        {{'ph2':'In-person','on':'Online','bo':'Hybrid','ne':'None'}[lt]}
                      </button>
                    ))}
                  </div>
                  {['ph2','bo'].includes(field('location_type')) && (
                    <input value={field('location') || ''} onChange={e => set('location', e.target.value)} style={inputStyle} placeholder="Street address"/>
                  )}
                  {['on','bo'].includes(field('location_type')) && (
                    <input value={field('url_link') || ''} onChange={e => set('url_link', e.target.value)} style={inputStyle} placeholder="Stream URL"/>
                  )}
                </div>
              ) : (
                <p style={valueStyle}>
                  {event.location_type === 'ph2' && (event.place_name ? `${event.place_name} · ` : '') + (event.location || '—')}
                  {event.location_type === 'on'  && (event.url_link || '—')}
                  {event.location_type === 'bo'  && `${event.location || ''} + online`}
                  {event.location_type === 'ne'  && 'No location'}
                </p>
              )}
            </Field>

            <Field label="Geo scope">
              {editing ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  {['hyper_local','city_wide','county','regional'].map(gs => (
                    <button key={gs} onClick={() => set('geo_scope', gs)}
                      style={{ padding: '0.3rem 0.65rem', borderRadius: 6, border: '1.5px solid', fontSize: 11, cursor: 'pointer',
                        borderColor: field('geo_scope') === gs ? '#3a8c3f' : '#ddd',
                        background:  field('geo_scope') === gs ? '#e8f5e9' : 'white',
                        color:       field('geo_scope') === gs ? '#2a6b2e' : '#666',
                        fontWeight:  field('geo_scope') === gs ? 700 : 400 }}>
                      {GEO_LABELS[gs]}
                    </button>
                  ))}
                </div>
              ) : (
                <p style={valueStyle}>{event.geo_scope ? GEO_LABELS[event.geo_scope] : '—'}</p>
              )}
            </Field>

            <Field label="Sponsors">
              {editing
                ? <input value={pj(field('sponsors')).join(', ')} onChange={e => set('sponsors', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))} style={inputStyle} placeholder="Sponsor 1, Sponsor 2"/>
                : <p style={valueStyle}>{sponsors.join(', ') || '—'}</p>}
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Field label="Contact email">
                {editing
                  ? <input value={field('contact_email') || ''} onChange={e => set('contact_email', e.target.value)} style={inputStyle}/>
                  : <p style={valueStyle}>{event.contact_email || '—'}</p>}
              </Field>
              <Field label="Phone">
                {editing
                  ? <input value={field('phone') || ''} onChange={e => set('phone', e.target.value)} style={inputStyle}/>
                  : <p style={valueStyle}>{event.phone || '—'}</p>}
              </Field>
            </div>

            <Field label="Image URL">
              {editing
                ? <input value={field('image_cdn_url') || ''} onChange={e => set('image_cdn_url', e.target.value)} style={inputStyle} placeholder="https://…"/>
                : event.image_cdn_url
                  ? <img src={event.image_cdn_url} alt="" style={{ maxHeight: 120, borderRadius: 6, objectFit: 'cover' }}/>
                  : <p style={{ ...valueStyle, color: '#aaa' }}>No image</p>}
            </Field>

            {/* Links */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', paddingTop: 4 }}>
              {event.calendar_source_url && (
                <a href={event.calendar_source_url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#3a8c3f', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <ExternalLink size={11}/> View source
                </a>
              )}
              {event.ingested_post_url && (
                <a href={event.ingested_post_url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#3a8c3f', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <ExternalLink size={11}/> Permalink
                </a>
              )}
            </div>

          </div>
        </div>

        {editing && Object.keys(edits).length > 0 && (
          <div style={{ background: '#e8f5e9', borderRadius: 8, padding: '0.75rem 1rem', fontSize: 12, color: '#2a6b2e', marginBottom: '1rem' }}>
            ✓ {Object.keys(edits).length} field(s) modified — the agent will learn from these corrections when you save.
          </div>
        )}
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: 10, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = { width: '100%', padding: '0.55rem 0.75rem', border: '1.5px solid #ddd', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const valueStyle: React.CSSProperties = { fontSize: 13, color: '#333', margin: 0, lineHeight: 1.5 };
const subLabel:   React.CSSProperties = { fontSize: 10, color: '#aaa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 2 };
