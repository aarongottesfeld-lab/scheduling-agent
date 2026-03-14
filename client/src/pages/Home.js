// Home.js — tabbed dashboard showing the user's plans and friends.
// Fetches nudges, friends, and itineraries in parallel on mount.
// Itineraries are bucketed into four tabs (Drafts, Waiting for them,
// Waiting for you, Confirmed) using client-side status derivation.
// Each tab shows the first INITIAL_VISIBLE items; a "Show all" button
// expands the list without a new API call.

import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import posthog from 'posthog-js';
import NavBar from '../components/NavBar';
import { getUserName, isOnboardingCompleted } from '../utils/auth';
import client from '../utils/client';

/* ── Constants ──────────────────────────────────────────────── */

// How many itinerary cards to show per tab before the "Show all" button appears.
const INITIAL_VISIBLE = 3;

/* ── Helpers ────────────────────────────────────────────────── */

/** Produces two-letter uppercase initials from a full name string. */
function getInitials(name = '') {
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

/**
 * Formats a date string for display on an itinerary card.
 * Uses short weekday/month/day — e.g. "Wed, Mar 12".
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00'); // force local time, not UTC midnight
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Formats a date range for display on pending/draft itinerary cards.
 * If start and end are the same day, shows just that day.
 * Otherwise shows "Mar 10 – Mar 15".
 */
function formatDateRange(startStr, endStr) {
  if (!startStr) return '';
  const opts = { month: 'short', day: 'numeric' };
  const start = new Date(startStr + 'T00:00:00').toLocaleDateString('en-US', opts);
  if (!endStr || startStr === endStr) return start;
  const end = new Date(endStr + 'T00:00:00').toLocaleDateString('en-US', opts);
  return `${start} – ${end}`;
}

/**
 * Derives which dashboard tab an itinerary belongs to based on its status fields.
 * Returns one of: 'drafts' | 'waiting_them' | 'waiting_you' | 'confirmed' | null.
 * null means the item should not appear on any tab (e.g., declined, or draft not
 * yet sent to the attendee).
 *
 * State machine:
 *   Organizer: pending → drafts
 *              sent/accepted (attendee pending) → waiting_them
 *              attendee accepted (counter-proposal) → waiting_you
 *   Attendee:  organizer pending → null (not visible yet)
 *              organizer sent, attendee pending → waiting_you
 *              attendee accepted → waiting_them
 *   Both:      locked_at set → confirmed
 *              either declined → null
 */
function deriveTab(item) {
  if (item.locked_at) return 'confirmed';
  if (item.organizer_status === 'declined' || item.attendee_status === 'declined') return null;
  if (item.isOrganizer) {
    if (item.organizer_status === 'pending') return 'drafts';
    // Attendee counter-proposed: org=accepted, att=pending, attendeeSelected flag set.
    // att stays 'pending' (not 'accepted') to avoid the DB auto-lock trigger.
    const hasAttendeeSelected = (item.suggestions || []).some(s => s.attendeeSelected);
    if (item.organizer_status === 'accepted' && hasAttendeeSelected) return 'waiting_you';
    return 'waiting_them';
  } else {
    if (item.organizer_status === 'pending') return null; // draft, not visible to attendee yet
    if (item.attendee_status === 'accepted') return 'waiting_them';
    // org=accepted means organizer has picked and sent — attendee needs to respond
    if (item.organizer_status === 'accepted' && item.attendee_status === 'pending') return 'waiting_you';
    return 'waiting_you';
  }
}

/* ── Sub-components ─────────────────────────────────────────── */

/**
 * Renders a single AI-generated nudge card with an action CTA and a dismiss button.
 * Nudges are friend-specific prompts suggesting the user reach out and plan something.
 */
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
 * Renders a single itinerary row linking to the itinerary detail page.
 * Shows the friend's name, event title, first suggestion date/neighborhood, and a status badge.
 * Includes a delete button only on draft items (which haven't been sent yet).
 */
function ItineraryCard({ item, onDelete }) {
  const friendName = item.isOrganizer ? item.attendeeName : item.organizerName;
  const tab = deriveTab(item);

  // Confirmed: show the specific date both users agreed to.
  // Pending/draft: show the scheduling window they're choosing from.
  const confirmedSuggestion = tab === 'confirmed'
    ? (item.suggestions || []).find(s => s.id === item.selected_suggestion_id)
      ?? item.suggestions?.[0]  // fallback if selected_suggestion_id is missing
    : null;
  const displayDate = confirmedSuggestion
    ? formatDate(confirmedSuggestion.date)
    : formatDateRange(item.date_range_start, item.date_range_end)
      || formatDate(item.suggestions?.[0]?.date); // fallback for itineraries missing date_range fields

  const firstSuggestion = item.suggestions?.[0];

  const badgeMap = {
    drafts:       { cls: 'badge--gray',  label: 'draft' },
    waiting_them: { cls: 'badge--gray',  label: 'waiting on them' },
    waiting_you:  { cls: 'badge--amber', label: 'waiting on you' },
    confirmed:    { cls: 'badge--green', label: 'confirmed' },
  };
  const badge = badgeMap[tab] || { cls: 'badge--gray', label: tab || 'pending' };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Link to={`/schedule/${item.id}`} className="itinerary-card" style={{ flex: 1 }}>
        <div className="avatar avatar--sm">{getInitials(friendName)}</div>
        <div className="itinerary-card__body">
          <div className="itinerary-card__title">
            {friendName}{item.event_title ? <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> · {item.event_title}</span> : ''}
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
            <span className={`badge ${badge.cls}`}>{badge.label}</span>
          </div>
        </div>
      </Link>
      {/* Delete button is only available on unsent drafts to prevent accidental deletion. */}
      {tab === 'drafts' && onDelete && (
        <button
          className="btn btn--ghost btn--sm"
          title="Delete draft"
          onClick={(e) => { e.preventDefault(); onDelete(item.id); }}
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
  // Show banner when onboarding hasn't been completed yet.
  // isOnboardingCompleted() is set by App.js before routes render, so this
  // value is stable by the time Home mounts.
  const showOnboardingBanner = isOnboardingCompleted() === false;

  const [nudges,       setNudges]       = useState([]);
  const [friends,      setFriends]      = useState([]);
  const [allItins,     setAllItins]     = useState([]);
  const [groupItins,   setGroupItins]   = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [activeTab,    setActiveTab]    = useState('waiting_you');
  // How many items are currently visible in the active tab.
  // Starts at INITIAL_VISIBLE and grows by INITIAL_VISIBLE on each "Load more" click.
  // Resets to INITIAL_VISIBLE whenever the user switches tabs.
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);

  // Fetch all dashboard data in parallel on mount using Promise.allSettled so a
  // single failing request doesn't block the rest of the page from rendering.
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
        // PostHog targeting event — used by in-app tooltip triggers
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

  /**
   * Optimistically removes the nudge from the list, then fires the dismiss API call.
   * Best-effort: a failed dismiss won't bring the nudge back.
   */
  async function dismissNudge(id) {
    setNudges((prev) => prev.filter((n) => n.id !== id));
    try { await client.post(`/nudges/${id}/dismiss`); } catch { /* best-effort */ }
  }

  /**
   * Optimistically removes the draft from the list, then fires the delete API call.
   * Best-effort: a failed delete won't restore the item in the UI.
   */
  async function deleteDraft(id) {
    setAllItins((prev) => prev.filter((i) => i.id !== id));
    try { await client.delete(`/schedule/itinerary/${id}`); } catch { /* best-effort */ }
  }

  // Sort itineraries by the first suggestion's date ascending (soonest first).
  // Falls back to created_at if no suggestion date is present (e.g. reroll in progress).
  function byEventDate(a, b) {
    const dateA = a.suggestions?.[0]?.date || a.created_at || '';
    const dateB = b.suggestions?.[0]?.date || b.created_at || '';
    return dateA < dateB ? -1 : dateA > dateB ? 1 : 0;
  }

  // Bucket all itineraries into their respective tab categories, each sorted chronologically.
  const tabs = {
    drafts:       allItins.filter(i => deriveTab(i) === 'drafts').sort(byEventDate),
    waiting_them: allItins.filter(i => deriveTab(i) === 'waiting_them').sort(byEventDate),
    waiting_you:  allItins.filter(i => deriveTab(i) === 'waiting_you').sort(byEventDate),
    confirmed:    allItins.filter(i => deriveTab(i) === 'confirmed').sort(byEventDate),
  };

  const TAB_CONFIG = [
    { key: 'waiting_you',  label: 'Waiting for you' },
    { key: 'waiting_them', label: 'Waiting for them' },
    { key: 'drafts',       label: 'Drafts' },
    { key: 'confirmed',    label: 'Confirmed' },
  ];

  // Show only the first 4 friends as avatar chips; "View all" links to /friends.
  const visibleFriends = friends.slice(0, 4);
  const firstName = (name || '').split(' ')[0] || 'there';
  const activeItems = tabs[activeTab] || [];
  // Show only the first visibleCount items; "Load more" increments this.
  const displayedItems = activeItems.slice(0, visibleCount);
  const hasMore = visibleCount < activeItems.length;

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

          {/* Onboarding completion banner — shown when onboarding_completed_at is null */}
          {showOnboardingBanner && (
            <Link
              to="/onboarding"
              className="alert"
              style={{
                display: 'block', marginBottom: 16, cursor: 'pointer',
                textDecoration: 'none', fontWeight: 500,
              }}
            >
              Finish setting up your profile →
            </Link>
          )}

          {error && <div className="alert alert--error">{error}</div>}

          {loading ? (
            <div className="loading"><div className="spinner spinner--lg" /><span>Loading your dashboard…</span></div>
          ) : (
            <>
              {/* AI-generated nudges prompting the user to reach out to friends */}
              {nudges.length > 0 && (
                <section className="section">
                  <div className="section-title">✨ Suggested plans</div>
                  <div className="scroll-row" role="list">
                    {nudges.map((n) => <NudgeCard key={n.id} nudge={n} onDismiss={dismissNudge} />)}
                  </div>
                </section>
              )}

              {/* Primary CTA to start a new event */}
              <div style={{ marginBottom: 24 }}>
                <button className="btn btn--primary" onClick={() => navigate('/schedule/new')}>
                  + New Event
                </button>
              </div>

              {/* Friends strip — first 4 friends as tappable avatar chips */}
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

              {/* Group event pills */}
              {groupItins.length > 0 && (
                <section className="section">
                  <div className="section-title">
                    Group Events
                    <Link to="/groups" className="section-link">View groups →</Link>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {groupItins.map(gi => {
                      const firstSug = gi.suggestions?.[0];
                      let badge, badgeCls;
                      if (gi.is_organizer) {
                        if (gi.itinerary_status === 'organizer_draft') { badge = 'draft'; badgeCls = 'badge--gray'; }
                        else if (gi.itinerary_status === 'awaiting_responses') { badge = 'waiting for votes'; badgeCls = 'badge--gray'; }
                        else if (gi.itinerary_status === 'locked') { badge = 'locked'; badgeCls = 'badge--green'; }
                        else { badge = gi.itinerary_status; badgeCls = 'badge--gray'; }
                      } else {
                        if (gi.my_vote === 'pending') { badge = 'vote needed'; badgeCls = 'badge--amber'; }
                        else if (gi.my_vote === 'accepted') { badge = 'voted'; badgeCls = 'badge--gray'; }
                        else if (gi.itinerary_status === 'locked') { badge = 'locked'; badgeCls = 'badge--green'; }
                        else { badge = gi.my_vote || 'pending'; badgeCls = 'badge--gray'; }
                      }
                      return (
                        <Link key={gi.id} to={`/group-itineraries/${gi.id}`} className="itinerary-card">
                          <div className="avatar avatar--sm">{getInitials(gi.organizer?.full_name || '')}</div>
                          <div className="itinerary-card__body">
                            <div className="itinerary-card__title">
                              {gi.event_title || 'Group Event'}
                              {!gi.is_organizer && gi.organizer?.full_name && (
                                <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> · {gi.organizer.full_name}</span>
                              )}
                            </div>
                            <div className="itinerary-card__meta">
                              {firstSug?.date && <span>{formatDate(firstSug.date)}</span>}
                              {firstSug?.neighborhood && (
                                <>
                                  <span className="itinerary-card__dot" />
                                  <span>{firstSug.neighborhood}</span>
                                </>
                              )}
                              <span className="itinerary-card__dot" />
                              <span className={`badge ${badgeCls}`}>{badge}</span>
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Tabbed itinerary list */}
              {allItins.length > 0 && (
                <section className="section">
                  {/* Tab bar — clicking a tab also resets the "show all" expansion. */}
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

                  {/* Tab content — shows visibleCount items; "Load more" reveals the next batch */}
                  {activeItems.length === 0 ? (
                    <div style={{ padding: '20px 0', color: 'var(--text-3)', fontSize: '0.88rem', textAlign: 'center' }}>
                      Nothing here yet.
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {displayedItems.map((item) => (
                          <ItineraryCard
                            key={item.id}
                            item={item}
                            onDelete={activeTab === 'drafts' ? deleteDraft : null}
                          />
                        ))}
                      </div>

                      {/* Load more button — increments visibleCount by INITIAL_VISIBLE each click.
                          All items are already in state so no extra API call is needed. */}
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

              {/* Empty state — first time the user has no plans, nudges, or friends */}
              {allItins.length === 0 && groupItins.length === 0 && nudges.length === 0 && friends.length === 0 && (
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
