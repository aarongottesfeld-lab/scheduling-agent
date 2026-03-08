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
  const parts = [dateStr, timeStr].filter(Boolean).join('T');
  const d = new Date(parts);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
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
  const start = [suggestion.date, suggestion.time].filter(Boolean).join('T').replace(/[-:]/g, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text:   `${suggestion.activityType || 'Event'} with ${itinerary?.attendee?.name || ''}`,
    details: suggestion.narrative || '',
    location: suggestion.neighborhood || '',
    ...(start ? { dates: `${start}/${start}` } : {}),
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
function SuggestionCard({ suggestion, isConfirmed, role, status, onConfirm, onSend, onAccept, onDecline, onReroll, submitting }) {
  const isOrganizer   = role === 'organizer';
  const isAttendee    = role === 'attendee';
  const notSentYet    = status === 'pending';
  const awaitingMe    = status === 'sent' && isAttendee;
  const locked        = status === 'confirmed';

  return (
    <div className={`suggestion-card${isConfirmed ? ' suggestion-card--confirmed' : ''}`}>
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
      </div>

      <div className="suggestion-card__body">
        {/* Rationale */}
        {suggestion.rationale && (
          <p className="suggestion-card__rationale">{suggestion.rationale}</p>
        )}

        {/* Travel times */}
        {(suggestion.estimatedTravelA || suggestion.estimatedTravelB || suggestion.travelTime?.organizer || suggestion.travelTime?.attendee) && (
          <div className="travel-row">
            {(suggestion.estimatedTravelA || suggestion.travelTime?.organizer) && (
              <span className="travel-chip">🚗 You: {suggestion.estimatedTravelA || suggestion.travelTime.organizer}</span>
            )}
            {(suggestion.estimatedTravelB || suggestion.travelTime?.attendee) && (
              <span className="travel-chip">🚗 Them: {suggestion.estimatedTravelB || suggestion.travelTime.attendee}</span>
            )}
          </div>
        )}

        {/* Venue suggestions */}
        {suggestion.venues?.length > 0 && (
          <div className="venue-chips">
            {suggestion.venues.map((v, i) => (
              <span key={i} className="venue-chip">
                {v.name}
                {v.rating != null && (
                  <span className="venue-chip__rating">★ {v.rating}</span>
                )}
              </span>
            ))}
          </div>
        )}

        {/* Narrative */}
        {suggestion.narrative && (
          <p className="suggestion-card__narrative">{suggestion.narrative}</p>
        )}
      </div>

      {/* Action buttons */}
      {!locked && (
        <div className="suggestion-card__footer">
          {isOrganizer && notSentYet && (
            <>
              <button
                className="btn btn--primary"
                onClick={() => onSend()}
                disabled={submitting}
              >
                Send to friend
              </button>
              <button
                className="btn btn--ghost"
                onClick={onReroll}
                disabled={submitting}
              >
                Re-roll
              </button>
            </>
          )}
          {isAttendee && awaitingMe && (
            <>
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
                className="btn btn--ghost"
                onClick={onReroll}
                disabled={submitting}
              >
                Re-roll with edits
              </button>
            </>
          )}
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

  const [rerollOpen,  setRerollOpen]  = useState(false);
  const [rerolling,   setRerolling]   = useState(false);

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
  const role = itinerary?.organizer_id === myUserId || itinerary?.organizer?.id === myUserId
    ? 'organizer' : 'attendee';
  const myStatus    = role === 'organizer' ? itinerary?.organizer_status : itinerary?.attendee_status;
  const otherStatus = role === 'organizer' ? itinerary?.attendee_status  : itinerary?.organizer_status;
  // Derive overall status
  const locked      = !!itinerary?.locked_at;
  const status      = locked ? 'confirmed'
    : (myStatus === 'declined' || otherStatus === 'declined') ? 'declined'
    : itinerary?.organizer_status === 'sent' ? 'sent'
    : 'pending';
  const confirmedId = itinerary?.selected_suggestion_id;
  const context     = itinerary?.context_prompt || '';

  /* Actions */
  async function handleSend() {
    setSubmitting(true); setActionErr('');
    try {
      await client.post(`/schedule/itinerary/${itineraryId}/send`);
      await load();
    } catch (err) { setActionErr(err.message || 'Could not send.'); }
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
                role={role}
                status={status}
                onSend={handleSend}
                onAccept={handleAccept}
                onDecline={handleDecline}
                onReroll={() => setRerollOpen(true)}
                submitting={submitting}
              />
            ))
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
