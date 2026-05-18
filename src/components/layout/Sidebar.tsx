'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, ClipboardList, CheckCircle, XCircle,
  Database, BarChart2, Shield, Settings, LogOut, Eye,
  RefreshCw, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';

interface SidebarProps {
  role:   'admin' | 'reviewer';
  name:   string;
  email?: string;
  token?: string;
}

export default function Sidebar({ role, name, email, token }: SidebarProps) {
  const path = usePathname();
  const [pendingCount, setPendingCount]       = useState<number | null>(null);
  const [previewAsReviewer, setPreviewAsReviewer] = useState(false);
  const [collapsed, setCollapsed]             = useState(false);
  const isActive = (href: string) => path === href || path.startsWith(href + '/');
  const effectiveRole = role === 'admin' && previewAsReviewer ? 'reviewer' : role;

  useEffect(() => {
    if (!token) return;
    fetch('/api/review/queue?limit=1', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setPendingCount(d.total ?? 0)).catch(() => {});
  }, [token, path]);

  function signOut() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  }

  return (
    <>
      {/* Sidebar */}
      <aside style={{
        width: collapsed ? 0 : 224,
        minWidth: collapsed ? 0 : 224,
        minHeight: '100vh',
        borderRight: collapsed ? 'none' : '1px solid #e8f0e8',
        background: previewAsReviewer ? '#f8fff8' : '#fff',
        display: 'flex', flexDirection: 'column', flexShrink: 0,
        overflow: 'hidden',
        transition: 'width 0.2s ease, min-width 0.2s ease',
        position: 'relative',
      }}>

        {/* Logo */}
        <div style={{ padding: '1rem', borderBottom: '1px solid #e8f5e9', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <Image src="/logo.png" alt="AI Events Aggregator" width={34} height={34} style={{ borderRadius: 4, flexShrink: 0 }}/>
          <div style={{ whiteSpace: 'nowrap' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#3a8c3f', letterSpacing: 0.8, lineHeight: 1.35 }}>AI EVENTS</div>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#3a8c3f', letterSpacing: 0.8, lineHeight: 1.35 }}>AGGREGATOR</div>
            <div style={{ fontSize: 9, color: '#bbb', marginTop: 1 }}>CommunityHub</div>
          </div>
        </div>

        {/* Reviewer preview banner */}
        {previewAsReviewer && (
          <div style={{ background: '#fff3cd', borderBottom: '1px solid #ffc107', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <Eye size={11} color="#856404"/>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#856404', whiteSpace: 'nowrap' }}>REVIEWER VIEW</span>
          </div>
        )}

        {/* Nav */}
        <nav style={{ flex: 1, padding: '0.625rem 0.5rem', overflowY: 'auto', overflowX: 'hidden' }}>
          <SideLink href={effectiveRole === 'admin' ? '/admin/stats' : '/reviewer/dashboard'}
            icon={<LayoutDashboard size={15}/>} label="Dashboard"
            active={isActive('/admin/stats') || isActive('/reviewer/dashboard')}/>
          <SideLink href="/reviewer/queue" icon={<ClipboardList size={15}/>} label="Needs Review"
            active={isActive('/reviewer/queue')}
            badge={pendingCount !== null && pendingCount > 0 ? pendingCount : undefined}/>
          <SideLink href="/events/approved" icon={<CheckCircle size={15}/>} label="Approved" active={isActive('/events/approved')}/>
          <SideLink href="/events/rejected" icon={<XCircle size={15}/>} label="Rejected" active={isActive('/events/rejected')}/>

          {effectiveRole === 'admin' && (
            <>
              <div style={{ borderTop: '1px solid #f0f0f0', margin: '0.5rem 0.25rem' }}/>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#ccc', textTransform: 'uppercase', letterSpacing: 1, padding: '0 0.75rem 0.25rem', whiteSpace: 'nowrap' }}>Admin</div>
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
          <div style={{ padding: '0.5rem 0.625rem', borderTop: '1px solid #f5f5f5', flexShrink: 0 }}>
            <button onClick={() => setPreviewAsReviewer(p => !p)} style={{
              width: '100%', padding: '0.4rem 0.75rem', borderRadius: 7,
              border: `1.5px solid ${previewAsReviewer ? '#ffc107' : '#e0e0e0'}`,
              background: previewAsReviewer ? '#fff3cd' : 'white',
              color: previewAsReviewer ? '#856404' : '#888',
              fontSize: 11, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              whiteSpace: 'nowrap',
            }}>
              {previewAsReviewer ? <><RefreshCw size={11}/> Back to admin</> : <><Eye size={11}/> Preview as reviewer</>}
            </button>
          </div>
        )}

        {/* User footer */}
        <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #eee', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ width: 30, height: 30, borderRadius: '50%', background: role === 'admin' ? '#3a8c3f' : '#e8f5e9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: role === 'admin' ? 'white' : '#3a8c3f', flexShrink: 0 }}>
              {name?.[0]?.toUpperCase() ?? 'U'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
              {email && <div style={{ fontSize: 10, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: role === 'admin' ? '#e8f5e9' : '#f0f0f0', color: role === 'admin' ? '#2a6b2e' : '#666', whiteSpace: 'nowrap' }}>
              {role === 'admin' ? <Shield size={9}/> : <Eye size={9}/>} {role}
            </span>
            <button onClick={signOut} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              <LogOut size={12}/> Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Floating toggle button — always visible */}
      <button
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Open sidebar' : 'Collapse sidebar'}
        style={{
          position: 'fixed', top: 12,
          left: collapsed ? 8 : 188,
          zIndex: 300, width: 28, height: 28,
          borderRadius: 7, border: '1.5px solid #e0e0e0',
          background: 'white', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#999', boxShadow: '0 1px 6px rgba(0,0,0,0.1)',
          transition: 'left 0.2s ease', padding: 0,
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = '#3a8c3f'; e.currentTarget.style.color = '#3a8c3f'; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = '#e0e0e0'; e.currentTarget.style.color = '#999'; }}
      >
        {collapsed ? <PanelLeftOpen size={13}/> : <PanelLeftClose size={13}/>}
      </button>
    </>
  );
}

function SideLink({ href, icon, label, active, badge }: {
  href: string; icon: React.ReactNode; label: string; active: boolean; badge?: number;
}) {
  return (
    <Link href={href} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '0.45rem 0.75rem', borderRadius: 7, marginBottom: 1,
      fontSize: 13, textDecoration: 'none', whiteSpace: 'nowrap',
      background: active ? '#e8f5e9' : 'transparent',
      color:      active ? '#2a6b2e' : '#555',
      fontWeight: active ? 600 : 400,
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
