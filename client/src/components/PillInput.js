// PillInput — reusable pill/tag input used in ProfileSetup and FriendProfile.
// Used by ProfileSetup (activity preferences, with pre-seeded suggestions)
// and FriendProfile (shared interests, with AI-suggested pills).

import React, { useState, useRef } from 'react';

export default function PillInput({
  pills = [],
  onChange,
  suggestions = [],
  placeholder = 'Type and press Enter...',
  suggestionsLabel = 'Suggestions',
}) {
  const [input, setInput] = useState('');
  const inputRef = useRef(null);

  function addPill(raw) {
    const value = raw.trim().toLowerCase();
    if (!value || pills.includes(value)) return;
    onChange([...pills, value]);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addPill(input);
      setInput('');
    } else if (e.key === 'Backspace' && input === '' && pills.length > 0) {
      // Remove last pill on backspace when input is empty
      onChange(pills.slice(0, -1));
    }
  }

  function handleBlur() {
    if (input.trim()) {
      addPill(input);
      setInput('');
    }
  }

  function removePill(pill) {
    onChange(pills.filter((p) => p !== pill));
  }

  function addSuggestion(s) {
    addPill(s);
  }

  const remainingSuggestions = suggestions.filter((s) => !pills.includes(s));

  return (
    <div>
      {/* Tag input box */}
      <div
        className="pill-input-wrap"
        onClick={() => inputRef.current?.focus()}
        role="group"
        aria-label="Tag input"
      >
        {pills.map((pill) => (
          <span key={pill} className="pill-tag pill-tag--removable">
            {pill}
            <button
              type="button"
              className="pill-tag__remove"
              onClick={(e) => { e.stopPropagation(); removePill(pill); }}
              aria-label={`Remove ${pill}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={pills.length === 0 ? placeholder : ''}
          aria-label={placeholder}
        />
      </div>

      {/* Clickable suggestion pills */}
      {remainingSuggestions.length > 0 && (
        <div className="pill-suggestions" role="list" aria-label={suggestionsLabel}>
          {remainingSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="pill-suggestion"
              role="listitem"
              onClick={() => addSuggestion(s)}
              aria-label={`Add ${s}`}
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
