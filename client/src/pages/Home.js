// Home.js — tabbed dashboard showing the user's plans and friends.
// Fetches nudges, friends, 1:1 itineraries, and group itineraries in parallel on mount.
// All events (1:1 and group) are bucketed into four shared tabs:
//   Waiting for you, Waiting for them, Drafts, Confirmed
// Group events show a 👥 indicator on the right side of their pill.
// Each tab shows the first INITIAL_VISIBLE items; a "Load more" button expands the list.

import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import posthog from 'posthog-js';
import NavBar from '../components/NavBar';
import { getUserName, isOnboardingCompleted } from '../utils/auth';
import client from '../utils/client';

/* ── Constants ──────────────────────────────────────────────── */

const INITIAL_VISIBLE = 3;

/* ── Helpers ────────────────────────────────────────────────── */

function getInitials(name = '') {
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatDateRange(startStr, endStr) {
  if (!startStr) return '';
  const opts = { month: 'short', day: 'numeric' };
  const start = new Date(startStr + 'T00:00:00').toLocaleDateString('en-US', opts);
  if (!endStr || startStr === endStr) return start;
  const end = new Date(endStr + 'T00:00:00').toLocaleDateString('en-US', opts);
  return `${start} – ${end}`;
}

/**
 * Derives the dashboard tab for a 1:1 itinerary.
 * Returns 'drafts' | 'waiting_them' | 'waiting_you' | 'confirmed' | null.
 */
function deriveTab(item) {
  if (item.locked_at) return 'confirmed';
  if (item.organizer_status === 'declined' || item.attendee_status === 'declined') return null;
  if (item.isOrganizer) {
    if (item.organizer_status === 'pending') return 'drafts';
    const hasAttendeeSelected = (item.suggestions || []).some(s => s.attendeeSelected);
    if (item.organizer_status === 'accepted' && hasAttendeeSelected) return 'waiting_you';
    return 'waiting_them';
  } else {
    if (item.organizer_status === 'pending') return null;
    if (item.attendee_status === 'accepted') return 'waiting_them';
    if (item.organizer_status === 'accepted' && item.attendee_status === 'pending') return 'waiting_you';
    return 'waiting_you';
  }
}

/**
 * Derives the dashboard tab for a group itinerary.
 * Returns 'drafts' | 'waiting_them' | 'waiting_you' | 'confirmed' | null.
 */
function deriveGroupTab(gi) {
  if (gi.itinerary_status === 'locked') return 'confirmed';
  if (gi.itinerary_status === 'cancelled') return null;
  if (gi.is_organizer) {
    if (gi.itinerary_status === 'organizer_draft') return 'drafts';
    if (gi.itinerary_status === 'awaiting_responses') return 'waiting_them';
  } else {
    if (gi.itinerary_status === 'awaiting_responses') {
      return (gi.my_vote === 'pending') ? 'waiting_you' : 'waiting_them';
    }
  }
  return null;
}

/* ── Sub-components ─────────────────────────────────────────── */

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

/**
 * Unified event card — handles both 1:1 (item._isGroup falsy) and group (item._isGroup true) items.
 * Group items show a 👥 indicator on the right; draft items show a delete button.
 * onDelete(id, isGroup) is called when the trash icon is clicked.
 */
function EventCard({ item, onDelete }) {
  const isGroup = !!item._isGroup;
  const tab     = isGroup ? deriveGroupTab(item) : deriveTab(item);

  // For confirmed events, find the locked suggestion for its specific date.
  const confirmedSuggestion = tab === 'confirmed'
    ? (item.suggestions || []).find(s => s.id === item.selected_suggestion_id) ?? item.suggestions?.[0]
    : null;

  const firstSuggestion = item.suggestions?.[0];

  const displayDate = confirmedSuggestion
    ? formatDate(confirmedSuggestion.date)
    : isGroup
      ? (firstSuggestion?.date ? formatDate(firstSuggestion.date) : '')
      : formatDateRange(item.date_range_start, item.date_range_end)
        || formatDate(firstSuggestion?.date);

  // Whose initials to show in the avatar.
  const avatarName = isGroup
    ? (item.organizer?.full_name || '')
    : (item.isOrganizer ? item.attendeeName : item.organizerName);

  // Primary title and optional secondary qualifier.
  const titleMain = isGroup
    ? ([item.group_name, item.event_title].filter(Boolean).join(' — ') || 'Group Event')
    : (item.isOrganizer ? item.attendeeName : item.organizerName);
  const titleSub = isGroup
    ? (!item.is_organizer && item.organizer?.full_name ? item.organizer.full_name : null)
    : (item.event_title || null);

  const url = isGroup ? `/group-itineraries/${item.id}` : `/schedule/${item.id}`;

  // Status badge — tab-relative label, more specific for group variants.
  let badgeCls, badgeLabel;
  if (tab === 'confirmed') {
    badgeCls = 'badge--green'; badgeLabel = 'confirmed';
  } else if (tab === 'drafts') {
    badgeCls = 'badge--gray';  badgeLabel = 'draft';
  } else if (tab === 'waiting_you') {
    badgeCls = 'badge--amber'; badgeLabel = isGroup ? 'vote needed' : 'waiting on you';
  } else if (tab === 'waiting_them') {
    badgeCls = 'badge--gray';
    badgeLabel = isGroup && item.is_organizer ? 'waiting for votes'
               : isGroup                      ? 'voted'
               :                                'waiting on them';
  } else {
    badgeCls = 'badge--gray'; badgeLabel = tab || 'pending';
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Link to={url} className="itinerary-card" style={{ flex: 1 }}>
        <div className="avatar avatar--sm">{getInitials(avatarName)}</div>
        <div className="itinerary-card__body">
          <div className="itinerary-card__title">
            {titleMain}
            {titleSub && <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> · {titleSub}</span>}
          </div>
          <div className="itinerary-card__meta">
            {displayDate && <span>{displayDate}</span>}
            {firstSuggestion?.neighborhood && (
              <>
                <span className="itinerary-card__dot" />
                <span>{firstSuggestion.neighborhood}</span>
              </>
            )}
            <span className="itinerary-card__dot" />
            <span className={`badge ${badgeCls}`}>{badgeLabel}</span>
          </div>
        </div>
      </Link>
      {/* Group indicator — visible on all group event pills */}
      {isGroup && (
        <span
          title="Group event"
          style={{ fontSize: '0.8rem', color: 'var(--text-3)', flexShrink: 0, lineHeight: 1 }}
        >
          👥
        </span>
      )}
      {/* Delete button — only shown for draft items */}
      {tab === 'drafts' && onDelete && (
        <button
          className="btn btn--ghost btn--sm"
          title="Delete draft"
          onClick={(e) => { e.preventDefault(); onDelete(item.id, isGroup); }}
          style={{ color: 'var(--text-3)', flexShrink: 0 }}
        >
          🗑
        </button>
      )}
    </div>
  );
}

/* ── Main component ─────────────────────────────────────────── */

export default function Home() {
  const navigate = useNavigate();
  const name     = getUserName();
  const showOnboardingBanner = isOnboardingCompleted() === false;

  const [nudges,       setNudges]       = useState([]);
  const [friends,      setFriends]      = useState([]);
  const [allItins,     setAllItins]     = useState([]);
  const [groupItins,   setGroupItins]   = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [activeTab,    setActiveTab]    = useState('waiting_you');
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [nudgesRes, friendsRes, itinsRes, groupItinsRes] = await Promise.allSettled([
          client.get('/nudges/pending'),
          client.get('/friends'),
          client.get('/schedule/itineraries'),
          client.get('/group-itineraries'),
        ]);
        if (!mounted) return;
        if (nudgesRes.status === 'fulfilled')      setNudges(nudgesRes.value.data?.nudges ?? []);
        if (friendsRes.status === 'fulfilled')     setFriends(friendsRes.value.data?.friends ?? []);
        if (itinsRes.status === 'fulfilled')       setAllItins(itinsRes.value.data?.itineraries ?? []);
        if (groupItinsRes.status === 'fulfilled')  setGroupItins(groupItinsRes.value.data?.itineraries ?? []);
        const itins   = itinsRes.status === 'fulfilled' ? (itinsRes.value.data?.itineraries ?? []) : [];
        const waiting = itins.filter(i => deriveTab(i) === 'waiting_you');
        const inProg  = itins.filter(i => deriveTab(i) === 'waiting_them');
        try { posthog.capture('home_view_loaded', { waiting_count: waiting.length, in_progress_count: inProg.length }); } catch {}
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

  /**
   * Deletes a draft — handles both 1:1 and group itineraries.
   * Optimistic: item is removed from state immediately, API call is best-effort.
   */
  async function handleDeleteDraft(id, isGroup) {
    if (isGroup) {
      setGroupItins(prev => prev.filter(i => i.id !== id));
      try { await client.delete(`/group-itineraries/${id}`); } catch { /* best-effort */ }
    } else {
      setAllItins(prev => prev.filter(i => i.id !== id));
      try { await client.delete(`/schedule/itinerary/${id}`); } catch { /* best-effort */ }
    }
  }

  function byEventDate(a, b) {
    const dateA = a.suggestions?.[0]?.date || a.created_at || '';
    const dateB = b.suggestions?.[0]?.date || b.created_at || '';
    return dateA < dateB ? -1 : dateA > dateB ? 1 : 0;
  }

  // Tag group items so EventCard can distinguish them, then merge both lists.
  const taggedGroupItins = groupItins.map(gi => ({ ...gi, _isGroup: true }));
  const allItems = [...allItins, ...taggedGroupItins];

  // Bucket into four tabs, sorted chronologically within each.
  const tabs = {
    drafts:       allItems.filter(i => (i._isGroup ? deriveGroupTab(i) : deriveTab(i)) === 'drafts').sort(byEventDate),
    waiting_them: allItems.filter(i => (i._isGroup ? deriveGroupTab(i) : deriveTab(i)) === 'waiting_them').sort(byEventDate),
    waiting_you:  allItems.filter(i => (i._isGroup ? deriveGroupTab(i) : deriveTab(i)) === 'waiting_you').sort(byEventDate),
    confirmed:    allItems.filter(i => (i._isGroup ? deriveGroupTab(i) : deriveTab(i)) === 'confirmed').sort(byEventDate),
  };

  const TAB_CONFIG = [
    { key: 'waiting_you',  label: 'Waiting for you' },
    { key: 'waiting_them', label: 'Waiting for them' },
    { key: 'drafts',       label: 'Drafts' },
    { key: 'confirmed',    label: 'Confirmed' },
  ];

  const visibleFriends = friends.slice(0, 4);
  const firstName      = (name || '').split(' ')[0] || 'there';
  const activeItems    = tabs[activeTab] || [];
  const displayedItems = activeItems.slice(0, visibleCount);
  const hasMore        = visibleCount < activeItems.length;
  const hasAnyEvents   = allItems.length > 0;

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container">
          <div style={{ marginBottom: 28 }}>
            <h1 className="home-greeting">Hey {firstName} 👋</h1>
            <p className="home-greeting__sub">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>

          {showOnboardingBanner && (
            <Link
              to="/onboarding"
              className="alert"
              style={{ display: 'block', marginBottom: 16, cursor: 'pointer', textDecoration: 'none', fontWeight: 500 }}
            >
              Finish setting up your profile →
            </Link>
          )}

          {error && <div className="alert alert--error">{error}</div>}

          {loading ? (
            <div className="loading"><div className="spinner spinner--lg" /><span>Loading your dashboard…</span></div>
          ) : (
            <>
              {nudges.length > 0 && (
                <section className="section">
                  <div className="section-title">✨ Suggested plans</div>
                  <div className="scroll-row" role="list">
                    {nudges.map((n) => <NudgeCard key={n.id} nudge={n} onDismiss={dismissNudge} />)}
                  </div>
                </section>
              )}

              <div style={{ marginBottom: 24, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button className="btn btn--primary" onClick={() => navigate('/schedule/new')}>
                  + New Event
                </button>
                <button className="btn btn--primary" onClick={() => navigate('/group-event/new')}>
                  + New Group Event
                </button>
              </div>

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

              {/* Unified tabbed event list — 1:1 and group events comingled */}
              {hasAnyEvents && (
                <section className="section">
                  <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
                    {TAB_CONFIG.map(({ key, label }) => {
                      const count = tabs[key]?.length || 0;
                      return (
                        <button
                          key={key}
                          onClick={() => { setActiveTab(key); setVisibleCount(INITIAL_VISIBLE); }}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: '8px 12px',
                            fontSize: '0.85rem',
                            fontWeight: activeTab === key ? 700 : 400,
                            color: activeTab === key ? 'var(--brand)' : 'var(--text-2)',
                            borderBottom: activeTab === key ? '2px solid var(--brand)' : '2px solid transparent',
                            marginBottom: -1,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {label}{count > 0 ? ` (${count})` : ''}
                        </button>
                      );
                    })}
                  </div>

                  {activeItems.length === 0 ? (
                    <div style={{ padding: '20px 0', color: 'var(--text-3)', fontSize: '0.88rem', textAlign: 'center' }}>
                      Nothing here yet.
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {displayedItems.map((item) => (
                          <EventCard
                            key={item.id}
                            item={item}
                            onDelete={activeTab === 'drafts' ? handleDeleteDraft : null}
                          />
                        ))}
                      </div>

                      {hasMore && (
                        <button
                          className="btn btn--ghost btn--sm"
                          style={{ marginTop: 12, width: '100%' }}
                          onClick={() => setVisibleCount(prev => prev + INITIAL_VISIBLE)}
                        >
                          Load more ({activeItems.length - visibleCount} remaining)
                        </button>
                      )}
                    </>
                  )}
                </section>
              )}

              {/* Empty state — no events, nudges, or friends at all */}
              {!hasAnyEvents && nudges.length === 0 && friends.length === 0 && (
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
