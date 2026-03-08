// routes/users.js — user profile + search endpoints
module.exports = function usersRouter(app, supabase, requireAuth) {

  // GET /users/me — current user's profile
  app.get('/users/me', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, username, location, timezone, bio, activity_preferences, dietary_restrictions, mobility_restrictions, avatar_url, share_token')
      .eq('id', req.userId)
      .single();
    if (error) return res.status(404).json({ error: 'Profile not found.' });
    res.json(data);
  });

  // POST /users/profile — create or update profile
  app.post('/users/profile', requireAuth, async (req, res) => {
    const { full_name, username, location, timezone, bio, activities, dietary, mobility } = req.body;
    if (!full_name?.trim()) return res.status(400).json({ error: 'full_name is required.' });
    if (!username?.trim())  return res.status(400).json({ error: 'username is required.' });
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username format.' });
    }

    const { data: existing } = await supabase
      .from('profiles').select('id').eq('username', username).neq('id', req.userId).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Username already taken.' });

    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        id: req.userId,
        full_name: full_name.trim(),
        username: username.trim(),
        location:  location?.trim() || null,
        timezone:  timezone || null,
        bio:       bio?.trim() || null,
        activity_preferences: activities ?? [],
        dietary_restrictions: dietary ?? [],
        mobility_restrictions: mobility ?? [],
        email: req.userSession.email,
      }, { onConflict: 'id' })
      .select().single();

    if (error) return res.status(500).json({ error: 'Could not save profile.' });
    res.json(data);
  });

  // GET /users/search?q= — search by username, email, or name
  app.get('/users/search', requireAuth, async (req, res) => {
    const q = (req.query.q || req.query.email || '').trim().toLowerCase();
    if (!q || q.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters.' });

    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, username, location, avatar_url')
      .or(`username.ilike.%${q}%,email.ilike.%${q}%,full_name.ilike.%${q}%`)
      .neq('id', req.userId)
      .limit(10);

    if (error) return res.status(500).json({ error: 'Search failed.' });

    const ids = (data || []).map(u => u.id);
    let friendIds = new Set();
    if (ids.length > 0) {
      const { data: friends } = await supabase
        .from('friendships').select('friend_id')
        .eq('user_id', req.userId).eq('status', 'accepted').in('friend_id', ids);
      friendIds = new Set((friends || []).map(f => f.friend_id));
    }

    res.json({ users: (data || []).map(u => ({ ...u, name: u.full_name, isFriend: friendIds.has(u.id) })) });
  });

  // GET /geocode?lat=&lng=
  app.get('/geocode', requireAuth, async (req, res) => {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required.' });
    if (!process.env.GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: 'Maps not configured.' });
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=locality|sublocality|neighborhood&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      const r = await fetch(url);
      const json = await r.json();
      res.json({ location: json.results?.[0]?.formatted_address || null });
    } catch {
      res.status(500).json({ error: 'Geocode failed.' });
    }
  });

  // POST /users/avatar — upload profile picture
  // Accepts multipart/form-data with field "avatar" (image file, max 5MB)
  app.post('/users/avatar', requireAuth, async (req, res) => {
    const busboy = require('busboy');
    const bb = busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024 } });
    let fileBuffer = null;
    let mimeType   = null;
    let fileSizeOk = true;

    bb.on('file', (fieldname, file, info) => {
      mimeType = info.mimeType;
      const allowed = ['image/jpeg','image/png','image/webp','image/gif'];
      if (!allowed.includes(mimeType)) { file.resume(); fileSizeOk = false; return; }
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('limit', () => { fileSizeOk = false; });
      file.on('close', () => { if (fileSizeOk) fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('close', async () => {
      if (!fileSizeOk)  return res.status(400).json({ error: 'File too large or invalid type (JPEG, PNG, WebP, GIF only, max 5MB).' });
      if (!fileBuffer)  return res.status(400).json({ error: 'No image received.' });

      const ext    = mimeType.split('/')[1].replace('jpeg','jpg');
      const path   = `${req.userId}/avatar.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from('avatars')
        .upload(path, fileBuffer, { contentType: mimeType, upsert: true });

      if (uploadErr) return res.status(500).json({ error: 'Upload failed.' });

      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);

      await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', req.userId);
      res.json({ avatar_url: publicUrl });
    });

    req.pipe(bb);
  });

};
