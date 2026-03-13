// Privacy: only supabaseId sent to PostHog — no PII, no health data, no calendar content
import React from 'react';
import ReactDOM from 'react-dom/client';
import posthog from 'posthog-js';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// Initialize PostHog before the app renders so identify() in App.js has a loaded client.
// Guarded by the env var — PostHog is a no-op in environments without a key (e.g. local dev
// without .env set, CI). capture_pageview:false because App.js fires pageviews manually on
// route change to avoid double-counting the initial load.
if (process.env.REACT_APP_POSTHOG_KEY) {
  posthog.init(process.env.REACT_APP_POSTHOG_KEY, {
    api_host: process.env.REACT_APP_POSTHOG_HOST,
    capture_pageview: false,
  });
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
