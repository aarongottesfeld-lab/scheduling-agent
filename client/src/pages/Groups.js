// Groups.js — Groups list and create screen.
//
// Landing screen for the Groups tab. Shows all groups the current user belongs
// to (active members), with member count and role badge. Inline create-group
// form at the top; empty state for users with no groups.
//
// Navigation:
//   Tap a group card → GroupDetail
//   Create group → navigate directly to the new GroupDetail

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';
import { getGroups, createGroup } from '../utils/api';

/** Two uppercase initials from a group name — used for the group avatar. */
function getInitials(name = '') {
  return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

export default function Groups() {
  const navigate = useNavigate();

  // Loaded groups list
  const [groups,  setGroups]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // Create-group form state — inline expand/collapse
  const [showCreate,   setShowCreate]   = useState(false);
  const [newName,      setNewName]      = useState('');
  const [newDesc,      setNewDesc]      = useState('');
  const [newActivities, setNewActivities] = useState(''); // comma-separated input
  const [creating,     setCreating]     = useState(false);
  const [createError,  setCreateError]  = useState('');

  // Fetch the user's groups on mount.
  useEffect(() => {
    (async () => {
      try {
        const data = await getGroups();
        setGroups(data.groups || []);
      } catch (e) {
        setError(e.message || 'Could not load groups.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /**
   * Submit the create-group form.
   * On success, navigate directly to the new group's detail screen.
   */
  async function handleCreate(e) {
    e.preventDefault();
    if (!newName.trim()) { setCreateError('Group name is required.'); return; }
    setCreating(true);
    setCreateError('');
    try {
      const activities = newActivities.split(',').map(a => a.trim()).filter(Boolean);
      const data = await createGroup(newName.trim(), newDesc.trim() || null, activities);
      navigate(`/groups/${data.group.id}`);
    } catch (e) {
      setCreateError(e.message || 'Could not create group.');
      setCreating(false);
    }
  }

  /** Toggle the inline create form, resetting its state on close. */
  function toggleCreate() {
    setShowCreate(s => !s);
    setNewName('');
    setNewDesc('');
    setNewActivities('');
    setCreateError('');
  }

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container container--sm">

          {/* Header row: title + create button */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <div>
              <h1 className="page-title" style={{ margin: 0 }}>Groups</h1>
              <p className="page-subtitle" style={{ margin: '4px 0 0' }}>Plan with your crew.</p>
            </div>
            <button className="btn btn--primary btn--sm" onClick={toggleCreate}>
              {showCreate ? 'Cancel' : '+ Create Group'}
            </button>
          </div>

          {error && <div className="alert alert--error">{error}</div>}

          {/* Inline create-group form — shown when "+ Create Group" is tapped */}
          {showCreate && (
            <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
              <div style={{ fontWeight: 700, marginBottom: 14 }}>New Group</div>
              {createError && (
                <div className="alert alert--error" style={{ marginBottom: 12 }}>{createError}</div>
              )}
              <form onSubmit={handleCreate} noValidate>
                <div className="form-group">
                  <label className="form-label" htmlFor="group-name">
                    Group name <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                  <input
                    id="group-name"
                    type="text"
                    className="form-control"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    maxLength={100}
                    placeholder="e.g. Brooklyn crew, Golf squad, Work friends"
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="group-desc">
                    Description <span className="optional">optional</span>
                  </label>
                  <textarea
                    id="group-desc"
                    className="form-control"
                    value={newDesc}
                    onChange={e => setNewDesc(e.target.value)}
                    maxLength={1000}
                    rows={2}
                    placeholder="What's this group about? e.g. Friends from college"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="group-activities">
                    Default activities <span className="optional">optional</span>
                  </label>
                  <input
                    id="group-activities"
                    type="text"
                    className="form-control"
                    value={newActivities}
                    onChange={e => setNewActivities(e.target.value)}
                    maxLength={500}
                    placeholder="e.g. golf, rooftop bars, bowling, brunch"
                  />
                  <p className="form-hint">
                    What does this group usually do together? Separate with commas. Claude uses this as a fallback when no specific activity is requested.
                  </p>
                </div>
                <button type="submit" className="btn btn--primary" disabled={creating}>
                  {creating ? 'Creating…' : 'Create Group'}
                </button>
              </form>
            </div>
          )}

          {/* Loading spinner */}
          {loading && (
            <div style={{ textAlign: 'center', padding: 48 }}>
              <div className="spinner" />
            </div>
          )}

          {/* Empty state */}
          {!loading && groups.length === 0 && !showCreate && (
            <div style={{ textAlign: 'center', padding: '56px 0', color: 'var(--text-3)' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>👥</div>
              <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: 6 }}>No groups yet</div>
              <div style={{ fontSize: '0.88rem' }}>
                Create one to plan with your crew — or wait to be invited.
              </div>
            </div>
          )}

          {/* Groups list */}
          {groups.map(group => (
            <button
              key={group.id}
              className="card"
              style={{
                width: '100%',
                textAlign: 'left',
                marginBottom: 10,
                padding: '14px 16px',
                cursor: 'pointer',
                border: 'none',
                display: 'block',
              }}
              onClick={() => navigate(`/groups/${group.id}`)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                {/* Group avatar: coloured circle with initials from the group name */}
                <div
                  className="avatar"
                  style={{ background: 'var(--brand)', color: '#fff', flexShrink: 0, fontWeight: 700 }}
                >
                  {getInitials(group.name)}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Name + admin badge */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{group.name}</span>
                    {group.my_role === 'admin' && (
                      <span
                        className="badge"
                        style={{ fontSize: '0.68rem', background: 'var(--brand)', color: '#fff' }}
                      >
                        Admin
                      </span>
                    )}
                  </div>

                  {/* Description preview — single line, truncated */}
                  {group.description && (
                    <div style={{
                      fontSize: '0.82rem',
                      color: 'var(--text-3)',
                      marginTop: 2,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {group.description}
                    </div>
                  )}

                  {/* Member count */}
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-4)', marginTop: 3 }}>
                    {group.member_count} member{group.member_count !== 1 ? 's' : ''}
                  </div>
                </div>

                <span style={{ color: 'var(--text-4)', fontSize: '1.1rem', flexShrink: 0 }}>›</span>
              </div>
            </button>
          ))}

        </div>
      </main>
    </>
  );
}
