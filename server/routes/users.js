// routes/users.js — user profile + search endpoints
'use strict';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sanitize a string before interpolating it into a PostgREST `.or()` filter.
 * The risk is NOT SQL injection (PostgREST parameterizes queries internally)
 * but malformed filter strings: a comma splits conditions, parentheses break
 * grouping, and `%` adds extra wildcards that make the query expensive.
 * Strip all of those characters.  Normal search chars (letters, digits,
 * spaces, @, ., _, -, +) are preserved.
 */
function sanitizeSearch(raw) {
  return raw.replace(/[()%,]/g, '').trim();
}

// Max field lengths (enforced both here and should mirror DB constraints).
const MAX = {
  full_name: 100,
  username:  30,
  location:  200,
  bio:       500,
  timezone:  80,
};

module.exports = function usersRouter(app, supabase, requireAuth) {

  // GET /users/me — current user's profile
  // Issues 3b: this never returns google_tokens — the tokens live in the
  // in-memory session only and are never written to a DB column.
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

    // Issue 5: max-length guards on free-text fields
    if (full_name.trim().length  > MAX.full_name) return res.status(400).json({ error: `full_name must be ${MAX.full_name} characters or fewer.` });
    if (location?.trim().length  > MAX.location)  return res.status(400).json({ error: `location must be ${MAX.location} characters or fewer.` });
    if (bio?.trim().length       > MAX.bio)       return res.status(400).json({ error: `bio must be ${MAX.bio} characters or fewer.` });
    if (timezone?.length         > MAX.timezone)  return res.status(400).json({ error: 'Invalid timezone value.' });

    // activities / dietary / mobility are arrays; cap array length to prevent oversized payloads
    if (Array.isArray(activities) && activities.length > 100) return res.status(400).json({ error: 'Too many activity preferences (max 100).' });
    if (Array.isArray(dietary)   && dietary.length   > 20)   return res.status(400).json({ error: 'Too many dietary restrictions (max 20).' });
    if (Array.isArray(mobility)  && mobility.length  > 20)   return res.status(400).json({ error: 'Too many mobility restrictions (max 20).' });

    const { data: existing } = await supabase
      .from('profiles').select('id').eq('username', username).neq('id', req.userId).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Username already taken.' });

    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        id:        req.userId,
        full_name: full_name.trim(),
        username:  username.trim(),
        location:  location?.trim() || null,
        timezone:  timezone || null,
        bio:       bio?.trim() || null,
        activity_preferences:  activities ?? [],
        dietary_restrictions:  dietary    ?? [],
        mobility_restrictions: mobility   ?? [],
        email: req.userSession.email,
      }, { onConflict: 'id' })
      .select().single();

    if (error) return res.status(500).json({ error: 'Could not save profile.' });
    res.json(data);
  });

  // GET /users/search?q= — search by username, email, or name
  app.get('/users/search', requireAuth, async (req, res) => {
    const raw = (req.query.q || req.query.email || '').trim().toLowerCase();

    // Issue 5: minimum length check
    if (!raw || raw.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters.' });
    }

    // Issue 2b: sanitize before interpolating into PostgREST .or() filter string.
    // Chars like commas and parens split/break the OR expression; % adds extra
    // wildcards that make the query unnecessarily expensive.
    const q = sanitizeSearch(raw);
    if (q.length < 2) {
      return res.status(400).json({ error: 'Query must contain at least 2 non-special characters.' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, username, location, avatar_url')
      .or(`username.ilike.%${q}%,email.ilike.%${q}%,full_name.ilike.%${q}%`)
      .neq('id', req.userId)
      .limit(10);

    if (error) return res.status(500).json({ error: 'Search failed.' });

    // Batch friendship check — single query, not N+1
    const ids = (data || []).map(u => u.id);
    let friendIds = new Set();
    if (ids.length > 0) {
      const { data: friends } = await supabase
        .from('friendships').select('friend_id')
        .eq('user_id', req.userId).eq('status', 'accepted').in('friend_id', ids);
      friendIds = new Set((friends || []).map(f => f.friend_id));
    }

    res.json({
      users: (data || []).map(u => ({ ...u, name: u.full_name, isFriend: friendIds.has(u.id) })),
    });
  });

  // GET /geocode?lat=&lng=
  // Issue 2: lat/lng validated as numbers in range before being interpolated
  // into the Google Maps URL — prevents URL injection via crafted query params.
  app.get('/geocode', requireAuth, async (req, res) => {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required.' });

    // Issue 5 / Issue 2b: validate numeric and within valid coordinate range
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (
      isNaN(latNum) || isNaN(lngNum) ||
      latNum < -90  || latNum > 90   ||
      lngNum < -180 || lngNum > 180
    ) {
      return res.status(400).json({ error: 'Invalid coordinates.' });
    }

    if (!process.env.GOOGLE_MAPS_API_KEY) return res.status(500).json({ error: 'Maps not configured.' });

    try {
      // Use validated numbers (not raw strings) in URL — no injection risk
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latNum},${lngNum}&result_type=locality|sublocality|neighborhood&key=${process.env.GOOGLE_MAPS_API_KEY}`;
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
      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowed.includes(mimeType)) { file.resume(); fileSizeOk = false; return; }
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('limit', () => { fileSizeOk = false; });
      file.on('close', () => { if (fileSizeOk) fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('close', async () => {
      if (!fileSizeOk) return res.status(400).json({ error: 'File too large or invalid type (JPEG, PNG, WebP, GIF only, max 5MB).' });
      if (!fileBuffer) return res.status(400).json({ error: 'No image received.' });

      const ext  = mimeType.split('/')[1].replace('jpeg', 'jpg');
      const path = `${req.userId}/avatar.${ext}`;

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
