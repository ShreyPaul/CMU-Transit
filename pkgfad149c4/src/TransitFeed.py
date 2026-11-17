"""TransitFeed — loads the PRT static GTFS network (routes, stops, trips, route geometry)."""
import csv
import io
import re
import time
import urllib.request
import zipfile

GTFS_SOURCE = 'prt-gtfs-static'
UPSERT_CHUNK = 2000
# About 4 m at Pittsburgh's latitude; keeps paths visually exact while cutting most GTFS shape points.
SIMPLIFY_TOLERANCE_DEG = 0.00004
GTFS_MODES = {'0': 'rail', '1': 'rail', '2': 'rail', '3': 'bus', '7': 'incline'}


def loadPrtNetwork(cls):
    started = time.time()
    config = c3.TransitConfig.inst().getConfig()
    archive = _download(config.prtGtfsStaticUrl, config.userAgent)

    routes = {}
    for row in _rows(archive, 'routes.txt'):
        route_id = row['route_id']
        routes[route_id] = c3.TransitRoute.make({
            'id': 'PRT:' + route_id,
            'provider': 'PRT',
            'routeCode': row.get('route_short_name') or route_id,
            'longName': _title(row.get('route_long_name')),
            'description': row.get('route_desc') or None,
            'color': '#' + row['route_color'] if row.get('route_color') else None,
            'externalId': route_id,
            'mode': GTFS_MODES.get(row.get('route_type'), 'bus'),
        })

    trips = []
    trip_route = {}
    shape_use = {}
    shape_first_trip = {}
    for row in _rows(archive, 'trips.txt'):
        route_id = row['route_id']
        if route_id not in routes:
            continue
        trip_route[row['trip_id']] = route_id
        direction = row.get('direction_id') or '0'
        shape_id = row.get('shape_id')
        trips.append({
            'id': 'PRT:' + row['trip_id'],
            'route': {'id': 'PRT:' + route_id},
            'headsign': _title(row.get('trip_headsign')),
            'directionId': int(direction),
            'shapeId': shape_id,
            'serviceId': 'PRT:' + row['service_id'],
        })
        if shape_id:
            shape_first_trip.setdefault(shape_id, row['trip_id'])
            key = (route_id, direction)
            counts = shape_use.setdefault(key, {})
            entry = counts.setdefault(shape_id, [0, row.get('trip_headsign')])
            entry[0] += 1

    # The most-used shape per route and direction is the path drawn on the map.
    chosen = {}
    for (route_id, direction), counts in shape_use.items():
        shape_id, (_, headsign) = max(counts.items(), key=lambda kv: kv[1][0])
        chosen[shape_id] = (route_id, direction, headsign)

    # One scheduled trip per drawn shape supplies the path's stop order and scheduled stop-to-stop times.
    rep_trip_shape = {shape_first_trip[shape_id]: shape_id for shape_id in chosen}
    rep_stop_times = {}
    stop_routes = {}
    trip_span = {}
    with archive.open('stop_times.txt') as raw:
        reader = csv.reader(io.TextIOWrapper(raw, encoding='utf-8-sig'))
        header = next(reader)
        trip_idx = header.index('trip_id')
        stop_idx = header.index('stop_id')
        seq_idx = header.index('stop_sequence')
        arr_idx = header.index('arrival_time')
        dep_idx = header.index('departure_time')
        for rec in reader:
            trip_id = rec[trip_idx]
            route_id = trip_route.get(trip_id)
            if route_id:
                stop_routes.setdefault(rec[stop_idx], set()).add(route_id)
                t = _gtfs_seconds(rec[dep_idx] or rec[arr_idx])
                if t is not None:
                    span = trip_span.get(trip_id)
                    trip_span[trip_id] = (t, t) if span is None else (min(span[0], t), max(span[1], t))
            if trip_id in rep_trip_shape:
                rep_stop_times.setdefault(rep_trip_shape[trip_id], []).append(
                    (int(rec[seq_idx]), rec[stop_idx], _gtfs_seconds(rec[arr_idx] or rec[dep_idx])))

    stops = []
    for row in _rows(archive, 'stops.txt'):
        served = stop_routes.get(row['stop_id'])
        if not served:
            continue
        codes = sorted(routes[r].routeCode for r in served)
        stops.append(c3.TransitStop.make({
            'id': 'PRT:' + row['stop_id'],
            'provider': 'PRT',
            'stopCode': row.get('stop_code') or None,
            'stopName': _title(row['stop_name']),
            'latitude': float(row['stop_lat']),
            'longitude': float(row['stop_lon']),
            'externalId': row['stop_id'],
            'servedRouteCodes': codes,
        }))

    shape_points = {}
    with archive.open('shapes.txt') as raw:
        reader = csv.reader(io.TextIOWrapper(raw, encoding='utf-8-sig'))
        header = next(reader)
        id_idx = header.index('shape_id')
        lat_idx = header.index('shape_pt_lat')
        lon_idx = header.index('shape_pt_lon')
        seq_idx = header.index('shape_pt_sequence')
        for rec in reader:
            if rec[id_idx] in chosen:
                shape_points.setdefault(rec[id_idx], []).append(
                    (int(rec[seq_idx]), float(rec[lat_idx]), float(rec[lon_idx])))

    paths = []
    for shape_id, pts in shape_points.items():
        route_id, direction, headsign = chosen[shape_id]
        pts.sort()
        simplified = _simplify([(p[1], p[2]) for p in pts], SIMPLIFY_TOLERANCE_DEG)
        times = sorted(rep_stop_times.get(shape_id, []))
        offsets = _interpolate([t[2] for t in times])
        paths.append(c3.TransitRoute.Path.make({
            'id': 'PRT:' + shape_id,
            'route': {'id': 'PRT:' + route_id},
            'directionName': 'Inbound' if direction == '1' else 'Outbound',
            'headsign': _title(headsign),
            'encodedPolyline': _encode_polyline(simplified),
            'pointCount': len(simplified),
            'stopSequence': ['PRT:' + t[1] for t in times],
            'stopOffsetsSec': offsets,
        }))

    trip_objs = []
    for t in trips:
        span = trip_span.get(t['id'][4:])
        if span:
            t['startSeconds'], t['endSeconds'] = span
        trip_objs.append(c3.TransitRoute.Trip.make(t))
    calendars = _calendars(archive)

    _upsert(c3.TransitServiceCalendar, calendars)
    _upsert(c3.TransitRoute, list(routes.values()))
    _upsert(c3.TransitStop, stops)
    _upsert(c3.TransitRoute.Path, paths)
    _upsert(c3.TransitRoute.Trip, trip_objs)

    duration_ms = int((time.time() - started) * 1000)
    c3.log().info('Loaded PRT GTFS: {} routes, {} stops, {} paths, {} trips in {} ms'.format(
        len(routes), len(stops), len(paths), len(trips), duration_ms))
    return c3.TransitFeed.LoadResult.make({
        'routes': len(routes),
        'stops': len(stops),
        'paths': len(paths),
        'trips': len(trips),
        'durationMs': duration_ms,
    })


def _download(url, user_agent):
    """Downloads the GTFS zip and records the outcome on its TransitDataSource row; failures are recorded, then raised."""
    started = time.time()
    try:
        req = urllib.request.Request(url, headers={'User-Agent': user_agent})
        with urllib.request.urlopen(req, timeout=300) as rsp:
            data = rsp.read()
        archive = zipfile.ZipFile(io.BytesIO(data))
    except Exception as e:
        c3.TransitDataSource.make({
            'id': GTFS_SOURCE,
            'status': 'ERROR',
            'lastAttemptAt': c3.DateTime.now(),
            'lastError': str(e)[:3900],
        }).merge()
        raise
    now = c3.DateTime.now()
    c3.TransitDataSource.make({
        'id': GTFS_SOURCE,
        'status': 'OK',
        'lastAttemptAt': now,
        'lastSuccessAt': now,
        'lastLatencyMs': int((time.time() - started) * 1000),
        'lastRecordCount': len(archive.namelist()),
        'lastError': None,
    }).merge({'include': 'id, status, lastAttemptAt, lastSuccessAt, lastLatencyMs, lastRecordCount, lastError'})
    return archive


def _calendars(archive):
    """GTFS service calendars with their date exceptions, as TransitServiceCalendar objects."""
    days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    out = {}
    for row in _rows(archive, 'calendar.txt'):
        out[row['service_id']] = {
            'id': 'PRT:' + row['service_id'],
            'provider': 'PRT',
            'weekdays': [i + 1 for i, d in enumerate(days) if row.get(d) == '1'],
            'startDate': _gtfs_date(row['start_date']),
            'endDate': _gtfs_date(row['end_date']),
            'addedDates': [],
            'removedDates': [],
        }
    if 'calendar_dates.txt' in archive.namelist():
        for row in _rows(archive, 'calendar_dates.txt'):
            cal = out.setdefault(row['service_id'], {
                'id': 'PRT:' + row['service_id'], 'provider': 'PRT', 'weekdays': [],
                'addedDates': [], 'removedDates': []})
            key = 'addedDates' if row['exception_type'] == '1' else 'removedDates'
            cal[key].append(_gtfs_date(row['date']))
    return [c3.TransitServiceCalendar.make(c) for c in out.values()]


def _gtfs_date(yyyymmdd):
    return '{}-{}-{}'.format(yyyymmdd[0:4], yyyymmdd[4:6], yyyymmdd[6:8])


def _gtfs_seconds(hhmmss):
    """GTFS times are `H:MM:SS` and may exceed 24:00:00 for trips past midnight; blank means not timed."""
    if not hhmmss:
        return None
    h, m, sec = hhmmss.strip().split(':')
    return int(h) * 3600 + int(m) * 60 + int(sec)


def _interpolate(seconds):
    """Returns offsets from the first timed stop, filling untimed stops linearly between timed neighbours."""
    known = [i for i, v in enumerate(seconds) if v is not None]
    if not known:
        return [0] * len(seconds)
    out = list(seconds)
    for i in range(len(out)):
        if out[i] is not None:
            continue
        prev = max((k for k in known if k < i), default=None)
        nxt = min((k for k in known if k > i), default=None)
        if prev is None:
            out[i] = seconds[nxt]
        elif nxt is None:
            out[i] = seconds[prev]
        else:
            out[i] = seconds[prev] + (seconds[nxt] - seconds[prev]) * (i - prev) // (nxt - prev)
    base = out[0]
    return [v - base for v in out]


def _rows(archive, name):
    with archive.open(name) as raw:
        for row in csv.DictReader(io.TextIOWrapper(raw, encoding='utf-8-sig')):
            yield row


def _upsert(c3_type, objs):
    for i in range(0, len(objs), UPSERT_CHUNK):
        c3_type.upsertBatch(objs[i:i + UPSERT_CHUNK])


def _title(text):
    """PRT publishes names in upper case; title-case them for display while keeping short codes like `CMU` readable."""
    if not text:
        return None
    keep_upper = ('CMU', 'PA', 'US', 'SR', 'UPMC', 'VA', 'PNC', 'PPG', 'II', 'III', 'FS', 'NS')

    def fix(match):
        word = match.group(0)
        return word.upper() if word.upper() in keep_upper else word.capitalize()

    return re.sub(r"[A-Za-z][A-Za-z']*", fix, text).replace(' + ', ' & ')


def _simplify(points, tolerance):
    """Douglas-Peucker simplification on (lat, lon) tuples, iterative to avoid deep recursion."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        ax, ay = points[start]
        bx, by = points[end]
        dx, dy = bx - ax, by - ay
        norm = dx * dx + dy * dy
        best, best_idx = 0.0, -1
        for i in range(start + 1, end):
            px, py = points[i]
            if norm == 0:
                dist = ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / norm))
                dist = ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2) ** 0.5
            if dist > best:
                best, best_idx = dist, i
        if best > tolerance and best_idx > 0:
            keep[best_idx] = True
            stack.append((start, best_idx))
            stack.append((best_idx, end))
    return [p for p, k in zip(points, keep) if k]


def _encode_polyline(points):
    out = []
    prev_lat = prev_lng = 0
    for lat, lng in points:
        ilat, ilng = int(round(lat * 1e5)), int(round(lng * 1e5))
        for value in (ilat - prev_lat, ilng - prev_lng):
            v = ~(value << 1) if value < 0 else value << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lng = ilat, ilng
    return ''.join(out)
