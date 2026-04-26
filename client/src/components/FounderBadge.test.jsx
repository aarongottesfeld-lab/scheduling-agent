import React from 'react';
import { render, screen } from '@testing-library/react';
import FounderBadge from './FounderBadge';

test('renders nothing when isFounder is false', () => {
  const { container } = render(<FounderBadge isFounder={false} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders nothing when isFounder is undefined', () => {
  const { container } = render(<FounderBadge />);
  expect(container).toBeEmptyDOMElement();
});

test('renders Founder label when isFounder is true', () => {
  render(<FounderBadge isFounder={true} />);
  expect(screen.getByText(/founder/i)).toBeInTheDocument();
});

test('has accessible label for screen readers', () => {
  render(<FounderBadge isFounder={true} />);
  expect(screen.getByLabelText(/founder of rendezvous/i)).toBeInTheDocument();
});
