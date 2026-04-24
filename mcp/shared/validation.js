'use strict';

// Single source of truth for UUID validation and prompt sanitization.
// Imported by both server/routes/ and mcp/tools/ files.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(s) { return typeof s === 'string' && UUID_RE.test(s); }

const INJECTION_RE = /\b(ignore\s+(previous|all|prior)\s+(instructions?|prompts?|context)|system\s*:|assistant\s*:|<\s*\/?\s*(system|assistant|user|prompt)\s*>|disregard\s+(the\s+)?(above|previous|prior)|you\s+are\s+now|new\s+instructions?|override\s+(the\s+)?(above|previous)|forget\s+(everything|all)|jailbreak|do\s+anything\s+now|DAN\b)/gim;

function sanitizePromptInput(raw, maxLen = 500) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(INJECTION_RE, '[removed]').trim().slice(0, maxLen);
}

// Sanitizes PostgREST .or() filter strings — strips chars that break
// filter grouping or add unwanted wildcards.
function sanitizeSearch(raw) {
  return raw.replace(/[()%,]/g, '').trim();
}

module.exports = { UUID_RE, isValidUUID, INJECTION_RE, sanitizePromptInput, sanitizeSearch };
