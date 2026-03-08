// 6/10 — Friends
// Search for users, manage incoming friend requests, view accepted friends,
// and share your profile link.

import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import NavBar from '../components/NavBar';
import { searchUserByEmail } from '../utils/api';
import client from '../utils/client';

/* ── Helpers ────────────────────────────────────────────────── */
function getInitials(name = '') {
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

const APP_URL = process.env.REACT_APP_URL || window.location.origin;

/* ── Component ──────────────────────────────────────────────── */
export default function Friends() {
  const [query,     setQuery]     = useState('');
  const [results,   setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState('');

  const [requests,  setRequests]  = useState([]);
  const [friends,   setFriends]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');

  const [copied,    setCopied]    = useState(false);
  const [myProfile, setMyProfile] = useState(null);

  /* Load friends + requests + own username */
  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [friendsRes, requestsRes, meRes] = await Promise.allSettled([
          client.get('/friends'),
          client.get('/friends/requests/incoming'),
          client.get('/users/me'),
        ]);
        if (!mounted) return;
        if (friendsRes.status === 'fulfilled')  setFriends(friendsRes.value.data?.friends ?? []);
        if (requestsRes.status === 'fulfilled') setRequests(requestsRes.value.data?.requests ?? []);
        if (meRes.status === 'fulfilled')       setMyProfile(meRes.value.data);
      } catch {
        if (mounted) setError('Could not load friends. Please try again.');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, []);

  /* Search */
  const handleSearch = useCallback(async (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchErr('');
    setResults([]);
    try {
      const data = await searchUserByEmail(q);
      setResults(data?.users ?? []);
      if ((data?.users ?? []).length === 0) setSearchErr('No users found.');
    } catch (err) {
      setSearchErr(err.message || 'Search failed. Try again.');
    } finally {
      setSearching(false);
    }
  }, [query]);

  /* Add friend */
  async function sendRequest(userId) {
    try {
      await client.post('/friends/request', { targetUserId: userId });
      setResults((prev) => prev.map((u) =>
        u.id === userId ? { ...u, requestSent: true } : u
      ));
    } catch (err) {
      alert(err.message || 'Could not send friend request.');
    }
  }

  /* Accept / decline incoming request */
  async function respondToRequest(requestId, accept) {
    try {
      await client.post(`/friends/requests/${requestId}/${accept ? 'accept' : 'decline'}`);
      setRequests((prev) => prev.filter((r) => r.id !== requestId));
      if (accept) {
        // Re-fetch friends list after accepting
        const res = await client.get('/friends');
        setFriends(res.data?.friends ?? []);
      }
    } catch (err) {
      alert(err.message || 'Could not respond to request.');
    }
  }

  /* Copy profile link */
  async function handleShareProfile() {
    const username = myProfile?.username;
    if (!username) return;
    const url = `${APP_URL}/u/${username}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback for browsers that block clipboard without interaction
      prompt('Copy your profile link:', url);
    }
  }

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container">

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 className="page-title">Friends</h1>
              <p className="page-subtitle">Find and manage your connections.</p>
            </div>
            {myProfile?.username && (
              <button
                className={`btn ${copied ? 'btn--success' : 'btn--ghost'} btn--sm`}
                onClick={handleShareProfile}
                style={{ flexShrink: 0 }}
              >
                {copied ? '✓ Link copied!' : '🔗 Share my profile'}
              </button>
            )}
          </div>

          {error && <div className="alert alert--error">{error}</div>}

          {/* ── Search ──────────────────────────────────── */}
          <section className="section">
            <div className="section-title">Find someone</div>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                className="form-control"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setResults([]); setSearchErr(''); }}
                placeholder="Email address or username…"
                style={{ flex: 1 }}
                autoComplete="off"
                spellCheck="false"
              />
              <button
                type="submit"
                className="btn btn--primary"
                disabled={searching || !query.trim()}
                style={{ flexShrink: 0 }}
              >
                {searching ? '…' : 'Search'}
              </button>
            </form>

            {searchErr && <p className="form-hint" style={{ marginTop: 8, color: 'var(--text-3)' }}>{searchErr}</p>}

            {results.length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {results.map((user) => (
                  <div key={user.id} className="friend-card">
                    {user.isFriend
                      ? <Link to={`/friends/${user.id}`} className="avatar" style={{ textDecoration:'none' }}>{getInitials(user.name)}</Link>
                      : <div className="avatar">{getInitials(user.name)}</div>
                    }
                    <div className="friend-card__info">
                      {user.isFriend
                        ? <Link to={`/friends/${user.id}`} className="friend-card__name" style={{ textDecoration:'none', color:'inherit' }}>{user.name}</Link>
                        : <div className="friend-card__name">{user.name}</div>
                      }
                      <div className="friend-card__sub">@{user.username}</div>
                    </div>
                    <div className="friend-card__actions">
                      {user.isFriend ? (
                        <span className="badge badge--green">Friends</span>
                      ) : user.requestSent ? (
                        <span className="badge badge--gray">Request sent</span>
                      ) : (
                        <button
                          className="btn btn--secondary btn--sm"
                          onClick={() => sendRequest(user.id)}
                        >
                          Add Friend
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <hr className="divider" />

          {loading ? (
            <div className="loading"><div className="spinner" /><span>Loading…</span></div>
          ) : (
            <>
              {/* ── Pending Requests ──────────────────────── */}
              {requests.length > 0 && (
                <section className="section">
                  <div className="section-title">Pending requests</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {requests.map((req) => (
                      <div key={req.id} className="friend-card">
                        <div className="avatar">{getInitials(req.fromName)}</div>
                        <div className="friend-card__info">
                          <div className="friend-card__name">{req.fromName}</div>
                          <div className="friend-card__sub">@{req.fromUsername}</div>
                        </div>
                        <div className="friend-card__actions">
                          <button
                            className="btn btn--success btn--sm"
                            onClick={() => respondToRequest(req.id, true)}
                          >
                            Accept
                          </button>
                          <button
                            className="btn btn--ghost btn--sm"
                            onClick={() => respondToRequest(req.id, false)}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* ── My Friends ────────────────────────────── */}
              <section className="section">
                <div className="section-title">My friends</div>
                {friends.length === 0 ? (
                  <div className="card card-pad">
                    <div className="empty-state">
                      <div className="empty-state__icon">👋</div>
                      <div className="empty-state__title">No friends yet</div>
                      <p className="empty-state__text">Search for someone to get started.</p>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {friends.map((f) => (
                      <div key={f.id} className="friend-card">
                        <Link to={`/friends/${f.id}`} className="avatar" style={{ textDecoration:'none' }}>
                          {getInitials(f.name)}
                        </Link>
                        <div className="friend-card__info">
                          <Link to={`/friends/${f.id}`} className="friend-card__name" style={{ textDecoration:'none', color:'inherit' }}>
                            {f.name}
                          </Link>
                          <div className="friend-card__sub">@{f.username}</div>
                        </div>
                        <div className="friend-card__actions">
                          <Link to={`/friends/${f.id}`} className="btn btn--ghost btn--sm">
                            View profile
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
