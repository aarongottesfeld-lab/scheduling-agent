// GroupItineraryView.js — Group itinerary detail / voting screen.
//
// Handles all four itinerary_status states:
//   organizer_draft    → organizer reviews suggestions before sending to the group.
//                        Shows "Draft — not sent yet" banner. Send + Re-roll buttons.
//   awaiting_responses → voting is open. All members see the response list.
//                        Organizer sees tallies. Attendees see per-card vote buttons.
//   locked             → winner is shown prominently. Read-only. Add-to-Calendar link.
//   cancelled          → cancelled state with final tally.
//
// Suggestion cards have full venue detail parity with ItineraryView.js:
//   verified badge + tooltip, type badge, unverified note, tags, duration,
//   ticket/book links, directions, Google Calendar link on lock.
//
// Auth: is_organizer and vote_status are computed server-side and returned by GET /:id.
// The current user's vote on a card is read from vote_status[myId].

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
 * Builds a Google Calendar "Add to Calendar" deep-link for a locked group suggestion.
 * Same logic as ItineraryView.js but uses group name + event title as the calendar title.
 */
function buildGCalUrl(suggestion, itinerary) {
  const allStops = (suggestion.days || []).flatMap(d => d.stops || []).concat(suggestion.venues || []);
  const location  = allStops[0]?.formatted_address || allStops[0]?.address || suggestion.neighborhood || '';
  const venueLines = allStops.map(v => `${v.name}${(v.formatted_address || v.address) ? ' — ' + (v.formatted_address || v.address) : ''}`).join('\n');
  const details   = [suggestion.narrative, venueLines ? '\nStops:\n' + venueLines : ''].filter(Boolean).join('\n\n');
  const title     = [itinerary.group_name, itinerary.event_title].filter(Boolean).join(' — ') || 'Group Plan';

  function toGCalDate(dateStr, timeStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    if (!timeStr) return `${y}${m}${d}`;
    const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!match) return `${y}${m}${d}`;
    let h = parseInt(match[1]);
    const min = match[2];
    const ampm = match[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    const hh     = String(h).padStart(2, '0');
    const durMs  = (suggestion.durationMinutes || 120) * 60000;
    const endMs  = new Date(`${dateStr}T${hh}:${min}:00`).getTime() + durMs;
    const end    = new Date(endMs);
    const endStr = `${end.getFullYear()}${String(end.getMonth()+1).padStart(2,'0')}${String(end.getDate()).padStart(2,'0')}T${String(end.getHours()).padStart(2,'0')}${String(end.getMinutes()).padStart(2,'0')}00`;
    return `${y}${m}${d}T${hh}${min}00/${endStr}`;
  }

  const dates  = toGCalDate(suggestion.date, suggestion.time);
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title, details, location, ...(dates ? { dates } : {}) });
  return `https://calendar.google.com/calendar/render?${params}`;
}

// Activity emoji map — same as ItineraryView.js
const ACTIVITY_EMOJI = {
  tennis: '🎾', golf: '⛳', pickleball: '🏓', bowling: '🎳', climbing: '🧗',
  ice_skating: '⛸️', mini_golf: '⛳', skiing: '⛷️', swimming: '🏊',
  basketball: '🏀', soccer: '⚽', baseball: '⚾', yoga: '🧘', cycling: '🚴',
  boxing: '🥊', pottery: '🏺', painting: '🎨', photography: '📷', drawing: '✏️',
  cooking: '👨‍🍳', dance: '💃', music_lessons: '🎵', board_games: '🎲',
  escape_room: '🔐', karaoke: '🎤', arcade: '🕹️', axe_throwing: '🪓',
  trivia: '🧠', comedy: '🎭', hiking: '🥾', kayaking: '🚣', biking: '🚵',
  birdwatching: '🦅',
};

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
  status,                    // itinerary_status
  organizerRecommendationId, // the card organizer picked when sending (never changes)
  attendeeSuggestionMap,     // { userId: suggestionId } — which card each attendee voted for
  onVote,                    // (suggestionId, vote) => void — attendee action
  onSend,                    // (suggestionId) => void — organizer sends draft
  onReroll,                  // (suggestionId, rerollType) => void
  sending,
  rerollingCard,             // { id, type } | null — which card is currently being rerolled
  actingCardId,              // which card currently has a pending vote action
}) {
  const [expanded,       setExpanded]       = useState(false);
  const [commentOpen,    setCommentOpen]    = useState(false);
  const [vibeInputOpen,  setVibeInputOpen]  = useState(false);
  const [vibeText,       setVibeText]       = useState('');
  const [tooltipOpen,    setTooltipOpen]    = useState(false);

  const isLocked        = status === 'locked';
  const isWinner        = isLocked && itinerary.selected_suggestion_id === suggestion.id;
  const isOrganizerPick = status === 'awaiting_responses' && organizerRecommendationId === suggestion.id;
  const myVote          = voteStatus?.[myId]?.vote; // overall accepted/declined/pending
  const myVotedCardId   = attendeeSuggestionMap?.[myId]; // which card this attendee voted for
  const myVoteIsHere    = myVotedCardId === suggestion.id;
  const isBusy          = actingCardId === suggestion.id;
  const isThisRerolling = rerollingCard?.id === suggestion.id;
  const isAnyRerolling  = !!rerollingCard;
  const isDraft         = status === 'organizer_draft';
  const isAwaiting      = status === 'awaiting_responses';

  // Quorum-relevant counts exclude the organizer entry (is_organizer: true) since the
  // organizer's acceptance is implied by sending, not a quorum vote.
  const attendeeEntries = Object.values(voteStatus || {}).filter(v => !v.is_organizer);
  const totalAttendees = attendeeEntries.length;
  const acceptCount    = attendeeEntries.filter(v => v.vote === 'accepted').length;
  const declineCount   = attendeeEntries.filter(v => v.vote === 'declined').length;
  const respondedCount = attendeeEntries.filter(v => v.vote !== 'pending').length;

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
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {suggestion.location_type === 'home' && (
              <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff', fontSize: '0.75rem' }}>🏠 At home</span>
            )}
            {suggestion.activityType && (
              <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff' }}>{suggestion.activityType}</span>
            )}
            {(suggestion.event_source === 'ticketmaster' || suggestion.event_source === 'eventbrite') && (
              <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff', fontSize: '0.75rem' }}>🎟 Live event</span>
            )}
            {suggestion.activity_source === 'places_activity' && (
              <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff', fontSize: '0.75rem' }}>
                {ACTIVITY_EMOJI[suggestion.activity_type] || '🏟'} {suggestion.activity_type ? suggestion.activity_type.replace(/_/g, ' ') : 'activity'}
              </span>
            )}
            {/* Winner badge */}
            {isWinner && (
              <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff', fontSize: '0.75rem' }}>✓ Locked</span>
            )}
            {/* Organizer's recommendation badge (awaiting_responses) */}
            {isOrganizerPick && !isWinner && (
              <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff', fontSize: '0.75rem' }}>
                📤 {isOrganizer ? 'Your recommendation' : 'Recommended'}
              </span>
            )}
          </div>
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
        {!expanded && suggestion.tags?.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
            {suggestion.tags.map((tag, i) => (
              <span key={i} style={{ fontSize: '0.72rem', background: 'var(--surface-2)', color: 'var(--text-2)', borderRadius: 99, padding: '2px 8px' }}>{tag}</span>
            ))}
          </div>
        )}
        <button
          className="btn btn--ghost btn--sm"
          style={{ marginTop: 8, padding: '4px 0', fontSize: '0.82rem' }}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? 'Collapse ↑' : 'See details & route ↓'}
        </button>

        {/* Expanded venue + detail panel — full parity with ItineraryView.js */}
        <div style={{ overflow: 'hidden', maxHeight: expanded ? '2000px' : '0', opacity: expanded ? 1 : 0, transition: 'max-height 0.3s ease, opacity 0.3s ease' }}>
          {narrative && (
            <p className="suggestion-card__narrative" style={{ marginTop: 8 }}>{narrative}</p>
          )}
          {(() => {
            const isMultiDay = suggestion.days?.length > 1;
            const allDays = isMultiDay
              ? suggestion.days
              : [{ day: 1, label: null, stops: suggestion.days?.[0]?.stops ?? suggestion.venues ?? [] }];
            const allStops = allDays.flatMap(d => d.stops || []);
            if (!allStops.length) return null;
            const firstVerifiedStopRef = allStops.find(v => v.venue_verified === true);

            const renderStop = (v, i) => {
              const addr = v.formatted_address || v.address;
              const isFirstVerified = v === firstVerifiedStopRef;
              return (
                <div key={i}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <a
                      href={`https://maps.google.com/?q=${encodeURIComponent(addr || v.name)}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{ fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' }}
                    >{v.name}</a>
                    {v.type && (
                      <span className="badge" style={{ fontSize: '0.7rem', textTransform: 'capitalize' }}>{v.type}</span>
                    )}
                    {v.venue_verified === true && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.72rem', color: '#16a34a', fontWeight: 500 }}>
                        ✓ Verified
                        {isFirstVerified && (
                          <span
                            role="button" tabIndex={0} aria-label="What does verified mean?"
                            aria-expanded={tooltipOpen}
                            style={{ cursor: 'pointer', color: 'var(--text-3)', lineHeight: 1, marginLeft: 1 }}
                            onMouseEnter={() => setTooltipOpen(true)}
                            onMouseLeave={() => setTooltipOpen(false)}
                            onClick={() => setTooltipOpen(o => !o)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTooltipOpen(o => !o); } }}
                          >ⓘ</span>
                        )}
                      </span>
                    )}
                    {v.venue_verified === false && v.type !== 'home' && (
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-3)', fontWeight: 400 }}>· unverified</span>
                    )}
                  </div>
                  {isFirstVerified && tooltipOpen && (
                    <div role="tooltip" style={{ fontSize: '0.75rem', color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', marginTop: 4, maxWidth: 300, lineHeight: 1.5 }}>
                      <strong>"Venue verified"</strong> means we confirmed this location exists via Google Places. It does not guarantee current hours, availability, or quality.
                    </div>
                  )}
                  {addr && <div style={{ fontSize: '0.78rem', color: 'var(--text-3)', marginTop: 2 }}>{addr}</div>}
                </div>
              );
            };

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
                    {stops.map((v, i) => renderStop(v, i))}
                  </div>
                </div>
              );
            });
          })()}

          {/* Duration */}
          {suggestion.durationMinutes > 0 && (
            <div style={{ fontSize: '0.82rem', color: 'var(--text-2)', marginTop: 6 }}>
              ~{Math.round(suggestion.durationMinutes / 60)} hrs
            </div>
          )}

          {/* Tags */}
          {suggestion.tags?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 10 }}>
              {suggestion.tags.map((tag, i) => (
                <span key={i} style={{ fontSize: '0.72rem', background: 'var(--surface-2)', color: 'var(--text-2)', borderRadius: 99, padding: '2px 8px' }}>{tag}</span>
              ))}
            </div>
          )}

          {/* Ticket link for live events */}
          {suggestion.event_url && (suggestion.event_source === 'ticketmaster' || suggestion.event_source === 'eventbrite') && (
            <div style={{ marginTop: 10 }}>
              <a href={suggestion.event_url} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '0.82rem', color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}>
                🎟 Get tickets →
              </a>
            </div>
          )}

          {/* Reserve/Book link for activity venues */}
          {suggestion.venue_url && suggestion.activity_source === 'places_activity' && (
            <div style={{ marginTop: 10 }}>
              <a href={suggestion.venue_url} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '0.82rem', color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}>
                {ACTIVITY_EMOJI[suggestion.activity_type] || '🏟'} Reserve / Book →
              </a>
            </div>
          )}

          {/* Directions */}
          {(() => {
            const dest = (suggestion.days?.[0]?.stops?.[0]?.formatted_address) ||
                         (suggestion.days?.[0]?.stops?.[0]?.address) ||
                         suggestion.neighborhood || '';
            if (!dest) return null;
            return (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Getting there</div>
                <a href={`https://maps.google.com/?daddr=${encodeURIComponent(dest)}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', textDecoration: 'none', color: 'var(--text-1)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>🗺️</span><span style={{ fontSize: '0.88rem' }}>Open in Google Maps</span>
                  </span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--brand)' }}>Open →</span>
                </a>
              </div>
            );
          })()}
        </div>

        {/* ── Google Calendar link (locked only) ── */}
        {isWinner && (
          <div style={{ marginTop: 14 }}>
            <a href={buildGCalUrl(suggestion, itinerary)} target="_blank" rel="noopener noreferrer"
              className="btn btn--ghost btn--sm">
              📅 Add to Calendar
            </a>
          </div>
        )}

        {/* ── Vote buttons (attendees only, awaiting_responses) ── */}
        {/* Design: no hidden-then-revealed flow — vote state is shown inline with a direct
            toggle button so there's no intermediate "changing" state that can race with
            async re-renders. Organizer's pick = Accept/Decline/toggle. Other cards = Suggest. */}
        {!isOrganizer && isAwaiting && (() => {
          if (isOrganizerPick) {
            // Voted for this card: show current vote + single toggle to the other option
            if (myVoteIsHere && myVote && myVote !== 'pending') {
              const isAccepted = myVote === 'accepted';
              return (
                <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-2)' }}>
                    Your vote: <strong>{isAccepted ? '✓ Accepted' : '✗ Declined'}</strong>
                  </span>
                  <button
                    className={`btn btn--sm ${isAccepted ? 'btn--danger' : 'btn--primary'}`}
                    disabled={isBusy}
                    onClick={() => onVote(suggestion.id, isAccepted ? 'declined' : 'accepted')}
                  >
                    {isBusy ? '…' : isAccepted ? 'Change to Decline' : 'Change to Accept'}
                  </button>
                </div>
              );
            }
            // Not yet voted (or voted for a different card): show Accept / Decline
            return (
              <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
              </div>
            );
          }

          // Non-organizer-pick card
          if (myVoteIsHere && myVote && myVote !== 'pending') {
            // This IS the card they counter-proposed — show confirmation (other cards let them move)
            return (
              <div style={{ marginTop: 14, fontSize: '0.85rem', color: 'var(--text-2)', padding: '4px 0' }}>
                ✓ Your counter-proposal
              </div>
            );
          }
          // Not voted for this card — offer to suggest it (or move vote here)
          const alreadyVoted = !!(myVotedCardId && myVotedCardId !== suggestion.id);
          return (
            <div style={{ marginTop: 14 }}>
              <button
                className="btn btn--ghost btn--sm"
                disabled={isBusy}
                onClick={() => onVote(suggestion.id, 'accepted')}
              >
                {isBusy ? '…' : alreadyVoted ? '↩ Move my vote here' : '↩ Suggest this instead'}
              </button>
            </div>
          );
        })()}

        {/* ── Card actions (send + re-roll) ── */}
        {/* Organizer in draft: all cards. Organizer waiting: only their rec card.
            Attendee: non-pick cards they haven't yet counter-proposed — re-roll disappears
            once they vote on this card (myVoteIsHere), locking in the counter-proposal. */}
        {((isOrganizer && isDraft) ||
          (isOrganizer && isAwaiting && isOrganizerPick) ||
          (!isOrganizer && isAwaiting && !isOrganizerPick && !myVoteIsHere)) && !isLocked && (
          <div style={{ marginTop: 14 }}>
            {/* Loading state: replaces buttons while this card is being rerolled */}
            {isThisRerolling ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', fontSize: '0.85rem', padding: '4px 0' }}>
                <span className="spinner spinner--sm" />
                {rerollingCard.type === 'timing'   && 'Updating time…'}
                {rerollingCard.type === 'activity' && 'Generating new vibe…'}
                {rerollingCard.type === 'both'     && 'Regenerating…'}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {isOrganizer && isDraft && (
                  <button
                    className="btn btn--primary btn--sm"
                    disabled={sending || isAnyRerolling}
                    onClick={() => onSend(suggestion.id)}
                  >
                    {sending ? 'Sending…' : '📤 Send this to group'}
                  </button>
                )}
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={isAnyRerolling || sending}
                  onClick={() => { setVibeInputOpen(false); onReroll(suggestion.id, 'timing'); }}
                >
                  🕐 Re-roll time
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={isAnyRerolling || sending}
                  onClick={() => { setVibeInputOpen(v => !v); setVibeText(''); }}
                >
                  ✨ Re-roll vibe
                </button>
              </div>
            )}

            {/* Inline vibe prompt — shown when user clicks "Re-roll vibe" */}
            {!isThisRerolling && vibeInputOpen && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <textarea
                  autoFocus
                  className="form-control"
                  rows={2}
                  placeholder="e.g. 'something outdoors', 'more low-key', 'closer to downtown'…"
                  value={vibeText}
                  onChange={e => setVibeText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      setVibeInputOpen(false);
                      onReroll(suggestion.id, 'activity', vibeText.trim());
                    }
                    if (e.key === 'Escape') setVibeInputOpen(false);
                  }}
                  disabled={isAnyRerolling || sending}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn--primary btn--sm"
                    disabled={isAnyRerolling || sending}
                    onClick={() => { setVibeInputOpen(false); onReroll(suggestion.id, 'activity', vibeText.trim()); }}
                  >
                    Generate
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => setVibeInputOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
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
  const [sending,       setSending]       = useState(false);
  const [rerollingCard, setRerollingCard] = useState(null); // { id, type } | null
  const [actingCard,    setActingCard]    = useState(null); // suggestion.id currently voting
  const [actionError,   setActionError]   = useState('');
  const [sentSuccess,   setSentSuccess]   = useState(false);

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

  /** Organizer sends the draft to all attendees, with a specific suggestion as their pick. */
  async function handleSend(suggestionId) {
    setSending(true);
    setActionError('');
    try {
      await sendGroupItinerary(id, suggestionId);
      setSentSuccess(true);
      setTimeout(() => setSentSuccess(false), 4000);
      load();
    } catch (e) {
      setActionError(e.message || 'Could not send itinerary.');
    } finally {
      setSending(false);
    }
  }

  /** Re-rolls a single suggestion card (time slot or activity vibe). */
  async function handleReroll(suggestionId, rerollType, feedback = '') {
    if (!suggestionId) {
      setActionError('Cannot re-roll: this card has no stable ID. Please refresh the page and try again.');
      return;
    }
    setRerollingCard({ id: suggestionId, type: rerollType });
    setActionError('');
    try {
      await rerollGroupItinerary(id, rerollType, suggestionId, feedback);
      load();
    } catch (e) {
      setActionError(e.message || 'Could not regenerate suggestion.');
    } finally {
      setRerollingCard(null);
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
    group_name: groupName,
    selected_suggestion_id: selectedId,
    organizer_recommendation_id: organizerRecommendationId,
    attendee_suggestion_map: attendeeSuggestionMap = {},
    quorum_threshold: quorumThreshold,
    locked_at: lockedAt,
  } = itinerary;

  // Full display title: "[Group Name] — [Event Title]" when both are present
  const displayTitle = [groupName, eventTitle].filter(Boolean).join(' — ') || 'Group Event';

  // Quorum counts are attendee-only — the organizer is injected into vote_status for display
  // purposes but they are the planner, not a quorum voter, so exclude is_organizer entries.
  const attendeeVoteEntries = Object.values(voteStatus).filter(v => !v.is_organizer);
  const totalAttendees  = attendeeVoteEntries.length;
  const respondedCount  = attendeeVoteEntries.filter(v => v.vote !== 'pending').length;
  const acceptCount     = attendeeVoteEntries.filter(v => v.vote === 'accepted').length;
  const winnerSuggestion = suggestions.find(s => s.id === selectedId);

  // In awaiting_responses, float the organizer's recommendation to the top so attendees
  // immediately see the card they need to act on first, matching 1:1 scheduling behaviour.
  const displaySuggestions = (status === 'awaiting_responses' && organizerRecommendationId)
    ? [
        ...suggestions.filter(s => s.id === organizerRecommendationId),
        ...suggestions.filter(s => s.id !== organizerRecommendationId),
      ]
    : suggestions;

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

  // Only used in cancelled state summary — attendees only, excludes organizer entry
  function declineCount() {
    return attendeeVoteEntries.filter(v => v.vote === 'declined').length;
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
            <h1 className="page-title" style={{ margin: 0 }}>{displayTitle}</h1>
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
                organizerRecommendationId={organizerRecommendationId}
                attendeeSuggestionMap={attendeeSuggestionMap}
                onVote={handleVote}
                onSend={handleSend}
                onReroll={handleReroll}
                sending={sending}
                rerollingCard={rerollingCard}
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
              {displaySuggestions.map(s => (
                <GroupSuggestionCard
                  key={s.id}
                  suggestion={s}
                  itinerary={itinerary}
                  voteStatus={voteStatus}
                  isOrganizer={isOrganizer}
                  myId={myId}
                  status={status}
                  organizerRecommendationId={organizerRecommendationId}
                  attendeeSuggestionMap={attendeeSuggestionMap}
                  onVote={handleVote}
                  onSend={handleSend}
                  onReroll={handleReroll}
                  sending={sending}
                  rerollingCard={rerollingCard}
                  actingCardId={actingCard}
                />
              ))}
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

          {/* Vote status: member list — visible to all members during awaiting_responses.
              Organizer sees full vote details. Attendees see their own vote in full,
              and others as Responded / Pending to avoid biasing pending voters. */}
          {status === 'awaiting_responses' && Object.keys(voteStatus).length > 0 && (
            <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{
                fontSize: '0.76rem', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: 10,
              }}>
                Group responses
              </div>
              {/* Sort: organizer first, then self, then others */}
              {Object.entries(voteStatus)
                .sort(([aUid, a], [bUid, b]) => {
                  if (b.is_organizer !== a.is_organizer) return b.is_organizer ? 1 : -1;
                  if (bUid === myId) return 1;
                  if (aUid === myId) return -1;
                  return 0;
                })
                .map(([uid, entry]) => {
                  const name      = entry.profile?.full_name || 'Member';
                  const vote      = entry.vote || 'pending';
                  const isMe      = uid === myId;
                  const responded = vote !== 'pending';

                  // Organizer sees full detail; attendees see full for themselves, responded/pending for others
                  let badgeText, badgeBg, badgeColor;
                  if (isOrganizer || isMe) {
                    badgeText  = vote === 'pending' ? 'Pending' : vote === 'accepted' ? '✓ Accepted' : '✗ Declined';
                    badgeBg    = vote === 'accepted' ? '#dcfce7' : vote === 'declined' ? '#fee2e2' : 'var(--surface-2)';
                    badgeColor = vote === 'accepted' ? '#166534'  : vote === 'declined' ? '#991b1b'  : 'var(--text-3)';
                  } else {
                    badgeText  = responded ? 'Responded' : 'Pending';
                    badgeBg    = responded ? 'var(--surface-2)' : 'var(--surface-2)';
                    badgeColor = responded ? 'var(--text-2)'    : 'var(--text-3)';
                  }

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
                      <span style={{ flex: 1, fontSize: '0.88rem', fontWeight: 600 }}>
                        {name}
                        {entry.is_organizer && (
                          <span style={{ marginLeft: 6, fontSize: '0.72rem', color: 'var(--text-3)', fontWeight: 400 }}>
                            (organizer)
                          </span>
                        )}
                        {isMe && !entry.is_organizer && (
                          <span style={{ marginLeft: 6, fontSize: '0.72rem', color: 'var(--text-3)', fontWeight: 400 }}>
                            (you)
                          </span>
                        )}
                      </span>
                      <span
                        className="badge"
                        style={{ fontSize: '0.72rem', background: badgeBg, color: badgeColor }}
                      >
                        {badgeText}
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
