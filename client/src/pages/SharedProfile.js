// SharedProfile.js — public shareable profile page at /u/:username
//
// Anyone can follow the link, but the page requires the viewer to be logged in
// to fetch profile data and send a friend request. Unauthenticated visitors see
// a sign-in prompt instead.
//
// This route is NOT wrapped in ProtectedRoute — it renders for everyone.
// Auth check is done inside the component via getSupabaseId().

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';
import { getSupabaseId } from '../utils/auth';
import client from '../utils/client';
import { getInitials } from '../utils/formatting';

export default function SharedProfile() {
  const { username } = useParams();
  const navigate     = useNavigate();
  const isLoggedIn   = !!getSupabaseId();

  const [profile,          setProfile]          = useState(null);
  const [friendshipStatus, setFriendshipStatus] = useState(null);
  const [loading,          setLoading]          = useState(true);
  const [error,            setError]            = useState('');
  const [actionBusy,       setActionBusy]       = useState(false);
  const [actionErr,        setActionErr]        = useState('');

  useEffect(() => {
    if (!isLoggedIn) { setLoading(false); return; }
    client.get(`/users/by-username/${encodeURIComponent(username)}`)
      .then(res => {
        setProfile(res.data);
        setFriendshipStatus(res.data.friendshipStatus);
      })
      .catch(err => {
        if (err.response?.status === 404) setError('Profile not found.');
        else setError('Could not load profile. Please try again.');
      })
      .finally(() => setLoading(false));
  }, [username, isLoggedIn]);

  async function handleAddFriend() {
    if (!profile) return;
    setActionBusy(true);
    setActionErr('');
    try {
      await client.post('/friends/request', { targetUserId: profile.id });
      setFriendshipStatus('pending');
    } catch (err) {
      setActionErr(err.response?.data?.error || 'Could not send friend request.');
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <>
      {isLoggedIn && <NavBar />}
      <main className={isLoggedIn ? 'page' : 'page-center'}>
        <div className="container--sm" style={{ margin: '0 auto', padding: '0 var(--page-pad)' }}>
          {loading ? (
            <div style={{ textAlign: 'center', paddingTop: 80 }}>
              <div className="spinner spinner--lg" />
            </div>

          ) : !isLoggedIn ? (
            /* ── Unauthenticated: sign-in prompt ── */
            <div className="card card-pad" style={{ textAlign: 'center', maxWidth: 420, margin: '64px auto 0' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>👤</div>
              <h2 style={{ margin: '0 0 8px', fontSize: '1.15rem', fontWeight: 800 }}>
                Sign in to connect
              </h2>
              <p style={{ color: 'var(--text-3)', marginBottom: 24, fontSize: '0.9rem' }}>
                Create an account or sign in to view profiles and add friends on Rendezvous.
              </p>
              <button className="btn btn--primary" onClick={() => navigate('/')}>
                Sign in to add as a friend
              </button>
            </div>

          ) : error ? (
            <div style={{ paddingTop: 64 }}>
              <div className="alert alert--error">{error}</div>
              <button className="btn btn--ghost btn--sm" style={{ marginTop: 12 }} onClick={() => navigate(-1)}>
                ← Go back
              </button>
            </div>

          ) : profile ? (
            /* ── Authenticated: full profile card ── */
            <div className="card card-pad" style={{ marginTop: 32 }}>
              {/* Avatar + name */}
              <div style={{ textAlign: 'center', marginBottom: 20 }}>
                {profile.avatar_url ? (
                  <img
                    src={profile.avatar_url}
                    alt={profile.full_name}
                    style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', margin: '0 auto', display: 'block' }}
                  />
                ) : (
                  <div
                    className="avatar"
                    style={{ width: 80, height: 80, fontSize: '1.8rem', lineHeight: '80px', margin: '0 auto' }}
                  >
                    {getInitials(profile.full_name)}
                  </div>
                )}
                <h1 style={{ margin: '14px 0 4px', fontSize: '1.3rem', fontWeight: 800 }}>
                  {profile.full_name}
                </h1>
                <div style={{ color: 'var(--text-3)', fontSize: '0.9rem' }}>@{profile.username}</div>
                {profile.location && (
                  <div style={{ color: 'var(--text-3)', fontSize: '0.85rem', marginTop: 6 }}>
                    📍 {profile.location}
                  </div>
                )}
              </div>

              {/* Bio */}
              {profile.bio && (
                <p style={{
                  textAlign: 'center', color: 'var(--text-2)', marginBottom: 18,
                  fontSize: '0.9rem', lineHeight: 1.5,
                }}>
                  {profile.bio}
                </p>
              )}

              {/* Activity pills */}
              {profile.activity_preferences?.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginBottom: 24 }}>
                  {profile.activity_preferences.map((a, i) => (
                    <span key={i} className="badge" style={{ fontSize: '0.78rem' }}>{a}</span>
                  ))}
                </div>
              )}

              {/* Friendship action */}
              <div style={{ textAlign: 'center' }}>
                {actionErr && (
                  <div className="alert alert--error" style={{ marginBottom: 12, fontSize: '0.87rem' }}>
                    {actionErr}
                  </div>
                )}
                {friendshipStatus === 'accepted' ? (
                  <span className="badge badge--green" style={{ fontSize: '0.9rem', padding: '8px 16px' }}>
                    Friends ✓
                  </span>
                ) : friendshipStatus === 'pending' ? (
                  <span className="badge badge--gray" style={{ fontSize: '0.9rem', padding: '8px 16px' }}>
                    Pending
                  </span>
                ) : (
                  <button
                    className="btn btn--primary"
                    onClick={handleAddFriend}
                    disabled={actionBusy}
                  >
                    {actionBusy ? '…' : '+ Add friend'}
                  </button>
                )}
              </div>
            </div>

          ) : null}
        </div>
      </main>
    </>
  );
}
