// GroupItineraryView.js — Group itinerary detail / voting screen.
//
// Handles all four itinerary_status states:
//   organizer_draft    → organizer reviews suggestions before sending to the group.
//                        Shows "Draft — not sent yet" banner. Send + Re-roll buttons.
//   awaiting_responses → voting is open. Organizer sees tallies + re-roll.
//                        Attendees see per-card vote buttons (Accept / Decline / Abstain).
//   locked             → winner is shown prominently. Read-only.
//   cancelled          → cancelled state with final tally.
//
// Suggestion cards reuse the same venue/days display logic from ItineraryView.js.
// Comment sidebar per card: expandable inline thread with add-comment form.
//
// Auth: is_organizer and vote_status are computed server-side and returned by GET /:id.
// The current user's vote on a card is read from vote_status[myId].vote.

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';
import {
  getGroupItinerary,
  sendGroupItinerary,
  voteOnGroupItinerary,
  rerollGroupItinerary,
  addGroupComment,
  getGroupComments,
} from '../utils/api';
import { getSupabaseId } from '../utils/auth';

/* ── Helpers ────────────────────────────────────────────────────────── */

/** Two uppercase initials from a name string. */
function getInitials(name = '') {
  return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

/**
 * Formats a YYYY-MM-DD date + optional time string into a human-readable label.
 * Uses local date construction to avoid UTC off-by-one (same as ItineraryView.js).
 */
function formatDateTime(dateStr, timeStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  if (isNaN(d)) return dateStr;
  const datePart = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return timeStr ? `${datePart} at ${timeStr}` : datePart;
}

/**
 * Count votes across all attendees for a given vote value ('accepted'|'declined'|'abstained').
 * voteStatus shape: { user_id: { vote, profile } }
 */
function countVotes(voteStatus, voteValue) {
  return Object.values(voteStatus || {}).filter(v => v.vote === voteValue).length;
}

/* ── CommentThread ──────────────────────────────────────────────────── */

/**
 * Expandable inline comment thread for a single suggestion card.
 * Loads comments on expand (lazy), then allows adding new ones.
 */
function CommentThread({ itineraryId, suggestionId, isOpen, onToggle }) {
  const [comments,  setComments]  = useState([]);
  const [loaded,    setLoaded]    = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [body,      setBody]      = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [addError,  setAddError]  = useState('');

  // Load comments the first time the thread is opened
  useEffect(() => {
    if (!isOpen || loaded) return;
    setLoading(true);
    getGroupComments(itineraryId, { suggestion_id: suggestionId })
      .then(data => { setComments(data.comments || []); setLoaded(true); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen, loaded, itineraryId, suggestionId]);

  async function handleAddComment(e) {
    e.preventDefault();
    if (!body.trim()) return;
    setSubmitting(true);
    setAddError('');
    try {
      const data = await addGroupComment(itineraryId, suggestionId, body.trim());
      setComments(prev => [...prev, data.comment]);
      setBody('');
    } catch (e) {
      setAddError(e.message || 'Could not add comment.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 10 }}>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        style={{ fontSize: '0.8rem', padding: '4px 0' }}
        onClick={onToggle}
      >
        {isOpen ? '▲ Hide comments' : `💬 Comments${comments.length ? ` (${comments.length})` : ''}`}
      </button>

      {isOpen && (
        <div style={{ marginTop: 10 }}>
          {loading && <div style={{ fontSize: '0.82rem', color: 'var(--text-3)' }}>Loading…</div>}
          {!loading && loaded && comments.length === 0 && (
            <div style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginBottom: 10 }}>
              No comments yet.
            </div>
          )}
          {/* Comment list */}
          {comments.map(c => (
            <div key={c.id} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <div className="avatar avatar--sm" style={{ width: 22, height: 22, fontSize: '0.65rem' }}>
                  {getInitials(c.author?.full_name || '')}
                </div>
                <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                  {c.author?.full_name || 'Member'}
                </span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-4)' }}>
                  {c.created_at ? new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                </span>
              </div>
              <div style={{ fontSize: '0.85rem', paddingLeft: 28, color: 'var(--text-1)' }}>{c.body}</div>
            </div>
          ))}

          {/* Add comment form */}
          {addError && (
            <div style={{ fontSize: '0.8rem', color: 'var(--danger)', marginBottom: 6 }}>{addError}</div>
          )}
          <form onSubmit={handleAddComment} style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input
              type="text"
              className="form-control"
              value={body}
              onChange={e => setBody(e.target.value.slice(0, 2000))}
              placeholder="Add a comment…"
              disabled={submitting}
              style={{ flex: 1, padding: '6px 10px', fontSize: '0.85rem' }}
            />
            <button
              type="submit"
              className="btn btn--primary btn--sm"
              disabled={submitting || !body.trim()}
            >
              {submitting ? '…' : 'Post'}
            </button>
          </form>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-4)', marginTop: 3 }}>
            {body.length}/2000
          </div>
        </div>
      )}
    </div>
  );
}

/* ── GroupSuggestionCard ────────────────────────────────────────────── */

/**
 * Single suggestion card for a group itinerary.
 * Adapts ItineraryView.js SuggestionCard for the group voting context:
 *   - Shows vote tally (organizer view) or per-card vote buttons (attendee view)
 *   - Expandable comment thread at the bottom
 *   - Locked state: highlighted if this is the winning suggestion
 */
function GroupSuggestionCard({
  suggestion,
  itinerary,
  voteStatus,
  isOrganizer,
  myId,
  status,       // itinerary_status
  onVote,       // (suggestionId, vote) => void — attendee action
  onSend,       // () => void — organizer sends draft
  onReroll,     // () => void — organizer rerolls
  sending,
  rerolling,
  actingCardId, // which card currently has a pending vote action
}) {
  const [expanded,        setExpanded]        = useState(false);
  const [commentOpen,     setCommentOpen]     = useState(false);

  const isLocked    = status === 'locked';
  const isWinner    = isLocked && itinerary.selected_suggestion_id === suggestion.id;
  const myVote      = voteStatus?.[myId]?.vote; // the current user's own vote (attendees only)
  const isBusy      = actingCardId === suggestion.id;
  const isDraft     = status === 'organizer_draft';
  const isAwaiting  = status === 'awaiting_responses';

  // Count votes across all attendees for this suggestion.
  // Note: the server does not track per-suggestion vote preferences before lock —
  // attendee_statuses records only the overall accept/decline per attendee, not a
  // per-suggestion preference. So vote tally = accepts / total for the whole itinerary.
  const totalAttendees = Object.keys(voteStatus || {}).length;
  const acceptCount    = countVotes(voteStatus, 'accepted');
  const declineCount   = countVotes(voteStatus, 'declined');
  const respondedCount = Object.values(voteStatus || {}).filter(v => v.vote !== 'pending').length;

  const narrative = suggestion.narrative || '';
  const truncated = narrative.length > 120 ? narrative.slice(0, 120) + '…' : narrative;

  return (
    <div
      className={`suggestion-card${isWinner ? ' suggestion-card--confirmed' : ''}`}
      style={{ marginBottom: 16, opacity: isLocked && !isWinner ? 0.55 : 1 }}
    >
      {/* ── Card header ── */}
      <div className={`suggestion-card__header${isWinner ? ' suggestion-card__header--confirmed' : ''}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="suggestion-card__date">{formatDateTime(suggestion.date, suggestion.time)}</div>
            {suggestion.neighborhood && (
              <div className="suggestion-card__neighborhood">📍 {suggestion.neighborhood}</div>
            )}
          </div>
          {/* Winner badge */}
          {isWinner && (
            <span
              className="badge"
              style={{ background: 'rgba(255,255,255,.25)', color: '#fff', fontSize: '0.75rem' }}
            >
              ✓ Locked
            </span>
          )}
        </div>

        {/* Organizer vote tally (awaiting_responses only) */}
        {isOrganizer && isAwaiting && (
          <div style={{ marginTop: 8, fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
            {respondedCount}/{totalAttendees} responded · {acceptCount} ✓ accepted · {declineCount} ✗ declined
          </div>
        )}
      </div>

      {/* ── Card body ── */}
      <div className="suggestion-card__body">
        {!expanded && narrative && (
          <p className="suggestion-card__narrative">{truncated}</p>
        )}
        <button
          className="btn btn--ghost btn--sm"
          style={{ marginTop: 8, padding: '4px 0', fontSize: '0.82rem' }}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? 'Collapse ↑' : 'See details ↓'}
        </button>

        {/* Expanded venue + detail panel — same rendering logic as ItineraryView.js */}
        <div style={{ overflow: 'hidden', maxHeight: expanded ? '2000px' : '0', opacity: expanded ? 1 : 0, transition: 'max-height 0.3s ease, opacity 0.3s ease' }}>
          {narrative && (
            <p className="suggestion-card__narrative" style={{ marginTop: 8 }}>{narrative}</p>
          )}
          {(() => {
            // Backward-compat: new rows use days[]; pre-migration rows use flat venues[]
            const isMultiDay = suggestion.days?.length > 1;
            const allDays = isMultiDay
              ? suggestion.days
              : [{ day: 1, label: null, stops: suggestion.days?.[0]?.stops ?? suggestion.venues ?? [] }];

            const allStops = allDays.flatMap(d => d.stops || []);
            if (!allStops.length) return null;

            return allDays.map(day => {
              const stops = day.stops || [];
              if (!stops.length) return null;
              return (
                <div key={day.day} style={{ marginTop: 12 }}>
                  {isMultiDay && (
                    <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {day.label ? `Day ${day.day} — ${day.label}` : `Day ${day.day}`}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {stops.map((v, i) => {
                      const addr = v.formatted_address || v.address;
                      return (
                        <div key={i}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <a
                              href={`https://maps.google.com/?q=${encodeURIComponent(addr || v.name)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' }}
                            >
                              {v.name}
                            </a>
                            {v.venue_verified === true && (
                              <span style={{ fontSize: '0.72rem', color: '#16a34a', fontWeight: 500 }}>✓ Verified</span>
                            )}
                          </div>
                          {addr && (
                            <div style={{ fontSize: '0.78rem', color: 'var(--text-3)', marginTop: 2 }}>{addr}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            });
          })()}
        </div>

        {/* ── Vote buttons (attendees only, awaiting_responses) ── */}
        {!isOrganizer && isAwaiting && (
          <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {myVote && myVote !== 'pending' ? (
              // Show current vote status — attendee already voted
              <div style={{ fontSize: '0.85rem', color: 'var(--text-2)', padding: '6px 0' }}>
                Your vote:{' '}
                <strong>
                  {myVote === 'accepted'  && '✓ Accepted'}
                  {myVote === 'declined'  && '✗ Declined'}
                  {myVote === 'abstained' && '— Abstained'}
                </strong>
                {' '}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  style={{ fontSize: '0.78rem' }}
                  onClick={() => onVote(suggestion.id, 'accepted')}
                  disabled={isBusy}
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <button
                  className="btn btn--primary btn--sm"
                  disabled={isBusy}
                  onClick={() => onVote(suggestion.id, 'accepted')}
                >
                  {isBusy ? '…' : '✓ Accept'}
                </button>
                <button
                  className="btn btn--danger btn--sm"
                  disabled={isBusy}
                  onClick={() => onVote(suggestion.id, 'declined')}
                >
                  {isBusy ? '…' : '✗ Decline'}
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={isBusy}
                  onClick={() => onVote(suggestion.id, 'abstained')}
                >
                  — Abstain
                </button>
              </>
            )}
          </div>
        )}

        {/* ── Organizer draft card actions ── */}
        {isOrganizer && isDraft && (
          <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn--primary btn--sm"
              disabled={sending || rerolling}
              onClick={onSend}
            >
              {sending ? 'Sending…' : '📤 Send to Group'}
            </button>
            <button
              className="btn btn--ghost btn--sm"
              disabled={sending || rerolling}
              onClick={onReroll}
            >
              {rerolling ? 'Regenerating…' : '↻ Re-roll all'}
            </button>
          </div>
        )}

        {/* ── Comment thread — available in all non-locked states ── */}
        {!isLocked && (
          <CommentThread
            itineraryId={itinerary.id}
            suggestionId={suggestion.id}
            isOpen={commentOpen}
            onToggle={() => setCommentOpen(o => !o)}
          />
        )}

        {/* Post-lock: read-only comments still visible */}
        {isLocked && isWinner && (
          <CommentThread
            itineraryId={itinerary.id}
            suggestionId={suggestion.id}
            isOpen={commentOpen}
            onToggle={() => setCommentOpen(o => !o)}
          />
        )}
      </div>
    </div>
  );
}

/* ── GroupItineraryView ─────────────────────────────────────────────── */

export default function GroupItineraryView() {
  const { id }   = useParams();
  const navigate = useNavigate();
  const myId     = getSupabaseId();

  // Main itinerary state — refreshed after every mutation
  const [itinerary,   setItinerary]   = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');

  // Action states
  const [sending,     setSending]     = useState(false);
  const [rerolling,   setRerolling]   = useState(false);
  const [actingCard,  setActingCard]  = useState(null); // suggestion.id currently voting
  const [actionError, setActionError] = useState('');
  const [sentSuccess, setSentSuccess] = useState(false);

  /** Fetch (or re-fetch) the itinerary from the server. */
  const load = useCallback(async () => {
    try {
      const data = await getGroupItinerary(id);
      setItinerary(data);
    } catch (e) {
      setError(e.message || 'Could not load itinerary.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  /** Organizer sends the draft to all attendees. */
  async function handleSend() {
    setSending(true);
    setActionError('');
    try {
      await sendGroupItinerary(id);
      setSentSuccess(true);
      setTimeout(() => setSentSuccess(false), 4000);
      load();
    } catch (e) {
      setActionError(e.message || 'Could not send itinerary.');
    } finally {
      setSending(false);
    }
  }

  /** Organizer requests a new set of AI suggestions. */
  async function handleReroll() {
    if (!window.confirm('Generate a new set of suggestions? The current ones will be archived.')) return;
    setRerolling(true);
    setActionError('');
    try {
      await rerollGroupItinerary(id);
      load();
    } catch (e) {
      setActionError(e.message || 'Could not regenerate suggestions.');
    } finally {
      setRerolling(false);
    }
  }

  /**
   * Attendee votes on a suggestion.
   * The DB trigger evaluates quorum after the vote — we read back itinerary_status
   * from the response to see if the itinerary locked.
   */
  async function handleVote(suggestionId, vote) {
    setActingCard(suggestionId);
    setActionError('');
    try {
      const result = await voteOnGroupItinerary(id, suggestionId, vote);
      // Refresh so we see the latest vote_status and any lock transition
      await load();
      // If the itinerary just locked, the refresh will show the locked state automatically
      return result;
    } catch (e) {
      setActionError(e.message || 'Could not record vote.');
    } finally {
      setActingCard(null);
    }
  }

  // ── Loading / error gates ────────────────────────────────────────────────

  if (loading) {
    return (
      <>
        <NavBar />
        <main className="page">
          <div className="container container--sm" style={{ textAlign: 'center', paddingTop: 64 }}>
            <div className="spinner" />
          </div>
        </main>
      </>
    );
  }

  if (!itinerary) {
    return (
      <>
        <NavBar />
        <main className="page">
          <div className="container container--sm">
            <div className="alert alert--error">{error || 'Itinerary not found.'}</div>
            <button className="btn btn--ghost" onClick={() => navigate('/home')}>← Home</button>
          </div>
        </main>
      </>
    );
  }

  const {
    itinerary_status: status,
    suggestions = [],
    vote_status: voteStatus = {},
    is_organizer: isOrganizer,
    organizer,
    event_title: eventTitle,
    selected_suggestion_id: selectedId,
    quorum_threshold: quorumThreshold,
    locked_at: lockedAt,
  } = itinerary;

  const totalAttendees  = Object.keys(voteStatus).length;
  const respondedCount  = Object.values(voteStatus).filter(v => v.vote !== 'pending').length;
  const acceptCount     = countVotes(voteStatus, 'accepted');
  const winnerSuggestion = suggestions.find(s => s.id === selectedId);

  // Derive my own vote status to show overall progress banner
  const myVoteEntry = voteStatus[myId];
  const myVote      = myVoteEntry?.vote;

  // ── Status banners ────────────────────────────────────────────────────────

  function StatusBanner() {
    if (status === 'organizer_draft') {
      return (
        <div
          className="alert"
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            marginBottom: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={{ fontSize: '1rem' }}>✏️</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Draft — not sent yet</div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginTop: 2 }}>
              Review the suggestions below, then send to the group.
            </div>
          </div>
        </div>
      );
    }
    if (status === 'awaiting_responses') {
      return (
        <div
          className="alert"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', marginBottom: 20 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
              {isOrganizer ? 'Waiting for votes…' : 'Vote on a suggestion below'}
            </span>
            <span style={{ fontSize: '0.82rem', color: 'var(--text-3)' }}>
              {respondedCount}/{totalAttendees} responded
            </span>
          </div>
          {/* Vote progress bar */}
          <div style={{ background: 'var(--border)', borderRadius: 99, height: 5, overflow: 'hidden' }}>
            <div style={{
              background: 'var(--brand)',
              height: '100%',
              width: totalAttendees > 0 ? `${(respondedCount / totalAttendees) * 100}%` : '0%',
              transition: 'width 0.3s ease',
            }} />
          </div>
          {/* Quorum hint */}
          <div style={{ fontSize: '0.76rem', color: 'var(--text-4)', marginTop: 5 }}>
            {quorumThreshold} accept{quorumThreshold !== 1 ? 's' : ''} needed to lock
            · {acceptCount} so far
          </div>
          {/* Attendee own-vote summary */}
          {!isOrganizer && myVote && myVote !== 'pending' && (
            <div style={{ marginTop: 8, fontSize: '0.83rem', color: 'var(--text-2)' }}>
              Your response: <strong>
                {myVote === 'accepted' && '✓ Accepted'}
                {myVote === 'declined' && '✗ Declined'}
                {myVote === 'abstained' && '— Abstained'}
              </strong>
            </div>
          )}
        </div>
      );
    }
    if (status === 'locked') {
      return (
        <div
          className="alert"
          style={{
            background: 'linear-gradient(135deg, var(--brand) 0%, #4f46e5 100%)',
            color: '#fff',
            marginBottom: 20,
            border: 'none',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 2 }}>🎉 Plans locked!</div>
          {lockedAt && (
            <div style={{ fontSize: '0.82rem', opacity: 0.9 }}>
              Locked on {new Date(lockedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </div>
          )}
          <div style={{ marginTop: 6, fontSize: '0.84rem', opacity: 0.9 }}>
            {acceptCount} of {totalAttendees} accepted
          </div>
        </div>
      );
    }
    if (status === 'cancelled') {
      return (
        <div className="alert alert--error" style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600 }}>This event was cancelled.</div>
          {totalAttendees > 0 && (
            <div style={{ fontSize: '0.83rem', marginTop: 4 }}>
              Final tally: {acceptCount} accepted · {declineCount()} declined
            </div>
          )}
        </div>
      );
    }
    return null;
  }

  // Only used in cancelled state summary
  function declineCount() {
    return countVotes(voteStatus, 'declined');
  }

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container container--sm">

          {/* Back navigation */}
          <button
            className="btn btn--ghost btn--sm"
            style={{ marginBottom: 16 }}
            onClick={() => navigate(-1)}
          >
            ← Back
          </button>

          {/* Event title */}
          <div style={{ marginBottom: 20 }}>
            <h1 className="page-title" style={{ margin: 0 }}>
              {eventTitle || 'Group Event'}
            </h1>
            {organizer && (
              <p style={{ fontSize: '0.84rem', color: 'var(--text-3)', margin: '4px 0 0' }}>
                Organized by {organizer.full_name || 'Unknown'}
              </p>
            )}
          </div>

          {/* Status banner */}
          <StatusBanner />

          {sentSuccess && (
            <div
              className="alert"
              style={{
                background: 'var(--success-bg, #d1fae5)',
                border: '1px solid var(--success, #059669)',
                color: 'var(--success-text, #065f46)',
                marginBottom: 16,
                fontWeight: 500,
              }}
            >
              Sent to group! Waiting for votes.
            </div>
          )}

          {actionError && (
            <div className="alert alert--error" style={{ marginBottom: 16 }}>{actionError}</div>
          )}

          {/* Organizer re-roll button (awaiting_responses) */}
          {isOrganizer && status === 'awaiting_responses' && (
            <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
              <button
                className="btn btn--ghost btn--sm"
                disabled={rerolling}
                onClick={handleReroll}
              >
                {rerolling ? <><span className="spinner spinner--sm" style={{ marginRight: 6 }} />Regenerating…</> : '↻ Re-roll suggestions'}
              </button>
            </div>
          )}

          {/* ── Locked: show winning suggestion prominently ── */}
          {status === 'locked' && winnerSuggestion && (
            <div style={{ marginBottom: 24 }}>
              <div style={{
                fontSize: '0.76rem', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: 10,
              }}>
                Winning Plan
              </div>
              <GroupSuggestionCard
                suggestion={winnerSuggestion}
                itinerary={itinerary}
                voteStatus={voteStatus}
                isOrganizer={isOrganizer}
                myId={myId}
                status={status}
                onVote={handleVote}
                onSend={handleSend}
                onReroll={handleReroll}
                sending={sending}
                rerolling={rerolling}
                actingCardId={actingCard}
              />
            </div>
          )}

          {/* ── Suggestions list ── */}
          {status !== 'locked' && suggestions.length > 0 && (
            <div>
              {status === 'organizer_draft' && (
                <div style={{
                  fontSize: '0.76rem', fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: 10,
                }}>
                  Suggestions
                </div>
              )}
              {suggestions.map(s => (
                <GroupSuggestionCard
                  key={s.id}
                  suggestion={s}
                  itinerary={itinerary}
                  voteStatus={voteStatus}
                  isOrganizer={isOrganizer}
                  myId={myId}
                  status={status}
                  onVote={handleVote}
                  onSend={handleSend}
                  onReroll={handleReroll}
                  sending={sending}
                  rerolling={rerolling}
                  actingCardId={actingCard}
                />
              ))}
            </div>
          )}

          {/* ── Draft: global send + reroll controls at bottom ── */}
          {isOrganizer && status === 'organizer_draft' && suggestions.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                className="btn btn--primary btn--lg"
                disabled={sending || rerolling}
                onClick={handleSend}
              >
                {sending ? <><span className="spinner spinner--sm" style={{ marginRight: 6 }} />Sending…</> : '📤 Send to Group'}
              </button>
              <button
                className="btn btn--ghost"
                disabled={sending || rerolling}
                onClick={handleReroll}
              >
                {rerolling ? 'Regenerating…' : '↻ Re-roll all'}
              </button>
            </div>
          )}

          {/* Empty suggestions state */}
          {suggestions.length === 0 && status === 'organizer_draft' && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-3)' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: 8 }}>🤔</div>
              <div style={{ fontWeight: 600 }}>No suggestions yet</div>
              <div style={{ fontSize: '0.85rem', marginTop: 4 }}>
                Something went wrong during generation. Please try again.
              </div>
            </div>
          )}

          {/* Vote status: attendee list with their votes (organizer view, awaiting_responses) */}
          {isOrganizer && status === 'awaiting_responses' && totalAttendees > 0 && (
            <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{
                fontSize: '0.76rem', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: 10,
              }}>
                Attendee Responses
              </div>
              {Object.entries(voteStatus).map(([uid, entry]) => {
                const name   = entry.profile?.full_name || 'Member';
                const vote   = entry.vote || 'pending';
                const colors = {
                  accepted:  { bg: '#dcfce7', color: '#166534' },
                  declined:  { bg: '#fee2e2', color: '#991b1b' },
                  abstained: { bg: '#f3f4f6', color: '#374151' },
                  pending:   { bg: 'var(--surface-2)', color: 'var(--text-3)' },
                };
                const style = colors[vote] || colors.pending;
                return (
                  <div key={uid} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    {entry.profile?.avatar_url ? (
                      <img
                        src={entry.profile.avatar_url}
                        alt={name}
                        style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                      />
                    ) : (
                      <div className="avatar avatar--sm" style={{ width: 28, height: 28, fontSize: '0.7rem', flexShrink: 0 }}>
                        {getInitials(name)}
                      </div>
                    )}
                    <span style={{ flex: 1, fontSize: '0.88rem', fontWeight: 600 }}>{name}</span>
                    <span
                      className="badge"
                      style={{ fontSize: '0.72rem', background: style.bg, color: style.color }}
                    >
                      {vote === 'pending'   && 'Pending'}
                      {vote === 'accepted'  && '✓ Accepted'}
                      {vote === 'declined'  && '✗ Declined'}
                      {vote === 'abstained' && '— Abstained'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

        </div>
      </main>
    </>
  );
}
