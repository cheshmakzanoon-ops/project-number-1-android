import { readFileSync } from 'node:fs';

// Invoked by convex deploy --cmd BEFORE it pushes any backend changes.
const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const expected = source.match(/const CONVEX_URL = "(https:\/\/[^"\s]+)";/)?.[1];
const actual = process.env.GARMA_DEPLOY_URL?.replace(/\/$/, '');
if (!expected || actual !== expected) {
  throw new Error('Refusing deployment: the deploy key must target the exact backend hard-coded in src/main.tsx.');
}
console.log('Deployment target matches the family app.');
