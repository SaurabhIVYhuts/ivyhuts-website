import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the new homepage discovery sections', () => {
  render(<App />);

  expect(screen.getByText(/Popular Cities/i)).toBeInTheDocument();
});
