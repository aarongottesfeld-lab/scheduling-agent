// NewEvent.js
import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import NavBar from '../components/NavBar';
import { getSuggestions } from '../utils/api';
import client from '../utils/client';

/* ── Constants ──────────────────────────────────────────────── */
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

const WINDOW_OPTIONS = [
  { value: '15',  label: '± 15 min' },
  { value: '30',  label: '± 30 min' },
  { value: '60',  label: '± 1 hour' },
  { value: '120', label: '± 2 hours' },
];

const TIME_OPTIONS = [
  { value: 'morning',   label: '🌅 Morning',   sub: '8am – 12pm' },
  { value: 'afternoon', label: '☀️ Afternoon',  sub: '12pm – 5pm' },
  { value: 'evening',   label: '🌆 Evening',    sub: '5pm – 10pm' },
  { value: 'any',       label: '🕐 Any time',   sub: '' },
  { value: 'custom',    label: '🎯 Custom time', sub: '' },
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

  const [allFriends,      setAllFriends]      = useState([]);
  const [friendQuery,     setFriendQuery]     = useState('');
  const [friendResults,   setFriendResults]   = useState([]);
  const [selectedFriend,  setSelectedFriend]  = useState(null);

  const [startDate,    setStartDate]    = useState(today());
  const [endDate,      setEndDate]      = useState('');
  const [timeOfDay,    setTimeOfDay]    = useState('any');
  const [customTime,   setCustomTime]   = useState('7:00 PM');
  const [customWindow, setCustomWindow] = useState('30');
  const [maxTravel,    setMaxTravel]    = useState('30');
  const [context,      setContext]      = useState('');
  const [generating,   setGenerating]   = useState(false);
  const [error,        setError]        = useState('');

  // Load friends list for dropdown on mount
  useEffect(() => {
    client.get('/friends').then(res => setAllFriends(res.data?.friends ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!prefillFriendId) return;
    client.get(`/friends/${prefillFriendId}/profile`)
      .then((res) => setSelectedFriend({ id: prefillFriendId, ...res.data }))
      .catch(() => {});
  }, [prefillFriendId]);

  // Filter loaded friends by query
  useEffect(() => {
    const q = friendQuery.trim().toLowerCase();
    if (!q) {
      setFriendResults(allFriends);
      return;
    }
    setFriendResults(
      allFriends.filter(f =>
        f.name?.toLowerCase().includes(q) ||
        f.username?.toLowerCase().includes(q)
      )
    );
  }, [friendQuery, allFriends]);

  function selectFriend(f) {
    setSelectedFriend(f);
    setFriendQuery('');
    setFriendResults([]);
  }

  function validate() {
    if (!selectedFriend)       return 'Select a friend to schedule with.';
    if (!startDate)            return 'Choose a start of scheduling window.';
    if (!endDate)              return 'Choose an end of scheduling window.';
    if (endDate < startDate)   return 'End date must be on or after the start date.';
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }
    setGenerating(true);
    setError('');
    try {
      const daysAhead = daysFromToday(endDate);
      const timePayload = timeOfDay === 'custom'
        ? { type: 'custom', time: customTime, windowMinutes: customWindow }
        : { type: timeOfDay };
      const data = await getSuggestions({
        targetUserId: selectedFriend.id,
        daysAhead,
        startDate,
        endDate,
        timeOfDay: timePayload,
        maxTravelMinutes: maxTravel || null,
        contextPrompt: context,
      });
      const itineraryId = data?.itineraryId || data?.id;
      if (!itineraryId) throw new Error('No itinerary ID returned from server.');
      navigate(`/schedule/${itineraryId}`);
    } catch (err) {
      setError(err.message || 'Could not generate suggestions. Please try again.');
      setGenerating(false);
    }
  }

  if (generating) {
    return (
      <>
        <NavBar />
        <main className="page">
          <div className="container container--sm">
            <div className="generating-overlay">
              <div className="spinner spinner--lg" />
              <div className="generating-overlay__text">Finding the best options for you both…</div>
              <div className="generating-overlay__sub">Checking calendars, travel times, and preferences.</div>
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
                    {selectedFriend.username && <div className="friend-card__sub">@{selectedFriend.username}</div>}
                  </div>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelectedFriend(null)}>Change</button>
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <input type="text" className="form-control" value={friendQuery}
                    onChange={(e) => setFriendQuery(e.target.value)}
                    onFocus={() => { if (!friendQuery) setFriendResults(allFriends); }}
                    placeholder={allFriends.length > 0 ? `Choose from ${allFriends.length} friend${allFriends.length !== 1 ? 's' : ''}…` : 'Search your friends…'}
                    autoComplete="off" />
                  {friendResults.length > 0 && (
                    <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4, maxHeight: 240, overflowY: 'auto' }}>
                      {friendResults.map((f) => (
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

            {/* ── Scheduling window ─────────────────────── */}
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

            {/* ── Time of day ───────────────────────────── */}
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

              {/* Custom time picker — revealed when Custom Time is selected */}
              {timeOfDay === 'custom' && (
                <div className="custom-time-panel">
                  <div className="form-row" style={{ marginTop: 0 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" htmlFor="custom-time">Approximate time</label>
                      <select id="custom-time" className="form-control" value={customTime}
                        onChange={(e) => setCustomTime(e.target.value)}>
                        {APPROX_TIMES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" htmlFor="custom-window">Flexibility</label>
                      <select id="custom-window" className="form-control" value={customWindow}
                        onChange={(e) => setCustomWindow(e.target.value)}>
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

            {/* ── Max travel time ───────────────────────── */}
            <div className="form-group">
              <label className="form-label" htmlFor="max-travel">Max travel time</label>
              <select id="max-travel" className="form-control" value={maxTravel} onChange={(e) => setMaxTravel(e.target.value)}>
                {TRAVEL_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>

            {/* ── Context prompt ────────────────────────── */}
            <div className="form-group">
              <label className="form-label" htmlFor="context">
                Any preferences? <span className="optional">optional</span>
              </label>
              <textarea id="context" className="form-control" value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="e.g. 'something low-key', 'good for catching up', 'near Midtown', 'want to see a show'"
                rows={3} />
              <p className="form-hint">Free text — our AI reads between the lines.</p>
            </div>

            <button type="submit" className="btn btn--primary btn--lg btn--full">Generate Suggestions</button>
          </form>
        </div>
      </main>
    </>
  );
}
