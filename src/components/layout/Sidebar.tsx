'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, ClipboardList, CheckCircle, XCircle,
  Database, BarChart2, Shield, Settings, LogOut, Eye, RefreshCw
} from 'lucide-react';

interface SidebarProps {
  role:   'admin' | 'reviewer';
  name:   string;
  email?: string;
  token?: string;
}

export default function Sidebar({ role, name, email, token }: SidebarProps) {
  const path = usePathname();
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [previewAsReviewer, setPreviewAsReviewer] = useState(false);
  const isActive = (href: string) => path === href || path.startsWith(href + '/');

  // Effective role — admin can toggle to reviewer view
  const effectiveRole = role === 'admin' && previewAsReviewer ? 'reviewer' : role;

  useEffect(() => {
    if (!token) return;
    fetch('/api/review/queue?limit=1', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setPendingCount(d.total ?? 0))
      .catch(() => {});
  }, [token, path]);

  function signOut() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  }

  return (
    <aside style={{
      width: 224, minHeight: '100vh',
      borderRight: '1px solid #e8f0e8',
      background: previewAsReviewer ? '#f8fff8' : '#fff',
      display: 'flex', flexDirection: 'column', flexShrink: 0,
      transition: 'background 0.2s',
    }}>
      {/* Logo */}
      <div style={{ padding: '1.25rem 1rem', borderBottom: '1px solid #e8f5e9', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Image src="/logo.png" alt="AI Events Aggregator" width={36} height={36} style={{ borderRadius: 4, flexShrink: 0 }}/>
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, color: '#3a8c3f', letterSpacing: 0.8, lineHeight: 1.35 }}>AI EVENTS</div>
          <div style={{ fontSize: 10, fontWeight: 800, color: '#3a8c3f', letterSpacing: 0.8, lineHeight: 1.35 }}>AGGREGATOR</div>
          <div style={{ fontSize: 9, color: '#bbb', marginTop: 1 }}>CommunityHub</div>
        </div>
      </div>

      {/* Preview banner */}
      {previewAsReviewer && (
        <div style={{ background: '#fff3cd', borderBottom: '1px solid #ffc107', padding: '0.5rem 0.75rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Eye size={11} color="#856404"/>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#856404' }}>REVIEWER VIEW</span>
        </div>
      )}

      {/* Nav */}
      <nav style={{ flex: 1, padding: '0.625rem 0.5rem', overflowY: 'auto' }}>
        {/* Common links — both roles */}
        <SideLink
          href={effectiveRole === 'admin' ? '/admin/stats' : '/reviewer/dashboard'}
          icon={<LayoutDashboard size={15}/>} label="Dashboard"
          active={isActive('/admin/stats') || isActive('/reviewer/dashboard')}/>

        <SideLink href="/reviewer/queue"
          icon={<ClipboardList size={15}/>} label="Needs Review"
          active={isActive('/reviewer/queue')}
          badge={pendingCount !== null && pendingCount > 0 ? pendingCount : undefined}/>

        <SideLink href="/events/approved"
          icon={<CheckCircle size={15}/>} label="Approved"
          active={isActive('/events/approved')}/>

        <SideLink href="/events/rejected"
          icon={<XCircle size={15}/>} label="Rejected"
          active={isActive('/events/rejected')}/>

        {/* Admin-only section — hidden in reviewer preview */}
        {effectiveRole === 'admin' && (
          <>
            <div style={{ borderTop: '1px solid #f0f0f0', margin: '0.5rem 0.25rem' }}/>
            <div style={{ fontSize: 9, fontWeight: 700, color: '#ccc', textTransform: 'uppercase', letterSpacing: 1, padding: '0 0.75rem 0.25rem' }}>Admin</div>
            <SideLink href="/admin/sources"   icon={<Database size={15}/>}  label="Event Sources"  active={isActive('/admin/sources')}/>
            <SideLink href="/admin/analytics" icon={<BarChart2 size={15}/>} label="AI Analytics"   active={isActive('/admin/analytics')}/>
            <SideLink href="/admin/controls"  icon={<Shield size={15}/>}    label="Admin Controls" active={isActive('/admin/controls')}/>
          </>
        )}

        <div style={{ borderTop: '1px solid #f0f0f0', margin: '0.5rem 0.25rem' }}/>
        <SideLink href="/settings" icon={<Settings size={15}/>} label="Settings" active={isActive('/settings')}/>
      </nav>

      {/* Admin preview toggle */}
      {role === 'admin' && (
        <div style={{ padding: '0.625rem 0.75rem', borderTop: '1px solid #f0f0f0' }}>
          <button
            onClick={() => setPreviewAsReviewer(p => !p)}
            style={{
              width: '100%', padding: '0.45rem 0.75rem',
              borderRadius: 7, border: '1.5px solid',
              borderColor: previewAsReviewer ? '#ffc107' : '#e0e0e0',
              background: previewAsReviewer ? '#fff3cd' : 'white',
              color: previewAsReviewer ? '#856404' : '#888',
              fontSize: 11, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              transition: 'all 0.15s',
            }}>
            {previewAsReviewer ? <><RefreshCw size={11}/> Back to admin view</> : <><Eye size={11}/> Preview as reviewer</>}
          </button>
        </div>
      )}

      {/* User footer */}
      <div style={{ padding: '0.875rem 1rem', borderTop: '1px solid #eee' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: role === 'admin' ? '#3a8c3f' : '#e8f5e9',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700,
            color: role === 'admin' ? 'white' : '#3a8c3f', flexShrink: 0,
          }}>
            {name?.[0]?.toUpperCase() ?? 'U'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
            {email && <div style={{ fontSize: 10, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</div>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: role === 'admin' ? '#e8f5e9' : '#f0f0f0', color: role === 'admin' ? '#2a6b2e' : '#666' }}>
            {role === 'admin' ? <Shield size={9}/> : <Eye size={9}/>} {role}
          </span>
          <button onClick={signOut} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 0' }}>
            <LogOut size={12}/> Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}

function SideLink({ href, icon, label, active, badge }: {
  href: string; icon: React.ReactNode; label: string; active: boolean; badge?: number;
}) {
  return (
    <Link href={href} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '0.45rem 0.75rem', borderRadius: 7, marginBottom: 1,
      fontSize: 13, textDecoration: 'none',
      background: active ? '#e8f5e9' : 'transparent',
      color:      active ? '#2a6b2e' : '#555',
      fontWeight: active ? 600 : 400,
      transition: 'background 0.1s',
    }}>
      <span style={{ flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== undefined && (
        <span style={{ background: '#3a8c3f', color: 'white', borderRadius: 20, padding: '1px 7px', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  );
}
