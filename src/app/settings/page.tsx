'use client';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';

export default function SettingsPage() {
  const { user, token, ready } = useAuth();
  if (!ready || !user) return null;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={token}/>
      <main style={{ flex: 1, padding: '2rem', maxWidth: 640 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: '0.25rem' }}>Settings</h1>
        <p style={{ fontSize: 13, color: '#888', marginBottom: '2rem' }}>Your account settings</p>

        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '1rem' }}>Account</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Row label="Name"  value={user.name} />
            <Row label="Email" value={user.email} />
            <Row label="Role"  value={user.role} badge />
          </div>
        </div>

        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '0.75rem' }}>Authentication</h3>
          <p style={{ fontSize: 13, color: '#666', marginBottom: '1rem' }}>You sign in using Google. No password is stored.</p>
          <button
            onClick={() => { localStorage.removeItem('token'); localStorage.removeItem('user'); window.location.href = '/login'; }}
            className="btn-ghost"
            style={{ fontSize: 13, color: '#c0392b', borderColor: '#c0392b' }}>
            Sign out
          </button>
        </div>

        {user.role === 'admin' && (
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '0.75rem' }}>System</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: '#666' }}>
              <div>App URL: <code style={{ background: '#f5f5f5', padding: '1px 6px', borderRadius: 4 }}>{typeof window !== 'undefined' ? window.location.origin : ''}</code></div>
              <div>Version: <code style={{ background: '#f5f5f5', padding: '1px 6px', borderRadius: 4 }}>1.0.0</code></div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Row({ label, value, badge }: { label: string; value: string; badge?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0.5rem 0', borderBottom: '1px solid #f5f5f5' }}>
      <span style={{ fontSize: 12, color: '#888', width: 80, flexShrink: 0 }}>{label}</span>
      {badge
        ? <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 10px', borderRadius: 20, background: value === 'admin' ? '#e8f5e9' : '#f0f0f0', color: value === 'admin' ? '#2a6b2e' : '#555' }}>{value}</span>
        : <span style={{ fontSize: 13, fontWeight: 500 }}>{value}</span>
      }
    </div>
  );
}
