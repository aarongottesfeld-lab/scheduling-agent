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

    // Batch friendship check — single query for all statuses (accepted + pending), not N+1.
    // We fetch all friendships in either direction so that:
    //   - accepted friends show a "Friends" badge
    //   - outgoing pending requests show a "Pending" badge
    //   - incoming pending requests also show "Pending" (they haven't replied yet)
    const ids = (data || []).map(u => u.id);

    // Map from user id → friendship status ('accepted' | 'pending' | null)
    const statusMap = {};

    if (ids.length > 0) {
      // Outgoing: rows where current user is the sender (user_id = me)
      const { data: outgoing } = await supabase
        .from('friendships')
        .select('friend_id, status')
        .eq('user_id', req.userId)
        .in('friend_id', ids);

      // Incoming: rows where current user is the recipient (friend_id = me)
      const { data: incoming } = await supabase
        .from('friendships')
        .select('user_id, status')
        .eq('friend_id', req.userId)
        .in('user_id', ids);

      for (const row of (outgoing || [])) statusMap[row.friend_id] = row.status;
      // Incoming rows fill in any gaps; if already set (outgoing accepted wins), skip.
      for (const row of (incoming || [])) {
        if (!statusMap[row.user_id]) statusMap[row.user_id] = row.status;
      }
    }

    res.json({
      users: (data || []).map(u => ({
        ...u,
        name:             u.full_name,
        isFriend:         statusMap[u.id] === 'accepted',
        // friendshipStatus is 'accepted', 'pending', or null (no relationship)
        friendshipStatus: statusMap[u.id] || null,
      })),
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
      // Use validated numbers (not raw strings) in URL — no injection risk.
      // No result_type filter: fetch all results and extract the most useful
      // human-readable locality from address_components (neighborhood > sublocality > locality > city).
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latNum},${lngNum}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      const r = await fetch(url);
      const json = await r.json();
      console.log('[geocode] status=%s results=%d', json.status, json.results?.length);

      // Walk address_components of the first result to find the most specific place name.
      // Preference order: neighborhood > sublocality > locality (city) > admin_area_level_2.
      let location = null;
      const components = json.results?.[0]?.address_components || [];
      const pick = (...types) => {
        for (const type of types) {
          const c = components.find(c => c.types.includes(type));
          if (c) return c.long_name;
        }
        return null;
      };
      location = pick('neighborhood', 'sublocality_level_1', 'sublocality', 'locality', 'administrative_area_level_2');
      // Append city if we picked a neighborhood/sublocality so the string is meaningful
      if (location) {
        const city = pick('locality');
        if (city && city !== location) location = `${location}, ${city}`;
      }
      // Last resort: use the formatted_address of the first result
      if (!location) location = json.results?.[0]?.formatted_address || null;

      res.json({ location });
    } catch {
      res.status(500).json({ error: 'Geocode failed.' });
    }
  });

  // POST /users/avatar — upload profile picture
  // Accepts multipart/form-data with field "avatar" (JPEG or PNG only, max 5MB).
  // Security: validates actual file content via magic bytes, not just the Content-Type
  // header declared by the client. A malicious file with a spoofed image MIME type
  // will be rejected after the buffer is assembled.
  app.post('/users/avatar', requireAuth, async (req, res) => {
    const busboy = require('busboy');
    const bb = busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024 } });
    let fileBuffer = null;
    let mimeType   = null;
    let fileSizeOk = true;

    bb.on('file', (fieldname, file, info) => {
      // mimeType comes from the multipart Content-Type header — client-declared, not trusted.
      // We record it here for the extension and storage contentType, but the actual format
      // is verified via magic bytes after the buffer is assembled (see bb.on('close')).
      mimeType = info.mimeType;
      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowed.includes(mimeType)) { file.resume(); fileSizeOk = false; return; }
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('limit', () => { fileSizeOk = false; });
      file.on('close', () => { if (fileSizeOk) fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('close', async () => {
      if (!fileSizeOk) return res.status(400).json({ error: 'File too large or invalid type (JPEG or PNG only, max 5MB).' });
      if (!fileBuffer) return res.status(400).json({ error: 'No image received.' });

      // ── Magic-bytes validation ────────────────────────────────────────────
      // Read the first 4 bytes of the actual file content to confirm the format,
      // independent of whatever Content-Type the client declared.
      //   JPEG: starts with FF D8 FF
      //   PNG:  starts with 89 50 4E 47 (i.e. \x89PNG)
      // Reject anything that doesn't match — this blocks e.g. a PHP script or
      // HTML file uploaded with Content-Type: image/jpeg.
      // Note: WebP and GIF are intentionally excluded here even though they were
      // previously allowed via MIME type — magic-byte support is limited to the
      // two most common formats to keep the check simple and auditable.
      const b0 = fileBuffer[0], b1 = fileBuffer[1], b2 = fileBuffer[2], b3 = fileBuffer[3];
      const isJpeg = b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF;
      const isPng  = b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47;
      if (!isJpeg && !isPng) {
        return res.status(400).json({ error: 'Invalid file type. Only JPEG and PNG are supported.' });
      }
      // ─────────────────────────────────────────────────────────────────────

      // Derive a safe extension from the verified magic bytes, not from the MIME header
      const ext  = isJpeg ? 'jpg' : 'png';
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
