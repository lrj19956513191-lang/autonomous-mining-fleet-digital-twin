import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import App from './App';

test('renders the project heading and scene placeholder without browser APIs', () => {
  const markup = renderToStaticMarkup(<App />);

  expect(markup).toContain('<h1>Autonomous Mining Fleet Digital Twin</h1>');
  expect(markup).toContain('id="cesium-container"');
});
