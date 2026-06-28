# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

AppMoltures is a collaborative PWA (Progressive Web App) for managing shared-space reservations (barbecue, pool, dining room) among a fixed group of families. It is entirely in Catalan.

## Architecture

This is a **no-build, vanilla JS frontend** backed by **Firebase**. There is no bundler, no transpilation, no npm for the frontend — just static files served directly.

```
index.html          — app shell; loads Firebase compat SDK + Chart.js from CDN, then app.js
app.js              — all frontend logic (~1280 lines, single file)
style.css           — all styles, including dark mode via [data-theme=dark] on <html>
service-worker.js   — cache-first PWA shell (cache name: appmoltures-v12)
manifest.json       — PWA manifest
functions/
  index.js          — single Firebase Cloud Function (calendarEvent, europe-west1)
  package.json      — Node 20, firebase-admin + firebase-functions + googleapis
.github/workflows/
  deploy-functions.yml   — deploys functions/ to Firebase on push to main
  bulk-create-calendar.yml
```

## Key data model

Reservations are stored flat in Firebase RTDB under `reservations/{id}`. Each record:
```js
{
  title, date, timeRange,       // "11:00 - 18:00" or empty for all-day
  family: string[],             // array of family IDs
  spaces: string[],             // ['barbacoa','piscina','menjador']
  adults, children, totalPeople,
  capacityColor,                // 'blue'|'yellow'|'red'|'purple'
  googleEventId,                // set after GCal sync
  createdAt
}
```

Feedback is stored under `feedback/{id}`.

## Frontend architecture (app.js)

- **Global state**: `reservations`, `feedbacks`, `currentView`, `weekOffset`, `monthOffset`, `editingId`, `selectedFamilies` (Set), `selectedSpaces` (Set).
- **Real-time sync**: `startRealtimeSync()` attaches a Firebase `on('value')` listener — all writes go to RTDB first, then UI re-renders via `renderAll()`.
- **Google Calendar sync**: done client-side via Web Crypto API (JWT signing with service account key embedded in app.js). `syncCalendar(action, reservation, googleEventId)` handles create/update/delete. The `googleEventId` is persisted back to RTDB.
- **Views**: `summary` (upcoming events list), `month` (calendar grid), `historic` (stats + table). Switched via `showView()`.
- **Historic view**: includes Chart.js charts (doughnut by family, line by month, doughnut by space). Chart instances are tracked in `_chartInstances` and destroyed before re-render.
- **Modals**: `modalOverlay` (create/edit), `dayDetailOverlay` (day detail), `infoOverlay`, `feedbackOverlay`, `installOverlay`.
- **Capacity color coding**: ≤6 → blue, ≤12 → yellow, ≤25 → red, >25 → purple.

## Firebase Cloud Function (functions/index.js)

The `calendarEvent` HTTPS function is an alternative/server-side path for Google Calendar sync (create/update/delete). It uses the same service account credentials as the client-side JWT approach. It also writes `googleEventId` back to RTDB when creating. Deployed via `firebase deploy --only functions --project appmoltures`.

## Static families and spaces

These are hardcoded arrays in app.js — not fetched from a database:
- **FAMILIES**: 8 entries (`xavier-lourdes`, `josep-mariona`, `anna-roger`, `xavi-maria`, `jordi-helena`, `mire-guido`, `gloria`, `bernat`)
- **SPACES**: `barbacoa`, `piscina`, `menjador`
- **SLOTS**: `dinar`, `sopar` (legacy, still present but new events use free-form `timeRange`)

## Deployment

The frontend is **not deployed via Firebase Hosting** — there is no hosting config in `firebase.json`. Static files are served by whatever hosts the domain. Only functions are deployed via CI.

To deploy functions manually:
```bash
cd functions && npm install
firebase deploy --only functions --project appmoltures
```

The CI workflow (`deploy-functions.yml`) triggers on push to `main` when `functions/**` or `firebase.json` change. It requires a `FIREBASE_TOKEN` secret.

## Service worker cache

The cache name is `appmoltures-v12`. When updating cached assets, bump this version in `service-worker.js` so old caches are invalidated on activate.
