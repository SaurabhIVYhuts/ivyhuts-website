// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';
import { TextEncoder, TextDecoder } from 'util';

// CRA 5 pins an older jsdom whose global scope has no TextEncoder/
// TextDecoder, which react-router v7 reaches for at import time — without
// these, any test that so much as imports a routed component dies with
// "TextEncoder is not defined" before a single assertion runs. Node's own
// implementations are the same thing the browser exposes.
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;
