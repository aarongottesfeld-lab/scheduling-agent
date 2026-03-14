// NewGroupEvent.js — Group event creation form.
//
// Adapts the NewEvent.js 1:1 form for group context. Key differences:
//   - No single "friend" picker: attendees come from a group's active member list.
//   - Group selector: if no groupId in URL, user picks from their groups dropdown.
//     If groupId is in URL params (from GroupDetail "Plan Event"), it is pre-selected.
//   - Attendee list: shows all active group members (excluding the organizer).
//     Organizer can remove individuals before submitting.
//   - Submission: POST /group-itineraries → then POST /:id/suggest to generate AI
//     suggestions → navigate to GroupItineraryView on success.
//
// The form stays locked (showing a spinner) once suggest is called to prevent
// duplicate submissions (same pattern as NewEvent.js).

import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import NavBar from '../components/NavBar';
import { getGroups, getGroup, createGroupItinerary, generateGroupSuggestions } from '../utils/api';
import { getSupabaseId } from '../utils/auth';

/* ── Constants (mirrors NewEvent.js) ─────────────────────────────────── */

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
  { value: '15', label: '± 15 min' },
  { value: '30', label: '± 30 min' },
  { value: '60', label: '± 1 hour' },
  { value: '120', label: '± 2 hours' },
];

const TIME_OPTIONS = [
  { value: 'morning',   label: '🌅 Morning',    sub: '8am – 12pm' },
  { value: 'afternoon', label: '☀️ Afternoon',   sub: '12pm – 5pm' },
  { value: 'evening',   label: '🌆 Evening',     sub: '5pm – 10pm' },
  { value: 'any',       label: '🕐 Any time',    sub: '' },
  { value: 'custom',    label: '🎯 Custom time', sub: '' },
];

const TRAVEL_MODE_OPTIONS = [
  { value: 'local',  label: 'Local' },
  { value: 'travel', label: 'Travel' },
];

const TRIP_DURATION_OPTIONS = [
  { value: 1, label: '1 day' },
  { value: 2, label: 'Weekend' },
  { value: 5, label: 'Longer' },
];

const LOCATION_OPTIONS = [
  { value: 'system_choice',       label: '🗺 Up to the system' },
  { value: 'closer_to_organizer', label: '📍 Closer to me' },
];

const TRAVEL_OPTIONS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '45', label: '45 min' },
  { value: '60', label: '1 hour' },
  { value: '',   label: 'No limit' },
];

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** Today's date as YYYY-MM-DD in the user's local timezone (avoids UTC off-by-one). */
function today() {
  const d  = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Two uppercase initials from a name string. */
function getInitials(name = '') {
  return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

/* ── Component ────────────────────────────────────────────────────────── */

export default function NewGroupEvent() {
  const navigate = useNavigate();
  // groupId may come from the URL (navigated from GroupDetail "Plan Event" button)
  const { groupId: urlGroupId } = useParams();
  const myId = getSupabaseId();

  // Group selection state — used when no groupId in URL
  const [myGroups,        setMyGroups]        = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState(urlGroupId || '');
  const [groupDetail,     setGroupDetail]     = useState(null); // { group, members, my_role }
  const [loadingGroup,    setLoadingGroup]    = useState(false);

  // Attendee list: all active members minus the organizer; organizer can remove individuals
  const [attendees,       setAttendees]       = useState([]); // [{ user_id, profile }]

  // Scheduling form fields (mirrors NewEvent.js)
  const [startDate,          setStartDate]          = useState(today());
  const [endDate,            setEndDate]            = useState('');
  const [timeOfDay,          setTimeOfDay]          = useState('any');
  const [customTime,         setCustomTime]         = useState('7:00 PM');
  const [customWindow,       setCustomWindow]       = useState('30');
  const [maxTravel,          setMaxTravel]          = useState('30');
  const [context,            setContext]            = useState('');
  const [eventTitle,         setEventTitle]         = useState('');
  const [locationPreference, setLocationPreference] = useState('system_choice');
  const [travelMode,         setTravelMode]         = useState('local');
  const [tripDurationDays,   setTripDurationDays]   = useState(1);
  const [destination,        setDestination]        = useState('');

  // Voting rules
  // quorumMode: 'custom' shows a number input; 'unanimous' locks to total participant count.
  // customQuorum: string so the <input> stays controlled; validated as integer on submit.
  const [quorumMode,      setQuorumMode]      = useState('custom');
  const [customQuorum,    setCustomQuorum]    = useState('');  // '' = not yet set by user
  const [tieBehavior,     setTieBehavior]     = useState('schedule'); // 'schedule' | 'decline'
  const [nudgeAfterHours, setNudgeAfterHours] = useState('48');

  // UI state
  const [generating, setGenerating] = useState(false);
  const [error,      setError]      = useState('');

  // Load the user's groups list for the group-selector dropdown (no URL groupId case)
  useEffect(() => {
    if (urlGroupId) return; // already have a group from the URL
    getGroups()
      .then(data => setMyGroups(data.groups || []))
      .catch(() => {});
  }, [urlGroupId]);

  /**
   * When selectedGroupId changes, fetch the group detail to populate the attendee list.
   * Attendees = all active members who are not the current organizer.
   */
  useEffect(() => {
    if (!selectedGroupId) {
      setGroupDetail(null);
      setAttendees([]);
      return;
    }
    setLoadingGroup(true);
    getGroup(selectedGroupId)
      .then(data => {
        setGroupDetail(data);
        // Seed the attendee list with all active non-organizer members
        const activeNonOrganizer = (data.members || []).filter(
          m => m.status === 'active' && m.user_id !== myId
        );
        setAttendees(activeNonOrganizer);
      })
      .catch(() => {})
      .finally(() => setLoadingGroup(false));
  }, [selectedGroupId, myId]);

  /** Remove an attendee from the list (organizer pre-submission customization). */
  function removeAttendee(userId) {
    setAttendees(prev => prev.filter(a => a.user_id !== userId));
  }

  /** Client-side validation. Returns error string or ''. */
  function validate() {
    if (!selectedGroupId) return 'Select a group to plan with.';
    if (attendees.length === 0) return 'At least one attendee is required.';
    if (!startDate)   return 'Choose a start of scheduling window.';
    if (!endDate)     return 'Choose an end of scheduling window.';
    if (endDate < startDate) return 'End date must be on or after start date.';
    if (quorumMode === 'custom') {
      const totalParticipants = attendees.length + 1; // attendees + organizer
      // Empty field is valid — treated as the majority default on submit.
      if (customQuorum !== '') {
        const threshold = parseInt(customQuorum, 10);
        if (isNaN(threshold) || threshold < 1)
          return 'Votes needed must be at least 1.';
        if (threshold > totalParticipants)
          return `Votes needed cannot exceed total participants (${totalParticipants}).`;
      }
    }
    return '';
  }

  /**
   * Submit the form:
   * 1. POST /group-itineraries → get itineraryId
   * 2. POST /group-itineraries/:id/suggest → generate AI suggestions
   * 3. Navigate to GroupItineraryView on success
   *
   * The form is locked (spinner overlay) once submission starts to prevent duplicates.
   */
  async function handleSubmit(e) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) { setError(validationError); return; }

    setGenerating(true);
    setError('');
    try {
      const timePayload = timeOfDay === 'custom'
        ? { type: 'custom', time: customTime, windowMinutes: customWindow }
        : { type: timeOfDay };

      const attendeeIds       = attendees.map(a => a.user_id);
      const totalParticipants = attendeeIds.length + 1; // attendees + organizer
      const majorityDefault   = Math.ceil(totalParticipants / 2);
      const quorumThreshold   = quorumMode === 'unanimous'
        ? totalParticipants
        : (parseInt(customQuorum, 10) || majorityDefault); // empty → majority default

      const { itineraryId } = await createGroupItinerary({
        group_id:            selectedGroupId,
        attendee_user_ids:   attendeeIds,
        date_range_start:    startDate,
        date_range_end:      endDate,
        time_of_day:         timePayload,
        max_travel_minutes:  maxTravel || null,
        context_prompt:      context || null,
        event_title:         eventTitle.trim() || null,
        travel_mode:         travelMode,
        location_preference: locationPreference,
        destination:         (travelMode === 'travel' && locationPreference === 'destination' && destination.trim())
          ? destination.trim()
          : null,
        trip_duration_days:  tripDurationDays,
        quorum_threshold:    quorumThreshold,
        tie_behavior:        tieBehavior,
        nudge_after_hours:   parseInt(nudgeAfterHours),
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      });

      // Generate AI suggestions immediately after creation.
      // The itinerary stays in organizer_draft until the organizer explicitly sends it.
      await generateGroupSuggestions(itineraryId);

      navigate(`/group-itineraries/${itineraryId}`);
    } catch (e) {
      setError(e.message || 'Could not create event. Please try again.');
      setGenerating(false);
    }
  }

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container container--sm">
          <h1 className="page-title">New Group Event</h1>
          <p className="page-subtitle">Plan something with the crew.</p>

          {error && <div className="alert alert--error">{error}</div>}

          {/* Generating spinner overlay — replaces submit button once in-flight */}
          {generating && (
            <div className="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-2)' }}>
              <div className="spinner spinner--sm" />
              <span>Checking everyone's calendars and generating suggestions…</span>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate>

            {/* ── Group selector — only shown when no groupId in URL ── */}
            {!urlGroupId && (
              <div className="form-group">
                <label className="form-label" htmlFor="group-select">Which group?</label>
                <select
                  id="group-select"
                  className="form-control"
                  value={selectedGroupId}
                  onChange={e => setSelectedGroupId(e.target.value)}
                  disabled={generating}
                >
                  <option value="">Select a group…</option>
                  {myGroups.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Selected group name (display only when groupId comes from URL) */}
            {urlGroupId && groupDetail && (
              <div className="form-group">
                <label className="form-label">Group</label>
                <div style={{
                  padding: '10px 14px',
                  background: 'var(--surface-2)',
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: '0.9rem',
                }}>
                  {groupDetail.group?.name}
                  {groupDetail.group?.description && (
                    <div style={{ fontWeight: 400, fontSize: '0.82rem', color: 'var(--text-3)', marginTop: 2 }}>
                      {groupDetail.group.description}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Attendee list — populated once a group is selected ── */}
            {selectedGroupId && (
              <div className="form-group">
                <label className="form-label">
                  Attendees
                  {loadingGroup && <span style={{ marginLeft: 8 }}><span className="spinner spinner--sm" /></span>}
                </label>
                {!loadingGroup && attendees.length === 0 && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-3)', padding: '8px 0' }}>
                    No active members to invite — add members to the group first.
                  </div>
                )}
                {attendees.map(a => {
                  const name = a.profile?.full_name || 'Unknown';
                  return (
                    <div
                      key={a.user_id}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}
                    >
                      {a.profile?.avatar_url ? (
                        <img
                          src={a.profile.avatar_url}
                          alt={name}
                          style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }}
                        />
                      ) : (
                        <div className="avatar avatar--sm" style={{ width: 28, height: 28, fontSize: '0.75rem' }}>
                          {getInitials(name)}
                        </div>
                      )}
                      <span style={{ flex: 1, fontSize: '0.88rem', fontWeight: 600 }}>{name}</span>
                      {/* Allow organizer to remove individuals before submitting */}
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}
                        onClick={() => removeAttendee(a.user_id)}
                        disabled={generating}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
                {attendees.length > 0 && (
                  <p className="form-hint" style={{ marginTop: 6 }}>
                    {attendees.length} attendee{attendees.length !== 1 ? 's' : ''} + you.
                    Remove anyone who won't be joining.
                  </p>
                )}
              </div>
            )}

            {/* ── Scheduling window ── */}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="start-date">Start of scheduling window</label>
                <input
                  id="start-date"
                  type="date"
                  className="form-control"
                  value={startDate}
                  min={today()}
                  disabled={generating}
                  onChange={e => {
                    setStartDate(e.target.value);
                    if (endDate && e.target.value > endDate) setEndDate(e.target.value);
                  }}
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="end-date">End of scheduling window</label>
                <input
                  id="end-date"
                  type="date"
                  className="form-control"
                  value={endDate}
                  min={startDate || today()}
                  disabled={generating}
                  onChange={e => setEndDate(e.target.value)}
                />
              </div>
            </div>

            {/* ── Time of day ── */}
            <div className="form-group">
              <label className="form-label">Time of day</label>
              <div className="radio-group">
                {TIME_OPTIONS.map(opt => (
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
                      disabled={generating}
                    />
                    <span>
                      {opt.label}
                      {opt.sub && (
                        <span style={{ display: 'block', fontSize: '0.72rem', fontWeight: 400, color: 'var(--text-4)', marginTop: 1 }}>
                          {opt.sub}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              {timeOfDay === 'custom' && (
                <div className="custom-time-panel">
                  <div className="form-row" style={{ marginTop: 0 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" htmlFor="custom-time">Approximate time</label>
                      <select
                        id="custom-time"
                        className="form-control"
                        value={customTime}
                        onChange={e => setCustomTime(e.target.value)}
                        disabled={generating}
                      >
                        {APPROX_TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label" htmlFor="custom-window">Flexibility</label>
                      <select
                        id="custom-window"
                        className="form-control"
                        value={customWindow}
                        onChange={e => setCustomWindow(e.target.value)}
                        disabled={generating}
                      >
                        {WINDOW_OPTIONS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ── Travel mode ── */}
            <div className="form-group">
              <label className="form-label">Mode</label>
              <div className="radio-group">
                {TRAVEL_MODE_OPTIONS.map(opt => (
                  <label
                    key={opt.value}
                    className={`radio-item${travelMode === opt.value ? ' radio-item--checked' : ''}`}
                  >
                    <input
                      type="radio"
                      name="travelMode"
                      value={opt.value}
                      checked={travelMode === opt.value}
                      disabled={generating}
                      onChange={() => {
                        setTravelMode(opt.value);
                        if (opt.value === 'local') {
                          setDestination('');
                          setTripDurationDays(1);
                          setLocationPreference(prev => prev === 'destination' ? 'system_choice' : prev);
                        }
                      }}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
              <p className="form-hint" style={{ marginTop: 8 }}>
                {travelMode === 'local'  && 'Suggestions in your city area.'}
                {travelMode === 'travel' && 'Multi-day trip — suggestions at a destination.'}
              </p>
            </div>

            {/* Trip duration — only shown in Travel mode */}
            {travelMode === 'travel' && (
              <div className="form-group">
                <label className="form-label">Trip length</label>
                <div className="radio-group">
                  {TRIP_DURATION_OPTIONS.map(opt => (
                    <label
                      key={opt.value}
                      className={`radio-item${tripDurationDays === opt.value ? ' radio-item--checked' : ''}`}
                    >
                      <input
                        type="radio"
                        name="tripDurationDays"
                        value={opt.value}
                        checked={tripDurationDays === opt.value}
                        disabled={generating}
                        onChange={() => setTripDurationDays(opt.value)}
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* ── Where to meet ── */}
            <div className="form-group">
              <label className="form-label">Where should you meet?</label>
              <div className="radio-group">
                {LOCATION_OPTIONS.map(opt => (
                  <label
                    key={opt.value}
                    className={`radio-item${locationPreference === opt.value ? ' radio-item--checked' : ''}`}
                  >
                    <input
                      type="radio"
                      name="locationPreference"
                      value={opt.value}
                      checked={locationPreference === opt.value}
                      disabled={generating}
                      onChange={() => setLocationPreference(opt.value)}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
                {travelMode === 'travel' && (
                  <label className={`radio-item${locationPreference === 'destination' ? ' radio-item--checked' : ''}`}>
                    <input
                      type="radio"
                      name="locationPreference"
                      value="destination"
                      checked={locationPreference === 'destination'}
                      disabled={generating}
                      onChange={() => setLocationPreference('destination')}
                    />
                    <span>📍 Somewhere specific</span>
                  </label>
                )}
              </div>
            </div>

            {/* Destination input — only when Travel + destination */}
            {travelMode === 'travel' && locationPreference === 'destination' && (
              <div className="form-group">
                <label className="form-label" htmlFor="destination">
                  Destination <span className="optional">optional</span>
                </label>
                <input
                  id="destination"
                  type="text"
                  className="form-control"
                  value={destination}
                  onChange={e => setDestination(e.target.value)}
                  placeholder="e.g. Nashville, Catskills, Philadelphia"
                  maxLength={100}
                  disabled={generating}
                />
              </div>
            )}

            {/* ── Max travel time ── */}
            <div className="form-group">
              <label className="form-label" htmlFor="max-travel">Max travel time</label>
              <select
                id="max-travel"
                className="form-control"
                value={maxTravel}
                onChange={e => setMaxTravel(e.target.value)}
                disabled={generating}
              >
                {TRAVEL_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* ── Voting rules ── */}
            <div className="form-group">
              <label className="form-label">Quorum</label>
              {(() => {
                const total = attendees.length + 1; // attendees + organizer
                return (
                  <div className="radio-group">
                    {/* Custom threshold option */}
                    <label
                      className={`radio-item${quorumMode === 'custom' ? ' radio-item--checked' : ''}`}
                      style={{ alignItems: 'center', gap: 10 }}
                    >
                      <input
                        type="radio"
                        name="quorumMode"
                        value="custom"
                        checked={quorumMode === 'custom'}
                        onChange={() => setQuorumMode('custom')}
                        disabled={generating}
                      />
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <input
                          type="number"
                          min={1}
                          max={total}
                          value={customQuorum}
                          placeholder={String(Math.ceil(total / 2))}
                          onChange={e => {
                            setQuorumMode('custom');
                            setCustomQuorum(e.target.value);
                          }}
                          disabled={generating}
                          style={{
                            width: 56,
                            padding: '2px 6px',
                            fontSize: '0.9rem',
                            borderRadius: 6,
                            border: '1px solid var(--border)',
                            textAlign: 'center',
                          }}
                          onClick={e => e.stopPropagation()}
                        />
                        <span style={{ fontSize: '0.88rem' }}>
                          of {total} vote{total !== 1 ? 's' : ''} needed
                        </span>
                      </span>
                    </label>

                    {/* Unanimous option */}
                    <label className={`radio-item${quorumMode === 'unanimous' ? ' radio-item--checked' : ''}`}>
                      <input
                        type="radio"
                        name="quorumMode"
                        value="unanimous"
                        checked={quorumMode === 'unanimous'}
                        onChange={() => setQuorumMode('unanimous')}
                        disabled={generating}
                      />
                      <span>
                        Unanimous
                        <span style={{ display: 'block', fontSize: '0.72rem', fontWeight: 400, color: 'var(--text-4)', marginTop: 1 }}>
                          All {total} must agree
                        </span>
                      </span>
                    </label>
                  </div>
                );
              })()}
            </div>

            <div className="form-group">
              <label className="form-label">If there's a tie</label>
              <div className="radio-group">
                <label className={`radio-item${tieBehavior === 'schedule' ? ' radio-item--checked' : ''}`}>
                  <input
                    type="radio"
                    name="tieBehavior"
                    value="schedule"
                    checked={tieBehavior === 'schedule'}
                    onChange={() => setTieBehavior('schedule')}
                    disabled={generating}
                  />
                  <span>Lock it in anyway</span>
                </label>
                <label className={`radio-item${tieBehavior === 'decline' ? ' radio-item--checked' : ''}`}>
                  <input
                    type="radio"
                    name="tieBehavior"
                    value="decline"
                    checked={tieBehavior === 'decline'}
                    onChange={() => setTieBehavior('decline')}
                    disabled={generating}
                  />
                  <span>Skip the suggestion</span>
                </label>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="nudge-hours">Remind attendees after</label>
              <select
                id="nudge-hours"
                className="form-control"
                value={nudgeAfterHours}
                onChange={e => setNudgeAfterHours(e.target.value)}
                disabled={generating}
              >
                <option value="24">24 hours</option>
                <option value="48">48 hours</option>
                <option value="72">72 hours</option>
                <option value="168">1 week</option>
              </select>
            </div>

            {/* ── Event title ── */}
            <div className="form-group">
              <label className="form-label" htmlFor="event-title">
                Event title <span className="optional">optional</span>
              </label>
              <input
                id="event-title"
                type="text"
                className="form-control"
                value={eventTitle}
                onChange={e => setEventTitle(e.target.value)}
                placeholder={groupDetail ? `e.g. "${groupDetail.group?.name} weekend", "Annual trip"` : 'Give this event a name…'}
                maxLength={80}
                disabled={generating}
              />
              <p className="form-hint">Shows up in the group's event list.</p>
            </div>

            {/* ── Context prompt ── */}
            <div className="form-group">
              <label className="form-label" htmlFor="context">
                What do you want to do? <span className="optional">optional</span>
              </label>
              <textarea
                id="context"
                className="form-control"
                value={context}
                onChange={e => setContext(e.target.value)}
                placeholder="e.g. 'outdoor activity', 'team dinner', 'something near downtown', 'golf and drinks after'"
                rows={3}
                disabled={generating}
              />
              <p className="form-hint">Free text — our AI reads between the lines.</p>
            </div>

            <button
              type="submit"
              className="btn btn--primary btn--lg btn--full"
              disabled={generating || !selectedGroupId || attendees.length === 0}
            >
              {generating ? 'Generating…' : 'Generate Suggestions'}
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
