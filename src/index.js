import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// react-snap (npm "postbuild") pre-renders every route in reactSnap.include
// to a static build/<route>/index.html so crawlers — and every non-JS bot
// (Bing, LinkedIn, Slack, WhatsApp, GPTBot) — get real HTML, real <title>,
// and the per-route <head> tags <Seo> writes, instead of an empty shell.
// When that pre-rendered markup is present the root already has children:
// hydrate it in place rather than throwing it away and re-rendering, so
// there's no blank flash and the server/client markup stays in sync.
const container = document.getElementById('root');
const tree = (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if (container.hasChildNodes()) {
  hydrateRoot(container, tree);
} else {
  createRoot(container).render(tree);
}

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
