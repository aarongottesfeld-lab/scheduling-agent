// client.js — authenticated axios instance for pages that need endpoints
// beyond what api.js exposes (e.g. nudges, friends, itineraries).
// api.js intentionally does not export its internal client, so pages
// that need additional calls import this instead.

import axios from 'axios';
import { getUserId } from './auth';

const BASE_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:3001';

const client = axios.create({ baseURL: BASE_URL });

client.interceptors.request.use((config) => {
  const userId = getUserId();
  if (userId) config.headers['x-user-id'] = userId;
  return config;
});

client.interceptors.response.use(
  (res) => res,
  (err) => {
    // Normalize error message for display — never bubble raw server errors
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
