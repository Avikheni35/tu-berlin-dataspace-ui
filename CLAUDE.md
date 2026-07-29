# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

This is the web UI for the [Dataspace Connector](https://github.com/International-Data-Spaces-Association/DataspaceConnector), an IDS (International Data Spaces) connector implementation. The UI itself never talks to the Dataspace Connector (DSC) directly — it goes through a small Node/Express proxy backend in `src/backend/` because of the Same-Origin-Policy and because the DSC uses Basic Auth over HTTPS with a self-signed cert.

Note: per `README.md`, this project is currently unmaintained and looking for new maintainers (IDSA). Keep changes minimal/targeted and don't assume anyone is actively triaging issues.

## Commands

Run from the repository root unless noted.

```bash
npm install --no-audit      # install deps; postinstall also runs `npm install` inside src/backend
npm start                   # runs frontend (port 8082) + backend (port 8083) concurrently
npm run serve               # frontend only, dev mode with hot reload (vue-cli-service serve)
npm run backend             # backend only (cd src/backend && npm start)
npm run build                # production build -> dist/
npm run serveprod           # frontend only, built against production mode
npm run startprod            # frontend (prod mode) + backend concurrently
npm run lint                 # vue-cli-service lint (eslint, plugin:vue/essential + eslint:recommended)
```

There is no frontend test suite configured. The backend's `npm test` (in `src/backend/`) is an unimplemented placeholder (`echo "Error: no test specified" && exit 1`) — do not treat it as a real check.

A real Dataspace Connector instance must be reachable (default `https://localhost:8080`) for most API-backed pages to work end to end; the UI backend also exposes `http://localhost:8083/testdata` (GET/POST) purely as a dummy REST backend-connection target for manual testing inside the DSC.

### Key runtime config points
- Frontend dev port: `package.json` → `serve` script `--port` flag.
- Backend connector target: `let connectorUrl = "https://localhost:8080"` in `src/backend/index.js`, overridable via `CONNECTOR_URL`/`CONNECTOR_USER`/`CONNECTOR_PASSWORD` env vars (or `src/backend/.env`).
- Basic Auth for the UI backend itself: `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` env vars (both must be non-empty to activate; off by default).
- Theme colors: `src/theme/default.js`.
- Optional "custom attributes" (ontology-driven extra Resource metadata) feature: toggle `USE_ONTOLOGY=true` in `src/backend/.env`, configured via `src/backend/ontology.ttl` (RDF/OWL, parsed by `ontologyLoader.js`) + `src/backend/ontology.config.json` (maps ontology classes/properties to `select`/`text` UI fields). Disabled by default.

## Architecture

**Stack**: Vue 2 (Options API) + Vuetify 2 for the frontend; a plain Express server (ESM, `"type": "module"`) as the backend proxy. `src/backend/` has its own independent `package.json`/`node_modules` — it is not part of the Vue build, it's a separate Node process.

### Request flow (important — read before touching API calls)
Every frontend API call goes through one indirection layer, never `axios` directly against the connector:

1. A page/component calls a method in `src/utils/dataUtils.js` (the domain-level API — one function per DSC concept: resources, contracts, routes, brokers, apps, etc.).
2. `dataUtils.js` delegates to `src/utils/restUtils.js`, specifically `callConnector(type, url, params, body)`, which POSTs a JSON envelope `{ toConnector, type, url, params, body }` to the UI backend at `http://localhost:8083/`.
3. `src/backend/index.js` receives that envelope on its single catch-all `POST /`, rebuilds the query string, and forwards the request to the real DSC (`connectorUrl`) using axios with Basic Auth + a permissive HTTPS agent (`rejectUnauthorized: false`, since the DSC uses a self-signed cert).
4. Errors from the DSC are passed back largely as-is (with `config`/`request` stripped) as the response body; `restUtils.isError()` / `getErrorDetails()` on the frontend inspect the shape of that body to detect and surface errors (there's no clean HTTP status contract — check status, `error`, `name === "Error"`, and a couple of legacy shapes).

When adding a new API call: add a method to `dataUtils.js` that calls `restUtils.callConnector(...)`, don't call `restUtils` or `axios` directly from components.

### Data model translation
Data coming back from the DSC is in IDS/JSON-LD-ish shape (`@id`, `@value`, arrays-of-one, etc.). `src/datamodel/clientDataModel.js` and helpers in `dataUtils.js` (e.g. `getValue`, the `POLICY_*`/`OPERATOR_TYPE_TO_SYMBOL`/`IDS_PAYMENT_METHOD_TO_NAME` maps) convert between the DSC's IDS vocabulary and simpler objects/display strings the Vue components use. When rendering or editing IDS policy/contract data, expect to go through these translation maps rather than reading `@id`/`@value` fields directly in components.

### Page structure & routing are generated, not hand-wired
- `src/pages/PageStructure.js` is the single source of truth for the app: it's a tree of `{ path, name, icon, component, subpages, showInAdvancedViewOnly, showInMenu }` nodes.
- `src/routes/routes.js` walks that tree (`generateRoutes`) to build the actual `vue-router` route list *and* breadcrumbs (`meta.breadcrumb`) automatically — routes and the left nav menu are two views of the same tree.
- To add a new page: add a component under `src/pages/...`, wire it into the tree in `PageStructure.js` (not into `routes.js` directly), and the route + breadcrumb + nav entry follow automatically. `showInAdvancedViewOnly: true` hides a node in the simplified/basic UI mode; `showInMenu: false` keeps a route reachable without a menu entry (e.g. detail/edit sub-pages).
- The folder layout under `src/pages/` mirrors the navigation hierarchy (e.g. `dataoffering/resources/addresource`, `dataconsumption/resources`).

### Component file split
Every page/component is split across three sibling files:
- `Page.vue` — 3-line shell: `<template src="./Page.html">`, `<script src="./Page.js">`, `<style src="./Page.css">`
- `Page.js` — Vue Options API logic (the file with actual component code)
- `Page.html` — Vuetify template markup

When searching for component logic, grep `.js` files. When searching for template structure, grep `.html` files. The `.vue` file is just glue.

### Global event bus conventions
Components communicate loading and error state through `this.$root.$emit(...)`:
- `this.$root.$emit('showBusyIndicator', true/false)` — show/hide loading spinner
- `this.$root.$emit('error', "message")` — surface an error notification

`errorUtils.showError(error, "Operation Name")` is the standard catch-block call; it logs to console and emits `'error'` via the Vue root (which `errorUtils` receives via `setVueRoot(root)` in `main.js`). Don't call `$root.$emit('error', ...)` directly from components — use `errorUtils`.

### Additional backend endpoints
Beyond the primary `POST /` proxy, the backend exposes:
- `GET /health` — returns `"OK"`, intentionally placed before BasicAuth middleware so it's accessible without credentials
- `GET /download?url=<path>` — fetches artifact data as raw bytes from the DSC and streams it back; includes `recoverIfDoubleEncoded()` to fix Latin-1/UTF-8 double-encoding corruption
- `GET /ontology` — returns ontology config (only meaningful when `USE_ONTOLOGY=true`)
- `GET /testdata` / `POST /testdata` — dummy echo endpoints for manual testing
- Special case inside `POST /`: when `url == "/connector/address"`, the backend returns its own `connectorUrl` string directly without forwarding to the DSC

Set `DEBUG=true` in `src/backend/.env` to log all outgoing DSC requests and their bodies to the console.

### Directory reference
- `src/backend/` — Express proxy to the DSC (see request flow above); also hosts the built frontend (`dist/`) as static files in production (`Dockerfile` builds the Vue app then runs `npm run backend`).
- `src/components/` — reusable Vue components, organized by feature (`cards/`, `policy/`, `flowchart/`, `fileupload/`, `navigationmenu/`, etc.).
- `src/pages/` — one folder per page/feature area, structure mirrors `PageStructure.js`.
- `src/datamodel/` — IDS JSON-LD ↔ plain-object conversion.
- `src/utils/` — `dataUtils.js` (all DSC API calls + IDS vocabulary/policy constants), `restUtils.js` (HTTP/error-envelope plumbing), `validationUtils.js`, `errorUtils.js`, `math.js`, `svg.js`.
- `src/plugins/` — Vuetify setup.
- `src/theme/` — theme colors.
- `src/styles/` — SCSS variables (currently unused per the dev guide).

### Docker/production notes
The `Dockerfile` builds the Vue app and then, oddly, `sed`s `http://localhost:8083` out of the built JS bundle before starting the backend — this is intentional: in production the backend serves the SPA itself from the same origin, so the frontend should call relative URLs rather than a hardcoded dev host. Keep this in mind if you change how `restUtils.js` constructs the backend URL — a hardcoded absolute `localhost:8083` reference would break under this Docker flow unless the `sed` step is updated to match.

## Contribution conventions (from CONTRIBUTING.md)
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) (`fix`, `feat`, `chore`, `test`, `refactor`, `docs`, `release`; `!` suffix for breaking changes).
- Changes are documented in `CHANGELOG.md` (Keep a Changelog format) and `README.md` where relevant.
- Never commit IDS keystores/certificates (`resources/conf` is gitignored for this reason).
