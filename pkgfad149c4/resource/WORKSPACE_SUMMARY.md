# Workspace Summary

Unified CMU transit app (PRT + CMU TripShot shuttles). Built in phases. **Phase 1 is done** (live map, tracking,
routes/stops, arrivals, alerts, data-source health). **Phase 2 mostly done**: address autocomplete, single-ride trip
planning (walk / PRT / CMU shuttle) leaving now or at a chosen time, live + timetable departures, route filter
(next departures on chosen routes), route-only stops for a tracked bus. Not built: transfers (user deferred),
weather/hills/incidents, AI assistant.

## Packages

- `pkgfad149c4` (main; depends on `mcpServer` 8.10). Summaries live in `pkgfad149c4/resource/`.

## External data (verified 2026-11-17 from the C3 server)

- **PRT GTFS-Realtime** (keyless): `https://truetime.rideprt.org/gtfsrt-{bus,train}/{vehicles,trips,alerts}`.
  Append `?debug` to get protobuf **text** format; `TransitFeed.js#parsePbText` parses it (no protobuf lib needed).
- **PRT static GTFS** (keyless, ~20 MB): `https://www.rideprt.org/developerresources/GTFS.zip` (Python loader).
- **TripShot CMU** (keyless public rider endpoints, not a partner API): `/v1/p/route`, `/v1/p/liveStatus`
  (vehicles, vehicleStatuses, rides with stopStatus ETAs and vias), `/v1/navigation/<navigationId>` (street-level
  step polylines). No public alerts endpoint.
- **Autocomplete** merges Allegheny County address points (official ArcGIS, `ADDR_NUM = n AND ST_NAME LIKE 'X%'`,
  only when the query starts with a number), Photon (`photon.komoot.io`, keyless, **intermittent HTTP 503**, retried
  once), and stop names. A failing source is skipped; search throws only if all fail. Nominatim forbids autocomplete.
- TripShot ignores any `date` parameter: shuttle rides are available for **today only**.
- **PRT trip updates predict only ~the next 10–30 stops of each trip**, so the alighting time is often missing; the
  planner then adds the path's scheduled offsets and flags `isArrivalScheduled`.
- Keyless and working: OSM tiles, OSRM foot (routing.openstreetmap.de), Open-Meteo forecast and elevation,
  Google News RSS. **NWS api.weather.gov returns 503 from this server** (edge block).
- **CARTO basemaps return an "API KEY REQUIRED" tile**, so the map uses OSM standard tiles (CSS-inverted in dark mode).
- Need keys (secrets on `TransitConfig`, NOT_CONFIGURED until set): `prtTrueTimeApiKey`, `googleMapsApiKey`,
  `newsApiKey`, `pa511ApiKey`. There is no public radio/traffic-radio API.

## Backend types (`src/`)

- `TransitProvider` enum (PRT, CMU_SHUTTLE). `TransitConfig` (Config+Singleton: URLs, refresh secs, UA, 4 secrets).
- Entities: `TransitRoute` (id `PRT:<route_id>` / `CMU:<uuid>`), `TransitRoute.Path` (encoded polyline,
  `@db(length=-1)`), `TransitRoute.Trip` (PRT headsigns), `TransitStop` (`stopName`, `servedRouteCodes`),
  `TransitVehicle` (latest position per vehicle; `inService`, `reportedAt` vs `fetchedAt`), `TransitServiceAlert`,
  `TransitDataSource` (+ `.Status`, `.Category` enums; `probeUrl`, `credentialField`; optional `probeBody` → POST
  JSON, `probeKeyHeader` → key sent as a header; `checkAll()`). Google uses the **Routes API**
  (`routes.googleapis.com/directions/v2:computeRoutes`, `X-Goog-Api-Key`, `fields=` mask) — legacy Directions /
  Distance Matrix return REQUEST_DENIED. Never put key defaults in `TransitConfig.c3typ`; set via `setSecretValue`.
- `TransitFeed` service: `refreshLive(force)` (throttled by `vehicleRefreshSeconds`; snapshot omits rows with
  `fetchedAt` older than 5 min), `refreshAlerts(force)`, `vehicleDetail(id)`, `stopArrivals(id)`,
  `loadTripShotNetwork()` (JS), `loadPrtNetwork()` (Python `TransitFeed.py`). Value types `TransitFeed.LiveSnapshot`,
  `.VehicleDetail`, `.StopEta`, `.StopArrivals`, `.Arrival`, `.LoadResult`.
- `TransitGeocoder.search(query, limit, nearLatitude, nearLongitude)`: Photon autocomplete (Pittsburgh bbox,
  location bias) followed by stop-name matches.
- `TransitFeed.planTrip(spec: TransitFeed.TripPlan.Spec {from/to lat/lon, departAt?, routeIds?})` →
  `TransitFeed.TripPlan` (`options`, `notes`, `plannedAt`, `departAt`, `servingRoutes`; `.Option` + `.Option.Kind`,
  `.Leg` + `.Leg.Mode`, leg `tripId`). Stops within 900 m of each end; per route, best board→alight pair along
  `TransitRoute.Path.stopSequence`. Departures: PRT live trip updates (read when departAt < now + 90 min) plus PRT
  timetable (trips on the path's shape, `TransitServiceCalendar` for the America/New_York service day and the day
  before, offsets scaled by each trip's running time; live trip ids win), CMU TripShot rides (today only). 3 h
  horizon, 2-min boarding buffer. No routeIds: best departure per route, top 3 PRT + 2 CMU. With routeIds: next 4
  departures per chosen route. Eastern time is computed in JS (`easternDate`, `easternOffsetMs`).
- `TransitRoute.Trip` has `serviceId`, `startSeconds`, `endSeconds`; `TransitServiceCalendar` (id `PRT:<service_id>`:
  weekdays, start/end date, added/removed dates) is loaded by `loadPrtNetwork`.
- C3 collections in Rhino have `forEach`/`filter`/`map` but **not** `some`; copy them into native arrays/objects first.
- `TransitRoute.Path.stopSequence` / `stopOffsetsSec`: ordered stop ids and scheduled offsets (PRT from one
  representative GTFS trip per shape, untimed stops interpolated; CMU from the best ride's vias/stopStatus).
- `TransitFeed.VehicleDetail.path`: path of the vehicle's current trip (PRT trip shape, else route+direction).
- Every pull records the outcome on its `TransitDataSource` row (`pull()` helper in `TransitFeed.js`).
- Persisted strings default to **512 chars**: use `@db(length=...)` for long text.

## Seed / data

- `data/TransitDataSource/TransitDataSource.json`: 17 API rows (upsert with `C3.pkg().upsertAllSeed()`).
- Network data is loaded from feeds, not files: run `TransitFeed.loadPrtNetwork()` (runPy, ~10 s: 101 routes,
  6,354 stops, 194 paths, 15,853 trips) and `TransitFeed.loadTripShotNetwork()` (runJs: 20 routes, 284 stops,
  15 paths). Re-run after service changes (no CronJob yet).

## UI (`ui/react/src/`)

- **Mobile-first pastel design system (2026-11-17 redesign).** Tokens in `styles/app-theme.css` (imported last in
  `globals.css`): Tailwind colors `canvas`, `surface`, `surface-2`, `ink`, `ink-soft`, `line`, `line-strong`, `field`
  (input border, 4:1), `brand`/`brand-strong`/`on-brand`, `focus`, and tint pairs `tint-{sky,lavender,mint,peach,rose}`
  + `-ink` (all AA, light + dark); radii `rounded-card`/`rounded-control`/`rounded-sheet`; `shadow-soft`/`shadow-float`;
  `.app-rise` (150 ms) and `.app-live-dot`. Global `:focus-visible` ring lives in `@layer base` so utilities can override.
- **App kit — use these, not raw `@/components/ui/*`, for new screens:** `components/app/AppButton.tsx` (variants
  primary/secondary/soft/ghost/danger, min 44px, `icon`, `loading`); `components/app/Surface.tsx` (`PageContainer`,
  `PageHeader`, `Card`, `SectionTitle`, `Tag` tones, `Notice` info/success/warning/error with `action`/`onDismiss`,
  `EmptyState`, `LoadingState`, `SkeletonList`, `Disclosure`, `Fact`); `components/app/Controls.tsx` (`SearchInput`
  with text "Clear", `SelectField` native select, `ToggleRow` whole-row switch, `SegmentedControl` radiogroup);
  `components/app/MapSheet.tsx` (`MapSheet`: bottom sheet < lg, side panel ≥ lg, Esc closes, focuses on open;
  `PanelHeader` with labelled Close / "Back"). Rules: text ≥ 16px except `Tag` and bottom-nav labels (14px); every
  icon has a text label; rem units only.
- Shell (`App.tsx` + `components/AppShell/AppShell.tsx`): `SkipLink`, `AppHeader` (brand, desktop NavLinks ≥ md,
  Dark/Light toggle — the only `useTheme` caller), `BottomNav` (< md). SideNav/TopNav were removed.
- Routes (`App.tsx`, lazy): `/` LiveMapPage, `/alerts` AlertsPage, `/sources` DataSourcesPage, `*` NotFound
  EmptyState. Nav in `config/navigation.ts` (labels Map / Alerts / Sources; lucide `Map` imported as `MapIcon`).
- Map page layout: `MapSearchCard.tsx` (first-visit welcome stored in localStorage `cmu-transit.welcome-dismissed`,
  "Where to?" search, Near me, Options, live count + Refresh, delayed-feed line) top on phones / left column ≥ lg with
  the options `Disclosure`; options open in a `MapSheet` on phones. Search card is hidden on phones while a sheet is
  open. `TransitMap` `FlyTo` offsets point targets 30% down on < 1024px so they land above the sheet; stops have an
  invisible 22px-radius `.tv-stop-hit` tap circle; markers have an `::after` tap pad and sr-only titles.
- Data sources page is filterable cards (All / Working / Needs key / Failing) + health-check success notice; the wide
  table is gone. Alerts page: search + campus `ToggleRow`, result count, long descriptions clamp with Show more,
  "All clear" / no-match empty states.
- `api/transit.ts`: all `c3Call` wrappers. `lib/transit.ts`: polyline decode, time/age formatting, `STOP_MIN_ZOOM`.
  `hooks/useLiveVehicles.ts` (15 s poll, pauses when hidden, server clock offset), `hooks/useIsDark.ts`.
- `pages/LiveMap/`: `TransitMap.tsx` (react-leaflet; divIcon markers; trip legs; fit-bounds with panel padding),
  `ControlPanel.tsx` (layer switches with legend swatches, route focus chips + native route select, live-feed and
  about disclosures), `VehiclePanel.tsx` (next stops first, details disclosure; reports its trip path via
  `onPathLoaded`), `StopPanel.tsx` ("Directions to this stop"), `TripPlanPanel.tsx` (From/To, sort tabs, option
  cards, legs, "Track this vehicle", re-plans every 90 s), `transit-map.css` (tokens; bearing via `.tv-rot-0..15`).
- `components/transit/PlaceAutocomplete.tsx`: debounced (300 ms, 3+ chars) combobox, stale-response guard, arrow
  keys/Enter, optional quick choices. The list renders in the design-system `Popover` (anchored, portaled, z-1300)
  so the scrolling side panels cannot clip it. `transit-map.css` lifts `[data-radix-popper-content-wrapper]` to
  z-1300 so Date Picker / Combobox popovers appear above the map overlays (z-1100).
- `TripPlanPanel`: Leave now / Depart at (DatePicker + TimePicker, browser time zone), "Ride a specific route" chips
  from `servingRoutes`. The route choice is the page's `focusedRouteIds`, shared with the left "Focus routes" chips.
- Stop display modes in `LiveMapPage`: `trip` (board/alight stops only), `route` (only stops of the tracked
  vehicle's trip path and focused routes, any zoom), `viewport` (bbox fetch at zoom ≥ 15).
- `components/transit/TransitBits.tsx`: `RouteChip` (color swatch is an SVG `fill` from feed data), `ProviderBadge`,
  `StatusBadge` (Working / Failing / Needs key / Not checked, with icons), `PredictionBadge` (Live vs Scheduled);
  all built on the app `Tag`. `Fact` moved to `components/app/Surface.tsx`.
- `c3Action.ts` and `vite.config.mts` are the canonical skill references. Build needs `VITE_C3_PKG=$MAIN_PKG_NAME`.
- Playwright is not authenticated (API calls 401). UI checks so far replay real backend responses via `page.route`.
  Capture recipe: `runJsOnLiveApp` with a native-array copier (`toJson()` arrays stringify as `{"0":…}`) and return
  `'X' + JSON.stringify(...)` so the tool keeps it a string; split the ~200 KB snapshot into 120-vehicle chunks; install
  with `page.context().route('**/api/8/**', …)`. Use the screenshot tool, not `page.screenshot` (path is off-workspace).
- A `departAt`/`routeIds` scheduled-trip feature exists in the backend (`TransitFeed.TripPlan.Spec`,
  `TransitServiceCalendar`) and `api/transit.ts#planTrip` accepts both, but the UI does not expose them yet.

## Key decisions

- Prefer official keyless feeds (GTFS-RT) over keyed APIs; never show data from an unconfigured or failed source.
- Mark every prediction as Live (vehicle tracking) or Scheduled (timetable).
- Out-of-service vehicles are hidden by default. CMU stops and paths are shown only for shuttle routes running now,
  because the NightSafe on-demand zones have hundreds of virtual stops.
- TripShot `riderCount` is cumulative boardings per ride, not the current load.
- Trip origin defaults to CMU campus (The Cut); switches to "My location" once the user shares it.
- Options without any operator departure prediction are dropped and listed in plan notes rather than guessed.
