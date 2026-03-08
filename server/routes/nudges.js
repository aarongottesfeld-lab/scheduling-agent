// routes/nudges.js — nudge endpoints (AI generation comes later)
module.exports = function nudgesRouter(app, supabase, requireAuth) {

  // GET /nudges/pending
  app.get('/nudges/pending', requireAuth, async (req, res) => {
    const { data } = await supabase
      .from('nudges')
      .select('id, friend_id, reason, suggested_window_start, suggested_window_end')
      .eq('user_id', req.userId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(5);

    const friendIds = [...new Set((data || []).map(n => n.friend_id))];
    let profileMap = {};
    if (friendIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles').select('id, full_name').in('id', friendIds);
      profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p.full_name]));
    }

    res.json({
      nudges: (data || []).map(n => ({
        id: n.id,
        friendId: n.friend_id,
        friendName: profileMap[n.friend_id] || 'A friend',
        reason: n.reason,
        windowStart: n.suggested_window_start,
        windowEnd: n.suggested_window_end,
      }))
    });
  });

  // POST /nudges/:id/dismiss
  app.post('/nudges/:id/dismiss', requireAuth, async (req, res) => {
    await supabase.from('nudges').update({ status: 'dismissed' })
      .eq('id', req.params.id).eq('user_id', req.userId);
    res.json({ ok: true });
  });
};
