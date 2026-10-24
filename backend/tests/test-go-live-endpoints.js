/** The three go-live endpoints load, route and refuse unauthenticated calls. Run: node backend/tests/test-go-live-endpoints.js */
'use strict';
const path = require('path');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
(async () => {
  for (const [name, method] of [['coop-portal-go-live-batch', 'POST'], ['coop-portal-go-live-import', 'POST'], ['coop-portal-go-live-template', 'GET'], ['coop-portal-go-live-books', 'POST']]) {
    const h = require(path.join(FN, name)).handler;
    const r = await h({ httpMethod: method, headers: {}, body: '{}' });
    ok(`${name}: no token is refused with 401`, r.statusCode === 401);
    const w = await h({ httpMethod: method === 'GET' ? 'POST' : 'GET', headers: {} });
    ok(`${name}: wrong method is refused with 405`, w.statusCode === 405);
  }
  const toml = require('fs').readFileSync(path.join(__dirname, '..', '..', 'netlify.toml'), 'utf8');
  ok('all three endpoints are routed in netlify.toml', ['batch', 'import', 'template', 'books'].every(n => toml.includes(`from = "/api/v1/coop-portal-go-live-${n}"`)));
  console.log(bad ? `\n${bad} FAILED` : '\nAll go-live endpoint tests passed');
})();
