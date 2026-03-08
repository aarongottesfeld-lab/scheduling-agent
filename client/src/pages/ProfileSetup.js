// 4/10 — ProfileSetup
// Onboarding form for new users. Collects name, username, location,
// timezone, bio, activity preferences (pill input), and dietary /
// mobility restrictions. Geolocation is reverse-geocoded server-side
// to avoid exposing the Google Maps key in client code.

import React, { useState, useCallback } from 'react';
import { getUserName } from '../utils/auth';
import { useNavigate } from 'react-router-dom';
import { saveProfile } from '../utils/api';
import PillInput from '../components/PillInput';
import client from '../utils/client';

/* ── Constants ──────────────────────────────────────────────── */

const ACTIVITY_SUGGESTIONS = [
  // Food & Drink
  'coffee', 'brunch', 'lunch spots', 'fine dining', 'street food',
  'craft beer', 'wine bars', 'cocktail bars', 'rooftop bars', 'speakeasies',
  // Arts & Culture
  'Broadway shows', 'off-Broadway', 'comedy clubs', 'live music', 'concerts',
  'jazz clubs', 'art museums', 'galleries', 'film screenings',
  // Sports & Fitness
  'golf', 'tennis', 'basketball', 'pickleball', 'cycling', 'running',
  'yoga', 'rock climbing', 'boxing',
  // Pro Sports
  'Knicks games', 'Yankees games', 'Mets games', 'Rangers games', 'Brooklyn Nets', 'NYCFC',
  // NYC Outdoors
  'Central Park', 'hiking', 'kayaking', 'beach days', 'High Line', 'Governors Island',
  // Other
  'escape rooms', 'bowling', 'arcade bars', 'board game cafes',
  'cooking classes', 'bookstores', 'flea markets', 'nightlife',
];

const DIETARY_OPTIONS = [
  'vegetarian', 'vegan', 'gluten-free', 'halal', 'kosher',
  'nut allergy', 'shellfish allergy', 'dairy-free', 'none',
];

const MOBILITY_OPTIONS = [
  'wheelchair accessible required', 'no stairs', 'elevator required', 'none',
];

const TIMEZONES = [
  { label: '─── United States ───', value: '', disabled: true },
  { label: 'Eastern Time (ET)',  value: 'America/New_York' },
  { label: 'Central Time (CT)',  value: 'America/Chicago' },
  { label: 'Mountain Time (MT)', value: 'America/Denver' },
  { label: 'Pacific Time (PT)',  value: 'America/Los_Angeles' },
  { label: 'Arizona (no DST)',   value: 'America/Phoenix' },
  { label: 'Alaska (AKT)',       value: 'America/Anchorage' },
  { label: 'Hawaii (HST)',       value: 'America/Honolulu' },
  { label: 'Puerto Rico (AST)',  value: 'America/Puerto_Rico' },
  { label: '─── North America ───', value: '', disabled: true },
  { label: 'Toronto (ET)',       value: 'America/Toronto' },
  { label: 'Vancouver (PT)',     value: 'America/Vancouver' },
  { label: 'Mexico City (CT)',   value: 'America/Mexico_City' },
  { label: 'São Paulo (BRT)',    value: 'America/Sao_Paulo' },
  { label: '─── Europe ───',     value: '', disabled: true },
  { label: 'London (GMT/BST)',   value: 'Europe/London' },
  { label: 'Paris (CET)',        value: 'Europe/Paris' },
  { label: 'Berlin (CET)',       value: 'Europe/Berlin' },
  { label: 'Amsterdam (CET)',    value: 'Europe/Amsterdam' },
  { label: 'Madrid (CET)',       value: 'Europe/Madrid' },
  { label: 'Rome (CET)',         value: 'Europe/Rome' },
  { label: 'Zurich (CET)',       value: 'Europe/Zurich' },
  { label: 'Moscow (MSK)',       value: 'Europe/Moscow' },
  { label: '─── Middle East & Africa ───', value: '', disabled: true },
  { label: 'Jerusalem (IST)',    value: 'Asia/Jerusalem' },
  { label: 'Dubai (GST)',        value: 'Asia/Dubai' },
  { label: '─── Asia & Pacific ───', value: '', disabled: true },
  { label: 'India (IST)',        value: 'Asia/Kolkata' },
  { label: 'Bangladesh (BST)',   value: 'Asia/Dhaka' },
  { label: 'Bangkok (ICT)',      value: 'Asia/Bangkok' },
  { label: 'Singapore (SGT)',    value: 'Asia/Singapore' },
  { label: 'Shanghai (CST)',     value: 'Asia/Shanghai' },
  { label: 'Tokyo (JST)',        value: 'Asia/Tokyo' },
  { label: 'Seoul (KST)',        value: 'Asia/Seoul' },
  { label: 'Sydney (AEDT)',      value: 'Australia/Sydney' },
  { label: 'Melbourne (AEDT)',   value: 'Australia/Melbourne' },
  { label: 'Auckland (NZDT)',    value: 'Pacific/Auckland' },
];

/* ── Username validation ────────────────────────────────────── */
function validateUsername(value) {
  if (!value) return 'Username is required.';
  if (/\s/.test(value)) return 'No spaces allowed.';
  if (!/^[a-z0-9._-]+$/.test(value)) return 'Lowercase letters, numbers, . _ - only.';
  if (value.length < 3) return 'At least 3 characters.';
  if (value.length > 30) return 'Max 30 characters.';
  return '';
}

/* ── Component ──────────────────────────────────────────────── */
export default function ProfileSetup() {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    full_name:   getUserName() || '',
    username:    '',
    location:    '',
    timezone:    Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    bio:         '',
    activities:  [],
    dietary:     [],
    mobility:    [],
  });

  const [usernameError, setUsernameError] = useState('');
  const [locating, setLocating]         = useState(false);
  const [locError, setLocError]         = useState('');
  const [saving, setSaving]             = useState(false);
  const [saveError, setSaveError]       = useState('');

  /* Generic field setter */
  const set = (field) => (e) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  /* Username: lowercase-enforce on change, validate on blur */
  function handleUsernameChange(e) {
    setForm((prev) => ({ ...prev, username: e.target.value.toLowerCase().replace(/\s/g, '') }));
  }
  function handleUsernameBlur() {
    setUsernameError(validateUsername(form.username));
  }

  /* Toggle a value in a string-array field (dietary / mobility) */
  const toggleMulti = useCallback((field, value) => {
    setForm((prev) => {
      const arr = prev[field];
      return {
        ...prev,
        [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value],
      };
    });
  }, []);

  /* Geolocation → server-side reverse geocode */
  async function handleUseLocation() {
    if (!navigator.geolocation) {
      setLocError('Geolocation is not supported by your browser.');
      return;
    }
    setLocating(true);
    setLocError('');
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const res = await client.get('/geocode', {
            params: { lat: coords.latitude, lng: coords.longitude },
          });
          setForm((prev) => ({ ...prev, location: res.data.location || '' }));
        } catch {
          setLocError('Could not determine your location. Enter it manually.');
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocError('Location access denied. Enter your location manually.');
        setLocating(false);
      }
    );
  }

  /* Submit */
  async function handleSubmit(e) {
    e.preventDefault();
    const err = validateUsername(form.username);
    if (err) { setUsernameError(err); return; }

    setSaving(true);
    setSaveError('');
    try {
      await saveProfile(form);
      navigate('/home');
    } catch (err) {
      setSaveError(err.message || 'Could not save your profile. Please try again.');
      setSaving(false);
    }
  }

  return (
    <div className="page-center" style={{ alignItems: 'flex-start', padding: '32px 16px' }}>
      <div className="container--sm" style={{ paddingTop: 16, paddingBottom: 40 }}>
        {/* Header */}
        <div className="setup-header">
          <div className="setup-logo">Rendezvous</div>
          <h1 className="page-title" style={{ fontSize: '1.4rem' }}>Set up your profile</h1>
          <p className="page-subtitle">Help your friends know the real you.</p>
        </div>

        {saveError && <div className="alert alert--error">{saveError}</div>}

        <form onSubmit={handleSubmit} noValidate>

          {/* ── Basics ─────────────────────────────────────── */}
          <div className="form-section">
            <div className="form-section-title">The basics</div>

            <div className="form-group">
              <label className="form-label" htmlFor="full_name">Full name</label>
              <input
                id="full_name"
                type="text"
                className="form-control"
                value={form.full_name}
                onChange={set('full_name')}
                placeholder="Your name"
                required
                autoComplete="name"
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                className={`form-control${usernameError ? ' form-control--error' : ''}`}
                value={form.username}
                onChange={handleUsernameChange}
                onBlur={handleUsernameBlur}
                placeholder="e.g. alex_nyc"
                required
                autoComplete="username"
                spellCheck="false"
              />
              {usernameError
                ? <p className="form-error">{usernameError}</p>
                : <p className="form-hint">Lowercase, no spaces. Others can find you by username.</p>
              }
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="bio">
                Bio <span className="optional">optional</span>
              </label>
              <textarea
                id="bio"
                className="form-control"
                value={form.bio}
                onChange={set('bio')}
                placeholder="A line or two about you…"
                rows={3}
              />
            </div>
          </div>

          {/* ── Location & timezone ────────────────────────── */}
          <div className="form-section">
            <div className="form-section-title">Location &amp; timezone</div>

            <div className="form-group">
              <label className="form-label" htmlFor="location">Location</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  id="location"
                  type="text"
                  className="form-control"
                  value={form.location}
                  onChange={set('location')}
                  placeholder="City, neighborhood, or region"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={handleUseLocation}
                  disabled={locating}
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                >
                  {locating ? '…' : '📍 Use my location'}
                </button>
              </div>
              {locError && <p className="form-error">{locError}</p>}
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="timezone">Timezone</label>
              <select
                id="timezone"
                className="form-control"
                value={form.timezone}
                onChange={set('timezone')}
                required
              >
                <option value="">Select a timezone…</option>
                {TIMEZONES.map((tz, i) =>
                  tz.disabled
                    ? <option key={i} value="" disabled>{tz.label}</option>
                    : <option key={tz.value} value={tz.value}>{tz.label}</option>
                )}
              </select>
            </div>
          </div>

          {/* ── Activity preferences ───────────────────────── */}
          <div className="form-section">
            <div className="form-section-title">Activity preferences</div>
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Add your interests — these help us suggest plans you'll actually enjoy.
              Type and press <kbd style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', fontSize: '0.75rem' }}>Enter</kbd> or click a suggestion.
            </p>
            <PillInput
              pills={form.activities}
              onChange={(activities) => setForm((prev) => ({ ...prev, activities }))}
              suggestions={ACTIVITY_SUGGESTIONS}
              placeholder="e.g. rooftop bars, board games…"
              suggestionsLabel="Popular interests"
            />
          </div>

          {/* ── Dietary restrictions ───────────────────────── */}
          <div className="form-section">
            <div className="form-section-title">Dietary restrictions</div>
            <div className="checkbox-group">
              {DIETARY_OPTIONS.map((opt) => (
                <label
                  key={opt}
                  className={`checkbox-item${form.dietary.includes(opt) ? ' checkbox-item--checked' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={form.dietary.includes(opt)}
                    onChange={() => toggleMulti('dietary', opt)}
                  />
                  {opt}
                </label>
              ))}
            </div>
          </div>

          {/* ── Mobility ──────────────────────────────────── */}
          <div className="form-section" style={{ borderBottom: 'none' }}>
            <div className="form-section-title">Mobility &amp; accessibility</div>
            <div className="checkbox-group">
              {MOBILITY_OPTIONS.map((opt) => (
                <label
                  key={opt}
                  className={`checkbox-item${form.mobility.includes(opt) ? ' checkbox-item--checked' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={form.mobility.includes(opt)}
                    onChange={() => toggleMulti('mobility', opt)}
                  />
                  {opt}
                </label>
              ))}
            </div>
          </div>

          {/* ── Submit ────────────────────────────────────── */}
          <div className="setup-actions">
            <button
              type="submit"
              className="btn btn--primary btn--lg"
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Finish setup →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
