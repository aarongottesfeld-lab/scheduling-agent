import React from 'react';

export default function FounderBadge({ isFounder }) {
  if (!isFounder) return null;
  return (
    <span
      aria-label="Founder of Rendezvous"
      title="Founder of Rendezvous"
      style={{
        display: 'inline-block',
        marginLeft: 6,
        padding: '2px 6px',
        fontSize: '0.7rem',
        fontWeight: 600,
        borderRadius: 6,
        background: 'var(--warn-bg)',
        color: 'var(--warn)',
        verticalAlign: 'middle',
      }}
    >
      Founder
    </span>
  );
}
