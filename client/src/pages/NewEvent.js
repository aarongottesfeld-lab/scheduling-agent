// NewEvent.js — form for creating a new scheduling event.
// Collects friend, date window, time-of-day preference, travel cap,
// optional title and free-text context, then calls the AI suggestion engine.
// Once generation starts, the form is replaced with a spinner overlay until the AI responds.
// Privacy: only supabaseId sent to PostHog — no PII, no health data, no calendar content

import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import posthog from 'posthog-js';
import NavBar from '../components/NavBar';
import { getSuggestions, getMe } from '../utils/api';
import client from '../utils/client';
import { getInitials } from '../utils/formatting';

/* ── Constants ──────────────────────────────────────────────── */

// Half-hour increments for the custom time picker.
const APPROX_TIMES = [
  '12:00 AM','12:30 AM','1:00 AM','1:30 AM','2:00 AM','2:30 AM',
  '3:00 AM','3:30 AM','4:00 AM','4:30 AM','5:00 AM','5:30 AM',
  '6:00 AM','6:30 AM','7:00 AM','7:30 AM','8:00 AM','8:30 AM',
  '9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM',
  '12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM',
  '3:00 PM','3:30 PM','4:00 PM','4:30 PM','5:00 PM','5:30 PM',
  '6:00 PM','6:30 PM','7:00 PM','7:30 PM','8:00 PM','8:30 PM',
  '9:00 PM','9:30 PM','10:00 PM','10:30 PM','11:00 PM','11:30 PM',
];

// Flexibility window around the custom time the user picks.
const WINDOW_OPTIONS = [
  { value: '15', label: '± 15 min' },
  { value: '30', label: '± 30 min' },
  { value: '60', label: '± 1 hour' },
  { value: '120', label: '± 2 hours' },
];

// Preset time-of-day buckets shown as radio cards.
const TIME_OPTIONS = [
  { value: 'morning',   label: '🌅 Morning',    sub: '8am – 12pm' },
  { value: 'afternoon', label: '☀️ Afternoon',   sub: '12pm – 5pm' },
  { value: 'evening',   label: '🌆 Evening',     sub: '5pm – 10pm' },
  { value: 'any',       label: '🕐 Any time',    sub: '' },
  { value: 'custom',    label: '🎯 Custom time', sub: '' },
];

// Where-to-meet options — controls location anchoring in the suggestion engine.
// Maps to location_preference values stored on the itinerary row.
const LOCATION_OPTIONS = [
  { value: 'system_choice',        label: '🗺 Up to the system' },
  { value: 'closer_to_organizer',  label: '📍 Closer to me' },
  { value: 'closer_to_attendee',   label: '📍 Closer to them' },
];

// Travel mode — Local stays in your city area; Remote is virtual; Travel is for overnight/destination trips.
const TRAVEL_MODE_OPTIONS = [
  { value: 'local',   label: 'Local' },
  { value: 'remote',  label: 'Remote' },
  { value: 'travel',  label: 'Travel' },
];

// Max-travel time cap options sent to the suggestion engine.
const TRAVEL_OPTIONS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '45', label: '45 min' },
  { value: '60', label: '1 hour' },
  { value: '',   label: 'No limit' },
];

/* ── Helpers ─────────────────────────────────────────────────── */

/**
 * Returns today's date as a YYYY-MM-DD string in the user's LOCAL timezone.
 * toISOString() returns UTC, which can be off by a day for users in UTC- or UTC+
 * timezones — e.g. 11 PM EST = next-day UTC, making the default start date tomorrow.
 */
function today() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * How many days from today until endDate (inclusive)?
 * Clamped to a minimum of 1 so the engine always has at least one day to search.
 */
function daysFromToday(endDate) {
  const ms = new Date(endDate) - new Date(today());
  return Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

/** 'YYYY-MM-DD' → 'Mar 20' */
function formatDateShort(s) {
  const [, m, d] = s.split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m-1]} ${+d}`;
}

/** 'HH:MM' → 'H:MM AM/PM' */
function formatTime12h(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/* ── Component ──────────────────────────────────────────────── */

export default function NewEvent() {
  const navigate        = useNavigate();
  const [searchParams]  = useSearchParams();
  // If navigated from a friend's profile, pre-select that friend automatically.
  const prefillFriendId = searchParams.get('friendId');

  // Friend picker state
  const [allFriends,     setAllFriends]     = useState([]);
  const [friendQuery,    setFriendQuery]    = useState('');
  const [friendResults,  setFriendResults]  = useState([]);
  const [selectedFriend, setSelectedFriend] = useState(null);
  // Ref for click-outside detection on the friend dropdown.
  const friendDropRef = useRef(null);

  // Form field state
  const [startDate,    setStartDate]    = useState(today());
  const [endDate,      setEndDate]      = useState('');
  const [timeOfDay,    setTimeOfDay]    = useState('any');
  const [customTime,   setCustomTime]   = useState('7:00 PM');
  const [customWindow, setCustomWindow] = useState('30');
  const [maxTravel,           setMaxTravel]           = useState('30');
  const [context,             setContext]             = useState('');
  const [eventTitle,          setEventTitle]          = useState('');
  // location_preference — where to anchor venue suggestions. Defaults to system_choice
  // so the form works without any extra interaction (same behavior as before this feature).
  const [locationPreference,  setLocationPreference]  = useState('system_choice');
  // travel_mode — 'local' (same city) or 'travel' (overnight/destination trip).
  const [travelMode,          setTravelMode]          = useState('local');
  // trip_duration_days — only active when travelMode='travel'. 1 / 2 / 5 days.
  const [tripDurationDays,    setTripDurationDays]    = useState(1);
  // destination — free text; only active when travelMode='travel' and locationPreference='destination'.
  const [destination,         setDestination]         = useState('');
  // Organizer's first name — fetched once for the helper text below the location selector.
  // Falls back to 'you' if the fetch fails or the name is missing.
  const [organizerFirstName,  setOrganizerFirstName]  = useState('');

  // Busy block state — organizer can block off specific dates/time ranges.
  const [busyBlocks,    setBusyBlocks]    = useState([]);
  const [busyBlockOpen, setBusyBlockOpen] = useState(false);
  const [busyDate,      setBusyDate]      = useState('');
  const [busyLabel,     setBusyLabel]     = useState('');
  const [busyTimeStart, setBusyTimeStart] = useState('');
  const [busyTimeEnd,   setBusyTimeEnd]   = useState('');

  // UI state
  const [generating,            setGenerating]            = useState(false);
  const [error,                 setError]                 = useState('');
  const [awaitingConflictOk,    setAwaitingConflictOk]    = useState(false);

  /* ── Effects ── */

  // Close the friend dropdown when the user clicks elsewhere on the page.
  useEffect(() => {
    if (!friendResults.length) return;
    function handleClickOutside(e) {
      if (friendDropRef.current && !friendDropRef.current.contains(e.target)) setFriendResults([]);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [friendResults.length]);

  // Load all friends once so we can populate the dropdown on focus.
  useEffect(() => {
    client.get('/friends').then(res => setAllFriends(res.data?.friends ?? [])).catch(() => {});
  }, []);

  // Fetch the organizer's first name for the location preference helper text.
  // Best-effort — falls back to '' (which the helper text renders as 'your location').
  useEffect(() => {
    getMe().then(me => {
      const first = (me?.full_name || me?.name || '').split(' ')[0];
      if (first) setOrganizerFirstName(first);
    }).catch(() => {});
  }, []);

  // If a friendId was passed via query param, fetch and pre-select that friend.
  useEffect(() => {
    if (!prefillFriendId) return;
    client.get(`/friends/${prefillFriendId}/profile`)
      .then((res) => setSelectedFriend({ id: prefillFriendId, ...res.data }))
      .catch(() => {});
  }, [prefillFriendId]);

  // Filter the friend list whenever the search query changes.
  useEffect(() => {
    const q = friendQuery.trim().toLowerCase();
    if (!q) { setFriendResults(allFriends); return; }
    setFriendResults(allFriends.filter(f =>
      f.name?.toLowerCase().includes(q) || f.username?.toLowerCase().includes(q)
    ));
  }, [friendQuery, allFriends]);

  /* ── Handlers ── */

  /** Lock in a friend selection and close the dropdown. */
  function selectFriend(f) {
    setSelectedFriend(f); setFriendQuery(''); setFriendResults([]);
  }

  /** Client-side validation before submitting. Returns an error string or ''. */
  function validate() {
    if (!selectedFriend)     return 'Select a friend to schedule with.';
    if (!startDate)          return 'Choose a start of scheduling window.';
    if (!endDate)            return 'Choose an end of scheduling window.';
    if (endDate < startDate) return 'End date must be on or after the start date.';
    return '';
  }

  /**
   * Submits the form to the AI suggestion engine.
   * Navigates to the new itinerary on success.
   * Once generating, the user sees a spinner overlay with a "Back to Home" button
   * rather than the form — this prevents them from going back, tweaking dates,
   * and re-submitting, which would create a duplicate itinerary.
   */
  async function submitSuggestions(confirmedOrganizerConflict = false) {
    setGenerating(true);
    setError('');
    setAwaitingConflictOk(false);
    try {
      const daysAhead = daysFromToday(endDate);
      const timePayload = timeOfDay === 'custom'
        ? { type: 'custom', time: customTime, windowMinutes: customWindow }
        : { type: timeOfDay };
      const data = await getSuggestions({
        targetUserId: selectedFriend.id,
        daysAhead, startDate, endDate,
        timeOfDay: timePayload,
        maxTravelMinutes: travelMode === 'remote' ? null : (maxTravel || null),
        contextPrompt: context,
        eventTitle: eventTitle.trim() || null,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        confirmedOrganizerConflict,
        locationPreference: travelMode === 'remote' ? null : locationPreference,
        travel_mode: travelMode,
        trip_duration_days: tripDurationDays,
        destination: travelMode === 'remote'
          ? null
          : (travelMode === 'travel' && locationPreference === 'destination' && destination.trim())
            ? destination.trim()
            : null,
        manual_busy_blocks: busyBlocks.length > 0 ? busyBlocks : undefined,
      });
      // Server found a conflict on the organizer's calendar — ask before generating.
      if (data?.needsConfirmation) {
        setAwaitingConflictOk(true);
        setGenerating(false);
        return;
      }
      const itineraryId = data?.itineraryId || data?.id;
      if (!itineraryId) throw new Error('No itinerary ID returned from server.');
      // Track successful suggestion generation. intent_class comes from the server response
      // if available (the schedule route may not return it yet — undefined is fine).
      try {
        posthog.capture('suggestion_generated', {
          intent_class:       data?.intent_class ?? null,
          has_context_prompt: !!context,
        });
      } catch {}
      navigate(`/schedule/${itineraryId}`);
    } catch (err) {
      setError(err.message || 'Could not generate suggestions. Please try again.');
      setGenerating(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }
    submitSuggestions(false);
  }

  /* ── Form ── */

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container container--sm">
          <h1 className="page-title">New Event</h1>
          <p className="page-subtitle">Plan something great together.</p>
          {error && <div className="alert alert--error">{error}</div>}
          {generating && (
            <div className="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-2)' }}>
              <div className="spinner spinner--sm" />
              <span>Checking calendars and generating suggestions…</span>
            </div>
          )}
          {awaitingConflictOk && (
            <div className="alert alert--warning" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span>⚠️ Looks like you have a scheduling conflict during this window. Are you sure this works for you?</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => submitSuggestions(true)}>
                  Yes, generate anyway
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAwaitingConflictOk(false)}>
                  Go back
                </button>
              </div>
            </div>
          )}
          <form onSubmit={handleSubmit} noValidate>

            {/* Friend selector — shows a search input with live dropdown, or a
                confirmation card once a friend is selected. */}
            <div className="form-group">
              <label className="form-label">Who are you meeting?</label>
              {selectedFriend ? (
                <div className="friend-card" style={{ marginBottom: 0 }}>
                  <div className="avatar">{getInitials(selectedFriend.name)}</div>
                  <div className="friend-card__info">
                    <div className="friend-card__name">{selectedFriend.name}</div>
                    {selectedFriend.username && <div className="friend-card__sub">@{selectedFriend.username}</div>}
                  </div>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelectedFriend(null)}>Change</button>
                </div>
              ) : (
                <div style={{ position: 'relative' }} ref={friendDropRef}>
                  <input type="text" className="form-control" value={friendQuery}
                    onChange={(e) => setFriendQuery(e.target.value)}
                    onFocus={() => { if (!friendQuery) setFriendResults(allFriends); }}
                    placeholder={allFriends.length > 0 ? `Choose from ${allFriends.length} friend${allFriends.length !== 1 ? 's' : ''}…` : 'Search your friends…'}
                    autoComplete="off" />
                  {friendResults.length > 0 && (
                    <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4, maxHeight: 240, overflowY: 'auto' }}>
                      {friendResults.map((f) => (
                        // onMouseDown fires before onBlur so the selection registers
                        // before the input loses focus and closes the dropdown.
                        <button key={f.id} type="button" onMouseDown={() => selectFriend(f)}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
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

            {/* Scheduling window — the date range the AI will search for free slots. */}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="start-date">Start of scheduling window</label>
                <input id="start-date" type="date" className="form-control" value={startDate} min={today()}
                  onChange={(e) => { setStartDate(e.target.value); if (endDate && e.target.value > endDate) setEndDate(e.target.value); }} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="end-date">End of scheduling window</label>
                <input id="end-date" type="date" className="form-control" value={endDate} min={startDate || today()}
                  onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>

            {/* Time-of-day preference — maps to hour ranges in findFreeWindows. */}
            <div className="form-group">
              <label className="form-label">Time of day</label>
              <div className="radio-group">
                {TIME_OPTIONS.map((opt) => (
                  <label key={opt.value} className={`radio-item${timeOfDay === opt.value ? ' radio-item--checked' : ''}`}>
                    <input type="radio" name="timeOfDay" value={opt.value}
                      checked={timeOfDay === opt.value} onChange={() => setTimeOfDay(opt.value)} />
                    <span>
                      {opt.label}
                      {opt.sub && <span style={{ display: 'block', fontSize: '0.72rem', fontWeight: 400, color: 'var(--text-4)', marginTop: 1 }}>{opt.sub}</span>}
                    </span>
                  </label>
                ))}
              </div>
              {/* Custom time panel — only shown when "Custom time" is selected. */}
              {timeOfDay === 'custom' && (
                <div className="custom-time-panel">
                  <div className="form-row" style={{ marginTop: 0 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" htmlFor="custom-time">Approximate time</label>
                      <select id="custom-time" className="form-control" value={customTime} onChange={(e) => setCustomTime(e.target.value)}>
                        {APPROX_TIMES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" htmlFor="custom-window">Flexibility</label>
                      <select id="custom-window" className="form-control" value={customWindow} onChange={(e) => setCustomWindow(e.target.value)}>
                        {WINDOW_OPTIONS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <p className="form-hint" style={{ marginTop: 8 }}>
                    We'll look for slots around {customTime}, give or take {WINDOW_OPTIONS.find(w => w.value === customWindow)?.label?.replace('± ', '')}.
                  </p>
                </div>
              )}
            </div>

            {/* Local / Travel toggle — determines whether this is a same-city hangout or an
                overnight/destination trip. Travel mode unlocks the duration picker and
                destination input. Inserted before location preference per the sprint spec. */}
            <div className="form-group">
              <label className="form-label">Mode</label>
              <div className="radio-group">
                {TRAVEL_MODE_OPTIONS.map((opt) => (
                  <label key={opt.value} className={`radio-item${travelMode === opt.value ? ' radio-item--checked' : ''}`}>
                    <input type="radio" name="travelMode" value={opt.value}
                      checked={travelMode === opt.value}
                      onChange={() => {
                        setTravelMode(opt.value);
                        // Reset destination and duration when switching back to local or remote.
                        // Also reset locationPreference if it was 'destination' — that option
                        // is only available in travel mode and is meaningless in local/remote mode.
                        if (opt.value === 'local') {
                          setDestination('');
                          setTripDurationDays(1);
                          setLocationPreference(prev => prev === 'destination' ? 'system_choice' : prev);
                        }
                        if (opt.value === 'remote') {
                          setDestination('');
                          setTripDurationDays(1);
                          setLocationPreference('system_choice');
                        }
                      }} />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
              <p className="form-hint" style={{ marginTop: 8 }}>
                {travelMode === 'local'  && "Suggestions in your city area."}
                {travelMode === 'remote' && "Suggestions for hanging out virtually — no travel needed."}
                {travelMode === 'travel' && "Multi-day trip — suggestions at a destination."}
              </p>
            </div>

            {/* Trip duration — only shown when Travel is selected. */}
            {travelMode === 'travel' && (
              <div className="form-group">
                <label className="form-label">Trip length</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input
                    type="number"
                    className="form-control"
                    style={{ width: 80 }}
                    min={1}
                    max={14}
                    step={1}
                    value={tripDurationDays}
                    onChange={e => setTripDurationDays(Math.min(14, Math.max(1, parseInt(e.target.value) || 1)))}
                    disabled={generating}
                  />
                  <span style={{ color: 'var(--text-2)', fontSize: '0.9rem' }}>
                    {tripDurationDays === 1 ? 'day' : 'days'}
                  </span>
                </div>
              </div>
            )}

            {/* Where to meet — controls which user's location Claude anchors suggestions to.
                Defaults to 'system_choice' (equidistant / best fit) so the form works
                without any extra interaction. Styled to match the time-of-day selector.
                Hidden in remote mode — no physical venue is involved. */}
            {travelMode !== 'remote' && (
              <div className="form-group">
                <label className="form-label">Where should you meet?</label>
                <div className="radio-group">
                  {LOCATION_OPTIONS.map((opt) => (
                    <label key={opt.value} className={`radio-item${locationPreference === opt.value ? ' radio-item--checked' : ''}`}>
                      <input type="radio" name="locationPreference" value={opt.value}
                        checked={locationPreference === opt.value}
                        onChange={() => setLocationPreference(opt.value)} />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                  {/* Destination option — only shown when Travel mode is selected. */}
                  {travelMode === 'travel' && (
                    <label className={`radio-item${locationPreference === 'destination' ? ' radio-item--checked' : ''}`}>
                      <input type="radio" name="locationPreference" value="destination"
                        checked={locationPreference === 'destination'}
                        onChange={() => setLocationPreference('destination')} />
                      <span>📍 Somewhere specific</span>
                    </label>
                  )}
                </div>
                {/* Helper text — updates based on selection to explain what Claude will do. */}
                <p className="form-hint" style={{ marginTop: 8 }}>
                  {locationPreference === 'closer_to_organizer' &&
                    `We'll suggest venues near ${organizerFirstName ? `${organizerFirstName}'s` : 'your'} location.`}
                  {locationPreference === 'closer_to_attendee' &&
                    `We'll suggest venues near ${selectedFriend ? `${selectedFriend.name.split(' ')[0]}'s` : "your friend's"} location.`}
                  {locationPreference === 'system_choice' &&
                    "We'll find the best spot between you both."}
                  {locationPreference === 'destination' &&
                    "Tell us where you're headed."}
                </p>
              </div>
            )}

            {/* Destination input — only shown when Travel + destination preference. */}
            {travelMode === 'travel' && locationPreference === 'destination' && (
              <div className="form-group">
                <label className="form-label" htmlFor="destination">
                  Destination <span className="optional">optional</span>
                </label>
                <input id="destination" type="text" className="form-control" value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="e.g. Nashville, Catskills, Philadelphia"
                  maxLength={100} />
                <p className="form-hint">City or region — we'll suggest everything there.</p>
              </div>
            )}

            {/* Max travel time — passed to the AI to filter out venues too far away.
                Hidden in remote mode — no travel is involved. */}
            {travelMode !== 'remote' && (
              <div className="form-group">
                <label className="form-label" htmlFor="max-travel">Max travel time</label>
                <select id="max-travel" className="form-control" value={maxTravel} onChange={(e) => setMaxTravel(e.target.value)}>
                  {TRAVEL_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </div>
            )}

            {/* Event title — optional label that appears in the plans list. */}
            <div className="form-group">
              <label className="form-label" htmlFor="event-title">
                Event title <span className="optional">optional</span>
              </label>
              <input id="event-title" type="text" className="form-control" value={eventTitle}
                onChange={(e) => setEventTitle(e.target.value)}
                placeholder={selectedFriend ? `e.g. "Golf with ${selectedFriend.name.split(' ')[0]}", "Morgan's birthday dinner"` : 'Give this event a name…'}
                maxLength={80} />
              <p className="form-hint">Shows up in your plans list so you can tell them apart at a glance.</p>
            </div>

            {/* Context prompt — free-text signal the AI uses to shape suggestions. */}
            <div className="form-group">
              <label className="form-label" htmlFor="context">
                What do you want to do? <span className="optional">optional</span>
              </label>
              <textarea id="context" className="form-control" value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="e.g. 'quick dinner', 'something active', 'near Midtown', 'golf and drinks after'"
                rows={3} />
              <p className="form-hint">Free text — our AI reads between the lines.</p>
            </div>

            {/* Block off times — optional date/time-range exclusions injected into the AI prompt */}
            <div className="form-group">
              <button type="button" className="btn btn--ghost btn--sm"
                onClick={() => setBusyBlockOpen(o => !o)}>
                {busyBlockOpen ? '▲' : '▼'} Block off dates{busyBlocks.length > 0 ? ` (${busyBlocks.length})` : ''} <span className="optional">optional</span>
              </button>
              {busyBlockOpen && (
                <div style={{ marginTop: 12 }}>
                  <p className="form-hint" style={{ marginBottom: 10 }}>
                    Select a date to add it — then optionally set a time range and reason.
                  </p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginBottom: 3 }}>Date</div>
                      <input
                        type="date"
                        className="form-control"
                        style={{ width: 'auto' }}
                        value={busyDate}
                        min={startDate || today()}
                        max={endDate || undefined}
                        onChange={e => {
                          const value = e.target.value;
                          if (!value) return;
                          setBusyBlocks(prev => [...prev, { date: value }]);
                          setBusyDate('');
                          setBusyLabel('');
                          setBusyTimeStart('');
                          setBusyTimeEnd('');
                        }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginBottom: 3 }}>From</div>
                      <input
                        type="time"
                        className="form-control"
                        style={{ width: 'auto' }}
                        value={busyTimeStart}
                        onChange={e => {
                          setBusyTimeStart(e.target.value);
                          setBusyBlocks(prev => {
                            if (!prev.length) return prev;
                            const last = { ...prev[prev.length - 1] };
                            if (e.target.value) last.timeStart = e.target.value; else delete last.timeStart;
                            return [...prev.slice(0, -1), last];
                          });
                        }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginBottom: 3 }}>To</div>
                      <input
                        type="time"
                        className="form-control"
                        style={{ width: 'auto' }}
                        value={busyTimeEnd}
                        onChange={e => {
                          setBusyTimeEnd(e.target.value);
                          setBusyBlocks(prev => {
                            if (!prev.length) return prev;
                            const last = { ...prev[prev.length - 1] };
                            if (e.target.value) last.timeEnd = e.target.value; else delete last.timeEnd;
                            return [...prev.slice(0, -1), last];
                          });
                        }}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 120 }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginBottom: 3 }}>Reason</div>
                      <input
                        type="text"
                        className="form-control"
                        placeholder="e.g. anniversary"
                        value={busyLabel}
                        maxLength={80}
                        onChange={e => {
                          setBusyLabel(e.target.value);
                          setBusyBlocks(prev => {
                            if (!prev.length) return prev;
                            const last = { ...prev[prev.length - 1] };
                            if (e.target.value.trim()) last.label = e.target.value.trim(); else delete last.label;
                            return [...prev.slice(0, -1), last];
                          });
                        }}
                      />
                    </div>
                  </div>
                  {busyBlocks.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {busyBlocks.map((b, i) => {
                        const isEditing = i === busyBlocks.length - 1;
                        let display = formatDateShort(b.date);
                        if (b.timeStart && b.timeEnd) display += `, ${formatTime12h(b.timeStart)} – ${formatTime12h(b.timeEnd)}`;
                        else if (b.timeStart) display += ` from ${formatTime12h(b.timeStart)}`;
                        if (b.label) display += ` — ${b.label}`;
                        return (
                          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 999, background: 'var(--surface-2)', fontSize: '0.82rem', color: 'var(--text-2)', border: `1px solid ${isEditing ? 'var(--primary, #6366f1)' : 'var(--border)'}` }}>
                            {display}
                            <button
                              type="button"
                              onClick={() => setBusyBlocks(prev => prev.filter((_, j) => j !== i))}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, marginLeft: 2, color: 'var(--text-3)', fontSize: '0.9rem' }}
                              aria-label="Remove"
                            >×</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <button type="submit" className="btn btn--primary btn--lg btn--full" disabled={generating}>
              {generating ? 'Generating…' : 'Generate Suggestions'}
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
