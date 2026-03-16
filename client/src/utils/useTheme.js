// useTheme.js — OS-default dark mode with manual override
//
// Reads/writes localStorage key 'theme': 'light' | 'dark' | null (system).
// Applies data-theme attribute on <html> so CSS selectors can target it.
// When preference is null (system), listens for OS theme changes mid-session.

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'theme';
const mq = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function applyTheme(preference) {
  const el = document.documentElement;
  if (preference === 'light' || preference === 'dark') {
    el.setAttribute('data-theme', preference);
  } else {
    el.removeAttribute('data-theme');
  }
}

export default function useTheme() {
  const [theme, setThemeState] = useState(readStored);

  // Apply on mount and whenever theme changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Listen for OS theme changes when in system mode
  useEffect(() => {
    if (theme !== null || !mq) return;
    const handler = () => applyTheme(null);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((value) => {
    const v = value === 'light' || value === 'dark' ? value : null;
    if (v) {
      localStorage.setItem(STORAGE_KEY, v);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    setThemeState(v);
  }, []);

  return [theme, setTheme];
}
