import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the new homepage discovery sections', () => {
  render(<App />);

  // Matched on the heading specifically: "Popular Cities" also appears in
  // the section's own body copy, so a plain getByText now finds two nodes
  // and throws.
  expect(screen.getByRole('heading', { name: /Popular Cities/i })).toBeInTheDocument();
});
