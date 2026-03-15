// MyProfile.js — view and edit the current user's own profile
import React, { useEffect, useState, useCallback } from 'react';
// useNavigate removed — navigation not used in this component
import NavBar from '../components/NavBar';
import PillInput from '../components/PillInput';
import client from '../utils/client';
import { getCalendarConnections, getGoogleConnectUrl, setPrimaryCalendarConnection, removeCalendarConnection, connectAppleCalendar } from '../utils/api';

const ACTIVITY_SUGGESTIONS = [
  'coffee','brunch','lunch spots','fine dining','street food',
  'craft beer','wine bars','cocktail bars','rooftop bars','speakeasies',
  'Broadway shows','off-Broadway','comedy clubs','live music','concerts',
  'jazz clubs','art museums','galleries','film screenings',
  'golf','tennis','basketball','pickleball','cycling','running',
  'yoga','rock climbing','boxing',
  'Knicks games','Yankees games','Mets games','Rangers games','Brooklyn Nets','NYCFC',
  'Central Park','hiking','kayaking','beach days','High Line','Governors Island',
  'escape rooms','bowling','arcade bars','board game cafes',
  'cooking classes','bookstores','flea markets','nightlife',
];

const DIETARY_OPTIONS = [
  'vegetarian','vegan','gluten-free','halal','kosher',
  'nut allergy','shellfish allergy','dairy-free','none',
];

const MOBILITY_OPTIONS = [
  'wheelchair accessible required','no stairs','elevator required','none',
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
  { label: '─── North America ───', value: '', disabled: true },
  { label: 'Toronto (ET)',       value: 'America/Toronto' },
  { label: 'Vancouver (PT)',     value: 'America/Vancouver' },
  { label: 'Mexico City (CT)',   value: 'America/Mexico_City' },
  { label: '─── Europe ───',     value: '', disabled: true },
  { label: 'London (GMT/BST)',   value: 'Europe/London' },
  { label: 'Paris (CET)',        value: 'Europe/Paris' },
  { label: 'Berlin (CET)',       value: 'Europe/Berlin' },
  { label: '─── Asia & Pacific ───', value: '', disabled: true },
  { label: 'India (IST)',        value: 'Asia/Kolkata' },
  { label: 'Tokyo (JST)',        value: 'Asia/Tokyo' },
  { label: 'Sydney (AEDT)',      value: 'Australia/Sydney' },
];

function validateUsername(v) {
  if (!v) return 'Username is required.';
  if (/\s/.test(v)) return 'No spaces allowed.';
  if (!/^[a-z0-9._-]+$/.test(v)) return 'Lowercase letters, numbers, . _ - only.';
  if (v.length < 3) return 'At least 3 characters.';
  if (v.length > 30) return 'Max 30 characters.';
  return '';
}

function getInitials(name = '') {
  return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

export default function MyProfile() {
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState('');
  const [saveErr,  setSaveErr]  = useState('');
  const [editing,  setEditing]  = useState(false);
  const [usernameError, setUsernameError] = useState('');
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [locating,   setLocating]   = useState(false);
  const [locError,   setLocError]   = useState('');
  const [locSuccess, setLocSuccess] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [connections,       setConnections]       = useState([]);
  const [connectBanner,     setConnectBanner]     = useState(''); // 'success' | error string | ''
  const [connectionLoading, setConnectionLoading] = useState(null); // id of row being actioned
  const [connectionError,   setConnectionError]   = useState('');
  const [confirmingRemoveId, setConfirmingRemoveId] = useState(null);
  const [appleGuideOpen,  setAppleGuideOpen]  = useState(false);
  const [appleEmail,      setAppleEmail]      = useState('');
  const [applePassword,   setApplePassword]   = useState('');
  const [appleSubmitting, setAppleSubmitting] = useState(false);
  const [appleMessage,    setAppleMessage]    = useState('');
  const [appleIsError,    setAppleIsError]    = useState(false);

  const [form, setForm] = useState({
    full_name: '', username: '', location: '', timezone: '', bio: '',
    activities: [], dietary: [], mobility: [],
  });

  useEffect(() => {
    client.get('/users/me')
      .then(res => {
        const d = res.data;
        setAvatarUrl(d.avatar_url || '');
        setForm({
          full_name:  d.full_name  || '',
          username:   d.username   || '',
          location:   d.location   || '',
          timezone:   d.timezone   || '',
          bio:        d.bio        || '',
          activities: d.activity_preferences  || [],
          dietary:    d.dietary_restrictions  || [],
          mobility:   d.mobility_restrictions || [],
        });
      })
      .catch(() => setError('Could not load your profile.'))
      .finally(() => setLoading(false));
  }, []);

  // Handle ?connected=1 / ?error= redirect params from the connect flow,
  // then load the connections list. Runs once on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === '1') {
      setConnectBanner('success');
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (params.get('error')) {
      setConnectBanner(params.get('error'));
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    getCalendarConnections()
      .then(data => setConnections(data.connections || []))
      .catch(err => { console.error('[getCalendarConnections] failed:', err); });
  }, []);

  // Dismiss the two-click remove confirmation when the user clicks anywhere
  // outside a [data-remove-btn] element.
  useEffect(() => {
    if (!confirmingRemoveId) return;
    function handleMouseDown(e) {
      if (!e.target.closest('[data-remove-btn]')) setConfirmingRemoveId(null);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [confirmingRemoveId]);

  const refetchConnections = useCallback(() =>
    getCalendarConnections()
      .then(data => setConnections(data.connections || []))
      .catch(err => { console.error('[refetchConnections] failed:', err); }),
  []);

  function showConnectionError(msg) {
    setConnectionError(msg);
    setTimeout(() => setConnectionError(''), 4000);
  }

  async function handleSetPrimary(id) {
    setConnectionLoading(id);
    setConfirmingRemoveId(null);
    try {
      await setPrimaryCalendarConnection(id);
      await refetchConnections();
    } catch (err) {
      showConnectionError(err.response?.data?.error || 'Could not update primary calendar.');
    } finally {
      setConnectionLoading(null);
    }
  }

  async function handleRemove(id) {
    if (confirmingRemoveId !== id) {
      setConfirmingRemoveId(id);
      return;
    }
    setConnectionLoading(id);
    setConfirmingRemoveId(null);
    try {
      await removeCalendarConnection(id);
      await refetchConnections();
    } catch (err) {
      showConnectionError(err.response?.data?.error || 'Could not remove calendar.');
    } finally {
      setConnectionLoading(null);
    }
  }

  async function handleAppleSubmit(e) {
    if (e?.preventDefault) e.preventDefault();
    setAppleSubmitting(true);
    setAppleMessage('');
    setAppleIsError(false);
    try {
      await connectAppleCalendar({ email: appleEmail, password: applePassword });
      setAppleMessage('Apple Calendar connected! It now appears in your Connected Calendars list.');
      setAppleIsError(false);
      setAppleEmail('');
      setApplePassword('');
      await refetchConnections();
    } catch (err) {
      setAppleIsError(true);
      if (err.response?.status === 501) {
        setAppleMessage('Apple Calendar support is coming soon.');
      } else if (err.response?.data?.error) {
        const serverMsg = err.response.data.error;
        if (serverMsg.includes('already connected')) {
          setAppleMessage('This Apple account is already connected — you can see it in the Connected Calendars list above.');
        } else {
          setAppleMessage(serverMsg);
        }
      } else {
        setAppleMessage(
          'Connection failed. Make sure you\'re using your iCloud email (not a Gmail or other address) ' +
          'and an app-specific password from appleid.apple.com — not your regular Apple ID password.'
        );
      }
    } finally {
      setAppleSubmitting(false);
    }
  }

  const set = f => e => setForm(p => ({ ...p, [f]: e.target.value }));

  const toggleMulti = useCallback((field, value) => {
    setForm(prev => {
      const arr = prev[field];
      return { ...prev, [field]: arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value] };
    });
  }, []);

  async function handleAvatarChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    try {
      const fd = new FormData();
      fd.append('avatar', file);
      const res = await client.post('/users/avatar', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setAvatarUrl(res.data.avatar_url);
    } catch (err) {
      setSaveErr(err.message || 'Could not upload photo.');
    } finally {
      setAvatarUploading(false);
    }
  }

  async function handleUseLocation() {
    if (!navigator.geolocation) {
      setLocError('Geolocation is not supported by your browser.');
      return;
    }
    setLocating(true);
    setLocError('');
    setLocSuccess('');
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const res = await client.get('/geocode', {
            params: { lat: coords.latitude, lng: coords.longitude },
          });
          console.log('[handleUseLocation] /geocode response:', res.data);
          const resolved = res.data.location || '';
          setForm((prev) => ({ ...prev, location: resolved }));
          if (resolved) setLocSuccess(resolved);
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

    async function handleSave(e) {
    e.preventDefault();
    const err = validateUsername(form.username);
    if (err) { setUsernameError(err); return; }
    setSaving(true); setSaveErr(''); setSaved(false);
    try {
      await client.post('/users/profile', form);
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveErr(err.message || 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return (
    <><NavBar /><main className="page"><div className="container container--sm">
      <div className="loading"><div className="spinner spinner--lg" /></div>
    </div></main></>
  );

  if (error) return (
    <><NavBar /><main className="page"><div className="container container--sm">
      <div className="alert alert--error">{error}</div>
    </div></main></>
  );

  // ── Connected Calendars card (shared between read-only and edit views) ──
  const connectedCalendarsCard = (
    <div className="card card-pad" style={{ marginBottom:16 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <div className="form-section-title" style={{ marginBottom:0 }}>Connected Calendars</div>
        <a href={getGoogleConnectUrl()} className="btn btn--secondary btn--sm">Add Google Calendar</a>
      </div>
      {connections.length === 0 ? (
        <p className="form-hint" style={{ margin:0 }}>No additional calendars connected.</p>
      ) : (
        <ul style={{ listStyle:'none', padding:0, margin:0 }}>
          {connections.map(conn => {
            const isLoading     = connectionLoading === conn.id;
            const isConfirming  = confirmingRemoveId === conn.id;
            const anyLoading    = !!connectionLoading;
            return (
              <li key={conn.id} style={{ display:'flex', alignItems:'center', gap:8, paddingBottom:10, flexWrap:'wrap' }}>
                <span className="badge badge--gray">{conn.provider}</span>
                <span style={{ flex:1 }}>{conn.account_email || conn.account_label}</span>
                {conn.is_primary && (
                  <span className="badge badge--green">Primary</span>
                )}
                {!conn.is_primary && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => handleSetPrimary(conn.id)}
                    disabled={isLoading || anyLoading}
                  >
                    {isLoading ? '…' : 'Set as primary'}
                  </button>
                )}
                <button
                  type="button"
                  data-remove-btn="true"
                  className={`btn btn--sm ${isConfirming ? 'btn--danger' : 'btn--ghost'}`}
                  onClick={() => handleRemove(conn.id)}
                  disabled={isLoading || anyLoading}
                >
                  {isLoading ? '…' : isConfirming ? 'Confirm remove' : 'Remove'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {connectionError && (
        <div className="alert alert--error" style={{ marginTop:10, marginBottom:0 }}>{connectionError}</div>
      )}

      {/* ── Apple CalDAV setup guide ── */}
      <div style={{ marginTop:16, borderTop:'1px solid var(--border)', paddingTop:14 }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setAppleGuideOpen(o => !o)}
          style={{ display:'flex', alignItems:'center', gap:6 }}
        >
          <span style={{ fontSize:11 }}>{appleGuideOpen ? '▼' : '▶'}</span>
          Connect Apple Calendar
        </button>
        {appleGuideOpen && (
          <div style={{ marginTop:12 }}>
            <div className="form-section-title" style={{ marginBottom:4 }}>Connect Apple Calendar</div>
            <p className="form-hint" style={{ marginBottom:12 }}>Apple Calendar uses app-specific passwords for third-party access.</p>
            <ol style={{ paddingLeft:18, margin:'0 0 14px 0', fontSize:14, lineHeight:1.7 }}>
              <li>Go to <a href="https://appleid.apple.com" target="_blank" rel="noopener noreferrer">appleid.apple.com</a> and sign in</li>
              <li>Under <strong>Security</strong>, tap <strong>App-Specific Passwords</strong> → <strong>Generate Password</strong></li>
              <li>Label it <strong>Rendezvous</strong> and tap Create</li>
              <li>Copy the 16-character password shown — you won't see it again</li>
              <li>Enter your iCloud email and paste the password below</li>
            </ol>
            <div>
              <div className="form-group" style={{ marginBottom:10 }}>
                <input
                  type="email"
                  className="form-control"
                  placeholder="your@icloud.com"
                  value={appleEmail}
                  onChange={e => setAppleEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-group" style={{ marginBottom:10 }}>
                <input
                  type="password"
                  className="form-control"
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  value={applePassword}
                  onChange={e => setApplePassword(e.target.value)}
                  required
                />
              </div>
              {appleMessage && (
                <div className={`alert alert--${appleIsError ? 'error' : 'success'}`} style={{ marginBottom:10 }}>{appleMessage}</div>
              )}
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={handleAppleSubmit}
                disabled={appleSubmitting || !appleEmail || !applePassword}
              >
                {appleSubmitting ? 'Connecting…' : 'Connect Apple Calendar'}
              </button>
            </div>
            <p className="form-hint" style={{ marginTop:10, marginBottom:6 }}>
              This password only grants calendar access. You can revoke it anytime at{' '}
              <a href="https://appleid.apple.com" target="_blank" rel="noopener noreferrer">
                appleid.apple.com → Security → App-Specific Passwords
              </a>.
            </p>
            <a href="https://appleid.apple.com" target="_blank" rel="noopener noreferrer" style={{ fontSize:14 }}>
              Open Apple ID settings →
            </a>
          </div>
        )}
      </div>
    </div>
  );

  // ── Read-only view ─────────────────────────────────────────
  if (!editing) return (
    <><NavBar />
    <main className="page"><div className="container container--sm">
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
        <h1 className="page-title">My Profile</h1>
        <button className="btn btn--secondary btn--sm" onClick={() => setEditing(true)}>Edit profile</button>
      </div>
      {saved && <div className="alert alert--success">Profile saved.</div>}
      <div className="card card-pad" style={{ marginBottom:16 }}>
        <div className="profile-hero">
          <label className="avatar-upload-wrap" title="Change photo">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleAvatarChange} disabled={avatarUploading} />
            {avatarUrl
              ? <img src={avatarUrl} alt={form.full_name} className="avatar avatar--xl avatar-img" style={{ width:64, height:64 }} />
              : <div className="avatar avatar--xl">{avatarUploading ? '…' : getInitials(form.full_name)}</div>
            }
            <span className="avatar-upload-overlay">{avatarUploading ? '…' : 'Edit'}</span>
          </label>
          <div className="profile-hero__info">
            <div className="profile-hero__name">{form.full_name}</div>
            {form.username && <div className="profile-hero__username">@{form.username}</div>}
            <div className="profile-meta">
              {form.location && <span className="profile-meta-item">📍 {form.location}</span>}
              {form.timezone && <span className="profile-meta-item">🕐 {form.timezone}</span>}
            </div>
            {form.bio && <p className="profile-hero__bio">{form.bio}</p>}
          </div>
        </div>
        {form.activities?.length > 0 && (
          <div style={{ marginTop:16 }}>
            <div className="form-label">Into</div>
            <div className="pill-suggestions" style={{ marginTop:6 }}>
              {form.activities.map(a => <span key={a} className="pill-tag">{a}</span>)}
            </div>
          </div>
        )}
        {form.dietary?.length > 0 && !form.dietary.includes('none') && (
          <div style={{ marginTop:14 }}>
            <div className="form-label">Dietary</div>
            <div className="pill-suggestions" style={{ marginTop:6 }}>
              {form.dietary.map(d => <span key={d} className="badge badge--amber" style={{ marginRight:4 }}>{d}</span>)}
            </div>
          </div>
        )}
        {form.mobility?.length > 0 && !form.mobility.includes('none') && (
          <div style={{ marginTop:14 }}>
            <div className="form-label">Accessibility</div>
            <div className="pill-suggestions" style={{ marginTop:6 }}>
              {form.mobility.map(m => <span key={m} className="badge badge--gray" style={{ marginRight:4 }}>{m}</span>)}
            </div>
          </div>
        )}
      </div>
      {connectBanner === 'success' && (
        <div className="alert alert--success" style={{ marginBottom:12 }}>Google Calendar connected successfully.</div>
      )}
      {connectBanner && connectBanner !== 'success' && (
        <div className="alert alert--error" style={{ marginBottom:12 }}>{connectBanner}</div>
      )}
      {connectedCalendarsCard}
    </div></main></>
  );

  // ── Edit form ──────────────────────────────────────────────
  return (
    <><NavBar />
    <main className="page"><div className="container container--sm" style={{ paddingBottom:40 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
        <h1 className="page-title">Edit Profile</h1>
        <button className="btn btn--ghost btn--sm" onClick={() => { setEditing(false); setSaveErr(''); }}>Cancel</button>
      </div>
      {saveErr && <div className="alert alert--error">{saveErr}</div>}
      <form onSubmit={handleSave} noValidate>
        <div className="form-section">
          <div className="form-section-title">The basics</div>
          <div className="form-group">
            <label className="form-label" htmlFor="full_name">Full name</label>
            <input id="full_name" type="text" className="form-control" value={form.full_name} onChange={set('full_name')} required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="username">Username</label>
            <input id="username" type="text" className={`form-control${usernameError ? ' form-control--error':''}`}
              value={form.username}
              onChange={e => setForm(p => ({ ...p, username: e.target.value.toLowerCase().replace(/\s/g,'') }))}
              onBlur={() => setUsernameError(validateUsername(form.username))}
              spellCheck="false" required />
            {usernameError ? <p className="form-error">{usernameError}</p>
              : <p className="form-hint">Lowercase, no spaces. Others find you by this.</p>}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="bio">Bio <span className="optional">optional</span></label>
            <textarea id="bio" className="form-control" value={form.bio} onChange={set('bio')} rows={3} />
          </div>
        </div>
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
                onChange={e => { setLocError(''); setLocSuccess(''); setForm(p => ({ ...p, location: e.target.value })); }}
                placeholder="City or neighborhood"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={handleUseLocation}
                disabled={locating}
                style={{ whiteSpace: 'nowrap' }}
              >
                {locating ? '…' : '📍 Use my location'}
              </button>
            </div>
            {locError   && <div className="form-error"   style={{ marginTop: 4 }}>{locError}</div>}
            {locSuccess && <div className="alert alert--success" style={{ marginTop: 4 }}>Location set to: {locSuccess}</div>}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="timezone">Timezone</label>
            <select id="timezone" className="form-control" value={form.timezone} onChange={set('timezone')}>
              <option value="">Select…</option>
              {TIMEZONES.map((tz,i) => tz.disabled
                ? <option key={i} value="" disabled>{tz.label}</option>
                : <option key={tz.value} value={tz.value}>{tz.label}</option>)}
            </select>
          </div>
        </div>
        <div className="form-section">
          <div className="form-section-title">Activity preferences</div>
          <PillInput pills={form.activities} onChange={activities => setForm(p => ({ ...p, activities }))}
            suggestions={ACTIVITY_SUGGESTIONS} placeholder="e.g. rooftop bars, board games…" suggestionsLabel="Popular interests" />
        </div>
        <div className="form-section">
          <div className="form-section-title">Dietary restrictions</div>
          <div className="checkbox-group">
            {DIETARY_OPTIONS.map(opt => (
              <label key={opt} className={`checkbox-item${form.dietary.includes(opt)?' checkbox-item--checked':''}`}>
                <input type="checkbox" checked={form.dietary.includes(opt)} onChange={() => toggleMulti('dietary', opt)} />{opt}
              </label>
            ))}
          </div>
        </div>
        <div className="form-section" style={{ borderBottom:'none' }}>
          <div className="form-section-title">Mobility &amp; accessibility</div>
          <div className="checkbox-group">
            {MOBILITY_OPTIONS.map(opt => (
              <label key={opt} className={`checkbox-item${form.mobility.includes(opt)?' checkbox-item--checked':''}`}>
                <input type="checkbox" checked={form.mobility.includes(opt)} onChange={() => toggleMulti('mobility', opt)} />{opt}
              </label>
            ))}
          </div>
          {/* Disclosure: dietary and mobility data flows into the Claude prompt for personalization */}
          <p className="form-hint" style={{ marginTop: 10 }}>
            These preferences may be shared with an AI model to generate personalized activity suggestions.
          </p>
        </div>
        {connectBanner === 'success' && (
          <div className="alert alert--success" style={{ marginBottom:12 }}>Google Calendar connected successfully.</div>
        )}
        {connectBanner && connectBanner !== 'success' && (
          <div className="alert alert--error" style={{ marginBottom:12 }}>{connectBanner}</div>
        )}
        {connectedCalendarsCard}
        <div className="setup-actions">
          <button type="submit" className="btn btn--primary btn--lg" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div></main></>
  );
}
