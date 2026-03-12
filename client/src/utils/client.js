// client.js — authenticated axios instance
//
// Cookie-based auth: the HTTP-only `rendezvous_session` cookie is sent
// automatically by the browser on every request when withCredentials: true.
// No manual auth headers are needed or set — the server reads the cookie in
// requireAuth and rejects requests with missing/expired sessions.
//
// Used by pages that need endpoints beyond what api.js exposes (nudges, friends,
// itineraries). api.js also imports this via its own client — they share the
// same baseURL and withCredentials config.

import axios from 'axios';

const BASE_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:3001';

const client = axios.create({
  baseURL:         BASE_URL,
  withCredentials: true, // send the HTTP-only session cookie on cross-origin requests
});

client.interceptors.response.use(
  (res) => res,
  (err) => {
    // Normalize all API errors to a single Error shape so pages can display
    // err.message without knowing the server's response format.
    // Never bubble raw axios/network errors directly to the UI.
    const msg =
      err.response?.data?.error ||
      err.response?.data?.message ||
      'Something went wrong. Please try again.';
    const normalized = new Error(msg);
    normalized.status = err.response?.status;
    return Promise.reject(normalized);
  }
);

export default client;
