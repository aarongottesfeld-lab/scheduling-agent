// routes/friends.js — friendships, requests, profiles, annotations, shared interests
'use strict';

// ── Helpers ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(s) { return typeof s === 'string' && UUID_RE.test(s); }

/**
 * Sanitize before interpolating into a PostgREST .or() filter string.
 * Commas split conditions; parens break grouping; % adds unintended wildcards.
 */
function sanitizeSearch(raw) {
  return raw.replace(/[()%,]/g, '').trim();
}

// Max lengths for free-text fields stored in friend_annotations
const MAX_NICKNAME  = 50;
const MAX_NOTES     = 1000;
const MAX_INTEREST  = 100;  // per pill
const MAX_INTERESTS = 50;   // total pills

module.exports = function friendsRouter(app, supabase, requireAuth) {

  // ── Notification helper ──────────────────────────────────────────────────
  async function insertNotification(userId, type, title, body, actionUrl, refId) {
    try {
      await supabase.from('notifications').insert({
        user_id: userId, type, title, body, action_url: actionUrl, ref_id: refId, read: false,
      });
    } catch (e) {
      // Non-fatal: log the problem but never surface notification errors to callers
      console.warn('insertNotification failed:', e.message);
    }
  }

  // GET /friends — list accepted friends, optional ?search= filter
  app.get('/friends', requireAuth, async (req, res) => {
    const rawSearch = req.query.search?.trim().toLowerCase();

    const { data: rows, error } = await supabase
      .from('friendships')
      .select('friend_id')
      .eq('user_id', req.userId)
      .eq('status', 'accepted');

    if (error) return res.status(500).json({ error: 'Could not load friends.' });

    const friendIds = (rows || []).map(r => r.friend_id);
    if (friendIds.length === 0) return res.json({ friends: [] });

    let query = supabase
      .from('profiles')
      .select('id, full_name, username, location, avatar_url')
      .in('id', friendIds);

    // Issue 2b: sanitize search before interpolating into PostgREST filter
    if (rawSearch) {
      const search = sanitizeSearch(rawSearch);
      if (search.length >= 1) {
        query = query.or(`username.ilike.%${search}%,full_name.ilike.%${search}%`);
      }
    }

    const { data: profiles } = await query;
    res.json({ friends: (profiles || []).map(p => ({ ...p, name: p.full_name })) });
  });

  // GET /friends/requests/incoming — pending requests sent to me
  app.get('/friends/requests/incoming', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('friendships')
      .select('id, user_id, created_at')
      .eq('friend_id', req.userId)
      .eq('status', 'pending');

    if (error) return res.status(500).json({ error: 'Could not load requests.' });

    const senderIds = (data || []).map(r => r.user_id);
    if (senderIds.length === 0) return res.json({ requests: [] });

    const { data: profiles } = await supabase
      .from('profiles').select('id, full_name, username').in('id', senderIds);

    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    res.json({
      requests: (data || []).map(r => ({
        id:           r.id,
        fromId:       r.user_id,
        fromName:     profileMap[r.user_id]?.full_name || 'Unknown',
        fromUsername: profileMap[r.user_id]?.username  || '',
        createdAt:    r.created_at,
      })),
    });
  });

  // POST /friends/request — send a friend request
  app.post('/friends/request', requireAuth, async (req, res) => {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required.' });

    // Issue 5: validate targetUserId is a real UUID before hitting the DB
    if (!isValidUUID(targetUserId)) return res.status(400).json({ error: 'Invalid targetUserId.' });
    if (targetUserId === req.userId) return res.status(400).json({ error: 'Cannot add yourself.' });

    // Check for existing friendship or request
    const { data: existing } = await supabase
      .from('friendships').select('id, status')
      .eq('user_id', req.userId).eq('friend_id', targetUserId).maybeSingle();
    if (existing) {
      return res.status(409).json({
        error: existing.status === 'accepted' ? 'Already friends.' : 'Request already sent.',
      });
    }

    // Issue 4: parallelize the insert with the sender profile lookup —
    // both are independent and can run concurrently.
    const [insertResult, senderProfileRes] = await Promise.all([
      supabase.from('friendships').insert({ user_id: req.userId, friend_id: targetUserId, status: 'pending' }),
      supabase.from('profiles').select('full_name, username').eq('id', req.userId).single(),
    ]);

    if (insertResult.error) return res.status(500).json({ error: 'Could not send request.' });

    const senderName = senderProfileRes.data?.full_name || senderProfileRes.data?.username || 'Someone';
    await insertNotification(
      targetUserId,
      'friend_request',
      'New friend request',
      `${senderName} sent you a friend request.`,
      '/friends',
      req.userId,
    );

    res.json({ ok: true });
  });

  // POST /friends/requests/:id/accept
  app.post('/friends/requests/:id/accept', requireAuth, async (req, res) => {
    const { id } = req.params;
    // Issue 5: validate route param is a UUID
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid request ID.' });

    const { data: request } = await supabase
      .from('friendships').select('user_id, friend_id, status')
      .eq('id', id).eq('friend_id', req.userId).maybeSingle();
    if (!request)                      return res.status(404).json({ error: 'Request not found.' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending.' });

    // Issue 4: run the two friendship writes and the acceptor profile fetch in parallel —
    // all three are independent (they touch different rows / different tables).
    const [, , acceptorProfileRes] = await Promise.all([
      supabase.from('friendships').update({ status: 'accepted' }).eq('id', id),
      supabase.from('friendships').upsert(
        { user_id: req.userId, friend_id: request.user_id, status: 'accepted' },
        { onConflict: 'user_id,friend_id' }
      ),
      supabase.from('profiles').select('full_name, username').eq('id', req.userId).single(),
    ]);

    const acceptorName = acceptorProfileRes.data?.full_name || acceptorProfileRes.data?.username || 'Someone';
    await insertNotification(
      request.user_id,
      'friend_request_accepted',
      'Friend request accepted',
      `${acceptorName} accepted your friend request.`,
      `/friends/${req.userId}`,
      req.userId,
    );

    res.json({ ok: true });
  });

  // POST /friends/requests/:id/decline
  app.post('/friends/requests/:id/decline', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid request ID.' });

    await supabase.from('friendships').delete().eq('id', id).eq('friend_id', req.userId);
    res.json({ ok: true });
  });

  // GET /friends/:id/profile — public profile of a friend
  // Issue 3c: only public fields are selected — annotations are never included.
  app.get('/friends/:id/profile', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const [profileRes, friendshipRes] = await Promise.all([
      supabase.from('profiles')
        .select('id, full_name, username, location, timezone, bio, activity_preferences, dietary_restrictions, mobility_restrictions, avatar_url')
        .eq('id', id).single(),
      // Two separate queries then pick whichever row exists — avoids nested and() in .or()
      (async () => {
        const a = await supabase.from('friendships').select('status')
          .eq('user_id', req.userId).eq('friend_id', id).maybeSingle();
        if (a.data) return a;
        return supabase.from('friendships').select('status')
          .eq('user_id', id).eq('friend_id', req.userId).maybeSingle();
      })(),
    ]);

    const { data, error } = profileRes;
    if (error || !data) return res.status(404).json({ error: 'Profile not found.' });

    res.json({
      ...data,
      name:             data.full_name,
      activities:       data.activity_preferences,
      dietary:          data.dietary_restrictions,
      mobility:         data.mobility_restrictions,
      friendshipStatus: friendshipRes.data?.status || null,
    });
  });

  // GET /friends/:id/annotations — current user's private notes on a friend
  // Issue 3c: always scoped to req.userId — User A's annotations are NEVER
  // returned to User B.  The double-filter (user_id AND friend_id) ensures this.
  app.get('/friends/:id/annotations', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const { data } = await supabase
      .from('friend_annotations')
      .select('nickname, shared_interests, notes')
      .eq('user_id', req.userId)
      .eq('friend_id', id)
      .maybeSingle();

    res.json({
      nickname:        data?.nickname         || '',
      sharedInterests: data?.shared_interests || [],
      notes:           data?.notes            || '',
    });
  });

  // PUT /friends/:id/annotations — save private notes
  app.put('/friends/:id/annotations', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const { nickname, sharedInterests, notes } = req.body;

    // Issue 5: max-length validation for annotation fields
    if (nickname && typeof nickname === 'string' && nickname.length > MAX_NICKNAME) {
      return res.status(400).json({ error: `Nickname must be ${MAX_NICKNAME} characters or fewer.` });
    }
    if (notes && typeof notes === 'string' && notes.length > MAX_NOTES) {
      return res.status(400).json({ error: `Notes must be ${MAX_NOTES} characters or fewer.` });
    }
    if (Array.isArray(sharedInterests)) {
      if (sharedInterests.length > MAX_INTERESTS) {
        return res.status(400).json({ error: `Too many shared interests (max ${MAX_INTERESTS}).` });
      }
      const tooLong = sharedInterests.find(s => typeof s === 'string' && s.length > MAX_INTEREST);
      if (tooLong) {
        return res.status(400).json({ error: `Each interest must be ${MAX_INTEREST} characters or fewer.` });
      }
    }

    const { error } = await supabase.from('friend_annotations').upsert({
      user_id:          req.userId,
      friend_id:        id,
      nickname:         nickname || null,
      shared_interests: sharedInterests || [],
      notes:            notes || null,
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'user_id,friend_id' });

    if (error) return res.status(500).json({ error: 'Could not save annotations.' });
    res.json({ ok: true });
  });

  // GET /friends/:id/shared-interests — AI comparison of activity preferences
  app.get('/friends/:id/shared-interests', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid user ID.' });

    const [myRes, friendRes] = await Promise.all([
      supabase.from('profiles').select('activity_preferences').eq('id', req.userId).single(),
      supabase.from('profiles').select('activity_preferences').eq('id', id).single(),
    ]);

    const myPrefs    = myRes.data?.activity_preferences    || [];
    const theirPrefs = friendRes.data?.activity_preferences || [];

    if (myPrefs.length === 0 && theirPrefs.length === 0) return res.json({ suggestions: [] });

    // Exact overlap first (fast, no AI needed)
    const exactOverlap = myPrefs.filter(p =>
      theirPrefs.some(t => t.toLowerCase() === p.toLowerCase())
    );

    if (!process.env.ANTHROPIC_API_KEY) return res.json({ suggestions: exactOverlap });

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic();
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Person A likes: ${myPrefs.join(', ')}\nPerson B likes: ${theirPrefs.join(', ')}\n\nReturn a JSON array of up to 6 short strings (2-4 words each) representing activities or interests they would BOTH enjoy together, including semantic overlaps (e.g. "rooftop bars" and "cocktail bars" → "craft cocktails"). Only return the JSON array, nothing else.`,
        }],
      });
      const raw = msg.content[0]?.text?.trim().replace(/```json|```/g, '').trim();
      const suggestions = JSON.parse(raw);
      return res.json({ suggestions: Array.isArray(suggestions) ? suggestions : exactOverlap });
    } catch {
      return res.json({ suggestions: exactOverlap });
    }
  });
};
