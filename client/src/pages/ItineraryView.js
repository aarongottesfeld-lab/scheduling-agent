// ItineraryView.js — detail view for a single itinerary (scheduling session between two users).
//
// Shows suggestion cards with context-sensitive action buttons depending on the viewer's
// role (organizer or attendee) and the current negotiation state.
//
// State machine summary (DB check constraint only allows pending/accepted/declined — no 'sent'):
//   org=pending                                         → organizer drafting; attendee can't see
//   org=accepted, att=pending, no attendeeSelected flag → organizer sent pick; attendee evaluating
//   org=accepted, att=pending, attendeeSelected:true    → attendee counter-proposed (attendee_suggested)
//   locked_at set                                       → both agreed; plan confirmed
//
// deriveStatus() maps the two DB columns + JSONB flag to: 'pending' | 'sent' | 'attendee_suggested' | 'confirmed'
//
// Attendee's counter-proposal is tracked via attendeeSelected:true on the JSONB suggestion
// object rather than overwriting selected_suggestion_id (which tracks the organizer's pick only).

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';
// No auth imports needed — isOrganizer is computed server-side in the API response.
// The session cookie is sent automatically; no manual auth header required.
import client from '../utils/client';

/* ── Helpers ────────────────────────────────────────────────── */

/**
 * Formats a YYYY-MM-DD date and optional "7:00 PM" time string into a human-readable label.
 * Uses local date construction (not UTC) to avoid off-by-one day from timezone offset.
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
 * Builds a Google Calendar "Add to Calendar" deep-link for a confirmed suggestion.
 * Uses the TEMPLATE action so the event pre-fills without requiring Google sign-in.
 * Duration defaults to 2 hours if not specified.
 */
function buildGCalUrl(suggestion, itinerary) {
  const venueName  = suggestion.venues?.[0]?.name || suggestion.activityType || 'Plans';
  const otherFirst = (itinerary?.attendee?.full_name || itinerary?.organizer?.full_name || '').split(' ')[0] || 'Friend';
  const title      = `${venueName} with ${otherFirst}`;
  const location   = suggestion.venues?.[0]?.address || suggestion.neighborhood || '';
  const venueLines = (suggestion.venues || []).map(v => `${v.name}${v.address ? ' — ' + v.address : ''}`).join('\n');
  const details    = [suggestion.narrative, venueLines ? '\nStops:\n' + venueLines : ''].filter(Boolean).join('\n\n');

  /** Converts a YYYY-MM-DD + "7:00 PM" pair into the GCal dates parameter format. */
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

/* ── RerollModal ────────────────────────────────────────────── */

/**
 * Modal dialog for a full-board reroll (all 3 suggestions replaced).
 * User can edit the context prompt before re-generating.
 * The parent controls the loading state; Cancel / backdrop-click closes without submitting.
 */
function RerollModal({ initialContext, onClose, onSubmit, loading }) {
  const [context, setContext] = useState(initialContext || '');
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="reroll-title">
        <div className="modal__header">
          <span className="modal__title" id="reroll-title">Generate new suggestions</span>
          <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal__body">
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="reroll-context">What would you like to change?</label>
            <textarea id="reroll-context" className="form-control" value={context}
              onChange={(e) => setContext(e.target.value)} rows={4}
              placeholder="e.g. 'something outdoors', 'closer to downtown', 'more casual'" />
            <p className="form-hint">Edit or add to the original prompt — the AI will adjust accordingly.</p>
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn btn--primary" onClick={() => onSubmit(context)} disabled={loading}>
            {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Generating…</> : 'Generate New Suggestions'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Activity emoji map ────────────────────────────────────────
// Maps activity_type keys (from the server's ACTIVITY_CONFIG) to display emojis
// for the activity badge and Reserve/Book link in SuggestionCard.
// Falls back to 🏟 for any unrecognized activity type.
const ACTIVITY_EMOJI = {
  tennis:        '🎾',
  golf:          '⛳',
  pickleball:    '🏓',
  bowling:       '🎳',
  climbing:      '🧗',
  ice_skating:   '⛸️',
  mini_golf:     '⛳',
  skiing:        '⛷️',
  swimming:      '🏊',
  basketball:    '🏀',
  soccer:        '⚽',
  baseball:      '⚾',
  yoga:          '🧘',
  cycling:       '🚴',
  boxing:        '🥊',
  pottery:       '🏺',
  painting:      '🎨',
  photography:   '📷',
  drawing:       '✏️',
  cooking:       '👨‍🍳',
  dance:         '💃',
  music_lessons: '🎵',
  board_games:   '🎲',
  escape_room:   '🔐',
  karaoke:       '🎤',
  arcade:        '🕹️',
  axe_throwing:  '🪓',
  trivia:        '🧠',
  comedy:        '🎭',
  hiking:        '🥾',
  kayaking:      '🚣',
  biking:        '🚵',
  birdwatching:  '🦅',
};

/* ── SuggestionCard ─────────────────────────────────────────── */

/**
 * Renders a single itinerary suggestion with its date, venues, narrative, and action buttons.
 *
 * Action button visibility depends on role + status + which card this is:
 *   Organizer / pending:           Pick this one | New time | New vibe (all cards)
 *   Organizer / sent + picked:     Reroll all | Accept | Decline (their pick only, pre-confirm)
 *   Organizer / attendee_suggested:Accept | Decline | Reroll all (all cards, re-evaluate mode)
 *   Attendee  / sent + org pick:   Accept | Decline (organizer's pick only)
 *   Attendee  / sent + other cards:Suggest this instead | New time | New vibe
 *   Locked:                        Add to Calendar link
 *
 * thisCardBusy tracks per-card spinner state so only the acting card shows a loading indicator
 * while the rest remain visible (controlled by activeCardId in the parent).
 */
function SuggestionCard({
  suggestion, isConfirmed, isPicked, isOrganizerPick, isAttendeePick,
  role, status,
  onAccept, onDecline, onReroll, onPick, onRerollWithFeedback, onSuggestAlternative,
  organizerName, attendeeName, organizerLocation,
  submitting, activeCardId, itinerary, calendarEventId,
}) {
  const [expanded,       setExpanded]       = useState(isConfirmed);
  // vibeInputOpen: toggles the inline prompt box when user clicks "New vibe"
  const [vibeInputOpen,  setVibeInputOpen]  = useState(false);
  const [vibeText,       setVibeText]       = useState('');
  // tooltipOpen: controls the "what does verified mean?" explanation popover.
  // Scoped per card so each card manages its own tooltip state independently.
  // Toggled on click/tap (mobile) and on mouse enter/leave (desktop).
  const [tooltipOpen,    setTooltipOpen]    = useState(false);

  const isOrganizer  = role === 'organizer';
  const isAttendee   = role === 'attendee';
  const locked       = !!isConfirmed;
  // True when this specific card's async action (reroll or suggest) is in-flight.
  const thisCardBusy = activeCardId === suggestion.id;

  const narrative = suggestion.narrative || '';
  const truncated = narrative.length > 100 ? narrative.slice(0, 100) + '…' : narrative;

  // ── Visibility flags ──────────────────────────────────────────
  // Organizer pre-send: can pick / swap any card before sending
  const showOrganizerPreSendControls = isOrganizer && status === 'pending';

  // True once organizer confirmed their pick (organizer_status='accepted') — they wait
  const organizerHasConfirmed = itinerary?.organizer_status === 'accepted';

  // Organizer awaiting attendee: only their picked card shows action buttons
  const showOrganizerAwaitingControls = isOrganizer && status === 'sent' && isOrganizerPick && !organizerHasConfirmed;

  // Unused in JSX but kept for future "waiting" badge logic
  const showOrganizerWaitingIndicator = isOrganizer && organizerHasConfirmed && isOrganizerPick && !isConfirmed; // eslint-disable-line no-unused-vars

  // Attendee suggested a different card: organizer needs to re-evaluate all cards
  const showOrganizerReevaluate = isOrganizer && status === 'attendee_suggested';

  // Attendee can act on all cards while the itinerary is in their court
  const showAttendeeControls = isAttendee && (status === 'sent' || status === 'attendee_suggested');

  // Attendee already counter-proposed this card — show "waiting" badge, hide action buttons
  const showAttendeeSentIndicator = isAttendeePick && !isConfirmed && isAttendee;

  return (
    <div className={`suggestion-card${isConfirmed ? ' suggestion-card--confirmed' : ''}${isAttendeePick ? ' suggestion-card--highlighted' : ''}`}>

      {/* ── Card header ── */}
      <div className={`suggestion-card__header${isConfirmed ? ' suggestion-card__header--confirmed' : ''}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="suggestion-card__date">{formatDateTime(suggestion.date, suggestion.time)}</div>
            {suggestion.neighborhood && (
              <div className="suggestion-card__neighborhood">📍 {suggestion.neighborhood}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {/* Home badge — shown when Claude flagged this suggestion as home-based.
                Helps users scan the options without expanding each card. */}
            {suggestion.location_type === 'home' && (
              <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff', fontSize: '0.75rem' }}>
                🏠 At home
              </span>
            )}
            {suggestion.activityType && (
              <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff' }}>
                {suggestion.activityType}
              </span>
            )}
            {/* Event badge — shown when this suggestion is anchored to a live event
                from Ticketmaster or Eventbrite. Tapping opens the ticket link. */}
            {(suggestion.event_source === 'ticketmaster' || suggestion.event_source === 'eventbrite') && (
              <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff', fontSize: '0.75rem' }}>
                🎟 Live event
              </span>
            )}
            {/* Activity badge — shown when Claude anchored this suggestion to a real venue
                fetched via activity-specific Places API discovery. Emoji is mapped from
                the activity_type field; falls back to 🏟 for unrecognized types. */}
            {suggestion.activity_source === 'places_activity' && (
              <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff', fontSize: '0.75rem' }}>
                {ACTIVITY_EMOJI[suggestion.activity_type] || '🏟'} {suggestion.activity_type ? suggestion.activity_type.replace(/_/g, ' ') : 'activity'}
              </span>
            )}
          </div>
        </div>

        {/* Status badges inside the header */}
        {isConfirmed && (
          <div style={{ marginTop: 8, fontSize: '0.82rem', fontWeight: 700, opacity: .9 }}>✓ Confirmed plan</div>
        )}
        {isPicked && !isConfirmed && isOrganizer && (
          <div style={{ marginTop: 8, fontSize: '0.78rem', fontWeight: 700, color: 'rgba(255,255,255,0.85)', background: 'rgba(0,0,0,0.18)', borderRadius: 6, display: 'inline-block', padding: '2px 10px' }}>
            ✓ Your pick — waiting on them
          </div>
        )}
        {isAttendeePick && !isConfirmed && isOrganizer && (
          <div style={{ marginTop: 8, fontSize: '0.78rem', fontWeight: 700, color: 'rgba(255,255,255,0.85)', background: 'rgba(0,0,0,0.25)', borderRadius: 6, display: 'inline-block', padding: '2px 10px' }}>
            ↩ {attendeeName} suggested this — waiting on you
          </div>
        )}
        {showAttendeeSentIndicator && (
          <div style={{ marginTop: 8, fontSize: '0.78rem', fontWeight: 700, color: 'rgba(255,255,255,0.85)', background: 'rgba(0,0,0,0.18)', borderRadius: 6, display: 'inline-block', padding: '2px 10px' }}>
            ✓ Your pick — waiting on them
          </div>
        )}
      </div>

      {/* ── Card body (collapsed / expanded) ── */}
      <div className="suggestion-card__body">
        {!expanded && narrative && <p className="suggestion-card__narrative">{truncated}</p>}
        {!expanded && suggestion.tags?.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
            {suggestion.tags.map((tag, i) => (
              <span key={i} style={{ fontSize: '0.72rem', background: 'var(--surface-2)', color: 'var(--text-2)', borderRadius: 99, padding: '2px 8px' }}>{tag}</span>
            ))}
          </div>
        )}
        <button className="btn btn--ghost btn--sm" style={{ marginTop: 10, padding: '4px 0', fontSize: '0.82rem' }}
          onClick={() => setExpanded(e => !e)}>
          {expanded ? 'Collapse ↑' : 'See details & route ↓'}
        </button>

        {/* Expanded detail panel — CSS transition on maxHeight for smooth animation */}
        <div style={{ overflow: 'hidden', maxHeight: expanded ? '2000px' : '0', opacity: expanded ? 1 : 0, transition: 'max-height 0.3s ease, opacity 0.3s ease' }}>
          {narrative && <p className="suggestion-card__narrative" style={{ marginTop: 8 }}>{narrative}</p>}
          {suggestion.venues?.length > 0 && (() => {
            // Find the first venue that was verified by Places API — the ⓘ explanation
            // is shown only on that one venue to avoid clutter on cards with multiple stops.
            const firstVerifiedIdx = suggestion.venues.findIndex(v => v.venue_verified === true);

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                {suggestion.venues.map((v, i) => {
                  // Prefer the Places-enriched address; fall back to Claude's address field.
                  const displayAddress = v.formatted_address || v.address;
                  // Only the first verified venue gets the ⓘ tooltip trigger.
                  const isFirstVerified = i === firstVerifiedIdx;

                  return (
                    <div key={i}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <a
                          href={`https://maps.google.com/?q=${encodeURIComponent(displayAddress || v.name)}`}
                          target="_blank" rel="noopener noreferrer"
                          style={{ fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' }}
                        >{v.name}</a>

                        {v.type && (
                          <span className="badge" style={{ fontSize: '0.7rem', textTransform: 'capitalize' }}>{v.type}</span>
                        )}

                        {/* Verified badge — only shown when venue_verified is explicitly true.
                            Venues without the field (pre-enrichment data) show nothing. */}
                        {v.venue_verified === true && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.72rem', color: '#16a34a', fontWeight: 500 }}>
                            ✓ Verified
                            {/* ⓘ appears only on the first verified venue per card.
                                Uses both onMouseEnter/Leave (desktop hover) and onClick (tap/click)
                                so the tooltip is accessible on mobile without relying on CSS :hover. */}
                            {isFirstVerified && (
                              <span
                                role="button"
                                tabIndex={0}
                                aria-label="What does verified mean?"
                                aria-expanded={tooltipOpen}
                                style={{ cursor: 'pointer', color: 'var(--text-3)', lineHeight: 1, marginLeft: 1 }}
                                onMouseEnter={() => setTooltipOpen(true)}
                                onMouseLeave={() => setTooltipOpen(false)}
                                onClick={() => setTooltipOpen(o => !o)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTooltipOpen(o => !o); } }}
                              >ⓘ</span>
                            )}
                          </span>
                        )}

                        {/* Unverified note — shown when venue_verified is explicitly false
                            AND the venue is not a home (home venues are intentionally skipped
                            by the enrichment layer; showing "Unverified" there would be misleading). */}
                        {v.venue_verified === false && v.type !== 'home' && (
                          <span style={{ fontSize: '0.68rem', color: 'var(--text-3)', fontWeight: 400 }}>· unverified</span>
                        )}
                      </div>

                      {/* Tooltip — rendered beneath the venue name row on the first verified venue.
                          Exact copy is required: do not paraphrase the disclaimer. */}
                      {isFirstVerified && tooltipOpen && (
                        <div
                          role="tooltip"
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-2)',
                            background: 'var(--surface-2)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            padding: '6px 10px',
                            marginTop: 4,
                            maxWidth: 300,
                            lineHeight: 1.5,
                          }}
                        >
                          <strong>"Venue verified"</strong> means we confirmed this location exists via Google Places. It does not guarantee current hours, availability, or quality.
                        </div>
                      )}

                      {/* Address row — enriched address takes priority over Claude's address string */}
                      {displayAddress && (
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-3)', marginTop: 2 }}>{displayAddress}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {/* Ticket link — only shown for event-anchored suggestions with a URL */}
          {suggestion.event_url && (suggestion.event_source === 'ticketmaster' || suggestion.event_source === 'eventbrite') && (
            <div style={{ marginTop: 10 }}>
              <a
                href={suggestion.event_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '0.82rem', color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}
              >
                🎟 Get tickets →
              </a>
            </div>
          )}
          {/* Reserve/Book link — only shown for activity-anchored suggestions with a venue website */}
          {suggestion.venue_url && suggestion.activity_source === 'places_activity' && (
            <div style={{ marginTop: 10 }}>
              <a
                href={suggestion.venue_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '0.82rem', color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}
              >
                {ACTIVITY_EMOJI[suggestion.activity_type] || '🏟'} Reserve / Book →
              </a>
            </div>
          )}
          {suggestion.durationMinutes > 0 && (
            <div style={{ fontSize: '0.82rem', color: 'var(--text-2)', marginTop: 6 }}>~{Math.round(suggestion.durationMinutes / 60)} hrs</div>
          )}
          {suggestion.tags?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 10 }}>
              {suggestion.tags.map((tag, i) => (
                <span key={i} style={{ fontSize: '0.72rem', background: 'var(--surface-2)', color: 'var(--text-2)', borderRadius: 99, padding: '2px 8px' }}>{tag}</span>
              ))}
            </div>
          )}
          {/* Directions link — uses organizer's location as origin if available */}
          {(() => {
            const dest   = suggestion.venues?.[0]?.address || suggestion.neighborhood || '';
            const origin = organizerLocation || '';
            if (!dest) return null;
            const href = `https://maps.google.com/?saddr=${encodeURIComponent(origin)}&daddr=${encodeURIComponent(dest)}`;
            return (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Getting there</div>
                <a href={href} target="_blank" rel="noopener noreferrer"
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
      </div>

      {/* ── Card footer action buttons ── */}
      {!locked && (showOrganizerPreSendControls || showOrganizerAwaitingControls || showOrganizerReevaluate || (showAttendeeControls && !showAttendeeSentIndicator)) && (
        <div className="suggestion-card__footer">

          {/* Organizer pre-send: pick, swap time, or swap activity on any card */}
          {showOrganizerPreSendControls && (
            <>
              <button className="btn btn--primary btn--sm" disabled={submitting} onClick={() => onPick(suggestion.id)}>
                Pick this one
              </button>
              <button className="btn btn--ghost btn--sm" disabled={submitting} onClick={() => onRerollWithFeedback(suggestion.id, 'timing')}>
                🕐 New time
              </button>
              <button className="btn btn--ghost btn--sm" disabled={submitting}
                onClick={() => { setVibeInputOpen(v => !v); setVibeText(''); }}>
                🎲 New vibe
              </button>
            </>
          )}

          {/* Organizer awaiting attendee: their picked card only */}
          {showOrganizerAwaitingControls && (
            <>
              <button className="btn btn--primary btn--sm" disabled={submitting} onClick={() => onAccept(suggestion.id)}>
                Accept
              </button>
              <button className="btn btn--danger btn--sm" disabled={submitting} onClick={onDecline}>
                Decline
              </button>
              <button className="btn btn--ghost btn--sm" disabled={submitting} onClick={onReroll}>
                ↻ Reroll all
              </button>
            </>
          )}

          {/* Organizer re-evaluating after attendee suggested an alternative.
              Attendee's highlighted card: Accept | Decline.
              Other cards: Suggest this instead | New time | New vibe (same controls as pre-send). */}
          {showOrganizerReevaluate && (
            <>
              {isAttendeePick ? (
                <>
                  <button className="btn btn--primary btn--sm" disabled={submitting} onClick={() => onAccept(suggestion.id)}>
                    Accept {attendeeName}'s pick
                  </button>
                  <button className="btn btn--danger btn--sm" disabled={submitting} onClick={onDecline}>
                    Decline
                  </button>
                </>
              ) : (
                <>
                  <button className="btn btn--ghost btn--sm" disabled={submitting} onClick={() => onAccept(suggestion.id)}>
                    ↩ Suggest this instead
                  </button>
                  <button className="btn btn--ghost btn--sm" disabled={submitting} onClick={() => onRerollWithFeedback(suggestion.id, 'timing')}>
                    🕐 New time
                  </button>
                  <button className="btn btn--ghost btn--sm" disabled={submitting}
                    onClick={() => { setVibeInputOpen(v => !v); setVibeText(''); }}>
                    🎲 New vibe
                  </button>
                </>
              )}
            </>
          )}

          {/* Attendee: organizer's picked card → Accept or Decline only */}
          {showAttendeeControls && !showAttendeeSentIndicator && isOrganizerPick && (
            <>
              <button className="btn btn--primary btn--sm" disabled={submitting} onClick={() => onAccept(suggestion.id)}>
                Accept
              </button>
              <button className="btn btn--danger btn--sm" disabled={submitting} onClick={onDecline}>
                Decline
              </button>
            </>
          )}

          {/* Attendee: non-pick cards → counter-propose or swap */}
          {showAttendeeControls && !showAttendeeSentIndicator && !isOrganizerPick && (
            <>
              <button className="btn btn--ghost btn--sm" disabled={submitting}
                onClick={() => onSuggestAlternative(suggestion.id)}>
                {thisCardBusy
                  ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Sending…</>
                  : '↩ Suggest this instead'}
              </button>
              <button className="btn btn--ghost btn--sm" disabled={submitting}
                onClick={() => onRerollWithFeedback(suggestion.id, 'timing')}>
                {thisCardBusy ? '…' : '🕐 New time'}
              </button>
              <button className="btn btn--ghost btn--sm" disabled={submitting}
                onClick={() => { setVibeInputOpen(v => !v); setVibeText(''); }}>
                {thisCardBusy ? '…' : '🎲 New vibe'}
              </button>
            </>
          )}

          {/* Inline vibe prompt — shown when user clicks "New vibe" on any card.
              Submits the text as contextPrompt for the single-card activity reroll. */}
          {vibeInputOpen && (
            <div style={{ width: '100%', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea
                autoFocus
                className="form-control"
                rows={2}
                placeholder="e.g. 'something outdoors', 'more low-key', 'closer to Brooklyn'…"
                value={vibeText}
                onChange={(e) => setVibeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    setVibeInputOpen(false);
                    onRerollWithFeedback(suggestion.id, 'activity', vibeText.trim());
                  }
                  if (e.key === 'Escape') setVibeInputOpen(false);
                }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn--primary btn--sm" disabled={submitting}
                  onClick={() => { setVibeInputOpen(false); onRerollWithFeedback(suggestion.id, 'activity', vibeText.trim()); }}>
                  Generate
                </button>
                <button className="btn btn--ghost btn--sm" onClick={() => setVibeInputOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Calendar link shown only once the plan is locked */}
      {locked && (
        <div className="suggestion-card__footer">
          <a href={buildGCalUrl(suggestion, itinerary)} target="_blank" rel="noopener noreferrer" className="btn btn--ghost btn--sm">
            {calendarEventId ? '📅 View in Google Calendar' : '📅 Add to Calendar'}
          </a>
        </div>
      )}
    </div>
  );
}

/* ── ItineraryView ──────────────────────────────────────────── */

/**
 * Main itinerary detail page.
 * Loads the itinerary by ID from the URL, determines the viewer's role,
 * and renders suggestion cards with the appropriate action buttons.
 */
export default function ItineraryView() {
  const { id }   = useParams();
  const navigate = useNavigate();

  const [itin,         setItin]       = useState(null);
  const [loading,      setLoading]    = useState(true);
  const [error,        setError]      = useState('');
  const [submitting,   setSubmitting] = useState(false);
  // Tracks the suggestion.id whose per-card action is in-flight (for spinners).
  const [activeCardId, setActiveCardId] = useState(null);
  const [rerollOpen,      setRerollOpen]      = useState(false);
  const [rerolling,       setRerolling]       = useState(false);
  // True while the "Generate More" append request is in-flight.
  const [generatingMore,  setGeneratingMore]  = useState(false);

  // Inline title editing
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft,   setTitleDraft]   = useState('');

  /**
   * Fetches the latest itinerary data from the server and refreshes myId in case
   * sessionStorage wasn't populated yet on the initial render.
   * Wrapped in useCallback so it can be used as a useEffect dependency without
   * re-creating on every render — only recreated when `id` changes.
   */
  const load = useCallback(async () => {
    try {
      const res = await client.get(`/schedule/itinerary/${id}`);
      setItin(res.data);
    } catch {
      setError('Could not load this itinerary.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  /**
   * Derives a simplified status string from the raw organizer/attendee status fields.
   * This collapses the two-column status into a single value the UI can branch on:
   *   'pending'           — organizer hasn't sent yet (draft)
   *   'sent'              — organizer sent; attendee evaluating (or org locked their pick)
   *   'attendee_suggested'— attendee counter-proposed; organizer needs to re-evaluate
   *   'confirmed'         — both agreed; locked_at is set
   */
  function deriveStatus(itin) {
    if (!itin) return 'pending';
    if (itin.locked_at) return 'confirmed';
    const os = itin.organizer_status;
    const as = itin.attendee_status;
    if (os === 'pending') return 'pending';
    // Both accepted but no lock: attendee counter-proposed a different card.
    // Detected via attendeeSelected:true on any suggestion in the JSONB array.
    // (The DB constraint forbids 'sent' as a status value, so we use the JSONB flag instead.)
    // Attendee counter-proposed: org=accepted, att=pending, attendeeSelected flag set.
    // (att stays 'pending' to avoid the DB auto-lock trigger which fires on both='accepted'.)
    if (os === 'accepted' && as === 'pending') {
      const hasAttendeeSelected = (itin.suggestions || []).some(s => s.attendeeSelected);
      return hasAttendeeSelected ? 'attendee_suggested' : 'sent';
    }
    if (os === 'accepted') return 'sent';
    return 'sent';
  }

  /* ── Action handlers ── */

  /**
   * Organizer picks a suggestion and sends the itinerary in one step.
   * Calls /send first (notifies the attendee; no status change — 'sent' is not a valid DB value)
   * then /confirm (records selected_suggestion_id and sets organizer_status='accepted').
   */
  async function handlePick(suggestionId) {
    setSubmitting(true);
    try {
      await client.post(`/schedule/itinerary/${id}/send`);
      await client.post('/schedule/confirm', { itineraryId: id, suggestionId });
      await load();
    } catch { setError('Could not send your pick. Please try again.'); }
    finally { setSubmitting(false); }
  }

  /**
   * Either party accepts a suggestion.
   * If both sides have now accepted the same card, the server sets locked_at and the
   * plan is confirmed. Always reloads after to reflect the latest state.
   */
  async function handleAccept(suggestionId) {
    setSubmitting(true);
    try {
      await client.post('/schedule/confirm', { itineraryId: id, suggestionId });
      await load();
    } catch { setError('Could not confirm. Please try again.'); }
    finally { setSubmitting(false); }
  }

  /**
   * Either party declines the itinerary entirely.
   * Navigates home on success; the itinerary is marked declined on the server.
   */
  async function handleDecline() {
    setSubmitting(true);
    try {
      await client.post(`/schedule/itinerary/${id}/decline`);
      navigate('/');
    } catch { setError('Could not decline. Please try again.'); }
    finally { setSubmitting(false); }
  }

  /**
   * Full-board reroll: replaces all 3 suggestions using a new context prompt.
   * Called from the RerollModal. The modal always closes in the finally block regardless
   * of success or failure — errors are displayed in the main view, not inside the modal,
   * so we need the modal out of the way for the user to see them.
   */
  async function handleRerollSubmit(context) {
    setRerolling(true);
    try {
      await client.post(`/schedule/itinerary/${id}/reroll`, { contextPrompt: context });
      await load();
    } catch { setError('Could not generate new suggestions. Please try again.'); }
    finally {
      setRerolling(false);
      // Close the modal in finally (not the try block) so it closes on both success
      // and failure — without this, a failed reroll leaves the modal open while the
      // error message sits invisible behind it.
      setRerollOpen(false);
    }
  }

  /**
   * Generates additional suggestions and appends them to the existing list.
   * Uses appendMode=true on the reroll endpoint so statuses and the organizer's pick
   * are untouched — we're just adding more options, not resetting the negotiation.
   */
  async function handleGenerateMore() {
    setGeneratingMore(true);
    setError('');
    try {
      await client.post(`/schedule/itinerary/${id}/reroll`, { appendMode: true });
      await load();
    } catch { setError('Could not generate more suggestions. Please try again.'); }
    finally { setGeneratingMore(false); }
  }

  /**
   * Per-card reroll: swaps out a single suggestion while preserving the others.
   * rerollType is 'timing' (same activity, new time) or 'activity' (same time, new activity).
   * feedback is the optional vibe prompt text from the inline textarea — scoped to this
   * card only and passed as contextPrompt in the request.
   * activeCardId drives the per-card busy spinner in SuggestionCard.
   */
  async function handleSingleCardReroll(suggestionId, rerollType, feedback = '') {
    setSubmitting(true);
    setActiveCardId(suggestionId);
    setError('');
    try {
      await client.post(`/schedule/itinerary/${id}/reroll`, {
        replaceSuggestionId: suggestionId,
        rerollType,
        ...(feedback ? { contextPrompt: feedback } : {}),
      });
      await load();
    } catch (err) { setError(err.message || 'Could not reroll. Please try again.'); }
    finally { setSubmitting(false); setActiveCardId(null); }
  }

  /**
   * Attendee counter-proposes a non-pick card.
   * Posts to /confirm with isSuggestAlternative=true, which sets attendeeSelected:true
   * on the JSONB suggestion object and keeps attendee_status='pending' (not 'accepted')
   * to avoid triggering the DB auto-lock trigger. The organizer sees the attendee_suggested
   * state via deriveStatus() reading the JSONB flag.
   */
  async function handleSuggestAlternative(suggestionId) {
    setSubmitting(true);
    setActiveCardId(suggestionId);
    setError('');
    try {
      await client.post('/schedule/confirm', { itineraryId: id, suggestionId, isSuggestAlternative: true });
      await load();
    } catch (err) { setError(err.message || 'Could not suggest alternative. Please try again.'); }
    finally { setSubmitting(false); setActiveCardId(null); }
  }

  /**
   * Saves an updated event title inline. Best-effort: failures don't surface to the user
   * because the title is cosmetic (just a label in the plans list).
   */
  async function handleSaveTitle() {
    const trimmed = titleDraft.trim().slice(0, 80);
    try {
      await client.patch(`/schedule/itinerary/${id}/title`, { eventTitle: trimmed || null });
      setItin(prev => ({ ...prev, event_title: trimmed || null }));
    } catch { /* best-effort — title is cosmetic, don't block the user on failure */ }
    setEditingTitle(false);
  }

  /* ── Render ── */

  if (loading) return (
    <><NavBar /><main className="page"><div className="container">
      <div className="loading"><div className="spinner spinner--lg" /><span>Loading…</span></div>
    </div></main></>
  );

  // Fatal error (e.g., 404 or network failure on initial load)
  if (error && !itin) return (
    <><NavBar /><main className="page"><div className="container">
      <div className="alert alert--error">{error}</div>
      <button className="btn btn--ghost" onClick={() => navigate('/')}>← Back</button>
    </div></main></>
  );

  // isOrganizer is computed server-side (organizer_id === req.userId in the API route)
  // and included in the response. This is more reliable than a client-side UUID
  // comparison, which required storing supabaseId in sessionStorage.
  const isOrganizer = itin.isOrganizer;
  const status      = deriveStatus(itin);
  // Sort suggestion cards so the most relevant card is always first:
  //   Organizer re-evaluating (attendeeSelected set): attendee's suggested card floats to top
  //   Attendee viewing organizer's pick: organizer's pick card floats to top
  //   All other cases: original order preserved
  const rawSuggestions = itin.suggestions || [];
  const hasAttendeeSel = !itin.locked_at && rawSuggestions.some(s => s.attendeeSelected);
  const suggestions = (() => {
    if (isOrganizer && hasAttendeeSel) {
      return [...rawSuggestions].sort((a, b) => (a.attendeeSelected ? -1 : b.attendeeSelected ? 1 : 0));
    }
    if (isOrganizer) return rawSuggestions;
    // Attendee: sort organizer's pick to top, unless attendee has already counter-proposed
    if (hasAttendeeSel) return rawSuggestions;
    const pickId = itin.selected_suggestion_id;
    if (!pickId) return rawSuggestions;
    return [...rawSuggestions].sort((a, b) => (a.id === pickId ? -1 : b.id === pickId ? 1 : 0));
  })();
  const lockedSugId = itin.selected_suggestion_id; // only meaningful when locked_at is set

  // orgPickedId: tracks which card the organizer chose.
  // When the attendee has counter-proposed (attendeeSelected flag present), the organizer is
  // in re-evaluation mode — null out orgPickedId so their old pick isn't highlighted as active.
  // (attendee_status stays 'pending' during counter-propose to avoid the DB auto-lock trigger.)
  const hasAttendeeSelected = hasAttendeeSel;
  const orgPickedId = hasAttendeeSelected ? null : itin.selected_suggestion_id;

  // atPickedId: the card the attendee most recently counter-proposed.
  // Stored as attendeeSelected:true on the JSONB suggestion rather than in selected_suggestion_id,
  // so we can preserve the organizer's pick reference independently.
  const atPickedId = !itin.locked_at
    ? ((itin.suggestions || []).find(s => s.attendeeSelected)?.id || null)
    : null;

  const attendeeName      = itin.attendee?.full_name  || 'Friend';
  const organizerName     = itin.organizer?.full_name || 'Organizer';
  const organizerLocation = itin.organizer?.location  || '';
  const role              = isOrganizer ? 'organizer' : 'attendee';
  const friendName        = isOrganizer ? attendeeName : organizerName;
  const friendFirstName   = friendName.split(' ')[0] || friendName;

  const titleDisplay = itin.event_title
    ? `${friendFirstName} · ${itin.event_title}`
    : `Plans with ${friendFirstName}`;

  // Organizer has sent their pick and is waiting — BUT only when the attendee hasn't yet
  // counter-proposed. If attendeeSelected is set, the organizer needs to re-evaluate (not wait).
  const sentAndWaiting = isOrganizer && itin.organizer_status === 'accepted' && !itin.locked_at && !hasAttendeeSelected;

  // Attendee has counter-proposed and is now waiting for the organizer to respond.
  const attendeeSentAndWaiting = !isOrganizer && hasAttendeeSelected && !itin.locked_at;

  // In either waiting state, show only the relevant card (organizer's pick or attendee's pick).
  const visibleSuggestions = sentAndWaiting
    ? suggestions.filter(s => s.id === orgPickedId)
    : attendeeSentAndWaiting
    ? suggestions.filter(s => s.attendeeSelected)
    : suggestions;

  return (
    <>
      <NavBar />

      {/* Full-board reroll modal — rendered outside the main flow so it overlays correctly */}
      {rerollOpen && (
        <RerollModal
          initialContext={itin.context_prompt || ''}
          onClose={() => setRerollOpen(false)}
          onSubmit={handleRerollSubmit}
          loading={rerolling}
        />
      )}

      <main className="page">
        <div className="container container--sm">
          {/* Edit button — hidden once either party is in a waiting state */}
          {!sentAndWaiting && !attendeeSentAndWaiting && (
            <button className="btn btn--ghost btn--sm" style={{ marginBottom: 16 }}
              onClick={() => {
                const friendId = isOrganizer ? itin.attendee_id : itin.organizer_id;
                navigate(`/schedule/new?friendId=${friendId}`);
              }}>
              ← Edit
            </button>
          )}

          {/* Page title with inline edit (pencil icon) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            {editingTitle ? (
              <>
                <input
                  autoFocus
                  type="text"
                  className="form-control"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveTitle(); if (e.key === 'Escape') setEditingTitle(false); }}
                  maxLength={80}
                  style={{ flex: 1, minWidth: 160, fontSize: '1.1rem' }}
                />
                <button className="btn btn--primary btn--sm" onClick={handleSaveTitle}>Save</button>
                <button className="btn btn--ghost btn--sm" onClick={() => setEditingTitle(false)}>Cancel</button>
              </>
            ) : (
              <>
                <h1 className="page-title" style={{ marginBottom: 0, flex: 1 }}>{titleDisplay}</h1>
                <button
                  title="Edit title"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--text-3)' }}
                  onClick={() => { setTitleDraft(itin.event_title || ''); setEditingTitle(true); }}
                >✏️</button>
              </>
            )}
          </div>

          {/* Non-fatal error banner (e.g., a failed reroll after successful initial load) */}
          {error && <div className="alert alert--error" style={{ marginBottom: 12 }}>{error}</div>}

          {/* Suggestion cards — all shown normally; only the picked card shown while waiting */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {visibleSuggestions.map((s) => {
              // A suggestion is "confirmed" only when the plan is locked AND it's the picked one.
              const isThisConfirmed    = !!itin.locked_at && lockedSugId === s.id;
              const isThisOrgPick      = orgPickedId === s.id && !itin.locked_at;
              const isThisAttendeePick = atPickedId === s.id && !itin.locked_at;

              return (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  isConfirmed={isThisConfirmed}
                  isPicked={isThisOrgPick && isOrganizer}
                  isOrganizerPick={isThisOrgPick}
                  isAttendeePick={isThisAttendeePick}
                  role={role}
                  status={status}
                  onAccept={handleAccept}
                  onDecline={handleDecline}
                  onReroll={() => setRerollOpen(true)}
                  onPick={handlePick}
                  onRerollWithFeedback={(sugId, type, feedback) => handleSingleCardReroll(sugId, type, feedback)}
                  onSuggestAlternative={handleSuggestAlternative}
                  organizerName={organizerName}
                  attendeeName={attendeeName}
                  organizerLocation={organizerLocation}
                  submitting={submitting}
                  activeCardId={activeCardId}
                  itinerary={itin}
                  calendarEventId={itin.calendar_event_id}
                />
              );
            })}
          </div>

          {/* Waiting state — shown after either party has committed to a pick */}
          {(sentAndWaiting || attendeeSentAndWaiting) && (
            <div style={{ textAlign: 'center', padding: '24px 0 8px' }}>
              <p style={{ color: 'var(--text-2)', marginBottom: 16 }}>
                We'll let you know when {friendFirstName} responds.
              </p>
              <button className="btn btn--primary" onClick={() => navigate('/')}>
                Return Home
              </button>
            </div>
          )}

          {/* Generate More — only shown while neither party is in a waiting state */}
          {!itin.locked_at && !sentAndWaiting && !attendeeSentAndWaiting && (
            <button
              className="btn btn--ghost btn--sm"
              style={{ marginTop: 8, width: '100%' }}
              disabled={generatingMore || submitting}
              onClick={handleGenerateMore}
            >
              {generatingMore
                ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Generating…</>
                : '+ Generate More Options'}
            </button>
          )}
        </div>
      </main>
    </>
  );
}
