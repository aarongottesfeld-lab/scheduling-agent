// routes/groups.js — group management routes
//
// POST   /groups                          — create a group
// GET    /groups                          — list groups the caller belongs to (active)
// GET    /groups/:id                      — get a group with its member list
// POST   /groups/:id/members              — invite a member (admin only)
// PATCH  /groups/:id/members/:userId      — update membership status (accept/decline/leave)
// DELETE /groups/:id/members/:userId      — remove a member (admin only)
//
// Security:
//   - All routes require a valid session via requireAuth.
//   - Member profile data returned is limited to id, full_name, avatar_url — no emails,
//     tokens, or full profile rows are ever included in list/detail responses.
//   - UUID validation rejects malformed IDs before any DB queries.
//   - Group size is capped at 15 members (SPRINT_SPECS cost/complexity ceiling).

'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(s) { return typeof s === 'string' && UUID_RE.test(s); }

const GROUP_SIZE_LIMIT = 15;

module.exports = function groupsRouter(app, supabase, requireAuth) {

  // ── Notification helper ────────────────────────────────────────────────────
  // Best-effort — notification failures never block the primary action.
  async function insertNotification(userId, type, tier, title, body, data) {
    try {
      await supabase.from('notifications').insert({
        user_id: userId,
        type,
        tier,
        title,
        body,
        data: data || null,
        read: false,
      });
    } catch (e) {
      console.warn('[groups] insertNotification failed:', e.message);
    }
  }

  /* ── POST /groups ─────────────────────────────────────────────────────── */
  // Creates a new group and inserts the creator as an active admin member.
  // The creator's membership row is inserted atomically — if it fails, the group
  // is removed to avoid an orphaned group with no admin.
  app.post('/groups', requireAuth, async (req, res) => {
    const { name, description } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required.' });
    }

    const cleanName = name.trim().slice(0, 100);
    const cleanDesc = typeof description === 'string' ? description.trim().slice(0, 1000) : null;

    const { data: group, error: groupErr } = await supabase
      .from('groups')
      .insert({ name: cleanName, description: cleanDesc, created_by: req.userId })
      .select('id, name, description, created_by, created_at')
      .single();

    if (groupErr) {
      console.error('[groups] create error:', groupErr.message);
      return res.status(500).json({ error: 'Could not create group.' });
    }

    // Insert creator as admin with active status (no pending step for the creator).
    const { error: memberErr } = await supabase
      .from('group_members')
      .insert({
        group_id:  group.id,
        user_id:   req.userId,
        role:      'admin',
        status:    'active',
        joined_at: new Date().toISOString(),
      });

    if (memberErr) {
      console.error('[groups] creator member insert error:', memberErr.message);
      // Clean up the orphaned group row before returning an error.
      await supabase.from('groups').delete().eq('id', group.id);
      return res.status(500).json({ error: 'Could not create group.' });
    }

    res.status(201).json({ group });
  });

  /* ── GET /groups ──────────────────────────────────────────────────────── */
  // Returns all groups the caller is an active member of, with member counts.
  app.get('/groups', requireAuth, async (req, res) => {
    const { data: memberships, error: membErr } = await supabase
      .from('group_members')
      .select('group_id, role, joined_at')
      .eq('user_id', req.userId)
      .eq('status', 'active');

    if (membErr) {
      console.error('[groups] list memberships error:', membErr.message);
      return res.status(500).json({ error: 'Could not fetch groups.' });
    }

    if (!memberships || memberships.length === 0) {
      return res.json({ groups: [] });
    }

    const groupIds = memberships.map(m => m.group_id);

    const [groupsRes, countsRes] = await Promise.all([
      supabase
        .from('groups')
        .select('id, name, description, created_by, created_at')
        .in('id', groupIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('group_members')
        .select('group_id')
        .in('group_id', groupIds)
        .in('status', ['active', 'pending']),
    ]);

    if (groupsRes.error) {
      console.error('[groups] list groups error:', groupsRes.error.message);
      return res.status(500).json({ error: 'Could not fetch groups.' });
    }

    // Build member count and caller role maps for O(1) lookup during response construction.
    const countMap = {};
    (countsRes.data || []).forEach(m => {
      countMap[m.group_id] = (countMap[m.group_id] || 0) + 1;
    });
    const roleMap = Object.fromEntries(memberships.map(m => [m.group_id, m.role]));

    res.json({
      groups: (groupsRes.data || []).map(g => ({
        ...g,
        member_count: countMap[g.id] || 1,
        my_role: roleMap[g.id] || 'member',
      })),
    });
  });

  /* ── GET /groups/:id ──────────────────────────────────────────────────── */
  // Returns group details + active/pending member list with minimal profile data.
  // Pending members are included per the RLS decision — they need to read group
  // name/description to decide whether to accept the invitation.
  app.get('/groups/:id', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ error: 'Invalid group ID.' });
    }

    // Verify the caller is a member (active or pending).
    const { data: myMembership } = await supabase
      .from('group_members')
      .select('role, status')
      .eq('group_id', req.params.id)
      .eq('user_id', req.userId)
      .maybeSingle();

    if (!myMembership || !['active', 'pending'].includes(myMembership.status)) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    const [groupRes, membersRes] = await Promise.all([
      supabase
        .from('groups')
        .select('id, name, description, created_by, created_at, updated_at')
        .eq('id', req.params.id)
        .single(),
      supabase
        .from('group_members')
        .select('user_id, role, status, joined_at, created_at')
        .eq('group_id', req.params.id)
        .in('status', ['active', 'pending'])
        .order('created_at', { ascending: true }),
    ]);

    if (groupRes.error || !groupRes.data) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    const members = membersRes.data || [];
    const memberUserIds = members.map(m => m.user_id);

    // Fetch minimal profile data — id, full_name, avatar_url only.
    // Never expose emails, tokens, or other profile fields in member lists.
    const { data: profiles } = memberUserIds.length
      ? await supabase
          .from('profiles')
          .select('id, full_name, avatar_url')
          .in('id', memberUserIds)
      : { data: [] };

    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    res.json({
      group: groupRes.data,
      my_role: myMembership.role,
      members: members.map(m => ({
        user_id:   m.user_id,
        role:      m.role,
        status:    m.status,
        joined_at: m.joined_at,
        profile:   profileMap[m.user_id]
          ? { id: profileMap[m.user_id].id, full_name: profileMap[m.user_id].full_name, avatar_url: profileMap[m.user_id].avatar_url }
          : null,
      })),
    });
  });

  /* ── POST /groups/:id/members ─────────────────────────────────────────── */
  // Invites a user to the group. Sends a Tier 1 notification to the invitee.
  // Admin-only. Enforces the 15-member cap.
  app.post('/groups/:id/members', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ error: 'Invalid group ID.' });
    }

    const { userId: inviteeId } = req.body;
    if (!inviteeId || !isValidUUID(inviteeId)) {
      return res.status(400).json({ error: 'userId is required and must be a valid UUID.' });
    }
    if (inviteeId === req.userId) {
      return res.status(400).json({ error: 'Cannot invite yourself.' });
    }

    // Verify caller is an active admin.
    const { data: adminCheck } = await supabase
      .from('group_members')
      .select('role, status')
      .eq('group_id', req.params.id)
      .eq('user_id', req.userId)
      .maybeSingle();

    if (!adminCheck || adminCheck.role !== 'admin' || adminCheck.status !== 'active') {
      return res.status(403).json({ error: 'Only group admins can invite members.' });
    }

    // Enforce the 15-member cap (active + pending count together).
    const { count: currentCount } = await supabase
      .from('group_members')
      .select('*', { count: 'exact', head: true })
      .eq('group_id', req.params.id)
      .in('status', ['active', 'pending']);

    if (currentCount >= GROUP_SIZE_LIMIT) {
      return res.status(400).json({ error: `Groups support a maximum of ${GROUP_SIZE_LIMIT} members.` });
    }

    // Verify the invitee exists.
    const { data: inviteeProfile } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('id', inviteeId)
      .maybeSingle();

    if (!inviteeProfile) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Check if already a current member or has a pending invite.
    const { data: existing } = await supabase
      .from('group_members')
      .select('status')
      .eq('group_id', req.params.id)
      .eq('user_id', inviteeId)
      .maybeSingle();

    if (existing && ['active', 'pending'].includes(existing.status)) {
      return res.status(409).json({ error: 'User is already a member or has a pending invitation.' });
    }

    // Upsert handles the case where the user previously left or declined.
    const { error: upsertErr } = await supabase
      .from('group_members')
      .upsert({
        group_id:   req.params.id,
        user_id:    inviteeId,
        role:       'member',
        status:     'pending',
        invited_by: req.userId,
        joined_at:  null,
        left_at:    null,
        created_at: new Date().toISOString(),
      }, { onConflict: 'group_id,user_id' });

    if (upsertErr) {
      console.error('[groups] invite member error:', upsertErr.message);
      return res.status(500).json({ error: 'Could not send invitation.' });
    }

    // Tier 1 notification — action required (accept or decline the invite).
    const { data: group } = await supabase.from('groups').select('name').eq('id', req.params.id).single();
    const inviterName = req.userSession.name || 'Someone';
    const groupName   = group?.name || 'a group';

    await insertNotification(
      inviteeId,
      'group_invite',
      1,
      `${inviterName} invited you to ${groupName}`,
      `You've been invited to join ${groupName}. Tap to accept or decline.`,
      { group_id: req.params.id },
    );

    res.status(201).json({ message: 'Invitation sent.' });
  });

  /* ── PATCH /groups/:id/members/:userId ────────────────────────────────── */
  // Users update their own membership status: accept an invite, decline, or leave.
  // status must be one of: 'active' (accept pending invite), 'declined', 'left'.
  app.patch('/groups/:id/members/:userId', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id) || !isValidUUID(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid group or user ID.' });
    }

    // Each user can only update their own membership row.
    if (req.params.userId !== req.userId) {
      return res.status(403).json({ error: 'You can only update your own membership.' });
    }

    const { status } = req.body;
    const VALID_STATUSES = new Set(['active', 'declined', 'left']);
    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: 'status must be one of: active, declined, left.' });
    }

    const { data: membership } = await supabase
      .from('group_members')
      .select('status')
      .eq('group_id', req.params.id)
      .eq('user_id', req.userId)
      .maybeSingle();

    if (!membership) {
      return res.status(404).json({ error: 'Membership not found.' });
    }

    // 'active' is only reachable from 'pending' (accepting an invite).
    if (status === 'active' && membership.status !== 'pending') {
      return res.status(400).json({ error: 'Can only accept a pending invitation.' });
    }
    // 'left' is only reachable from 'active'.
    if (status === 'left' && membership.status !== 'active') {
      return res.status(400).json({ error: 'Can only leave a group you are an active member of.' });
    }

    const now = new Date().toISOString();
    const update = {
      status,
      ...(status === 'active' ? { joined_at: now } : {}),
      ...(status === 'left'   ? { left_at:   now } : {}),
    };

    const { error: updateErr } = await supabase
      .from('group_members')
      .update(update)
      .eq('group_id', req.params.id)
      .eq('user_id', req.userId);

    if (updateErr) {
      console.error('[groups] membership update error:', updateErr.message);
      return res.status(500).json({ error: 'Could not update membership.' });
    }

    res.json({ message: 'Membership updated.' });
  });

  /* ── DELETE /groups/:id/members/:userId ───────────────────────────────── */
  // Removes a member from the group. Admin-only.
  // Admins cannot remove themselves via this route — use PATCH with status='left'.
  app.delete('/groups/:id/members/:userId', requireAuth, async (req, res) => {
    if (!isValidUUID(req.params.id) || !isValidUUID(req.params.userId)) {
      return res.status(400).json({ error: 'Invalid group or user ID.' });
    }

    // Verify caller is an active admin.
    const { data: adminCheck } = await supabase
      .from('group_members')
      .select('role, status')
      .eq('group_id', req.params.id)
      .eq('user_id', req.userId)
      .maybeSingle();

    if (!adminCheck || adminCheck.role !== 'admin' || adminCheck.status !== 'active') {
      return res.status(403).json({ error: 'Only group admins can remove members.' });
    }

    // Admins use PATCH with status='left' to leave themselves.
    if (req.params.userId === req.userId) {
      return res.status(400).json({ error: 'Use the leave group action to remove yourself.' });
    }

    const { error: deleteErr } = await supabase
      .from('group_members')
      .delete()
      .eq('group_id', req.params.id)
      .eq('user_id', req.params.userId);

    if (deleteErr) {
      console.error('[groups] remove member error:', deleteErr.message);
      return res.status(500).json({ error: 'Could not remove member.' });
    }

    res.json({ message: 'Member removed.' });
  });

};
