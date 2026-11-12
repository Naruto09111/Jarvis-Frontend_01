# Testing report

Environment: sandbox with Node 22.23 / npm 10.9 and **no network**. `npm ci`, `tsc -b`, lint, `vite build`
and the real `vitest` runner could **not** be run here (project needs npm >= 11.19 and the registry).

## Passed (executed)
* 29 frontend tests in `src/lib/api.backend-connection.test.ts`, executed against the real `api.ts` / `sse.ts`
  under Node 22 with a small vitest-compatible shim and mocked `fetch`/`localStorage`: URL normalisation, URL/env
  precedence (incl. stale saved URL), `VITE_API_BASE_URL` name, empty/non-empty API key headers, model parsing,
  connection classification (ok / empty models / CORS / unreachable / tunnel 530 / HTML-200 / auth / invalid URL),
  no false-positive "connected", chat request URL/body/headers, chat error messages.
* 12 backend checks of the real `_engine_routes_model` / `_uses_direct_cloud_router` logic against the real
  `MultiEngine` (gateway model listed and routed to its engine; direct-cloud behaviour preserved).
* Syntax-level TypeScript parse of every changed frontend file: no syntax errors, no undefined identifiers.

## NOT verified (needs your machines)
* `npm ci && npm run build && npm test` with the real toolchain (please run once).
* Real browser CORS/preflight from https://frontend-1-rose-sigma.vercel.app to your tunnel.
* End-to-end chat with a real model: depends on your backend engine actually advertising a model after the patch.
* Streaming against the real backend.
