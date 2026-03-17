// NavBar.js — top navigation bar (desktop) + bottom tab bar (mobile)
// Desktop (≥769px): fixed top bar with brand, center nav links, user area + bell
// Mobile (≤768px): slim top bar (brand + bell + avatar) + fixed bottom tab bar
//                  with icon+label tabs for Home, Friends, Groups, New Event

import React, { useState, useEffect } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { logout } from '../utils/api';
import NotificationBell from './NotificationBell';
import { clearSession, getUserName, getAvatarUrl, setAvatarUrl } from '../utils/auth';
import client from '../utils/client';
import { getInitials } from '../utils/formatting';

// ── Tab icon SVGs (20×20, stroke-based, no external libraries) ───────────────
function IconHome() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  );
}

function IconFriends() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

function IconGroups() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <circle cx="12" cy="8" r="4"/>
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
      <circle cx="4.5" cy="10" r="2.5"/>
      <path d="M1 20c0-2.5 1.6-4.5 3.5-4.5"/>
      <circle cx="19.5" cy="10" r="2.5"/>
      <path d="M23 20c0-2.5-1.6-4.5-3.5-4.5"/>
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="16"/>
      <line x1="8" y1="12" x2="16" y2="12"/>
    </svg>
  );
}

export default function NavBar() {
  const navigate        = useNavigate();
  const name            = getUserName();
  const [busy, setBusy] = useState(false);
  const [avatar, setAvatar] = useState(getAvatarUrl());

  // Always prefer uploaded avatar_url over Google picture — fetch on every mount
  useEffect(() => {
    client.get('/users/me').then(res => {
      const url = res.data?.avatar_url;
      if (url) { setAvatarUrl(url); setAvatar(url); }
      // If no uploaded avatar, keep Google picture already in state
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleLogout() {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
    } catch {
      // Server logout failed (e.g. session already gone) — proceed anyway
    } finally {
      clearSession();
      navigate('/', { replace: true });
    }
  }

  // NavLink applies className based on active state (React Router v6 API)
  const linkClass = ({ isActive }) =>
    `navbar__link${isActive ? ' navbar__link--active' : ''}`;

  const tabClass = ({ isActive }) =>
    `tab-item${isActive ? ' tab-item--active' : ''}`;

  return (
    <>
      <nav className="navbar" aria-label="Main navigation">
        {/* Brand */}
        <Link to="/home" className="navbar__brand" aria-label="Rendezvous home">
          Rendezvous
        </Link>

        {/* Center nav links — hidden on mobile, replaced by bottom tab bar */}
        <div className="navbar__links">
          <NavLink to="/friends" className={linkClass}>Friends</NavLink>
          <NavLink to="/groups"  className={linkClass}>Groups</NavLink>
          <NavLink to="/help"   className={linkClass}>Help</NavLink>
          <NavLink to="/schedule/new" className={linkClass}>New Event</NavLink>
        </div>

        {/* User area — bell stays on both mobile and desktop */}
        <div className="navbar__user">
          <NotificationBell />
          <Link
            to="/profile"
            className="avatar avatar--sm"
            title={name ? `View your profile (${name})` : 'My profile'}
            aria-label="My profile"
            style={{ textDecoration:'none', overflow:'hidden', padding: avatar ? 0 : undefined }}
          >
            {avatar
              ? <img src={avatar} alt={name || 'Avatar'} style={{ width:'100%', height:'100%', objectFit:'cover', borderRadius:'50%' }} />
              : getInitials(name)
            }
          </Link>
          {name && (
            <Link to="/profile" className="navbar__name" style={{ textDecoration:'none', color:'inherit' }}>
              {name.split(' ')[0]}
            </Link>
          )}
          <button
            className="navbar__logout-btn"
            onClick={handleLogout}
            disabled={busy}
            aria-label="Log out"
          >
            {busy ? '…' : 'Log out'}
          </button>
        </div>
      </nav>

      {/* Bottom tab bar — only visible on mobile (≤768px) via CSS */}
      <nav className="bottom-tab-bar" aria-label="Mobile navigation">
        <NavLink to="/home"         className={tabClass} end>
          <IconHome />
          <span>Home</span>
        </NavLink>
        <NavLink to="/friends"      className={tabClass}>
          <IconFriends />
          <span>Friends</span>
        </NavLink>
        <NavLink to="/groups"       className={tabClass}>
          <IconGroups />
          <span>Groups</span>
        </NavLink>
        <NavLink to="/schedule/new" className={tabClass}>
          <IconPlus />
          <span>New Event</span>
        </NavLink>
      </nav>
    </>
  );
}
