// 10/10 — NavBar
// Fixed top navigation bar rendered by every protected page.
// "Rendezvous" brand → /home
// Center links: Friends, New Event
// Right: avatar initial, user name, logout button

import React, { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { logout } from '../utils/api';
import { clearSession, getUserName } from '../utils/auth';

function getInitials(name = '') {
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

export default function NavBar() {
  const navigate     = useNavigate();
  const name         = getUserName();
  const [busy, setBusy] = useState(false);

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

  // NavLink applies className based on active state (React Router v7 API)
  const linkClass = ({ isActive }) =>
    `navbar__link${isActive ? ' navbar__link--active' : ''}`;

  return (
    <nav className="navbar" aria-label="Main navigation">
      {/* Brand */}
      <Link to="/home" className="navbar__brand" aria-label="Rendezvous home">
        Rendezvous
      </Link>

      {/* Center nav links */}
      <div className="navbar__links">
        <NavLink to="/friends" className={linkClass}>
          Friends
        </NavLink>
        <NavLink to="/schedule/new" className={linkClass}>
          New Event
        </NavLink>
      </div>

      {/* User area */}
      <div className="navbar__user">
        <div
          className="avatar avatar--sm"
          aria-hidden="true"
          title={name || ''}
        >
          {getInitials(name)}
        </div>
        {name && <span className="navbar__name">{name.split(' ')[0]}</span>}
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
  );
}
