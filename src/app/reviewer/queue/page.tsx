'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { Clock, Globe, Calendar } from 'lucide-react';
import { formatDateTime } from '@/lib/timezone';

const GEO_COLORS: Record<string,string> = {
  hyper_local: '#e8f5e9|#2a6b2e', city_wide: '#e3f2fd|#1565c0',
  county: '#fff3e0|#c05e00', regional: '#f3e5f5|#7b1fa2',
};
const GEO_LABELS: Record<string,string> = {
  hyper_local:'Hyper-local', city_wide:'City-wide', county:'County', regional:'Regional',
};

export default function ReviewerQueuePage() {
  const { user, token, ready } = useAuth();
  const [events, setEvents]    = useState<any[]>([]);
  const [total, setTotal]      = useState(0);
  const [loading, setLoading]  = useState(true);
  const [page, setPage]        = useState(0);
  const router = useRouter();

  useEffect(() => {
    if (!ready || !token) return;
    const source_id = new URLSearchParams(window.location.search).get('source_id') || '';
    fetch(`/api/review/queue?page=${page}&limit=20${source_id ? `&source_id=${source_id}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then(d => { setEvents(d.events||[]); setTotal(d.total||0); }).finally(() => setLoading(false));
  }, [ready, token, page]);

  if (!ready || !user) return null;

  function formatDate(sessions: string) {
    try {
      const s = typeof sessions === 'string' ? JSON.parse(sessions) : sessions;
      if (!s?.[0]?.startTime) return '—';
      return formatDateTime(s[0].startTime, { short: true, dateOnly: true });
    } catch { return '—'; }
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={token} />
      <main style={{ flex: 1, padding: '2rem' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Review queue</h1>
          <p style={{ fontSize: 13, color: '#888' }}>{total} event{total!==1?'s':''} pending review</p>
        </div>

        {loading ? <div style={{ color:'#888', fontSize:14 }}>Loading…</div>
        : events.length === 0 ? (
          <div className="card" style={{ textAlign:'center', padding:'3rem', color:'#888' }}>
            <div style={{ fontSize:36, marginBottom:12 }}>✓</div>
            <div style={{ fontSize:16, fontWeight:600 }}>Queue is empty</div>
            <div style={{ fontSize:13, marginTop:4 }}>All events reviewed</div>
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {events.map(ev => {
              const [bg,fg] = (GEO_COLORS[ev.geo_scope]||'#f0f0f0|#555').split('|');
              return (
                <div key={ev.id} onClick={() => router.push(`/reviewer/events/${ev.id}`)}
                  className="card" style={{ cursor:'pointer', display:'flex', alignItems:'center', gap:'1rem', padding:'1rem 1.25rem' }}
                  onMouseEnter={e=>(e.currentTarget.style.boxShadow='0 2px 12px rgba(58,140,63,0.15)')}
                  onMouseLeave={e=>(e.currentTarget.style.boxShadow='none')}>
                  <div style={{ width:36, height:36, borderRadius:8, background:'#e8f5e9', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700, color:'#3a8c3f', flexShrink:0 }}>
                    {ev.source_name[0]}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:2 }}>
                      <span style={{ fontSize:14, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ev.title}</span>
                      {ev.geo_scope && <span style={{ fontSize:10, padding:'1px 8px', borderRadius:20, background:bg, color:fg, fontWeight:600, flexShrink:0 }}>{GEO_LABELS[ev.geo_scope]}</span>}
                    </div>
                    <div style={{ fontSize:12, color:'#888', display:'flex', gap:12 }}>
                      <span style={{ display:'flex', alignItems:'center', gap:3 }}><Globe size={11}/> {ev.source_name}</span>
                      <span style={{ display:'flex', alignItems:'center', gap:3 }}><Calendar size={11}/> {formatDate(ev.sessions)}</span>
                      <span style={{ display:'flex', alignItems:'center', gap:3 }}><Clock size={11}/> {new Date(ev.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div style={{ fontSize:11, color:'#bbb' }}>→</div>
                </div>
              );
            })}
          </div>
        )}

        {total > 20 && (
          <div style={{ display:'flex', gap:8, marginTop:'1.5rem', justifyContent:'center' }}>
            <button onClick={() => setPage(p=>Math.max(0,p-1))} disabled={page===0} className="btn-ghost" style={{ fontSize:12 }}>← Prev</button>
            <span style={{ fontSize:13, color:'#888', padding:'0.4rem 0.5rem' }}>Page {page+1} of {Math.ceil(total/20)}</span>
            <button onClick={() => setPage(p=>p+1)} disabled={(page+1)*20>=total} className="btn-ghost" style={{ fontSize:12 }}>Next →</button>
          </div>
        )}
      </main>
    </div>
  );
}
