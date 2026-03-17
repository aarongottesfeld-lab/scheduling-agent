// Friends.js — friends management page
// Three sections: user search, incoming friend requests, and the accepted friends list.
// All friend mutations (add, accept/decline, remove) update local state optimistically
// so the UI responds immediately without a full reload.
// Privacy: only supabaseId sent to PostHog — no PII, no health data, no calendar content
import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import posthog from 'posthog-js';
import NavBar from '../components/NavBar';
import { searchUserByEmail } from '../utils/api';
import client from '../utils/client';
import { getInitials } from '../utils/formatting';

const APP_URL = process.env.REACT_APP_URL || window.location.origin;

export default function Friends() {
  const [query,     setQuery]     = useState('');
  const [results,   setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState('');

  const [requests,  setRequests]  = useState([]);
  const [friends,   setFriends]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');

  // Inline action errors instead of alert()
  const [actionErr, setActionErr] = useState('');

  // confirmRemoveId: the friend.id whose remove-confirmation row is currently showing.
  // null means no confirmation is open. Set to a friend's id to reveal the inline
  // "Remove [name]? Yes / Cancel" row for that specific card only.
  const [confirmRemoveId, setConfirmRemoveId] = useState(null);

  const [copied,    setCopied]    = useState(false);
  const [myProfile, setMyProfile] = useState(null);

  // Fetch friends list, incoming requests, and own profile in parallel on mount.
  // Uses allSettled so a single failing request doesn't blank the whole page.
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
        if (friendsRes.status === 'fulfilled') {
          const confirmed = friendsRes.value.data?.friends ?? [];
          setFriends(confirmed);
          // PostHog targeting event — used by in-app tooltip triggers
          try { posthog.capture('friends_view_loaded', { confirmed_friend_count: confirmed.length }); } catch {}
        }
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

  /**
   * Searches users by email or username. Wraps the shared searchUserByEmail helper.
   * Clears previous results on each new submission so stale data is never shown.
   */
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

  /**
   * Sends a friend request to a search result user.
   * Optimistically marks the result card as "Request sent" so the button
   * disappears immediately without a refetch.
   */
  async function sendRequest(userId) {
    setActionErr('');
    try {
      await client.post('/friends/request', { targetUserId: userId });
      setResults((prev) => prev.map((u) =>
        u.id === userId ? { ...u, requestSent: true } : u
      ));
      // TODO: onboarding_completed — wire here once the onboarding flow is built.
      try { posthog.capture('friend_added'); } catch {}
    } catch (err) {
      setActionErr(err.response?.data?.error || err.message || 'Could not send friend request.');
    }
  }

  /**
   * Accepts or declines a pending incoming friend request.
   * On accept, refetches the friends list so the new friend appears immediately.
   * On decline, just removes the request card from the pending list.
   */
  async function respondToRequest(requestId, accept) {
    setActionErr('');
    try {
      await client.post(`/friends/requests/${requestId}/${accept ? 'accept' : 'decline'}`);
      setRequests((prev) => prev.filter((r) => r.id !== requestId));
      if (accept) {
        const res = await client.get('/friends');
        setFriends(res.data?.friends ?? []);
      }
    } catch (err) {
      setActionErr(err.response?.data?.error || err.message || 'Could not respond to request.');
    }
  }

  /**
   * Removes an accepted friend. Called only after the user has confirmed via the
   * inline confirmation row (confirmRemoveId === friendId), so no window.confirm() needed.
   * Optimistically removes the friend from local state on success so the card
   * disappears immediately. Sets actionErr on failure so the user knows it didn't work.
   * Only available on the accepted friends list — not search results or pending requests.
   *
   * @param {string} friendId - Supabase UUID of the friend to remove
   */
  async function removeFriend(friendId) {
    setConfirmRemoveId(null); // close the confirmation row regardless of outcome
    setActionErr('');
    try {
      await client.delete(`/friends/${friendId}`);
      // Optimistic update: remove from local state without a full refetch
      setFriends((prev) => prev.filter((f) => f.id !== friendId));
    } catch (err) {
      setActionErr(err.message || 'Could not remove friend. Please try again.');
    }
  }

  /**
   * Copies the user's shareable profile URL to the clipboard.
   * Falls back to a prompt() dialog on browsers that block clipboard access.
   */
  async function handleShareProfile() {
    const username = myProfile?.username;
    if (!username) return;
    const url = `${APP_URL}/u/${username}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      prompt('Copy your profile link:', url);
    }
  }

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container">

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
          {actionErr && (
            <div className="alert alert--error" style={{ marginBottom: 16 }}>
              {actionErr}
              <button
                onClick={() => setActionErr('')}
                style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
              >
                ✕
              </button>
            </div>
          )}

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
                    <Link to={`/friends/${user.id}`} className="avatar" style={{ textDecoration:'none' }}>
                      {getInitials(user.name)}
                    </Link>
                    <div className="friend-card__info">
                      <Link to={`/friends/${user.id}`} className="friend-card__name" style={{ textDecoration:'none', color:'inherit' }}>
                        {user.name}
                      </Link>
                      <div className="friend-card__sub">@{user.username}</div>
                    </div>
                    <div className="friend-card__actions">
                      {user.isFriend ? (
                        <span className="badge badge--green">Friends</span>
                      ) : (user.friendshipStatus === 'pending' || user.requestSent) ? (
                        // 'pending' covers both outgoing requests (server returned friendshipStatus)
                        // and optimistically-sent requests (requestSent flag set by sendRequest()).
                        <span className="badge badge--gray">Pending</span>
                      ) : (
                        <button className="btn btn--secondary btn--sm" onClick={() => sendRequest(user.id)}>
                          Add
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
                          <button className="btn btn--success btn--sm" onClick={() => respondToRequest(req.id, true)}>Accept</button>
                          <button className="btn btn--ghost btn--sm" onClick={() => respondToRequest(req.id, false)}>Decline</button>
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
                      <div key={f.id} className="friend-card" style={{ flexWrap: 'wrap' }}>
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
                          <Link to={`/friends/${f.id}`} className="btn btn--ghost btn--sm">View profile</Link>
                          {/* Muted color signals secondary/destructive — clicking shows the
                              inline confirmation row instead of a blocking window.confirm(). */}
                          <button
                            className="btn btn--ghost btn--sm"
                            style={{ color: 'var(--text-3)' }}
                            onClick={() => setConfirmRemoveId(f.id)}
                          >
                            Remove
                          </button>
                        </div>

                        {/* Inline confirmation row — only visible for the card that was clicked.
                            Replaces window.confirm() so the rest of the page stays interactive. */}
                        {confirmRemoveId === f.id && (
                          <div
                            style={{
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              paddingTop: 10,
                              borderTop: '1px solid var(--border)',
                              fontSize: '0.88rem',
                              color: 'var(--text-2)',
                            }}
                          >
                            <span>Remove {f.name.split(' ')[0]} as a friend?</span>
                            <button
                              className="btn btn--ghost btn--sm"
                              style={{ color: 'var(--danger, #c0392b)', fontWeight: 600 }}
                              onClick={() => removeFriend(f.id)}
                            >
                              Yes, remove
                            </button>
                            <button
                              className="btn btn--ghost btn--sm"
                              onClick={() => setConfirmRemoveId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
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
