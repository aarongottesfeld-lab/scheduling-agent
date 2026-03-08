// 5/10 — Home
// Dashboard: AI nudge cards, friends preview, itineraries awaiting response,
// and upcoming confirmed events.

import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';
import { getUserName } from '../utils/auth';
import client from '../utils/client';

/* ── Helpers ────────────────────────────────────────────────── */
function getInitials(name = '') {
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function statusBadge(status) {
  const map = {
    pending:   'badge--amber',
    sent:      'badge',
    accepted:  'badge--green',
    declined:  'badge--red',
    confirmed: 'badge--green',
  };
  return `badge ${map[status] || 'badge--gray'}`;
}

/* ── Nudge card ─────────────────────────────────────────────── */
function NudgeCard({ nudge, onDismiss }) {
  return (
    <div className="nudge-card">
      <p className="nudge-card__reason">{nudge.reason}</p>
      <div className="nudge-card__actions">
        <Link
          to={`/schedule/new?friendId=${nudge.friendId}`}
          className="btn btn--primary btn--sm"
        >
          Let's do it
        </Link>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => onDismiss(nudge.id)}
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}

/* ── Itinerary list item ─────────────────────────────────────── */
function ItineraryCard({ item }) {
  return (
    <Link to={`/schedule/${item.id}`} className="itinerary-card">
      <div className="avatar avatar--sm">{getInitials(item.friendName)}</div>
      <div className="itinerary-card__body">
        <div className="itinerary-card__title">{item.friendName}</div>
        <div className="itinerary-card__meta">
          {item.date && <span>{formatDate(item.date)}</span>}
          {item.activityType && (
            <>
              <span className="itinerary-card__dot" />
              <span className="badge badge--gray" style={{ textTransform: 'none', fontWeight: 500, letterSpacing: 0 }}>
                {item.activityType}
              </span>
            </>
          )}
          <span className="itinerary-card__dot" />
          <span className={statusBadge(item.status)}>{item.status}</span>
        </div>
      </div>
    </Link>
  );
}

/* ── Component ──────────────────────────────────────────────── */
export default function Home() {
  const navigate = useNavigate();
  const name     = getUserName();

  const [nudges,    setNudges]    = useState([]);
  const [friends,   setFriends]   = useState([]);
  const [waiting,   setWaiting]   = useState([]);
  const [upcoming,  setUpcoming]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const [nudgesRes, friendsRes, waitingRes, upcomingRes] = await Promise.allSettled([
          client.get('/nudges/pending'),
          client.get('/friends'),
          client.get('/schedule/itineraries?filter=waiting'),
          client.get('/schedule/itineraries?filter=upcoming'),
        ]);

        if (!mounted) return;

        if (nudgesRes.status === 'fulfilled')   setNudges(nudgesRes.value.data?.nudges   ?? []);
        if (friendsRes.status === 'fulfilled')  setFriends(friendsRes.value.data?.friends ?? []);
        if (waitingRes.status === 'fulfilled')  setWaiting(waitingRes.value.data?.itineraries ?? []);
        if (upcomingRes.status === 'fulfilled') setUpcoming(upcomingRes.value.data?.itineraries ?? []);
      } catch {
        if (mounted) setError('Could not load your dashboard. Please refresh.');
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => { mounted = false; };
  }, []);

  async function dismissNudge(id) {
    setNudges((prev) => prev.filter((n) => n.id !== id));
    try {
      await client.post(`/nudges/${id}/dismiss`);
    } catch {
      // Best-effort dismiss; silently ignore
    }
  }

  const visibleFriends = friends.slice(0, 4);
  const firstName      = (name || '').split(' ')[0] || 'there';

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container">

          {/* Greeting */}
          <div style={{ marginBottom: 28 }}>
            <h1 className="home-greeting">Hey {firstName} 👋</h1>
            <p className="home-greeting__sub">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>

          {error && <div className="alert alert--error">{error}</div>}

          {loading ? (
            <div className="loading"><div className="spinner spinner--lg" /><span>Loading your dashboard…</span></div>
          ) : (
            <>
              {/* ── AI Nudges ─────────────────────────────── */}
              {nudges.length > 0 && (
                <section className="section">
                  <div className="section-title">
                    ✨ Suggested plans
                  </div>
                  <div className="scroll-row" role="list">
                    {nudges.map((n) => (
                      <NudgeCard key={n.id} nudge={n} onDismiss={dismissNudge} />
                    ))}
                  </div>
                </section>
              )}

              {/* ── New event CTA ─────────────────────────── */}
              <div style={{ marginBottom: 28 }}>
                <button
                  className="btn btn--primary"
                  onClick={() => navigate('/schedule/new')}
                >
                  + New Event
                </button>
              </div>

              {/* ── Friends preview ───────────────────────── */}
              {visibleFriends.length > 0 && (
                <section className="section">
                  <div className="section-title">
                    Friends
                    <Link to="/friends" className="section-link">View all →</Link>
                  </div>
                  <div className="friends-preview">
                    {visibleFriends.map((f) => (
                      <Link
                        key={f.id}
                        to={`/friends/${f.id}`}
                        className="friend-mini"
                      >
                        <div className="avatar">{getInitials(f.name)}</div>
                        <span className="friend-mini__name">{f.name.split(' ')[0]}</span>
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              {/* ── Waiting on you ────────────────────────── */}
              {waiting.length > 0 && (
                <section className="section">
                  <div className="section-title">Waiting on you</div>
                  {waiting.map((item) => (
                    <ItineraryCard key={item.id} item={item} />
                  ))}
                </section>
              )}

              {/* ── Upcoming ─────────────────────────────── */}
              {upcoming.length > 0 && (
                <section className="section">
                  <div className="section-title">Upcoming</div>
                  {upcoming.map((item) => (
                    <ItineraryCard key={item.id} item={item} />
                  ))}
                </section>
              )}

              {/* Empty state */}
              {!nudges.length && !waiting.length && !upcoming.length && friends.length === 0 && (
                <div className="card card-pad">
                  <div className="empty-state">
                    <div className="empty-state__icon">📅</div>
                    <div className="empty-state__title">Your schedule is wide open</div>
                    <p className="empty-state__text">
                      Add friends and create your first event to get started.
                    </p>
                    <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                      <Link to="/friends" className="btn btn--secondary">Add Friends</Link>
                      <button className="btn btn--primary" onClick={() => navigate('/schedule/new')}>New Event</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
