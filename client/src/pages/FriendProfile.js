// 7/10 — FriendProfile
// Two-panel layout:
//   Public section  — read-only: avatar, name, username, bio, location,
//                     activity preferences (pills), dietary/mobility info.
//   Private annotations — only visible to the current user, never shared:
//                     nickname, shared interests (pill input + AI suggestions),
//                     free-form notes.

import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';
import PillInput from '../components/PillInput';
import client from '../utils/client';

/* ── Helpers ────────────────────────────────────────────────── */
function getInitials(name = '') {
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

/* ── Component ──────────────────────────────────────────────── */
export default function FriendProfile() {
  const { friendId } = useParams();
  const navigate     = useNavigate();

  const [profile,        setProfile]        = useState(null);
  const [annotations,    setAnnotations]    = useState({ nickname: '', sharedInterests: [], notes: '' });
  const [aiSuggestions,  setAiSuggestions]  = useState([]);

  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [saving,      setSaving]      = useState(false);
  const [requesting,  setRequesting]  = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [requestErr,  setRequestErr]  = useState('');
  const [saved,    setSaved]    = useState(false);
  const [saveErr,  setSaveErr]  = useState('');

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const [profileRes, annotationsRes, suggestionsRes] = await Promise.allSettled([
          client.get(`/friends/${friendId}/profile`),
          client.get(`/friends/${friendId}/annotations`),
          client.get(`/friends/${friendId}/shared-interests`),
        ]);

        if (!mounted) return;

        if (profileRes.status === 'fulfilled') {
          setProfile(profileRes.value.data);
        } else {
          setError('Could not load this profile.');
        }

        if (annotationsRes.status === 'fulfilled') {
          const a = annotationsRes.value.data;
          setAnnotations({
            nickname:        a?.nickname        ?? '',
            sharedInterests: a?.sharedInterests ?? [],
            notes:           a?.notes           ?? '',
          });
        }

        if (suggestionsRes.status === 'fulfilled') {
          setAiSuggestions(suggestionsRes.value.data?.suggestions ?? []);
        }
      } catch {
        if (mounted) setError('Something went wrong loading this profile.');
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => { mounted = false; };
  }, [friendId]);

  async function sendFriendRequest() {
    setRequesting(true); setRequestErr('');
    try {
      await client.post('/friends/request', { targetUserId: friendId });
      setRequestSent(true);
    } catch (err) {
      setRequestErr(err.response?.data?.error || err.message || 'Could not send request.');
    } finally {
      setRequesting(false);
    }
  }

  async function saveAnnotations(e) {
    e.preventDefault();
    setSaving(true);
    setSaveErr('');
    setSaved(false);
    try {
      await client.put(`/friends/${friendId}/annotations`, annotations);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveErr(err.message || 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

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

  if (error || !profile) {
    return (
      <>
        <NavBar />
        <main className="page">
          <div className="container container--sm">
            <div className="alert alert--error">{error || 'Profile not found.'}</div>
            <button className="btn btn--ghost" onClick={() => navigate('/friends')}>← Back to friends</button>
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

          {/* Back */}
          <Link to="/friends" className="btn btn--ghost btn--sm" style={{ marginBottom: 20 }}>
            ← Friends
          </Link>

          {/* ── Public profile ──────────────────────────── */}
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="profile-hero">
              <div className="avatar avatar--xl">{getInitials(profile.name)}</div>
              <div className="profile-hero__info">
                <div className="profile-hero__name">{profile.name}</div>
                {profile.username && (
                  <div className="profile-hero__username">@{profile.username}</div>
                )}
                <div className="profile-meta">
                  {profile.location && (
                    <span className="profile-meta-item">📍 {profile.location}</span>
                  )}
                  {profile.timezone && (
                    <span className="profile-meta-item">🕐 {profile.timezone}</span>
                  )}
                </div>
                {profile.bio && (
                  <p className="profile-hero__bio">{profile.bio}</p>
                )}
              </div>
            </div>

            {/* Activity preferences */}
            {profile.activities?.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="form-label">Into</div>
                <div className="pill-suggestions" style={{ marginTop: 6 }}>
                  {profile.activities.map((a) => (
                    <span key={a} className="pill-tag">{a}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Dietary */}
            {profile.dietary?.length > 0 && !profile.dietary.includes('none') && (
              <div style={{ marginTop: 14 }}>
                <div className="form-label">Dietary</div>
                <div className="pill-suggestions" style={{ marginTop: 6 }}>
                  {profile.dietary.map((d) => (
                    <span key={d} className="badge badge--amber" style={{ marginRight: 4 }}>{d}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Mobility */}
            {profile.mobility?.length > 0 && !profile.mobility.includes('none') && (
              <div style={{ marginTop: 14 }}>
                <div className="form-label">Accessibility</div>
                <div className="pill-suggestions" style={{ marginTop: 6 }}>
                  {profile.mobility.map((m) => (
                    <span key={m} className="badge badge--gray" style={{ marginRight: 4 }}>{m}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Schedule CTA — only available once friendship is accepted */}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              {profile.friendshipStatus === 'accepted' ? (
                <Link
                  to={`/schedule/new?friendId=${friendId}`}
                  className="btn btn--primary"
                >
                  Schedule with {profile.name.split(' ')[0]}
                </Link>
              ) : profile.friendshipStatus === 'pending' ? (
                <div style={{ fontSize: '0.88rem', color: 'var(--text-2)' }}>
                  ⏳ Friend request pending — you can schedule once they accept.
                </div>
              ) : (
                <div>
                  {requestErr && <div className="alert alert--error" style={{ marginBottom: 8 }}>{requestErr}</div>}
                  {requestSent ? (
                    <span className="badge badge--gray">Request sent</span>
                  ) : (
                    <button
                      className="btn btn--secondary btn--sm"
                      onClick={sendFriendRequest}
                      disabled={requesting}
                    >
                      {requesting ? 'Sending…' : `+ Add ${profile.name.split(' ')[0]}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Private annotations ─────────────────────── */}
          <div className="annotation-panel">
            <div className="annotation-panel__title">🔒 Your private notes — only you see this</div>

            {saveErr && <div className="alert alert--error">{saveErr}</div>}

            <form onSubmit={saveAnnotations}>
              <div className="form-group">
                <label className="form-label" htmlFor="nickname">
                  Nickname <span className="optional">optional</span>
                </label>
                <input
                  id="nickname"
                  type="text"
                  className="form-control"
                  value={annotations.nickname}
                  onChange={(e) => setAnnotations((prev) => ({ ...prev, nickname: e.target.value }))}
                  placeholder={`What do you call ${profile.name.split(' ')[0]}?`}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Shared interests</label>
                <PillInput
                  pills={annotations.sharedInterests}
                  onChange={(sharedInterests) => setAnnotations((prev) => ({ ...prev, sharedInterests }))}
                  placeholder="Things you both enjoy…"
                />

                {/* AI-suggested shared interests */}
                {aiSuggestions.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <p className="form-hint" style={{ marginBottom: 6 }}>✨ AI suggested</p>
                    <div className="pill-suggestions">
                      {aiSuggestions
                        .filter((s) => !annotations.sharedInterests.includes(s))
                        .map((s) => (
                          <button
                            key={s}
                            type="button"
                            className="pill-suggestion"
                            onClick={() =>
                              setAnnotations((prev) => ({
                                ...prev,
                                sharedInterests: [...prev.sharedInterests, s],
                              }))
                            }
                          >
                            + {s}
                          </button>
                        ))
                      }
                    </div>
                  </div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="notes">
                  Notes <span className="optional">optional</span>
                </label>
                <textarea
                  id="notes"
                  className="form-control"
                  value={annotations.notes}
                  onChange={(e) => setAnnotations((prev) => ({ ...prev, notes: e.target.value }))}
                  placeholder={`Notes about ${profile.name.split(' ')[0]} — reminders, preferences, conversation starters…`}
                  rows={4}
                />
              </div>

              <button
                type="submit"
                className={`btn ${saved ? 'btn--success' : 'btn--primary'} btn--sm`}
                disabled={saving}
              >
                {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save notes'}
              </button>
            </form>
          </div>

        </div>
      </main>
    </>
  );
}
