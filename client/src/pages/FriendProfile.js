// FriendProfile.js — detail page for a single friend's profile
//
// Two-panel layout:
//   Public section  — read-only: avatar, name, username, bio, location,
//                     activity preferences (pills), dietary/mobility info,
//                     and a context-sensitive CTA block (schedule / pending / add / remove).
//   Private annotations — only visible to the current user, never shared:
//                     nickname, shared interests (pill input + AI suggestions),
//                     free-form notes.
//
// The Remove friend button only renders when profile.friendshipStatus === 'accepted'.
// It is absent for pending, non-friend, and error states.

import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';
import PillInput from '../components/PillInput';
import client from '../utils/client';
import { getInitials } from '../utils/formatting';

/* ── Component ──────────────────────────────────────────────── */
export default function FriendProfile() {
  const { friendId } = useParams();
  const navigate     = useNavigate();

  const [profile,        setProfile]        = useState(null);
  const [annotations,    setAnnotations]    = useState({ nickname: '', sharedInterests: [], notes: '' });
  const [aiSuggestions,  setAiSuggestions]  = useState([]);

  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [saving,      setSaving]      = useState(false);
  const [requesting,  setRequesting]  = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [requestErr,  setRequestErr]  = useState('');
  const [saved,       setSaved]       = useState(false);
  const [saveErr,     setSaveErr]     = useState('');

  // removing: true while the DELETE /friends/:id request is in flight (disables buttons)
  // removeErr: non-empty string if the remove request failed (shown as an alert near the button)
  // showRemoveConfirm: true when the inline "Remove [name]? Yes / Cancel" block is visible.
  //   Clicking "Remove friend" opens it; "Cancel" closes it; confirmed remove closes + fires DELETE.
  const [removing,           setRemoving]           = useState(false);
  const [removeErr,          setRemoveErr]          = useState('');
  const [showRemoveConfirm,  setShowRemoveConfirm]  = useState(false);

  /**
   * Loads the friend's profile, the current user's private annotations for them,
   * and AI-suggested shared interests — all in parallel.
   * Uses allSettled so a failing annotations/suggestions fetch doesn't block the profile.
   * Cleans up via the mounted flag to avoid state updates after unmount.
   */
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

  /**
   * Sends a friend request to the viewed user.
   * Sets requestSent on success so the button swaps to a static badge.
   */
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

  /**
   * Removes the currently viewed user as a friend.
   * Called only after the user has confirmed via the inline confirmation UI
   * (showRemoveConfirm === true), so no window.confirm() is needed here.
   * On success, navigates back to /friends — there's nothing useful left to show
   * on this page once the friendship is gone.
   * On failure, surfaces removeErr near the Remove button.
   */
  async function removeFriend() {
    setShowRemoveConfirm(false); // close confirmation UI regardless of outcome
    setRemoving(true);
    setRemoveErr('');
    try {
      await client.delete(`/friends/${friendId}`);
      navigate('/friends');
    } catch (err) {
      setRemoveErr(err.message || 'Could not remove friend. Please try again.');
      setRemoving(false); // only reset on error — on success we navigate away
    }
  }

  /**
   * Saves the current user's private annotations (nickname, shared interests, notes)
   * for this friend. Shows a temporary "✓ Saved" state for 3 seconds on success.
   */
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

            {/* Schedule CTA — context-sensitive based on friendship status */}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              {profile.friendshipStatus === 'accepted' ? (
                <>
                  {/* Primary action: schedule a plan */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <Link
                      to={`/schedule/new?friendId=${friendId}`}
                      className="btn btn--primary"
                    >
                      Schedule with {profile.name.split(' ')[0]}
                    </Link>

                    {/* Remove friend — clicking opens the inline confirmation block below
                        instead of a blocking window.confirm(). Disabled while in-flight. */}
                    {!showRemoveConfirm && (
                      <button
                        className="btn btn--ghost btn--sm"
                        style={{ color: 'var(--text-3)' }}
                        onClick={() => setShowRemoveConfirm(true)}
                        disabled={removing}
                      >
                        {removing ? 'Removing…' : 'Remove friend'}
                      </button>
                    )}
                  </div>

                  {/* Inline confirmation — replaces window.confirm() so the page stays
                      interactive. Only renders when showRemoveConfirm is true. */}
                  {showRemoveConfirm && (
                    <div
                      style={{
                        marginTop: 12,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        flexWrap: 'wrap',
                        fontSize: '0.88rem',
                        color: 'var(--text-2)',
                      }}
                    >
                      <span>Remove {profile.name.split(' ')[0]} as a friend?</span>
                      <button
                        className="btn btn--ghost btn--sm"
                        style={{ color: 'var(--danger, #c0392b)', fontWeight: 600 }}
                        onClick={removeFriend}
                        disabled={removing}
                      >
                        Yes, remove
                      </button>
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => setShowRemoveConfirm(false)}
                        disabled={removing}
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {/* Inline error shown directly below the confirmation / remove button */}
                  {removeErr && (
                    <div className="alert alert--error" style={{ marginTop: 10 }}>
                      {removeErr}
                    </div>
                  )}
                </>
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
                      {requesting ? 'Sending…' : `+ Add ${profile.name.split(' ')[0]} as a friend`}
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

                {/* AI-suggested shared interests — filtered to exclude already-added pills */}
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
