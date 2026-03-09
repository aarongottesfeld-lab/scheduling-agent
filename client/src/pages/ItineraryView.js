// 9/10 — ItineraryView
// Fetches an itinerary by ID and renders up to 3 suggestion cards.
// Button set adapts based on the current user's role (organizer / attendee)
// and the itinerary's status.
// Includes a re-roll modal with an editable context prompt, and a changelog
// section visible once the itinerary is locked/confirmed.

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';
import { getUserId } from '../utils/auth';
import client from '../utils/client';

/* ── Helpers ────────────────────────────────────────────────── */
function formatDateTime(dateStr, timeStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  if (isNaN(d)) return dateStr;
  const datePart = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return timeStr ? `${datePart} at ${timeStr}` : datePart;
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function buildGCalUrl(suggestion, itinerary) {
  // Title: e.g. "Bowling with Jamie" using first venue or activity type
  const venueName = suggestion.venues?.[0]?.name || suggestion.activityType || 'Plans';
  const otherFirst = (itinerary?.attendee?.full_name || itinerary?.organizer?.full_name || '').split(' ')[0] || 'Friend';
  const title = `${venueName} with ${otherFirst}`;

  // Location: first venue address, fall back to neighborhood
  const location = suggestion.venues?.[0]?.address || suggestion.neighborhood || '';

  // Description: narrative + venue list
  const venueLines = (suggestion.venues || []).map(v => `${v.name}${v.address ? ' — ' + v.address : ''}`).join('\n');
  const details = [suggestion.narrative, venueLines ? '\nStops:\n' + venueLines : ''].filter(Boolean).join('\n\n');

  // Dates: GCal needs YYYYMMDDTHHmmss format
  function toGCalDate(dateStr, timeStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    if (!timeStr) return `${y}${m}${d}`;
    // parse "7:00 PM" style
    const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!match) return `${y}${m}${d}`;
    let h = parseInt(match[1]);
    const min = match[2];
    const ampm = match[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    const hh = String(h).padStart(2, '0');
    const durMins = suggestion.durationMinutes || 120;
    const endMs = new Date(`${dateStr}T${hh}:${min}:00`).getTime() + durMins * 60000;
    const end = new Date(endMs);
    const endStr = `${end.getFullYear()}${String(end.getMonth()+1).padStart(2,'0')}${String(end.getDate()).padStart(2,'0')}T${String(end.getHours()).padStart(2,'0')}${String(end.getMinutes()).padStart(2,'0')}00`;
    return `${y}${m}${d}T${hh}${min}00/${endStr}`;
  }

  const dates = toGCalDate(suggestion.date, suggestion.time);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    details,
    location,
    ...(dates ? { dates } : {}),
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/* ── Re-roll Modal ──────────────────────────────────────────── */
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
            <textarea
              id="reroll-context"
              className="form-control"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={4}
              placeholder="e.g. 'something outdoors', 'closer to downtown', 'more casual'"
            />
            <p className="form-hint">Edit or add to the original prompt — the AI will adjust accordingly.</p>
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={() => onSubmit(context)}
            disabled={loading}
          >
            {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Generating…</> : 'Generate New Suggestions'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Suggestion Card ────────────────────────────────────────── */
function SuggestionCard({
  suggestion, isConfirmed, isPicked, role, status,
  onConfirm, onAccept, onDecline, onReroll, onPick, onRerollWithFeedback,
  organizerName, attendeeName, organizerLocation,
  submitting,
}) {
  const [expanded,     setExpanded]     = useState(isConfirmed);
  const [feedbackText, setFeedbackText] = useState('');

  const isOrganizer = role === 'organizer';
  const isAttendee  = role === 'attendee';
  const notSentYet  = status === 'pending';
  const awaitingMe  = status === 'sent' && isAttendee;
  const locked      = status === 'confirmed';

  const narrative = suggestion.narrative || '';
  const truncated = narrative.length > 100 ? narrative.slice(0, 100) + '…' : narrative;

  return (
    <div className={`suggestion-card${isConfirmed ? ' suggestion-card--confirmed' : ''}`}>
      {/* Card header */}
      <div className={`suggestion-card__header${isConfirmed ? ' suggestion-card__header--confirmed' : ''}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="suggestion-card__date">{formatDateTime(suggestion.date, suggestion.time)}</div>
            {suggestion.neighborhood && (
              <div className="suggestion-card__neighborhood">📍 {suggestion.neighborhood}</div>
            )}
          </div>
          {suggestion.activityType && (
            <span className="badge" style={{ background: 'rgba(255,255,255,.25)', color: '#fff' }}>
              {suggestion.activityType}
            </span>
          )}
        </div>
        {isConfirmed && (
          <div style={{ marginTop: 8, fontSize: '0.82rem', fontWeight: 700, opacity: .9 }}>
            ✓ Confirmed plan
          </div>
        )}
        {isPicked && !isConfirmed && (
          <div style={{ marginTop: 8, fontSize: '0.78rem', fontWeight: 700, color: 'rgba(255,255,255,0.85)', background: 'rgba(0,0,0,0.18)', borderRadius: 6, display: 'inline-block', padding: '2px 10px' }}>
            ✓ Your pick — waiting on them
          </div>
        )}
      </div>

      <div className="suggestion-card__body">
        {/* Always-visible collapsed preview */}
        {!expanded && narrative && (
          <p className="suggestion-card__narrative">{truncated}</p>
        )}
        {!expanded && suggestion.tags?.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
            {suggestion.tags.map((tag, i) => (
              <span key={i} style={{ fontSize: '0.72rem', background: 'var(--surface-2)', color: 'var(--text-2)', borderRadius: 99, padding: '2px 8px' }}>
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Toggle button — always visible */}
        <button
          className="btn btn--ghost btn--sm"
          style={{ marginTop: 10, padding: '4px 0', fontSize: '0.82rem' }}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? 'Collapse ↑' : 'See details & route ↓'}
        </button>

        {/* Animated expandable section */}
        <div style={{
          overflow: 'hidden',
          maxHeight: expanded ? '2000px' : '0',
          opacity: expanded ? 1 : 0,
          transition: 'max-height 0.3s ease, opacity 0.3s ease',
        }}>
          {/* Full narrative */}
          {narrative && (
            <p className="suggestion-card__narrative" style={{ marginTop: 8 }}>{narrative}</p>
          )}

          {/* Venues */}
          {suggestion.venues?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              {suggestion.venues.map((v, i) => (
                <div key={i}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <a
                      href={`https://maps.google.com/?q=${encodeURIComponent(v.address || v.name)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' }}
                    >
                      {v.name}
                    </a>
                    {v.type && (
                      <span className="badge" style={{ fontSize: '0.7rem', textTransform: 'capitalize' }}>
                        {v.type}
                      </span>
                    )}
                  </div>
                  {v.address && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-3)', marginTop: 2 }}>
                      {v.address}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

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
                <span key={i} style={{ fontSize: '0.72rem', background: 'var(--surface-2)', color: 'var(--text-2)', borderRadius: 99, padding: '2px 8px' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Getting there */}
          {(() => {
            const dest   = suggestion.venues?.[0]?.address || suggestion.neighborhood || '';
            const origin = organizerLocation || '';
            if (!dest) return null;
            const href = `https://maps.google.com/?saddr=${encodeURIComponent(origin)}&daddr=${encodeURIComponent(dest)}`;
            return (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                  Getting there
                </div>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 0', borderBottom: '1px solid var(--border)',
                    textDecoration: 'none', color: 'var(--text-1)',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>🗺️</span>
                    <span style={{ fontSize: '0.88rem' }}>Open in Google Maps</span>
                  </span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--brand)' }}>Open →</span>
                </a>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Footer — organizer: pending (not yet sent) */}
      {isOrganizer && notSentYet && (
        <div className="suggestion-card__footer" style={{ flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn--primary"
              onClick={() => onPick(suggestion.id)}
              disabled={submitting}
            >
              Pick this one
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => onRerollWithFeedback(suggestion.id, '', 'timing')}
              disabled={submitting}
              title="Keep this activity, find a different time"
            >
              🕐 New time
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => onRerollWithFeedback(suggestion.id, '', 'activity')}
              disabled={submitting}
              title="Keep this time slot, suggest a different activity"
            >
              🎲 New vibe
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <input
              type="text"
              className="form-control"
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder="e.g. more casual, closer to Brooklyn"
              style={{ flex: 1 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && feedbackText.trim()) {
                  onRerollWithFeedback(suggestion.id, feedbackText);
                }
              }}
            />
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => onRerollWithFeedback(suggestion.id, feedbackText, 'both')}
              disabled={submitting || !feedbackText.trim()}
            >
              Regenerate
            </button>
          </div>
        </div>
      )}

      {/* Footer — attendee: awaiting response */}
      {isAttendee && awaitingMe && (
        <div className="suggestion-card__footer" style={{ flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn--primary"
              onClick={() => onAccept(suggestion.id)}
              disabled={submitting}
            >
              Accept
            </button>
            <button
              className="btn btn--danger"
              onClick={() => onDecline(suggestion.id)}
              disabled={submitting}
            >
              Decline
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => onRerollWithFeedback(suggestion.id, '', 'timing')}
              disabled={submitting}
              title="Keep this activity, find a different time"
            >
              🕐 New time
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => onRerollWithFeedback(suggestion.id, '', 'activity')}
              disabled={submitting}
              title="Keep this time slot, suggest a different activity"
            >
              🎲 New vibe
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <input
              type="text"
              className="form-control"
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder="e.g. more casual, closer to Brooklyn"
              style={{ flex: 1 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && feedbackText.trim()) {
                  onRerollWithFeedback(suggestion.id, feedbackText);
                }
              }}
            />
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => onRerollWithFeedback(suggestion.id, feedbackText, 'both')}
              disabled={submitting || !feedbackText.trim()}
            >
              Regenerate
            </button>
          </div>
        </div>
      )}

      {/* Confirmed actions */}
      {locked && isConfirmed && (
        <div className="suggestion-card__footer">
          <a
            href={buildGCalUrl(suggestion, null)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn--secondary"
          >
            📅 Add to Calendar
          </a>
        </div>
      )}
    </div>
  );
}

/* ── Main Component ─────────────────────────────────────────── */
export default function ItineraryView() {
  const { itineraryId } = useParams();
  const navigate        = useNavigate();
  const myUserId        = getUserId();

  const [itinerary,   setItinerary]   = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [actionErr,   setActionErr]   = useState('');

  const [rerollOpen,   setRerollOpen]   = useState(false);
  const [rerolling,    setRerolling]    = useState(false);
  const [loadingMore,  setLoadingMore]  = useState(false);

  const [changeText,  setChangeText]  = useState('');
  const [addingChange,setAddingChange]= useState(false);

  const load = useCallback(async () => {
    try {
      const res = await client.get(`/schedule/itinerary/${itineraryId}`);
      setItinerary(res.data);
    } catch (err) {
      setError(err.message || 'Could not load this itinerary.');
    } finally {
      setLoading(false);
    }
  }, [itineraryId]);

  useEffect(() => { load(); }, [load]);

  /* Derived state */
  // Use the server-computed isOrganizer flag — the server compares against the
  // real Supabase UUID, whereas getUserId() returns the session key which is a
  // different string and would always fail the organizer_id comparison.
  const role = itinerary?.isOrganizer ? 'organizer' : 'attendee';
  const myStatus    = role === 'organizer' ? itinerary?.organizer_status : itinerary?.attendee_status;
  const otherStatus = role === 'organizer' ? itinerary?.attendee_status  : itinerary?.organizer_status;
  const locked      = !!itinerary?.locked_at;
  // 'sent' covers both 'sent' (organizer chose nothing yet) and 'accepted'
  // (organizer used "Pick this one" which sends+confirms in one step) — in both
  // cases the ball is in the attendee's court.
  const status      = locked ? 'confirmed'
    : (myStatus === 'declined' || otherStatus === 'declined') ? 'declined'
    : (itinerary?.organizer_status === 'sent' || itinerary?.organizer_status === 'accepted') ? 'sent'
    : 'pending';
  const confirmedId = itinerary?.selected_suggestion_id;
  const context     = itinerary?.context_prompt || '';

  const organizerFirst    = (itinerary?.organizer?.full_name || '').split(' ')[0] || 'Organizer';
  const attendeeFirst     = (itinerary?.attendee?.full_name  || '').split(' ')[0] || 'Friend';
  const organizerLocation = itinerary?.organizer?.location || '';

  /* Actions */
  async function handleSend() {
    setSubmitting(true); setActionErr('');
    try {
      await client.post(`/schedule/itinerary/${itineraryId}/send`);
      await load();
    } catch (err) { setActionErr(err.message || 'Could not send.'); }
    finally { setSubmitting(false); }
  }

  async function handlePick(suggestionId) {
    setSubmitting(true); setActionErr('');
    try {
      await client.post(`/schedule/itinerary/${itineraryId}/send`);
      await client.post('/schedule/confirm', { itineraryId, suggestionId });
      await load();
    } catch (err) { setActionErr(err.message || 'Could not pick suggestion.'); }
    finally { setSubmitting(false); }
  }

  async function handleAccept(suggestionId) {
    setSubmitting(true); setActionErr('');
    try {
      await client.post('/schedule/confirm', { itineraryId, suggestionId });
      await load();
    } catch (err) { setActionErr(err.message || 'Could not confirm.'); }
    finally { setSubmitting(false); }
  }

  async function handleDecline(suggestionId) {
    setSubmitting(true); setActionErr('');
    try {
      await client.post(`/schedule/itinerary/${itineraryId}/decline`, { suggestionId });
      await load();
    } catch (err) { setActionErr(err.message); }
    finally { setSubmitting(false); }
  }

  async function handleReroll(newContext) {
    setRerolling(true); setActionErr('');
    try {
      const res = await client.post(`/schedule/itinerary/${itineraryId}/reroll`, {
        contextPrompt: newContext,
      });
      const newId = res.data?.itineraryId || res.data?.id;
      setRerollOpen(false);
      if (newId && newId !== itineraryId) {
        navigate(`/schedule/${newId}`);
      } else {
        await load();
      }
    } catch (err) { setActionErr(err.message); }
    finally { setRerolling(false); }
  }

  async function handleRerollWithFeedback(suggestionId, feedback, rerollType = 'both') {
    setRerolling(true); setActionErr('');
    try {
      await client.post(`/schedule/itinerary/${itineraryId}/reroll`, {
        contextPrompt: context,
        feedback: feedback || '',
        replaceSuggestionId: suggestionId,
        rerollType,
      });
      setRerollOpen(false);
      await load();
    } catch (err) { setActionErr(err.message); }
    finally { setRerolling(false); }
  }

  async function handleShowMore() {
    setLoadingMore(true); setActionErr('');
    try {
      await client.post(`/schedule/itinerary/${itineraryId}/reroll`, {
        contextPrompt: context,
        feedback: 'Generate 3 additional different suggestions, different vibes from the existing ones',
      });
      await load();
    } catch (err) { setActionErr(err.message || 'Could not load more options.'); }
    finally { setLoadingMore(false); }
  }

  async function handleSuggestChange() {
    const text = changeText.trim();
    if (!text) return;
    setAddingChange(true);
    try {
      await client.post(`/schedule/itinerary/${itineraryId}/changelog`, { message: text });
      setChangeText('');
      await load();
    } catch (err) { setActionErr(err.message); }
    finally { setAddingChange(false); }
  }

  /* ── Render ──────────────────────────────────────────────── */

  if (loading) {
    return (
      <>
        <NavBar />
        <main className="page">
          <div className="container container--sm">
            <div className="loading"><div className="spinner spinner--lg" /></div>
          </div>
        </main>
      </>
    );
  }

  if (error || !itinerary) {
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

  const otherPerson = role === 'organizer' ? itinerary.attendee : itinerary.organizer;
  const otherName = otherPerson?.full_name || otherPerson?.name || 'friend';
  const suggestions = itinerary.suggestions || [];

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container container--sm">

          {/* Header */}
          <div className="itinerary-header">
            <div className="itinerary-header__left">
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => navigate('/home')}
                style={{ marginBottom: 12 }}
              >
                ← Home
              </button>
              <h1 className="page-title" style={{ marginBottom: 4 }}>
                Plans with {otherName.split(' ')[0]}
              </h1>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className={`badge${status === 'confirmed' ? ' badge--green' : status === 'declined' ? ' badge--red' : ' badge--amber'}`}>
                  {status}
                </span>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-3)' }}>
                  {role === 'organizer' ? 'You created this' : 'From ' + (itinerary.organizer?.full_name || itinerary.organizer?.name || 'organizer')}
                </span>
              </div>
            </div>
          </div>

          {actionErr && <div className="alert alert--error">{actionErr}</div>}

          {/* Confirmed banner */}
          {/* Attendee sees this when organizer hasn't sent yet */}
          {!locked && role === 'attendee' && status === 'pending' && (
            <div style={{
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 10, padding: '16px 20px', textAlign: 'center',
              color: 'var(--text-2)', fontSize: '0.92rem', marginBottom: 16,
            }}>
              ⏳ Waiting for {organizerFirst} to pick a plan to send you.
            </div>
          )}

          {locked && (
            <div className="confirmed-banner">
              <span style={{ fontSize: '1.4rem' }}>🎉</span>
              <span>You're both confirmed! See you there.</span>
            </div>
          )}

          {/* Suggestion cards */}
          {suggestions.length === 0 ? (
            <div className="card card-pad">
              <div className="empty-state">
                <div className="empty-state__icon">🔄</div>
                <div className="empty-state__title">No suggestions yet</div>
                <p className="empty-state__text">They're being generated — refresh in a moment.</p>
              </div>
            </div>
          ) : (
            suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                isConfirmed={locked && s.id === confirmedId}
                isPicked={!locked && role === 'organizer' && s.id === confirmedId}
                confirmedId={confirmedId}
                role={role}
                status={status}
                onAccept={handleAccept}
                onDecline={handleDecline}
                onReroll={() => setRerollOpen(true)}
                onPick={handlePick}
                onRerollWithFeedback={handleRerollWithFeedback}
                organizerName={organizerFirst}
                attendeeName={attendeeFirst}
                organizerLocation={organizerLocation}
                submitting={submitting || rerolling}
              />
            ))
          )}

          {/* Show More options */}
          {!locked && (itinerary?.reroll_count ?? 0) < 10 && suggestions.length > 0 && (
            <div style={{ marginTop: 8, textAlign: 'center' }}>
              {loadingMore ? (
                <div className="loading" style={{ padding: '12px 0' }}>
                  <div className="spinner" />
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-2)' }}>Finding more options…</span>
                </div>
              ) : (
                <button
                  className="btn btn--ghost"
                  onClick={handleShowMore}
                  disabled={submitting || rerolling}
                >
                  Show more options
                </button>
              )}
            </div>
          )}

          {/* Suggest a change (confirmed itineraries) */}
          {locked && (
            <div className="card card-pad" style={{ marginTop: 8 }}>
              <div className="section-title" style={{ marginBottom: 8 }}>Suggest a change</div>
              <div className="change-input-row">
                <input
                  type="text"
                  className="form-control"
                  value={changeText}
                  onChange={(e) => setChangeText(e.target.value)}
                  placeholder="e.g. 'Can we push to 7pm instead?'"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSuggestChange(); }}
                />
                <button
                  className="btn btn--secondary"
                  onClick={handleSuggestChange}
                  disabled={addingChange || !changeText.trim()}
                >
                  {addingChange ? '…' : 'Send'}
                </button>
              </div>

              {/* Changelog */}
              {itinerary.changelog?.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <div className="form-label" style={{ marginBottom: 8 }}>Change log</div>
                  <ul className="changelog">
                    {itinerary.changelog.map((entry, i) => (
                      <li key={i} className="changelog-item">
                        <span className="changelog-item__time">{formatTimestamp(entry.ts || entry.timestamp)}</span>
                        <span>{entry.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Re-roll modal */}
      {rerollOpen && (
        <RerollModal
          initialContext={context}
          onClose={() => { if (!rerolling) setRerollOpen(false); }}
          onSubmit={handleReroll}
          loading={rerolling}
        />
      )}
    </>
  );
}
