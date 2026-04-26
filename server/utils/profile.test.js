'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stampFounder } = require('./profile');

const originalFounderId = process.env.FOUNDER_USER_ID;
test.afterEach(() => {
  if (originalFounderId === undefined) delete process.env.FOUNDER_USER_ID;
  else process.env.FOUNDER_USER_ID = originalFounderId;
});

test('stampFounder returns null when given null', () => {
  assert.equal(stampFounder(null), null);
});

test('stampFounder returns undefined when given undefined', () => {
  assert.equal(stampFounder(undefined), undefined);
});

test('stampFounder adds is_founder: true when profile id matches FOUNDER_USER_ID', () => {
  process.env.FOUNDER_USER_ID = '11111111-1111-1111-1111-111111111111';
  const profile = { id: '11111111-1111-1111-1111-111111111111', full_name: 'Aaron' };
  const result = stampFounder(profile);
  assert.equal(result.is_founder, true);
  assert.equal(result.id, profile.id);
  assert.equal(result.full_name, 'Aaron');
});

test('stampFounder adds is_founder: false when id does not match', () => {
  process.env.FOUNDER_USER_ID = '11111111-1111-1111-1111-111111111111';
  const profile = { id: '22222222-2222-2222-2222-222222222222', full_name: 'Other' };
  const result = stampFounder(profile);
  assert.equal(result.is_founder, false);
});

test('stampFounder adds is_founder: false when FOUNDER_USER_ID is unset', () => {
  delete process.env.FOUNDER_USER_ID;
  const profile = { id: '11111111-1111-1111-1111-111111111111' };
  const result = stampFounder(profile);
  assert.equal(result.is_founder, false);
});

test('stampFounder does not mutate the input', () => {
  process.env.FOUNDER_USER_ID = '11111111-1111-1111-1111-111111111111';
  const profile = { id: '11111111-1111-1111-1111-111111111111' };
  stampFounder(profile);
  assert.equal('is_founder' in profile, false);
});
