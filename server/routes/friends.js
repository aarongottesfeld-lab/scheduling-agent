// routes/friends.js — friendships, requests, profiles, annotations, shared interests
module.exports = function friendsRouter(app, supabase, requireAuth) {

  // GET /friends — list accepted friends, optional ?search= filter
  app.get('/friends', requireAuth, async (req, res) => {
    const search = req.query.search?.trim().toLowerCase();

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

    if (search) query = query.or(`username.ilike.%${search}%,full_name.ilike.%${search}%`);

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
        id: r.id,
        fromId: r.user_id,
        fromName: profileMap[r.user_id]?.full_name || 'Unknown',
        fromUsername: profileMap[r.user_id]?.username || '',
        createdAt: r.created_at,
      }))
    });
  });

  // POST /friends/request — send a friend request
  app.post('/friends/request', requireAuth, async (req, res) => {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required.' });
    if (targetUserId === req.userId) return res.status(400).json({ error: 'Cannot add yourself.' });

    // Check for existing friendship or request
    const { data: existing } = await supabase
      .from('friendships').select('id, status')
      .eq('user_id', req.userId).eq('friend_id', targetUserId).maybeSingle();
    if (existing) return res.status(409).json({ error: existing.status === 'accepted' ? 'Already friends.' : 'Request already sent.' });

    const { error } = await supabase
      .from('friendships').insert({ user_id: req.userId, friend_id: targetUserId, status: 'pending' });
    if (error) return res.status(500).json({ error: 'Could not send request.' });
    res.json({ ok: true });
  });

  // POST /friends/requests/:id/accept
  app.post('/friends/requests/:id/accept', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { data: request } = await supabase
      .from('friendships').select('user_id, friend_id, status').eq('id', id).eq('friend_id', req.userId).maybeSingle();
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending.' });

    // Update original request to accepted + create the reverse friendship
    await supabase.from('friendships').update({ status: 'accepted' }).eq('id', id);
    await supabase.from('friendships').upsert(
      { user_id: req.userId, friend_id: request.user_id, status: 'accepted' }, { onConflict: 'user_id,friend_id' }
    );
    res.json({ ok: true });
  });

  // POST /friends/requests/:id/decline
  app.post('/friends/requests/:id/decline', requireAuth, async (req, res) => {
    const { id } = req.params;
    await supabase.from('friendships').delete().eq('id', id).eq('friend_id', req.userId);
    res.json({ ok: true });
  });

  // GET /friends/:id/profile — public profile of a friend
  app.get('/friends/:id/profile', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, username, location, timezone, bio, activity_preferences, dietary_restrictions, mobility_restrictions, avatar_url')
      .eq('id', id).single();
    if (error || !data) return res.status(404).json({ error: 'Profile not found.' });
    res.json({ ...data, name: data.full_name, activities: data.activity_preferences, dietary: data.dietary_restrictions, mobility: data.mobility_restrictions });
  });

  // GET /friends/:id/annotations — current user's private notes on a friend
  app.get('/friends/:id/annotations', requireAuth, async (req, res) => {
    const { data } = await supabase
      .from('friend_annotations')
      .select('nickname, shared_interests, notes')
      .eq('user_id', req.userId).eq('friend_id', req.params.id).maybeSingle();
    res.json({ nickname: data?.nickname || '', sharedInterests: data?.shared_interests || [], notes: data?.notes || '' });
  });

  // PUT /friends/:id/annotations — save private notes
  app.put('/friends/:id/annotations', requireAuth, async (req, res) => {
    const { nickname, sharedInterests, notes } = req.body;
    const { error } = await supabase.from('friend_annotations').upsert({
      user_id: req.userId,
      friend_id: req.params.id,
      nickname: nickname || null,
      shared_interests: sharedInterests || [],
      notes: notes || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,friend_id' });
    if (error) return res.status(500).json({ error: 'Could not save annotations.' });
    res.json({ ok: true });
  });

  // GET /friends/:id/shared-interests — AI comparison of activity preferences
  app.get('/friends/:id/shared-interests', requireAuth, async (req, res) => {
    const { id } = req.params;
    const [myRes, friendRes] = await Promise.all([
      supabase.from('profiles').select('activity_preferences').eq('id', req.userId).single(),
      supabase.from('profiles').select('activity_preferences').eq('id', id).single(),
    ]);

    const myPrefs    = myRes.data?.activity_preferences || [];
    const theirPrefs = friendRes.data?.activity_preferences || [];

    if (myPrefs.length === 0 && theirPrefs.length === 0) return res.json({ suggestions: [] });

    // Exact overlap first (fast, no AI needed)
    const exactOverlap = myPrefs.filter(p => theirPrefs.some(t => t.toLowerCase() === p.toLowerCase()));

    // AI semantic suggestions if Anthropic key available
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ suggestions: exactOverlap });

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic();
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
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
