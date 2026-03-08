// 8/10 — NewEvent
// Event creation form. Collects friend, date range, time of day, max travel
// time, and a free-text context prompt. On submit, calls getSuggestions()
// from api.js and redirects to the resulting itinerary page.
//
// NOTE: getSuggestions() currently passes { targetUserId, daysAhead } to the
// server. The additional fields (dateRange, timeOfDay, maxTravelTime,
// contextPrompt) are collected here and ready to be wired up once the API
// is extended to accept them.

import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import NavBar from '../components/NavBar';
import { getSuggestions } from '../utils/api';
import client from '../utils/client';

/* ── Constants ──────────────────────────────────────────────── */
const TIME_OPTIONS = [
  { value: 'morning',   label: '🌅 Morning',   sub: '8am – 12pm' },
  { value: 'afternoon', label: '☀️ Afternoon',  sub: '12pm – 5pm' },
  { value: 'evening',   label: '🌆 Evening',    sub: '5pm – 10pm' },
  { value: 'any',       label: '🕐 Any time',   sub: '' },
];

const TRAVEL_OPTIONS = [
  { value: '15',  label: '15 min' },
  { value: '30',  label: '30 min' },
  { value: '45',  label: '45 min' },
  { value: '60',  label: '1 hour' },
  { value: '',    label: 'No limit' },
];

function today() {
  return new Date().toISOString().split('T')[0];
}

function daysFromToday(endDate) {
  const ms = new Date(endDate) - new Date(today());
  return Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

function getInitials(name = '') {
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

/* ── Component ──────────────────────────────────────────────── */
export default function NewEvent() {
  const navigate        = useNavigate();
  const [searchParams]  = useSearchParams();
  const prefillFriendId = searchParams.get('friendId');

  // Friend selection
  const [friendQuery,    setFriendQuery]    = useState('');
  const [friendResults,  setFriendResults]  = useState([]);
  const [friendSearching,setFriendSearching]= useState(false);
  const [selectedFriend, setSelectedFriend] = useState(null);

  // Form fields
  const [startDate,    setStartDate]    = useState(today());
  const [endDate,      setEndDate]      = useState('');
  const [timeOfDay,    setTimeOfDay]    = useState('any');
  const [maxTravel,    setMaxTravel]    = useState('30');
  const [context,      setContext]      = useState('');

  // State
  const [generating, setGenerating] = useState(false);
  const [error,      setError]      = useState('');

  /* Pre-fill friend from URL param */
  useEffect(() => {
    if (!prefillFriendId) return;
    client.get(`/friends/${prefillFriendId}/profile`)
      .then((res) => setSelectedFriend({ id: prefillFriendId, ...res.data }))
      .catch(() => {}); // non-fatal — user can search manually
  }, [prefillFriendId]);

  /* Friend search */
  useEffect(() => {
    if (!friendQuery.trim()) { setFriendResults([]); return; }
    const timer = setTimeout(async () => {
      setFriendSearching(true);
      try {
        const res = await client.get('/friends', { params: { search: friendQuery } });
        setFriendResults(res.data?.friends ?? []);
      } catch {
        setFriendResults([]);
      } finally {
        setFriendSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [friendQuery]);

  function selectFriend(f) {
    setSelectedFriend(f);
    setFriendQuery('');
    setFriendResults([]);
  }

  /* Validation */
  function validate() {
    if (!selectedFriend)   return 'Select a friend to schedule with.';
    if (!startDate)        return 'Choose a start date.';
    if (!endDate)          return 'Choose an end date.';
    if (endDate < startDate) return 'End date must be on or after the start date.';
    return '';
  }

  /* Submit */
  async function handleSubmit(e) {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }

    setGenerating(true);
    setError('');

    try {
      const daysAhead = daysFromToday(endDate);
      // getSuggestions() from api.js — passes targetUserId + daysAhead.
      // When the backend API is extended, the function signature should also
      // accept: startDate, endDate, timeOfDay, maxTravelMinutes, contextPrompt.
      const data = await getSuggestions({
        targetUserId: selectedFriend.id,
        daysAhead,
      });

      const itineraryId = data?.itineraryId || data?.id;
      if (!itineraryId) throw new Error('No itinerary ID returned from server.');
      navigate(`/schedule/${itineraryId}`);
    } catch (err) {
      setError(err.message || 'Could not generate suggestions. Please try again.');
      setGenerating(false);
    }
  }

  /* ── Render ────────────────────────────────────────────────── */

  if (generating) {
    return (
      <>
        <NavBar />
        <main className="page">
          <div className="container container--sm">
            <div className="generating-overlay">
              <div className="spinner spinner--lg" />
              <div className="generating-overlay__text">Finding the best options for you both…</div>
              <div className="generating-overlay__sub">
                Checking calendars, travel times, and preferences.
              </div>
            </div>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container container--sm">

          <h1 className="page-title">New Event</h1>
          <p className="page-subtitle">Plan something great together.</p>

          {error && <div className="alert alert--error">{error}</div>}

          <form onSubmit={handleSubmit} noValidate>

            {/* ── Friend selector ───────────────────────── */}
            <div className="form-group">
              <label className="form-label">Who are you meeting?</label>

              {selectedFriend ? (
                <div className="friend-card" style={{ marginBottom: 0 }}>
                  <div className="avatar">{getInitials(selectedFriend.name)}</div>
                  <div className="friend-card__info">
                    <div className="friend-card__name">{selectedFriend.name}</div>
                    {selectedFriend.username && (
                      <div className="friend-card__sub">@{selectedFriend.username}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setSelectedFriend(null)}
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    className="form-control"
                    value={friendQuery}
                    onChange={(e) => setFriendQuery(e.target.value)}
                    placeholder="Search your friends…"
                    autoComplete="off"
                  />
                  {friendSearching && (
                    <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }}>
                      <div className="spinner" style={{ width: 16, height: 16 }} />
                    </div>
                  )}
                  {friendResults.length > 0 && (
                    <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4 }}>
                      {friendResults.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                          onMouseDown={() => selectFriend(f)}
                        >
                          <div className="avatar avatar--sm">{getInitials(f.name)}</div>
                          <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{f.name}</span>
                          {f.username && <span style={{ fontSize: '0.8rem', color: 'var(--text-3)' }}>@{f.username}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Date range ────────────────────────────── */}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="start-date">From</label>
                <input
                  id="start-date"
                  type="date"
                  className="form-control"
                  value={startDate}
                  min={today()}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    if (endDate && e.target.value > endDate) setEndDate(e.target.value);
                  }}
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="end-date">To</label>
                <input
                  id="end-date"
                  type="date"
                  className="form-control"
                  value={endDate}
                  min={startDate || today()}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>

            {/* ── Time of day ───────────────────────────── */}
            <div className="form-group">
              <label className="form-label">Time of day</label>
              <div className="radio-group">
                {TIME_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className={`radio-item${timeOfDay === opt.value ? ' radio-item--checked' : ''}`}
                  >
                    <input
                      type="radio"
                      name="timeOfDay"
                      value={opt.value}
                      checked={timeOfDay === opt.value}
                      onChange={() => setTimeOfDay(opt.value)}
                    />
                    <span>
                      {opt.label}
                      {opt.sub && <span style={{ display: 'block', fontSize: '0.72rem', fontWeight: 400, color: 'var(--text-4)', marginTop: 1 }}>{opt.sub}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* ── Max travel time ───────────────────────── */}
            <div className="form-group">
              <label className="form-label" htmlFor="max-travel">Max travel time</label>
              <select
                id="max-travel"
                className="form-control"
                value={maxTravel}
                onChange={(e) => setMaxTravel(e.target.value)}
              >
                {TRAVEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* ── Context prompt ────────────────────────── */}
            <div className="form-group">
              <label className="form-label" htmlFor="context">
                Any preferences? <span className="optional">optional</span>
              </label>
              <textarea
                id="context"
                className="form-control"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="e.g. 'something low-key', 'good for catching up', 'near Midtown'"
                rows={3}
              />
              <p className="form-hint">Free text — our AI reads between the lines.</p>
            </div>

            {/* ── Submit ────────────────────────────────── */}
            <button type="submit" className="btn btn--primary btn--lg btn--full">
              Generate Suggestions
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
