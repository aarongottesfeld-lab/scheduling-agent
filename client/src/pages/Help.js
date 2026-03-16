// Help.js — public help & FAQ page
//
// Publicly accessible (no ProtectedRoute). Shows NavBar for logged-in users.
// Sections 1–5 always visible; sections 6–9 only when authenticated.

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import NavBar from '../components/NavBar';
import { isAuthenticated } from '../utils/auth';

const FEEDBACK_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeAk1O_pPiJh376XybMTIWFnj0kKczYOzU2AeRoIsmrJbRFBw/viewform';
const DISCORD_INVITE_URL = 'https://discord.gg/6xc8ERrDDb';
const MCP_URL = 'https://scheduling-agent-production-0a8e.up.railway.app';

/* ── Copy button for code blocks ───────────────────────────────── */
function CopyBlock({ text }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      window.prompt('Copy this:', text);
    });
  }
  return (
    <div style={{ position: 'relative', marginTop: 8, marginBottom: 8 }}>
      <pre style={{
        background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', padding: '12px 14px', fontSize: '0.82rem',
        overflowX: 'auto', lineHeight: 1.6, margin: 0,
      }}>{text}</pre>
      <button
        onClick={handleCopy}
        className="btn btn--ghost btn--sm"
        style={{ position: 'absolute', top: 6, right: 6, fontSize: '0.75rem' }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

/* ── Accordion ─────────────────────────────────────────────────── */
function Accordion({ items }) {
  const [activeIndex, setActiveIndex] = useState(null);
  return (
    <div>
      {items.map((item, i) => {
        const open = activeIndex === i;
        return (
          <div key={i} style={{ borderBottom: '1px solid var(--border)' }}>
            <button
              onClick={() => setActiveIndex(open ? null : i)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                width: '100%', padding: '14px 0', background: 'none', border: 'none',
                cursor: 'pointer', textAlign: 'left', fontSize: '0.9rem',
                fontWeight: 600, color: 'var(--text)', gap: 12,
              }}
            >
              <span style={{ flex: 1 }}>{item.q}</span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-3)', flexShrink: 0 }}>
                {open ? '\u25BC' : '\u25B6'}
              </span>
            </button>
            {open && (
              <div style={{
                padding: '0 0 14px', fontSize: '0.875rem',
                color: 'var(--text-2)', lineHeight: 1.7,
              }}>
                {item.a}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Section wrapper ───────────────────────────────────────────── */
function Section({ id, title, children }) {
  return (
    <section id={id} style={{ marginBottom: 24, scrollMarginTop: 80 }}>
      <h2 className="section-title">{title}</h2>
      <div className="card card-pad">{children}</div>
    </section>
  );
}

/* ── Public FAQ items ──────────────────────────────────────────── */
const PUBLIC_FAQ = [
  {
    q: 'What calendars does Rendezvous support?',
    a: 'Google Calendar is supported out of the box when you sign in. You can also connect Apple Calendar and additional Google accounts (like a work calendar) from your profile settings.',
  },
  {
    q: 'Does Rendezvous read my calendar events?',
    a: 'Rendezvous only reads your free/busy times \u2014 it never sees event titles, descriptions, or attendees. We use this solely to find windows when you and your friend are both available.',
  },
  {
    q: 'Do I need to be friends with someone to plan with them?',
    a: 'Yes \u2014 you need to be connected as friends on Rendezvous first. You can find people by username or email from the Friends tab.',
  },
  {
    q: 'Can I plan with a group?',
    a: 'Yes. Create a group from the Groups tab and plan events with up to 15 people. Everyone votes on the suggestions before anything is locked in.',
  },
  {
    q: 'What happens when a plan is locked in?',
    a: 'Once the quorum of votes is reached, Rendezvous automatically creates a calendar event for everyone. No copy-pasting, no manual invites.',
  },
  {
    q: 'What if I don\'t like any of the suggestions?',
    a: 'Hit "New vibe" to get a fresh set of suggestions. You can also add context \u2014 like "something quieter" or "further downtown" \u2014 and Rendezvous will take that into account.',
  },
  {
    q: 'Can I suggest changes after a plan is sent?',
    a: 'Yes \u2014 either person can request new suggestions (called a reroll) before the plan is locked in. After locking, changes are logged in the plan history.',
  },
  {
    q: 'How does group voting work?',
    a: 'When the organizer sends a group plan, all members can vote to accept, decline, or abstain on each suggestion. The plan locks automatically once enough members accept to reach the quorum \u2014 based on the group size. If enough members decline to make quorum unreachable, the plan is automatically cancelled. Members who have not voted are counted as pending and do not block the outcome. On an even-numbered group, a perfect 50/50 tie is resolved by the organizer\'s tie-breaker setting.',
  },
];

/* ── Logged-in FAQ items ───────────────────────────────────────── */
const AUTHED_FAQ = [
  {
    q: 'How does Rendezvous decide what to suggest?',
    a: 'It combines your activity preferences, dietary and mobility needs, your friend\'s preferences, your mutual free windows, nearby venues from Google Maps, and any context you\'ve added. It also picks up on things like sports teams or upcoming events in your preferences and tries to anchor suggestions around them when relevant.',
  },
  {
    q: 'How many times can I reroll?',
    a: 'There is no hard limit, but each generation counts against a daily cap to keep things running smoothly for everyone.',
  },
  {
    q: 'What is the difference between In-app and Push notifications?',
    a: 'In-app notifications appear inside Rendezvous when you open it. Push notifications are sent to your device even when the app is not open. You can control both independently from Settings.',
  },
  {
    q: 'Can I use Rendezvous without giving notification permission?',
    a: 'Yes \u2014 notifications are optional. You will still see all activity inside the app under the bell icon.',
  },
];

/* ── Roadmap FAQ items ─────────────────────────────────────────── */
const ROADMAP_FAQ = [
  {
    q: 'Why do I need a Google account to sign in?',
    a: 'Rendezvous uses Google to access your calendar availability. Support for other calendar providers is on the roadmap \u2014 Google is required for now.',
  },
  {
    q: 'Will there be a mobile app?',
    a: 'Rendezvous is a Progressive Web App \u2014 you can add it to your home screen on iPhone or Android today and it works like a native app. A dedicated App Store version is planned for later.',
  },
  {
    q: 'Can I use Rendezvous for work meetings?',
    a: 'Rendezvous is designed for social planning with friends \u2014 dinners, activities, weekend plans. Work scheduling is not a current focus.',
  },
  {
    q: 'Is my data safe?',
    a: 'All data is stored in Supabase (Postgres) with row-level security \u2014 users can only ever access their own data. Connections are encrypted in transit. Calendar tokens are never exposed in any API response.',
  },
  {
    q: 'How do I delete my account?',
    a: 'Email aaron.gottesfeld@gmail.com with your username and we will remove your data within 7 days.',
  },
  {
    q: 'How do I revoke AI assistant access?',
    a: 'Go to Settings in Rendezvous to manage connected AI tools. You can also disconnect the connector directly from within Claude or ChatGPT\'s settings.',
  },
  {
    q: 'Can I set voting rules for my group?',
    a: 'Tie-breaker behavior is already supported in the backend \u2014 a 50/50 split can either lock the plan or cancel it based on the organizer\'s preference. A UI to configure this when creating a group event is coming soon.',
  },
  {
    q: 'Can I use Travel or Remote mode with groups?',
    a: 'Yes \u2014 both modes are available when creating a group event. Remote mode works well for groups spread across different cities. Travel mode lets the group plan a shared destination trip together.',
  },
];

/* ── Main component ────────────────────────────────────────────── */
export default function Help() {
  const authed = isAuthenticated();

  return (
    <>
      {authed && <NavBar />}
      <main className="page">
        <div className="container container--sm">
          <h1 className="page-title" style={{ marginBottom: 24 }}>Help</h1>

          {/* ── Table of contents ── */}
          <nav className="card card-pad" style={{ marginBottom: 24 }}>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text)', marginBottom: 10 }}>On this page</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.875rem', lineHeight: 2 }}>
              <li><a href="#how-it-works" style={{ color: 'var(--brand)', textDecoration: 'none' }}>How it works</a></li>
              <li><a href="#planning-modes" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Planning modes</a></li>
              <li><a href="#faq" style={{ color: 'var(--brand)', textDecoration: 'none' }}>FAQ</a></li>
              <li><a href="#privacy" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Privacy &amp; calendar</a></li>
              <li><a href="#contact" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Contact &amp; feedback</a></li>
              {authed && (
                <>
                  <li><a href="#settings-guide" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Settings guide</a></li>
                  <li><a href="#mcp" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Use Rendezvous with AI assistants</a></li>
                  <li><a href="#roadmap" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Roadmap Q&amp;A</a></li>
                </>
              )}
            </ul>
          </nav>

          {/* ── Section 1: How it works ── */}
          <Section id="how-it-works" title="How it works">
            {[
              { step: 1, title: 'Connect your calendar', desc: 'Sign in with Google to connect your calendar. You can also add Apple Calendar and additional Google accounts from your profile settings.' },
              { step: 2, title: 'Add your friends', desc: 'Find friends by username or email and send a friend request. Once connected you can start planning together.' },
              { step: 3, title: 'Pick a time and vibe', desc: 'Choose a date range, time of day, and optionally describe what you\u2019re looking for \u2014 \u201Clow-key dinner\u201D, \u201Csomething active\u201D, \u201Crooftop drinks\u201D.' },
              { step: 4, title: 'Get a real plan', desc: 'Rendezvous suggests three full itineraries with real venues, timing, and a route \u2014 tailored to both of your preferences and availability. Pick one, your friend confirms, and it lands on both calendars automatically.' },
            ].map(s => (
              <div key={s.step} style={{
                display: 'flex', gap: 14, alignItems: 'flex-start',
                paddingBottom: 16, marginBottom: 16,
                borderBottom: s.step < 4 ? '1px solid var(--border)' : 'none',
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%', background: 'var(--brand)',
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 800, fontSize: '0.8rem', flexShrink: 0,
                }}>{s.step}</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text)', marginBottom: 4 }}>{s.title}</div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-2)', lineHeight: 1.6 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </Section>

          {/* ── Section 2: Planning modes ── */}
          <Section id="planning-modes" title="Planning modes">
            {[
              { label: 'Local', desc: 'The default mode. Rendezvous suggests venues and activities near both of you, based on your locations. Great for dinners, bars, activities, and day plans in your city.' },
              { label: 'Remote', desc: 'For plans with friends in different cities or anyone you are meeting virtually. Rendezvous skips venue suggestions and focuses on activities you can do over video \u2014 watch parties, online games, cooking the same recipe, and so on.' },
              { label: 'Travel', desc: 'For overnight or destination trips. Rendezvous treats one city as the destination and builds a multi-day itinerary around it \u2014 hotels, neighborhoods, day-by-day activities. Set the destination and trip length when creating the event.' },
            ].map(m => (
              <div key={m.label} style={{
                borderLeft: '3px solid var(--brand)', paddingLeft: 14,
                marginBottom: 16,
              }}>
                <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text)', marginBottom: 4 }}>{m.label}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-2)', lineHeight: 1.6 }}>{m.desc}</div>
              </div>
            ))}
            <p className="form-hint" style={{ margin: 0 }}>
              You can select the mode when creating a new event. Remote and Travel modes are available for both 1-on-1 and group plans.
            </p>
          </Section>

          {/* ── Section 3: FAQ ── */}
          <Section id="faq" title="FAQ">
            <Accordion items={authed ? [...PUBLIC_FAQ, ...AUTHED_FAQ] : PUBLIC_FAQ} />
          </Section>

          {/* ── Section 4: Privacy & calendar ── */}
          <Section id="privacy" title="Privacy & calendar">
            <div style={{ fontSize: '0.875rem', color: 'var(--text-2)', lineHeight: 1.7 }}>
              <p style={{ marginBottom: 14 }}>
                Your calendar data stays private. Rendezvous only reads free/busy blocks &mdash; it never accesses event titles, descriptions, locations, or attendee lists.
              </p>
              <p style={{ marginBottom: 14 }}>
                Your availability is used only to find overlap with your friend&rsquo;s calendar. It is never stored permanently, shared with other users, or used for any purpose other than generating plans.
              </p>
              <p style={{ marginBottom: 14 }}>
                Your activity preferences and any context you add to a plan are sent to an AI model to generate suggestions. This is the only time your data leaves Rendezvous&rsquo;s servers. No personally identifiable information is included in that request.
              </p>
              <p style={{ margin: 0 }}>
                You can disconnect your Google Calendar at any time by revoking access at{' '}
                <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">myaccount.google.com/permissions</a>.
                You can also request account deletion by emailing{' '}
                <a href="mailto:aaron.gottesfeld@gmail.com">aaron.gottesfeld@gmail.com</a>.
              </p>
            </div>
          </Section>

          {/* ── Section 5: Contact & feedback ── */}
          <Section id="contact" title="Contact & feedback">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              <a href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer" className="btn btn--primary">
                Share feedback
              </a>
              <a href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer" className="btn btn--secondary">
                Join the Discord
              </a>
            </div>
            <p className="form-hint" style={{ margin: 0 }}>
              Found a bug? Use the feedback button at the bottom of any page, or email{' '}
              <a href="mailto:aaron.gottesfeld@gmail.com">aaron.gottesfeld@gmail.com</a>.
            </p>
          </Section>

          {/* ── Logged-in only sections ── */}
          {authed && (
            <>
              {/* ── Section 6: Settings guide ── */}
              <Section id="settings-guide" title="Settings guide">
                {[
                  { label: 'Appearance (Light / System / Dark)', to: '/settings' },
                  { label: 'Notification preferences', to: '/settings' },
                  { label: 'Privacy controls', to: '/settings' },
                  { label: 'Connected calendars', to: '/profile' },
                  { label: 'Share your profile link', to: '/profile' },
                ].map(row => (
                  <Link key={row.label} to={row.to} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 0', borderBottom: '1px solid var(--border)',
                    textDecoration: 'none', fontSize: '0.875rem',
                  }}>
                    <span style={{ color: 'var(--text-2)', fontWeight: 500 }}>{row.label}</span>
                    <span style={{ color: 'var(--text-3)', fontSize: '0.85rem' }}>&rarr;</span>
                  </Link>
                ))}
              </Section>

              {/* ── Section 7: Use Rendezvous with AI ── */}
              <section id="mcp" style={{ marginBottom: 24, scrollMarginTop: 80 }}>
                <h2 className="section-title">Use Rendezvous with AI assistants</h2>
                <div className="card card-pad">
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 20 }}>
                    Rendezvous supports MCP (Model Context Protocol), which lets you manage your plans, check availability, and plan with friends directly from Claude, ChatGPT, and other AI tools &mdash; without opening the app.
                  </p>

                  {/* What you can do */}
                  <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>What you can do</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 24 }}>
                    {[
                      { cat: 'Friends', items: ['View your friends list', 'Search for users', 'Send and respond to friend requests'] },
                      { cat: 'Availability', items: ['Check when you and a friend are both free'] },
                      { cat: 'Plans (1-on-1)', items: ['Create a new plan with a friend', 'View your existing plans', 'Get full plan details', 'Request new suggestions', 'Accept or decline a plan', 'Lock in a confirmed plan'] },
                      { cat: 'Groups', items: ['View your groups', 'View and create group plans', 'Vote on group suggestions', 'Submit a counter-proposal'] },
                    ].map(g => (
                      <div key={g.cat}>
                        <div style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{g.cat}</div>
                        <ul style={{ paddingLeft: 18, margin: 0, fontSize: '0.85rem', color: 'var(--text-2)', lineHeight: 1.8 }}>
                          {g.items.map(item => <li key={item}>{item}</li>)}
                        </ul>
                      </div>
                    ))}
                  </div>

                  {/* Claude Desktop and Claude AI */}
                  <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>Connect to Claude Desktop and Claude AI</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 14 }}>
                    Works with both the Claude desktop app and <a href="https://claude.ai" target="_blank" rel="noopener noreferrer">claude.ai</a> in a browser.
                  </p>
                  <ol style={{ paddingLeft: 20, margin: '0 0 24px', fontSize: '0.875rem', color: 'var(--text-2)', lineHeight: 1.8 }}>
                    <li style={{ marginBottom: 8 }}>
                      Open Claude (the desktop app or <a href="https://claude.ai" target="_blank" rel="noopener noreferrer">claude.ai</a>).
                    </li>
                    <li style={{ marginBottom: 8 }}>Click your profile icon &rarr; Settings &rarr; Integrations.</li>
                    <li style={{ marginBottom: 8 }}>
                      Click &ldquo;Add more&rdquo; and enter the following URL:
                      <CopyBlock text={MCP_URL} />
                    </li>
                    <li style={{ marginBottom: 8 }}>You will be redirected to sign in to Rendezvous and authorize access &mdash; click &ldquo;Allow access&rdquo;.</li>
                    <li>Once connected, Rendezvous tools will be available in your conversations. Look for a hammer icon to confirm.</li>
                  </ol>

                  {/* ChatGPT */}
                  <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>Connect to ChatGPT</h3>
                  <div className="alert alert--warn" style={{ marginBottom: 14 }}>
                    ChatGPT MCP support requires a Plus, Pro, Team, or Enterprise plan with Developer Mode enabled. It is not available on free accounts.
                  </div>
                  <ol style={{ paddingLeft: 20, margin: '0 0 16px', fontSize: '0.875rem', color: 'var(--text-2)', lineHeight: 1.8 }}>
                    <li style={{ marginBottom: 8 }}>In ChatGPT, go to Settings and enable Developer Mode. Look under Beta features or Advanced settings.</li>
                    <li style={{ marginBottom: 8 }}>Go to Settings &rarr; Connectors (may be labeled &ldquo;Apps&rdquo;).</li>
                    <li style={{ marginBottom: 8 }}>Click &ldquo;Add connector&rdquo; or &ldquo;Create&rdquo;.</li>
                    <li style={{ marginBottom: 8 }}>
                      Fill in:<br />
                      <strong>Name:</strong> Rendezvous<br />
                      <strong>MCP server URL:</strong>
                      <CopyBlock text={`${MCP_URL}/sse`} />
                      <strong>Authentication:</strong> OAuth
                    </li>
                    <li style={{ marginBottom: 8 }}>Click Create. You will be redirected to sign in to Rendezvous and authorize access &mdash; click &ldquo;Allow access&rdquo;.</li>
                    <li>To use Rendezvous in a conversation, select Rendezvous from your connectors list when starting a chat.</li>
                  </ol>
                  <p className="form-hint" style={{ marginBottom: 16 }}>
                    ChatGPT will ask you to confirm write actions like creating a plan or sending a friend request. Click Confirm to proceed.
                  </p>

                  {/* Coming soon */}
                  <p className="form-hint" style={{ margin: 0 }}>
                    <span className="badge badge--gray" style={{ marginRight: 6 }}>Coming soon</span>
                    Support for additional AI tools including Cursor, Gemini, and others that support MCP is coming. The connection URL will be the same.
                  </p>
                </div>
              </section>

              {/* ── Section 8: Roadmap Q&A ── */}
              <Section id="roadmap" title="Roadmap Q&A">
                <Accordion items={ROADMAP_FAQ} />
              </Section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
