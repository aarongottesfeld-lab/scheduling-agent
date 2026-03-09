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

/**
 * Derive a human-readable status from an itinerary row.
 * isOrganizer = whether the current user is the organizer.
 */
function deriveStatus(item) {
  if (item.locked_at) return 'confirmed';
  if (item.organizer_status === 'declined' || item.attendee_status === 'declined') return 'declined';

  if (item.isOrganizer) {
    // Organizer perspective
    if (item.organizer_status === 'pending') return 'draft';           // not sent yet
    if (item.attendee_status  === 'pending') return 'awaiting them';   // sent, friend hasn't responded
    if (item.attendee_status  === 'accepted') return 'they accepted';  // friend accepted, you need to confirm
  } else {
    // Attendee perspective
    if (item.organizer_status === 'sent' && item.attendee_status === 'pending') return 'respond';
    if (item.attendee_status  === 'accepted') return 'awaiting them';
  }
  return 'pending';
}

function statusBadge(status) {
  const map = {
    confirmed:      'badge--green',
    declined:       'badge--red',
    'respond':      'badge--amber',
    draft:          'badge--gray',
    'awaiting them':'badge--gray',
    'they accepted':'badge--amber',
    pending:        'badge--gray',
  };
  return `badge ${map[status] || 'badge--gray'}`;
}

/* ── Nudge card ─────────────────────────────────────────────── */
function NudgeCard({ nudge, onDismiss }) {
  return (
    <div className="nudge-card">
      <p className="nudge-card__reason">{nudge.reason}</p>
      <div className="nudge-card__actions">
        <Link to={`/schedule/new?friendId=${nudge.friendId}`} className="btn btn--primary btn--sm">
          Let's do it
        </Link>
        <button className="btn btn--ghost btn--sm" onClick={() => onDismiss(nudge.id)}>
          Maybe later
        </button>
      </div>
    </div>
  );
}

/* ── Itinerary list item ─────────────────────────────────────── */
function ItineraryCard({ item }) {
  const friendName = item.isOrganizer ? item.attendeeName : item.organizerName;
  const firstSuggestion = item.suggestions?.[0];
  const displayDate = firstSuggestion?.date;
  const status = deriveStatus(item);

  return (
    <Link to={`/schedule/${item.id}`} className="itinerary-card">
      <div className="avatar avatar--sm">{getInitials(friendName)}</div>
      <div className="itinerary-card__body">
        <div className="itinerary-card__title">
            {friendName}{item.event_title ? <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> · {item.event_title}</span> : ''}
          </div>
        <div className="itinerary-card__meta">
          {displayDate && <span>{formatDate(displayDate)}</span>}
          {firstSuggestion?.neighborhood && (
            <>
              <span className="itinerary-card__dot" />
              <span>{firstSuggestion.neighborhood}</span>
            </>
          )}
          <span className="itinerary-card__dot" />
          <span className={statusBadge(status)}>{status}</span>
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
  const [allItins,  setAllItins]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const [nudgesRes, friendsRes, itinsRes] = await Promise.allSettled([
          client.get('/nudges/pending'),
          client.get('/friends'),
          client.get('/schedule/itineraries'),
        ]);

        if (!mounted) return;
        if (nudgesRes.status === 'fulfilled')  setNudges(nudgesRes.value.data?.nudges   ?? []);
        if (friendsRes.status === 'fulfilled') setFriends(friendsRes.value.data?.friends ?? []);
        if (itinsRes.status === 'fulfilled')   setAllItins(itinsRes.value.data?.itineraries ?? []);
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
    try { await client.post(`/nudges/${id}/dismiss`); } catch { /* best-effort */ }
  }

  // Split itineraries into sections client-side so we use one API call
  const waiting = allItins.filter(i => {
    if (i.locked_at) return false;
    if (i.organizer_status === 'declined' || i.attendee_status === 'declined') return false;
    // "Waiting on you" = you need to take action
    if (!i.isOrganizer && i.organizer_status === 'sent' && i.attendee_status === 'pending') return true;
    if (i.isOrganizer && i.attendee_status === 'accepted' && i.organizer_status !== 'accepted') return true;
    return false;
  });

  const inProgress = allItins.filter(i => {
    if (i.locked_at) return false;
    if (i.organizer_status === 'declined' || i.attendee_status === 'declined') return false;
    // Active but not waiting on current user
    return !waiting.includes(i);
  });

  const upcoming = allItins.filter(i => !!i.locked_at);

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
                  <div className="section-title">✨ Suggested plans</div>
                  <div className="scroll-row" role="list">
                    {nudges.map((n) => (
                      <NudgeCard key={n.id} nudge={n} onDismiss={dismissNudge} />
                    ))}
                  </div>
                </section>
              )}

              {/* ── New event CTA ─────────────────────────── */}
              <div style={{ marginBottom: 28 }}>
                <button className="btn btn--primary" onClick={() => navigate('/schedule/new')}>
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
                      <Link key={f.id} to={`/friends/${f.id}`} className="friend-mini">
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
                  {waiting.map((item) => <ItineraryCard key={item.id} item={item} />)}
                </section>
              )}

              {/* ── In progress ───────────────────────────── */}
              {inProgress.length > 0 && (
                <section className="section">
                  <div className="section-title">In progress</div>
                  {inProgress.map((item) => <ItineraryCard key={item.id} item={item} />)}
                </section>
              )}

              {/* ── Upcoming ─────────────────────────────── */}
              {upcoming.length > 0 && (
                <section className="section">
                  <div className="section-title">Upcoming</div>
                  {upcoming.map((item) => <ItineraryCard key={item.id} item={item} />)}
                </section>
              )}

              {/* Empty state */}
              {!nudges.length && !waiting.length && !inProgress.length && !upcoming.length && friends.length === 0 && (
                <div className="card card-pad">
                  <div className="empty-state">
                    <div className="empty-state__icon">📅</div>
                    <div className="empty-state__title">Your schedule is wide open</div>
                    <p className="empty-state__text">Add friends and create your first event to get started.</p>
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
