'use client';
import { useState } from 'react';
import Sidebar from './Sidebar';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface AppShellProps {
  role:     'admin' | 'reviewer';
  name:     string;
  email?:   string;
  token?:   string;
  children: React.ReactNode;
}

export default function AppShell({ role, name, email, token, children }: AppShellProps) {
  const [open, setOpen] = useState(true);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      {/* Sidebar */}
      <div style={{
        width: open ? 224 : 0,
        minWidth: open ? 224 : 0,
        overflow: 'hidden',
        transition: 'width 0.2s ease, min-width 0.2s ease',
        flexShrink: 0,
      }}>
        <Sidebar role={role} name={name} email={email} token={token}/>
      </div>

      {/* Toggle button */}
      <button
        onClick={() => setOpen(o => !o)}
        title={open ? 'Collapse sidebar' : 'Open sidebar'}
        style={{
          position: 'fixed',
          top: 14,
          left: open ? 188 : 8,
          zIndex: 200,
          width: 28,
          height: 28,
          borderRadius: 7,
          border: '1.5px solid #e0e0e0',
          background: 'white',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#888',
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          transition: 'left 0.2s ease',
          padding: 0,
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = '#3a8c3f'; e.currentTarget.style.color = '#3a8c3f'; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = '#e0e0e0'; e.currentTarget.style.color = '#888'; }}
      >
        {open ? <PanelLeftClose size={14}/> : <PanelLeftOpen size={14}/>}
      </button>

      {/* Main content */}
      <main style={{ flex: 1, minWidth: 0, paddingTop: 0 }}>
        {children}
      </main>
    </div>
  );
}
