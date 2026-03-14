// GroupDetail.js — Group detail screen with member list and management.
//
// Shows group name, description, active + pending members with role/status badges.
// Admin capabilities: invite members (friend search dropdown), remove non-admin members.
// Pending invite flow: if the viewer has a pending invitation, an accept/decline prompt
// is shown at the top before the rest of the UI.
// Non-admin active members can leave the group via a "Leave group" button at the bottom.
// "Plan Event" navigates to NewGroupEvent with this group pre-selected.
//
// Auth: the current user's Supabase UUID is read from auth.js (getSupabaseId) to
// find their own membership row without an extra API call.

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';
import { getGroup, inviteMember, updateMembership, removeMember, updateGroup } from '../utils/api';
import { getSupabaseId } from '../utils/auth';
import client from '../utils/client';

/** Two uppercase initials from a display name string. */
function getInitials(name = '') {
  return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

export default function GroupDetail() {
  const { id }    = useParams();
  const navigate  = useNavigate();
  const myId      = getSupabaseId(); // current user's Supabase UUID

  // Group + member state
  const [group,   setGroup]   = useState(null);
  const [members, setMembers] = useState([]);
  const [myRole,  setMyRole]  = useState('');  // 'admin' | 'member'
  const [myStatus, setMyStatus] = useState(''); // 'active' | 'pending'
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // Invite flow — friend search dropdown
  const [allFriends,    setAllFriends]    = useState([]);
  const [inviteQuery,    setInviteQuery]    = useState('');
  const [inviteResults,  setInviteResults]  = useState([]);
  const [inviteNoMatch,  setInviteNoMatch]  = useState(false);
  const [inviting,       setInviting]       = useState(false);
  const [inviteError,    setInviteError]    = useState('');
  const [inviteSuccess,  setInviteSuccess]  = useState('');
  const dropRef = useRef(null);

  // Per-member spinner: stores the userId currently being acted on
  const [busyUser, setBusyUser] = useState(null);

  // Edit group modal state (admin only)
  const [showEdit,      setShowEdit]      = useState(false);
  const [editName,      setEditName]      = useState('');
  const [editDesc,      setEditDesc]      = useState('');
  const [editActivities, setEditActivities] = useState(''); // comma-separated
  const [saving,        setSaving]        = useState(false);
  const [editError,     setEditError]     = useState('');

  /** Fetch (or re-fetch) the group and refresh component state. */
  const load = useCallback(async () => {
    try {
      const data = await getGroup(id);
      setGroup(data.group);
      setMembers(data.members || []);
      setMyRole(data.my_role);
      // Find the viewer's own membership row to determine pending/active state.
      // getSupabaseId() returns the UUID stored by App.js after /auth/me completes.
      const mine = (data.members || []).find(m => m.user_id === myId);
      if (mine) setMyStatus(mine.status);
    } catch (e) {
      setError(e.message || 'Could not load group.');
    } finally {
      setLoading(false);
    }
  }, [id, myId]);

  // Initial load on mount
  useEffect(() => { load(); }, [load]);

  // Load friends list once (only needed for the admin invite form)
  useEffect(() => {
    if (myRole !== 'admin') return;
    client.get('/friends')
      .then(res => setAllFriends(res.data?.friends || []))
      .catch(() => {});
  }, [myRole]);

  // Filter invite dropdown results as the query changes.
  // Excludes friends who are already active or pending members of this group.
  useEffect(() => {
    const memberIds = new Set(members.map(m => m.user_id));
    const eligible  = allFriends.filter(f => !memberIds.has(f.id));
    const q = inviteQuery.trim().toLowerCase();
    if (!q) {
      setInviteResults(eligible);
      setInviteNoMatch(false);
      return;
    }
    const filtered = eligible.filter(f =>
      f.name?.toLowerCase().includes(q) || f.username?.toLowerCase().includes(q)
    );
    setInviteResults(filtered);
    setInviteNoMatch(filtered.length === 0);
  }, [inviteQuery, allFriends, members]);

  // Close invite dropdown on outside click (same pattern as NewEvent friend picker)
  useEffect(() => {
    if (!inviteResults.length && !inviteNoMatch) return;
    function handler(e) {
      if (dropRef.current && !dropRef.current.contains(e.target)) {
        setInviteResults([]);
        setInviteNoMatch(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [inviteResults.length, inviteNoMatch]);

  /**
   * Send an invite to a friend by their userId.
   * Uses onMouseDown in the dropdown so selection fires before the input loses focus.
   */
  async function handleInvite(friendId) {
    setInviting(true);
    setInviteError('');
    setInviteSuccess('');
    setInviteQuery('');
    setInviteResults([]);
    setInviteNoMatch(false);
    try {
      await inviteMember(id, friendId);
      setInviteSuccess('Invitation sent.');
      load(); // refresh member list to show the new pending row
    } catch (e) {
      setInviteError(e.message || 'Could not send invitation.');
    } finally {
      setInviting(false);
    }
  }

  /**
   * Update a membership status row.
   * Used for accept/decline (by invitee) and leave (by member).
   * status: 'active' (accept), 'declined', or 'left'.
   */
  async function handleMembershipUpdate(userId, status) {
    setBusyUser(userId);
    setError('');
    try {
      await updateMembership(id, userId, status);
      if (status === 'left' || status === 'declined') {
        // User left/declined — navigate back to the groups list
        navigate('/groups');
      } else {
        load();
      }
    } catch (e) {
      setError(e.message || 'Could not update membership.');
    } finally {
      setBusyUser(null);
    }
  }

  /** Admin removes a non-admin member. Prompts for confirmation first. */
  async function handleRemoveMember(userId) {
    if (!window.confirm('Remove this member from the group?')) return;
    setBusyUser(userId);
    setError('');
    try {
      await removeMember(id, userId);
      load();
    } catch (e) {
      setError(e.message || 'Could not remove member.');
    } finally {
      setBusyUser(null);
    }
  }

  /** Open the edit modal pre-populated with current group values. */
  function openEdit() {
    setEditName(group.name || '');
    setEditDesc(group.description || '');
    setEditActivities((group.default_activities || []).join(', '));
    setEditError('');
    setShowEdit(true);
  }

  /** Save group edits — name, description, default_activities. */
  async function handleSaveEdit() {
    if (!editName.trim()) { setEditError('Group name is required.'); return; }
    setSaving(true);
    setEditError('');
    try {
      const activities = editActivities.split(',').map(a => a.trim()).filter(Boolean);
      await updateGroup(id, {
        name: editName.trim(),
        description: editDesc.trim() || null,
        defaultActivities: activities,
      });
      setShowEdit(false);
      load(); // refresh to show updated values
    } catch (e) {
      setEditError(e.message || 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  }

  // ── Loading / error gates ──────────────────────────────────────────────────

  if (loading) {
    return (
      <>
        <NavBar />
        <main className="page">
          <div className="container container--sm" style={{ textAlign: 'center', paddingTop: 64 }}>
            <div className="spinner" />
          </div>
        </main>
      </>
    );
  }

  if (!group) {
    return (
      <>
        <NavBar />
        <main className="page">
          <div className="container container--sm">
            <div className="alert alert--error">{error || 'Group not found.'}</div>
            <button className="btn btn--ghost" onClick={() => navigate('/groups')}>← Back to Groups</button>
          </div>
        </main>
      </>
    );
  }

  // Partition members into active and pending for count display
  const activeMembers  = members.filter(m => m.status === 'active');
  const pendingMembers = members.filter(m => m.status === 'pending');

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container container--sm">

          {/* Back navigation */}
          <button
            className="btn btn--ghost btn--sm"
            style={{ marginBottom: 16 }}
            onClick={() => navigate('/groups')}
          >
            ← Groups
          </button>

          {/* Pending invite banner — shown when the viewer has been invited but not yet responded */}
          {myStatus === 'pending' && (
            <div
              className="alert"
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                marginBottom: 20,
                padding: '14px 16px',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 10 }}>
                You've been invited to join <em>{group.name}</em>
              </div>
              {group.description && (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-3)', marginBottom: 12 }}>
                  {group.description}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn--primary btn--sm"
                  disabled={!!busyUser}
                  onClick={() => handleMembershipUpdate(myId, 'active')}
                >
                  {busyUser === myId ? '…' : 'Accept'}
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={!!busyUser}
                  onClick={() => handleMembershipUpdate(myId, 'declined')}
                >
                  Decline
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="alert alert--error" style={{ marginBottom: 12 }}>{error}</div>
          )}

          {/* Group header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 className="page-title" style={{ margin: 0 }}>{group.name}</h1>
              {group.description && (
                <p style={{ color: 'var(--text-3)', margin: '4px 0 0', fontSize: '0.9rem' }}>
                  {group.description}
                </p>
              )}
              <p style={{ color: 'var(--text-4)', margin: '4px 0 0', fontSize: '0.78rem' }}>
                {activeMembers.length} active member{activeMembers.length !== 1 ? 's' : ''}
                {pendingMembers.length > 0 && `, ${pendingMembers.length} pending`}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              {/* Edit button — admin only */}
              {myRole === 'admin' && myStatus === 'active' && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={openEdit}
                >
                  Edit
                </button>
              )}
              {/* Plan Event navigates to NewGroupEvent with this group pre-selected via URL param */}
              {myStatus === 'active' && (
                <button
                  className="btn btn--primary btn--sm"
                  onClick={() => navigate(`/groups/${id}/new-event`)}
                >
                  Plan Event
                </button>
              )}
            </div>
          </div>

          {/* Edit group modal — admin only */}
          {showEdit && (
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 100,
            }}>
              <div className="card" style={{ width: '100%', maxWidth: 480, padding: 28, margin: 16 }}>
                <h2 style={{ margin: '0 0 20px', fontSize: '1.1rem', fontWeight: 700 }}>Edit Group</h2>

                {editError && (
                  <div className="alert alert--error" style={{ marginBottom: 14, fontSize: '0.87rem' }}>
                    {editError}
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label" htmlFor="edit-name">Group name <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input
                    id="edit-name"
                    type="text"
                    className="form-control"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    disabled={saving}
                    maxLength={100}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="edit-desc">Description</label>
                  <textarea
                    id="edit-desc"
                    className="form-control"
                    value={editDesc}
                    onChange={e => setEditDesc(e.target.value)}
                    disabled={saving}
                    maxLength={1000}
                    rows={3}
                    style={{ resize: 'vertical' }}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="edit-activities">Default activities</label>
                  <input
                    id="edit-activities"
                    type="text"
                    className="form-control"
                    value={editActivities}
                    onChange={e => setEditActivities(e.target.value)}
                    disabled={saving}
                    placeholder="e.g. hiking, board games, trying new restaurants"
                  />
                  <p style={{ margin: '5px 0 0', fontSize: '0.8rem', color: 'var(--text-3)' }}>
                    What does this group usually do together? Separate with commas.
                  </p>
                </div>

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 24 }}>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => setShowEdit(false)}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={handleSaveEdit}
                    disabled={saving}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Admin invite form — only visible to active admins */}
          {myRole === 'admin' && myStatus === 'active' && (
            <div className="card" style={{ marginBottom: 24, padding: '14px 18px' }}>
              <div style={{ fontWeight: 600, marginBottom: 10, fontSize: '0.88rem' }}>
                Invite a member
              </div>
              {inviteError && (
                <div className="alert alert--error" style={{ marginBottom: 8, padding: '8px 12px', fontSize: '0.84rem' }}>
                  {inviteError}
                </div>
              )}
              {inviteSuccess && (
                <div className="alert" style={{ marginBottom: 8, padding: '8px 12px', fontSize: '0.84rem', background: 'var(--surface-2)' }}>
                  {inviteSuccess}
                </div>
              )}
              <div style={{ position: 'relative' }} ref={dropRef}>
                <input
                  type="text"
                  className="form-control"
                  value={inviteQuery}
                  onChange={e => setInviteQuery(e.target.value)}
                  onFocus={() => {
                    if (!inviteQuery.trim()) {
                      const memberIds = new Set(members.map(m => m.user_id));
                      setInviteResults(allFriends.filter(f => !memberIds.has(f.id)));
                    }
                  }}
                  placeholder={allFriends.length
                    ? `Search ${allFriends.length} friend${allFriends.length !== 1 ? 's' : ''}…`
                    : 'Search your friends…'}
                  disabled={inviting}
                  autoComplete="off"
                />
                {(inviteResults.length > 0 || inviteNoMatch) && (
                  <div className="card" style={{
                    position: 'absolute', top: '100%', left: 0, right: 0,
                    zIndex: 50, marginTop: 4, maxHeight: 200, overflowY: 'auto',
                  }}>
                    {inviteNoMatch ? (
                      <div style={{ padding: '12px 14px', color: 'var(--text-3)', fontSize: '0.875rem' }}>
                        No matches
                      </div>
                    ) : inviteResults.map(f => (
                      // onMouseDown fires before onBlur so the click registers before the input
                      // loses focus and the dropdown closes
                      <button
                        key={f.id}
                        type="button"
                        disabled={inviting}
                        onMouseDown={() => handleInvite(f.id)}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                          padding: '10px 14px', background: 'none', border: 'none',
                          cursor: 'pointer', textAlign: 'left',
                        }}
                      >
                        <div className="avatar avatar--sm">{getInitials(f.name || '')}</div>
                        <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{f.name}</span>
                        {f.username && (
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-3)' }}>@{f.username}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Members list */}
          <div style={{ marginBottom: 24 }}>
            <div style={{
              fontSize: '0.76rem', fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: 10,
            }}>
              Members
            </div>
            {members.map(member => {
              const profile = member.profile;
              const name    = profile?.full_name || 'Unknown';
              const isBusy  = busyUser === member.user_id;
              const isMe    = member.user_id === myId;
              return (
                <div
                  key={member.user_id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 0', borderBottom: '1px solid var(--border)',
                  }}
                >
                  {/* Avatar */}
                  {profile?.avatar_url ? (
                    <img
                      src={profile.avatar_url}
                      alt={name}
                      style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                    />
                  ) : (
                    <div className="avatar avatar--sm" style={{ flexShrink: 0 }}>
                      {getInitials(name)}
                    </div>
                  )}

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                      {name}{isMe ? ' (you)' : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 5, marginTop: 3, flexWrap: 'wrap' }}>
                      {/* Role badge */}
                      <span
                        className="badge"
                        style={{
                          fontSize: '0.66rem',
                          background: member.role === 'admin' ? 'var(--brand)' : 'var(--surface-2)',
                          color:      member.role === 'admin' ? '#fff'        : 'var(--text-2)',
                        }}
                      >
                        {member.role === 'admin' ? 'Admin' : 'Member'}
                      </span>
                      {/* Pending badge — shown for members who haven't accepted yet */}
                      {member.status === 'pending' && (
                        <span className="badge" style={{ fontSize: '0.66rem', background: '#fef3c7', color: '#92400e' }}>
                          Pending
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Admin-only: remove non-admin, non-self members */}
                  {myRole === 'admin' && !isMe && member.role !== 'admin' && (
                    <button
                      className="btn btn--ghost btn--sm"
                      disabled={isBusy}
                      onClick={() => handleRemoveMember(member.user_id)}
                      style={{ fontSize: '0.78rem', color: 'var(--danger)', flexShrink: 0 }}
                    >
                      {isBusy ? '…' : 'Remove'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Leave group — available to non-admin active members only.
              Admins must use the PATCH ?status=left path via a different action if needed. */}
          {myRole !== 'admin' && myStatus === 'active' && (
            <div style={{ paddingTop: 8 }}>
              <button
                className="btn btn--ghost btn--sm"
                style={{ color: 'var(--danger)' }}
                disabled={!!busyUser}
                onClick={() => {
                  if (window.confirm('Leave this group?')) {
                    handleMembershipUpdate(myId, 'left');
                  }
                }}
              >
                {busyUser === myId ? '…' : 'Leave group'}
              </button>
            </div>
          )}

        </div>
      </main>
    </>
  );
}
