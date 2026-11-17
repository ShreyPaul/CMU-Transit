/*
 * TransitFeed — PRT GTFS-Realtime and CMU TripShot integration.
 *
 * PRT publishes GTFS-Realtime as protobuf; the TrueTime server also serves the protobuf text format when `?debug` is
 * appended, which this file parses with a small text-format reader (no protobuf library is needed in Rhino).
 * TripShot's public rider endpoints (`/v1/p/*`) return JSON.
 */
var log = Logger.for('TransitFeed');

var PRT_VEHICLES_SOURCE = 'prt-gtfsrt-vehicles';
var PRT_TRIPS_SOURCE = 'prt-gtfsrt-trips';
var PRT_ALERTS_SOURCE = 'prt-gtfsrt-alerts';
var CMU_LIVE_SOURCE = 'tripshot-livestatus';
var CMU_ROUTES_SOURCE = 'tripshot-routes';
var LIVE_SOURCE_IDS = [PRT_VEHICLES_SOURCE, CMU_LIVE_SOURCE];

/** Vehicles whose last successful pull is older than this are left out of a snapshot rather than shown as live. */
var MAX_SNAPSHOT_AGE_SECONDS = 300;
/** TripShot GPS fixes older than this are treated as an inactive vehicle. */
var MAX_CMU_FIX_AGE_SECONDS = 900;

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------

function refreshLive(force) {
  var config = TransitConfig.inst().getConfig();
  var sources = sourcesById(LIVE_SOURCE_IDS);
  if (isDue(sources[PRT_VEHICLES_SOURCE], config.vehicleRefreshSeconds, force)) {
    pull(PRT_VEHICLES_SOURCE, refreshPrtVehicles);
  }
  if (isDue(sources[CMU_LIVE_SOURCE], config.vehicleRefreshSeconds, force)) {
    pull(CMU_LIVE_SOURCE, refreshCmuVehicles);
  }
  var cutoff = DateTime.now().minusSeconds(MAX_SNAPSHOT_AGE_SECONDS);
  var vehicles = TransitVehicle.fetch({
    filter: Filter.ge('fetchedAt', cutoff),
    order: 'provider, vehicleLabel',
    limit: 3000,
  }).objs;
  return TransitFeed.LiveSnapshot.make({
    vehicles: vehicles || [],
    sources: TransitDataSource.fetch({ filter: Filter.intersects('id', LIVE_SOURCE_IDS), limit: 10 }).objs || [],
    serverTime: DateTime.now(),
  });
}

function refreshAlerts(force) {
  var config = TransitConfig.inst().getConfig();
  var sources = sourcesById([PRT_ALERTS_SOURCE]);
  if (isDue(sources[PRT_ALERTS_SOURCE], config.alertRefreshSeconds, force)) {
    pull(PRT_ALERTS_SOURCE, refreshPrtAlerts);
  }
  return TransitServiceAlert.fetch({ order: 'provider, headline', limit: 1000 }).objs || [];
}

function vehicleDetail(vehicleId) {
  var vehicle = TransitVehicle.forId(vehicleId);
  if (!vehicle) {
    throw new Error('Vehicle not found: ' + vehicleId);
  }
  var now = DateTime.now();
  if (!vehicle.inService || !vehicle.tripId) {
    return TransitFeed.VehicleDetail.make({
      vehicle: vehicle,
      upcomingStops: [],
      note: 'This vehicle is not assigned to a trip, so the operator publishes no arrival predictions for it.',
      fetchedAt: now,
    });
  }
  var detail = vehicle.provider == TransitProvider.PRT ? prtVehicleDetail(vehicle, now) : cmuVehicleDetail(vehicle, now);
  var path = vehiclePath(vehicle);
  return path ? detail.withPath(path) : detail;
}

/** The path a vehicle's current trip follows: the trip's own GTFS shape, else the route path in its direction. */
function vehiclePath(vehicle) {
  if (!vehicle.route) {
    return null;
  }
  var include = 'id, route.id, directionName, headsign, encodedPolyline, pointCount, stopSequence, stopOffsetsSec';
  var paths = TransitRoute.Path.fetch({ filter: Filter.eq('route.id', vehicle.route.id), include: include, limit: 50 }).objs || [];
  if (!paths.length) {
    return null;
  }
  var wantedId = null;
  if (vehicle.provider == TransitProvider.PRT) {
    var trip = TransitRoute.Trip.forId('PRT:' + vehicle.tripId);
    wantedId = trip && trip.shapeId ? 'PRT:' + trip.shapeId : null;
  } else {
    wantedId = vehicle.route.id + ':' + (vehicle.directionName || 'Loop');
  }
  var byId = paths.filter(function (p) {
    return p.id === wantedId;
  })[0];
  if (byId) {
    return byId;
  }
  var byDirection = paths.filter(function (p) {
    return vehicle.directionName && p.directionName === vehicle.directionName;
  })[0];
  return byDirection || paths[0];
}

function stopArrivals(stopId) {
  var stop = TransitStop.forId(stopId);
  if (!stop) {
    throw new Error('Stop not found: ' + stopId);
  }
  if (stop.provider == TransitProvider.PRT) {
    return prtStopArrivals(stop);
  }
  return cmuStopArrivals(stop);
}

function loadTripShotNetwork() {
  var started = Date.now();
  var base = TransitConfig.inst().getConfig().tripShotBaseUrl;

  var routeRsp = fetchText(base + '/v1/p/route');
  var routeJson = JSON.parse(routeRsp.text);
  recordSuccess(CMU_ROUTES_SOURCE, routeJson.length, routeRsp.latencyMs);

  var routes = routeJson.map(function (r) {
    return TransitRoute.make({
      id: 'CMU:' + r.routeId,
      provider: TransitProvider.CMU_SHUTTLE,
      routeCode: r.shortName || r.name,
      longName: r.publicName || r.name,
      description: r.description,
      color: r.color,
      externalId: r.routeId,
      mode: 'shuttle',
    });
  });
  var routeCodeById = {};
  routes.forEach(function (r) {
    routeCodeById[r.externalId] = r.routeCode;
  });

  var liveRsp = fetchText(base + '/v1/p/liveStatus');
  var live = JSON.parse(liveRsp.text);
  recordSuccess(CMU_LIVE_SOURCE, (live.vehicleStatuses || []).length, liveRsp.latencyMs);

  // The ride with the most vias for each route and direction gives the fullest stop list and path geometry.
  var stops = {};
  var bestRide = {};
  (live.rides || []).forEach(function (ride) {
    var key = ride.routeId + '|' + (ride.direction || '');
    var vias = ride.vias || [];
    if (!bestRide[key] || vias.length > (bestRide[key].vias || []).length) {
      bestRide[key] = ride;
    }
    vias.forEach(function (via) {
      if (!via.ViaStop) {
        return;
      }
      var s = via.ViaStop.stop;
      var entry = stops[s.stopId] || { stop: s, routes: {} };
      entry.routes[routeCodeById[ride.routeId] || ride.routeName] = true;
      stops[s.stopId] = entry;
    });
  });

  var stopObjs = Object.keys(stops).map(function (stopId) {
    var s = stops[stopId].stop;
    return TransitStop.make({
      id: 'CMU:' + stopId,
      provider: TransitProvider.CMU_SHUTTLE,
      stopCode: s.gtfsId,
      stopName: s.name,
      latitude: s.location.lt,
      longitude: s.location.lg,
      externalId: stopId,
      servedRouteCodes: Object.keys(stops[stopId].routes).sort(),
    });
  });

  var pathObjs = [];
  Object.keys(bestRide).forEach(function (key) {
    var ride = bestRide[key];
    var navigationId = ride.effectiveNavigationId || ride.navigationId;
    if (!navigationId) {
      return;
    }
    // TripShot's navigation holds the street-level path the driver follows, as encoded polylines per turn step.
    var nav = JSON.parse(fetchText(base + '/v1/navigation/' + navigationId).text);
    var points = [];
    (nav.legs || []).forEach(function (leg) {
      (leg.steps || []).forEach(function (step) {
        if (step.polyline) {
          points = points.concat(decodePolyline(step.polyline));
        }
      });
    });
    if (points.length < 2) {
      return;
    }
    // Stop order comes from the ride's vias; scheduled times from its stop statuses (keyed by via index).
    var scheduledByVia = {};
    (ride.stopStatus || []).forEach(function (s) {
      var body = s[Object.keys(s)[0]];
      if (body && body.viaIdx != null && body.scheduledDepartureTime) {
        scheduledByVia[body.viaIdx] = DateTime.fromString(body.scheduledDepartureTime).millis;
      }
    });
    var sequence = [];
    var offsets = [];
    var startMs = null;
    var lastMs = null;
    (ride.vias || []).forEach(function (via, idx) {
      if (!via.ViaStop) {
        return;
      }
      var ms = scheduledByVia[idx] != null ? scheduledByVia[idx] : lastMs;
      if (startMs == null && ms != null) {
        startMs = ms;
      }
      lastMs = ms;
      sequence.push('CMU:' + via.ViaStop.stop.stopId);
      offsets.push(ms != null && startMs != null ? Math.round((ms - startMs) / 1000) : 0);
    });
    pathObjs.push(TransitRoute.Path.make({
      id: 'CMU:' + ride.routeId + ':' + (ride.direction || 'Loop'),
      route: { id: 'CMU:' + ride.routeId },
      directionName: ride.direction,
      headsign: lastViaStopName(ride),
      encodedPolyline: encodePolyline(points),
      pointCount: points.length,
      stopSequence: sequence,
      stopOffsetsSec: offsets,
    }));
  });

  // Replace CMU geometry wholesale so routes that lost their navigation do not keep a stale path.
  var oldPaths = TransitRoute.Path.fetch({ filter: Filter.startsWith('id', 'CMU:'), include: 'id', limit: 1000 }).objs || [];
  if (oldPaths.length) {
    TransitRoute.Path.removeBatch(oldPaths);
  }

  TransitRoute.upsertBatch(routes);
  if (stopObjs.length) {
    TransitStop.upsertBatch(stopObjs);
  }
  if (pathObjs.length) {
    TransitRoute.Path.upsertBatch(pathObjs);
  }
  log.info('Loaded TripShot network: {} routes, {} stops, {} paths', routes.length, stopObjs.length, pathObjs.length);
  return TransitFeed.LoadResult.make({
    routes: routes.length,
    stops: stopObjs.length,
    paths: pathObjs.length,
    trips: 0,
    durationMs: Date.now() - started,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// PRT (GTFS-Realtime)
// ---------------------------------------------------------------------------------------------------------------

function refreshPrtVehicles() {
  var base = TransitConfig.inst().getConfig().prtRealtimeBaseUrl;
  var fetchedAt = DateTime.now();
  var raw = [];
  var latencyMs = 0;
  ['/gtfsrt-bus/vehicles?debug', '/gtfsrt-train/vehicles?debug'].forEach(function (path) {
    var rsp = fetchText(base + path);
    latencyMs += rsp.latencyMs;
    (parsePbText(rsp.text).entity || []).forEach(function (entity) {
      var v = first(entity, 'vehicle');
      if (v && first(v, 'position')) {
        raw.push({ v: v, rail: path.indexOf('train') >= 0 });
      }
    });
  });

  var tripIds = [];
  var routeIds = [];
  raw.forEach(function (r) {
    var trip = first(r.v, 'trip');
    if (trip) {
      tripIds.push('PRT:' + first(trip, 'trip_id'));
      routeIds.push('PRT:' + first(trip, 'route_id'));
    }
  });
  var trips = indexById(fetchByIds(TransitRoute.Trip, tripIds, 'id, headsign, directionId'));
  var routes = indexById(fetchByIds(TransitRoute, routeIds, 'id, routeCode, longName, color'));

  var objs = raw.map(function (r) {
    var trip = first(r.v, 'trip');
    var pos = first(r.v, 'position');
    var desc = first(r.v, 'vehicle') || {};
    var vehicleId = String(first(desc, 'id'));
    var routeExternalId = trip ? String(first(trip, 'route_id')) : null;
    var route = routeExternalId ? routes['PRT:' + routeExternalId] : null;
    var tripRow = trip ? trips['PRT:' + first(trip, 'trip_id')] : null;
    var ts = first(r.v, 'timestamp');
    return TransitVehicle.make({
      id: 'PRT:' + vehicleId,
      provider: TransitProvider.PRT,
      vehicleLabel: String(first(desc, 'label') || vehicleId),
      inService: !!trip,
      route: route ? { id: route.id } : null,
      routeCode: route ? route.routeCode : routeExternalId,
      routeName: route ? route.longName : null,
      routeColor: route ? route.color : null,
      destination: tripRow ? tripRow.headsign : null,
      directionName: tripRow && tripRow.directionId != null ? (tripRow.directionId == 1 ? 'Inbound' : 'Outbound') : null,
      tripId: trip ? String(first(trip, 'trip_id')) : null,
      latitude: first(pos, 'latitude'),
      longitude: first(pos, 'longitude'),
      bearing: first(pos, 'bearing'),
      speedMps: first(pos, 'speed'),
      reportedAt: ts ? DateTime.fromMillisUtc(ts * 1000) : null,
      fetchedAt: fetchedAt,
    });
  });

  replaceVehicles(TransitProvider.PRT, objs);
  return objs.length;
}

function prtVehicleDetail(vehicle, now) {
  var base = TransitConfig.inst().getConfig().prtRealtimeBaseUrl;
  var path = vehicle.route && isRailRoute(vehicle.routeCode) ? '/gtfsrt-train/trips?debug' : '/gtfsrt-bus/trips?debug';
  var update = null;
  pull(PRT_TRIPS_SOURCE, function () {
    var rsp = fetchText(base + path);
    var block = entityBlockContaining(rsp.text, 'trip_id: "' + vehicle.tripId + '"');
    update = block ? first(first(parsePbText(block), 'entity'), 'trip_update') : null;
    return update ? 1 : 0;
  });

  var etas = [];
  var nowSec = now.millis / 1000;
  if (update) {
    (update.stop_time_update || []).forEach(function (stu) {
      var etaSec = stopTimeSeconds(stu);
      if (etaSec && etaSec >= nowSec - 30 && !isSkipped(stu)) {
        etas.push({ stopId: 'PRT:' + first(stu, 'stop_id'), etaSec: etaSec });
      }
    });
  }
  etas = etas.slice(0, 12);
  var stops = indexById(fetchByIds(TransitStop, etas.map(function (e) {
    return e.stopId;
  }), 'id, stopName, latitude, longitude'));
  var realtime = !!(update && first(update, 'vehicle'));

  return TransitFeed.VehicleDetail.make({
    vehicle: vehicle,
    upcomingStops: etas.map(function (e) {
      var s = stops[e.stopId];
      return TransitFeed.StopEta.make({
        stopId: s ? s.id : null,
        stopName: s ? s.stopName : e.stopId.substring(4),
        latitude: s ? s.latitude : null,
        longitude: s ? s.longitude : null,
        eta: DateTime.fromMillisUtc(e.etaSec * 1000),
        isRealtime: realtime,
      });
    }),
    predictionSource: 'PRT GTFS-Realtime trip updates',
    note: update ? null : 'PRT is not currently publishing predictions for this trip.',
    fetchedAt: now,
  });
}

function prtStopArrivals(stop) {
  var base = TransitConfig.inst().getConfig().prtRealtimeBaseUrl;
  var now = DateTime.now();
  var nowSec = now.millis / 1000;
  var marker = 'stop_id: "' + stop.externalId + '"';
  var found = [];
  pull(PRT_TRIPS_SOURCE, function () {
    var scanned = 0;
    ['/gtfsrt-bus/trips?debug', '/gtfsrt-train/trips?debug'].forEach(function (path) {
      var text = fetchText(base + path).text;
      var blocks = text.split('\nentity {');
      scanned += blocks.length - 1;
      for (var i = 1; i < blocks.length; i++) {
        if (blocks[i].indexOf(marker) < 0) {
          continue;
        }
        var update = first(first(parsePbText('entity {' + blocks[i]), 'entity'), 'trip_update');
        var stu = (update && update.stop_time_update || []).filter(function (u) {
          return String(first(u, 'stop_id')) === stop.externalId;
        })[0];
        var etaSec = stu ? stopTimeSeconds(stu) : null;
        if (etaSec && etaSec >= nowSec - 60 && etaSec <= nowSec + 3 * 3600 && !isSkipped(stu)) {
          var trip = first(update, 'trip');
          var veh = first(update, 'vehicle');
          found.push({
            tripId: 'PRT:' + first(trip, 'trip_id'),
            routeId: 'PRT:' + first(trip, 'route_id'),
            routeExternalId: String(first(trip, 'route_id')),
            vehicleExternalId: veh ? String(first(veh, 'id')) : null,
            etaSec: etaSec,
          });
        }
      }
    });
    return scanned;
  });

  found.sort(function (a, b) {
    return a.etaSec - b.etaSec;
  });
  found = found.slice(0, 15);
  var trips = indexById(fetchByIds(TransitRoute.Trip, found.map(function (f) {
    return f.tripId;
  }), 'id, headsign'));
  var routes = indexById(fetchByIds(TransitRoute, found.map(function (f) {
    return f.routeId;
  }), 'id, routeCode, longName, color'));

  return TransitFeed.StopArrivals.make({
    stop: stop,
    arrivals: found.map(function (f) {
      var route = routes[f.routeId];
      var trip = trips[f.tripId];
      return TransitFeed.Arrival.make({
        provider: TransitProvider.PRT,
        routeCode: route ? route.routeCode : f.routeExternalId,
        routeName: route ? route.longName : null,
        routeColor: route ? route.color : null,
        destination: trip ? trip.headsign : null,
        vehicleId: f.vehicleExternalId ? 'PRT:' + f.vehicleExternalId : null,
        vehicleLabel: f.vehicleExternalId,
        eta: DateTime.fromMillisUtc(f.etaSec * 1000),
        isRealtime: !!f.vehicleExternalId,
      });
    }),
    predictionSource: 'PRT GTFS-Realtime trip updates',
    note: found.length ? null : 'PRT is not publishing any predictions for this stop in the next 3 hours.',
    fetchedAt: now,
  });
}

function refreshPrtAlerts() {
  var base = TransitConfig.inst().getConfig().prtRealtimeBaseUrl;
  var fetchedAt = DateTime.now();
  var objs = [];
  ['/gtfsrt-bus/alerts?debug', '/gtfsrt-train/alerts?debug'].forEach(function (path) {
    (parsePbText(fetchText(base + path).text).entity || []).forEach(function (entity) {
      var alert = first(entity, 'alert');
      if (!alert) {
        return;
      }
      var routeCodes = {};
      var stopIds = {};
      (alert.informed_entity || []).forEach(function (ie) {
        if (first(ie, 'route_id') != null) {
          routeCodes[String(first(ie, 'route_id'))] = true;
        }
        if (first(ie, 'stop_id') != null) {
          stopIds[String(first(ie, 'stop_id'))] = true;
        }
      });
      var period = first(alert, 'active_period');
      var start = period ? first(period, 'start') : null;
      var end = period ? first(period, 'end') : null;
      var headline = translated(first(alert, 'header_text'));
      objs.push(TransitServiceAlert.make({
        id: 'PRT:' + first(entity, 'id'),
        provider: TransitProvider.PRT,
        headline: headline || String(first(entity, 'id')),
        description: translated(first(alert, 'description_text')),
        cause: first(alert, 'cause'),
        effect: first(alert, 'effect'),
        url: translated(first(alert, 'url')),
        routeCodes: Object.keys(routeCodes).sort(),
        stopIds: Object.keys(stopIds).sort(),
        activeStart: start ? DateTime.fromMillisUtc(start * 1000) : null,
        activeEnd: end ? DateTime.fromMillisUtc(end * 1000) : null,
        fetchedAt: fetchedAt,
      }));
    });
  });

  if (objs.length) {
    TransitServiceAlert.upsertBatch(objs);
  }
  var keep = {};
  objs.forEach(function (o) {
    keep[o.id] = true;
  });
  var stale = [];
  (TransitServiceAlert.fetch({ filter: Filter.eq('provider', TransitProvider.PRT), include: 'id', limit: 3000 }).objs || [])
    .forEach(function (a) {
      if (!keep[a.id]) {
        stale.push(a);
      }
    });
  if (stale.length) {
    TransitServiceAlert.removeBatch(stale);
  }
  return objs.length;
}

/** PRT light rail route codes (Red, Blue, Silver lines) are served from the `/gtfsrt-train` feeds. */
function isRailRoute(routeCode) {
  return ['RED', 'BLUE', 'SLVR', 'BLLB', 'BLSV'].indexOf(String(routeCode).toUpperCase()) >= 0;
}

function stopTimeSeconds(stu) {
  var arrival = first(stu, 'arrival');
  var departure = first(stu, 'departure');
  return (arrival && first(arrival, 'time')) || (departure && first(departure, 'time')) || null;
}

function isSkipped(stu) {
  var rel = first(stu, 'schedule_relationship');
  return rel === 'SKIPPED' || rel === 'NO_DATA';
}

function translated(textNode) {
  if (!textNode) {
    return null;
  }
  var all = textNode.translation || [];
  var en = all.filter(function (t) {
    return first(t, 'language') === 'en';
  })[0] || all[0];
  return en ? first(en, 'text') : null;
}

// ---------------------------------------------------------------------------------------------------------------
// CMU shuttles (TripShot)
// ---------------------------------------------------------------------------------------------------------------

function fetchTripShotLive() {
  var rsp = fetchText(TransitConfig.inst().getConfig().tripShotBaseUrl + '/v1/p/liveStatus');
  return JSON.parse(rsp.text);
}

function rideState(ride) {
  return ride && ride.state ? Object.keys(ride.state)[0] : null;
}

function viaStopNames(ride) {
  var names = {};
  (ride.vias || []).forEach(function (via) {
    if (via.ViaStop) {
      names[via.ViaStop.stop.stopId] = via.ViaStop.stop;
    }
  });
  return names;
}

function lastViaStopName(ride) {
  var name = null;
  (ride.vias || []).forEach(function (via) {
    if (via.ViaStop) {
      name = via.ViaStop.stop.name;
    }
  });
  return name;
}

function refreshCmuVehicles() {
  var live = fetchTripShotLive();
  var fetchedAt = DateTime.now();
  var nowMs = fetchedAt.millis;

  var vehiclesById = {};
  (live.vehicles || []).forEach(function (v) {
    vehiclesById[v.vehicleId] = v;
  });

  // Prefer the ride a vehicle is actively driving; fall back to one the driver has accepted but not started.
  var rideByVehicle = {};
  (live.rides || []).forEach(function (ride) {
    var state = rideState(ride);
    if (!ride.vehicleId || (state !== 'Active' && state !== 'Accepted')) {
      return;
    }
    var prev = rideByVehicle[ride.vehicleId];
    if (!prev || (state === 'Active' && rideState(prev) !== 'Active')) {
      rideByVehicle[ride.vehicleId] = ride;
    }
  });

  var routeIds = Object.keys(rideByVehicle).map(function (vid) {
    return 'CMU:' + rideByVehicle[vid].routeId;
  });
  var routes = indexById(fetchByIds(TransitRoute, routeIds, 'id, routeCode, longName, color'));

  var objs = [];
  (live.vehicleStatuses || []).forEach(function (status) {
    if (!status.location || !status.when) {
      return;
    }
    var reportedAt = DateTime.fromString(status.when);
    if ((nowMs - reportedAt.millis) / 1000 > MAX_CMU_FIX_AGE_SECONDS) {
      return;
    }
    var info = vehiclesById[status.vehicleId] || {};
    var ride = rideByVehicle[status.vehicleId];
    var route = ride ? routes['CMU:' + ride.routeId] : null;
    var next = null;
    if (ride) {
      var stopsById = viaStopNames(ride);
      (ride.stopStatus || []).some(function (s) {
        if (s.Awaiting) {
          next = { name: (stopsById[s.Awaiting.stopId] || {}).name, eta: s.Awaiting.expectedArrivalTime };
          return true;
        }
        return false;
      });
    }
    objs.push(TransitVehicle.make({
      id: 'CMU:' + status.vehicleId,
      provider: TransitProvider.CMU_SHUTTLE,
      vehicleLabel: status.name || info.name || info.shortName || status.vehicleId,
      inService: !!ride,
      route: route ? { id: route.id } : null,
      routeCode: route ? route.routeCode : ride ? ride.routeName : null,
      routeName: route ? route.longName : ride ? ride.routeName : null,
      routeColor: route ? route.color : ride ? ride.color : null,
      destination: ride ? lastViaStopName(ride) : null,
      directionName: ride ? ride.direction : null,
      tripId: ride ? ride.rideId : null,
      latitude: status.location.lt,
      longitude: status.location.lg,
      bearing: status.bearing,
      speedMps: status.speed,
      reportedAt: reportedAt,
      fetchedAt: fetchedAt,
      delaySeconds: ride ? ride.lateBySec : null,
      nextStopName: next ? next.name : null,
      nextStopEta: next && next.eta ? DateTime.fromString(next.eta) : null,
      riderCount: ride ? ride.riderCount : null,
      capacity: (ride && ride.vehicleCapacity) || info.capacity,
    }));
  });

  replaceVehicles(TransitProvider.CMU_SHUTTLE, objs);
  return objs.length;
}

function cmuVehicleDetail(vehicle, now) {
  var ride = null;
  pull(CMU_LIVE_SOURCE, function () {
    var live = fetchTripShotLive();
    ride = (live.rides || []).filter(function (r) {
      return r.rideId === vehicle.tripId;
    })[0];
    return (live.vehicleStatuses || []).length;
  });
  var stopsById = ride ? viaStopNames(ride) : {};
  var realtime = !!(ride && ride.liveDataAvailable && rideState(ride) === 'Active');
  var etas = [];
  (ride && ride.stopStatus || []).forEach(function (s) {
    if (s.Awaiting && s.Awaiting.expectedArrivalTime) {
      var stop = stopsById[s.Awaiting.stopId];
      etas.push(TransitFeed.StopEta.make({
        stopId: 'CMU:' + s.Awaiting.stopId,
        stopName: stop ? stop.name : s.Awaiting.stopId,
        latitude: stop ? stop.location.lt : null,
        longitude: stop ? stop.location.lg : null,
        eta: DateTime.fromString(s.Awaiting.expectedArrivalTime),
        isRealtime: realtime,
      }));
    }
  });
  return TransitFeed.VehicleDetail.make({
    vehicle: vehicle,
    upcomingStops: etas.slice(0, 12),
    predictionSource: 'CMU TripShot live ride status',
    note: ride ? (etas.length ? null : 'This ride has no remaining stops.') : 'TripShot no longer lists this ride.',
    fetchedAt: now,
  });
}

function cmuStopArrivals(stop) {
  var now = DateTime.now();
  var nowMs = now.millis;
  var found = [];
  pull(CMU_LIVE_SOURCE, function () {
    var live = fetchTripShotLive();
    (live.rides || []).forEach(function (ride) {
      var state = rideState(ride);
      if (state !== 'Active' && state !== 'Accepted' && state !== 'Scheduled') {
        return;
      }
      (ride.stopStatus || []).forEach(function (s) {
        if (!s.Awaiting || s.Awaiting.stopId !== stop.externalId || !s.Awaiting.expectedArrivalTime) {
          return;
        }
        var eta = DateTime.fromString(s.Awaiting.expectedArrivalTime);
        var deltaSec = (eta.millis - nowMs) / 1000;
        if (deltaSec >= -60 && deltaSec <= 3 * 3600) {
          found.push({ ride: ride, eta: eta, realtime: !!(ride.liveDataAvailable && state !== 'Scheduled') });
        }
      });
    });
    return (live.vehicleStatuses || []).length;
  });
  found.sort(function (a, b) {
    return a.eta.millis - b.eta.millis;
  });
  found = found.slice(0, 15);
  var routes = indexById(fetchByIds(TransitRoute, found.map(function (f) {
    return 'CMU:' + f.ride.routeId;
  }), 'id, routeCode, longName, color'));

  return TransitFeed.StopArrivals.make({
    stop: stop,
    arrivals: found.map(function (f) {
      var route = routes['CMU:' + f.ride.routeId];
      return TransitFeed.Arrival.make({
        provider: TransitProvider.CMU_SHUTTLE,
        routeCode: route ? route.routeCode : f.ride.routeName,
        routeName: route ? route.longName : f.ride.routeName,
        routeColor: route ? route.color : f.ride.color,
        destination: lastViaStopName(f.ride),
        vehicleId: f.ride.vehicleId ? 'CMU:' + f.ride.vehicleId : null,
        vehicleLabel: f.ride.vehicleName,
        eta: f.eta,
        isRealtime: f.realtime,
      });
    }),
    predictionSource: 'CMU TripShot ride schedule and live status',
    note: found.length ? null : 'No CMU shuttle rides are scheduled to stop here in the next 3 hours.',
    fetchedAt: now,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Trip planning
// ---------------------------------------------------------------------------------------------------------------

var WALK_ROUTER_SOURCE = 'osrm-foot';
/** Straight-line radius searched for boarding and alighting stops. */
var MAX_STOP_WALK_METERS = 900;
/** Walking speed and street-detour factor used when the walking router is unavailable. */
var WALK_SPEED_MPS = 1.3;
var WALK_DETOUR_FACTOR = 1.25;
/** Arrive at the boarding stop this early. */
var BOARDING_BUFFER_SECONDS = 120;
/** Departures further out than this are not offered. */
var DEPARTURE_HORIZON_SECONDS = 3 * 3600;
/** Walking-only option is skipped above this duration. */
var MAX_WALK_ONLY_SECONDS = 2 * 3600;
var MAX_PRT_OPTIONS = 3;
var MAX_CMU_OPTIONS = 2;
/** Departures offered for each route the rider chose. */
var DEPARTURES_PER_CHOSEN_ROUTE = 4;
/** How far ahead PRT trip updates are worth reading. */
var LIVE_WINDOW_SECONDS = 90 * 60;

function planTrip(spec) {
  var now = DateTime.now();
  var nowMs = now.millis;
  var startMs = spec.departAt && spec.departAt.millis > nowMs ? spec.departAt.millis : nowMs;
  var from = { lat: spec.fromLatitude, lon: spec.fromLongitude, name: 'Start' };
  var to = { lat: spec.toLatitude, lon: spec.toLongitude, name: 'Destination' };
  var wanted = null;
  if (spec.routeIds && spec.routeIds.length) {
    wanted = [];
    spec.routeIds.forEach(function (id) {
      wanted.push(String(id));
    });
  }
  var notes = [];
  var walker = makeWalker();
  var options = [];

  var walkAll = walker.leg(from, to);
  if (walkAll.durationSeconds <= MAX_WALK_ONLY_SECONDS) {
    options.push(walkOnlyOption(walkAll, startMs));
  }

  var originStops = stopsNear(from, MAX_STOP_WALK_METERS);
  var destStops = stopsNear(to, MAX_STOP_WALK_METERS);
  if (!originStops.length) {
    notes.push('No PRT or CMU shuttle stop is within ' + MAX_STOP_WALK_METERS + ' m of the start.');
  }
  if (!destStops.length) {
    notes.push('No PRT or CMU shuttle stop is within ' + MAX_STOP_WALK_METERS + ' m of the destination.');
  }

  var all = originStops.length && destStops.length ? rideCandidates(originStops, destStops) : [];
  var servingRoutes = all.map(function (c) {
    return c.route;
  });
  var candidates = all;
  if (wanted) {
    candidates = all.filter(function (c) {
      return wanted.indexOf(c.route.id) >= 0;
    });
    var missing = wanted.filter(function (id) {
      return !all.some(function (c) {
        return c.route.id === id;
      });
    });
    if (missing.length) {
      var names = (TransitRoute.fetch({ filter: Filter.intersects('id', missing), include: 'routeCode', limit: missing.length + 1 }).objs || [])
        .map(function (r) {
          return r.routeCode;
        });
      notes.push((names.length ? names.join(', ') : 'The chosen route') + ' has no stop within ' + MAX_STOP_WALK_METERS +
        ' m of both the start and the destination, so it cannot be used for this trip.');
    }
  }

  var prt = candidates.filter(function (c) {
    return c.route.provider == TransitProvider.PRT;
  });
  var cmu = candidates.filter(function (c) {
    return c.route.provider == TransitProvider.CMU_SHUTTLE;
  });
  prt.forEach(function (c) {
    c.departures = [];
  });
  cmu.forEach(function (c) {
    c.departures = [];
  });
  if (prt.length) {
    if (startMs < nowMs + LIVE_WINDOW_SECONDS * 1000) {
      attachPrtLiveDepartures(prt, startMs);
    }
    attachPrtScheduledDepartures(prt, startMs);
    if (startMs > nowMs + LIVE_WINDOW_SECONDS * 1000) {
      notes.push('PRT times are from the published timetable; live predictions only cover about the next 30 minutes.');
    }
  }
  if (cmu.length) {
    if (easternDate(startMs).key !== easternDate(nowMs).key) {
      notes.push('CMU shuttle times are published only for today, so shuttles are not planned for another day.');
    } else {
      attachCmuDepartures(cmu, startMs);
    }
  }
  prt.concat(cmu).forEach(sortDepartures);

  var withoutDepartures = [];
  var rideOptions = [];
  var perRoute = wanted ? DEPARTURES_PER_CHOSEN_ROUTE : 1;
  [{ list: prt, max: wanted ? prt.length : MAX_PRT_OPTIONS }, { list: cmu, max: wanted ? cmu.length : MAX_CMU_OPTIONS }]
    .forEach(function (group) {
      var timed = [];
      group.list.forEach(function (c) {
        if (c.departures.length) {
          timed.push(c);
        } else {
          withoutDepartures.push(c.route.routeCode);
        }
      });
      timed.sort(function (a, b) {
        return estimatedArrivalMs(a, startMs) - estimatedArrivalMs(b, startMs);
      });
      timed.slice(0, group.max).forEach(function (c) {
        rideOptions = rideOptions.concat(rideOptionsFor(c, from, to, walker, startMs, perRoute));
      });
    });
  if (withoutDepartures.length) {
    notes.push('No departure in the 3 hours after the chosen time for: ' + unique(withoutDepartures).join(', ') + '.');
  }

  attachAlerts(rideOptions);
  options = options.concat(rideOptions);
  options.sort(function (a, b) {
    return a.arriveAt.millis - b.arriveAt.millis;
  });
  if (walker.estimated) {
    notes.push('The walking router is unavailable, so walking times are straight-line estimates.');
  }
  walker.record();

  return TransitFeed.TripPlan.make({
    options: options,
    notes: notes,
    plannedAt: now,
    departAt: DateTime.fromMillisUtc(startMs),
    servingRoutes: servingRoutes,
  });
}

/** Walking legs from the OSRM foot router, falling back to a marked straight-line estimate when it fails. */
function makeWalker() {
  var base = TransitConfig.inst().getConfig().walkRouterBaseUrl;
  var state = { calls: 0, failures: 0, latencyMs: 0, lastError: null, estimated: false };
  state.leg = function (a, b) {
    var straight = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    var legBase = {
      mode: TransitFeed.TripPlan.Leg.Mode.WALK,
      fromName: a.name,
      toName: b.name,
      fromLatitude: a.lat,
      fromLongitude: a.lon,
      toLatitude: b.lat,
      toLongitude: b.lon,
    };
    if (straight < 40) {
      legBase.durationSeconds = Math.round(straight / WALK_SPEED_MPS);
      legBase.distanceMeters = Math.round(straight);
      legBase.encodedPolyline = encodePolyline([[a.lat, a.lon], [b.lat, b.lon]]);
      return legBase;
    }
    if (!state.lastError) {
      var started = Date.now();
      state.calls++;
      try {
        var url = base + '/route/v1/foot/' + a.lon + ',' + a.lat + ';' + b.lon + ',' + b.lat +
          '?overview=full&geometries=polyline';
        var json = JSON.parse(fetchText(url).text);
        state.latencyMs += Date.now() - started;
        if (json.code !== 'Ok' || !json.routes || !json.routes.length) {
          throw new Error('Walking router returned ' + json.code);
        }
        var route = json.routes[0];
        legBase.durationSeconds = Math.round(route.duration);
        legBase.distanceMeters = Math.round(route.distance);
        legBase.encodedPolyline = route.geometry;
        return legBase;
      } catch (e) {
        // One failure switches the rest of the plan to estimates; the outage is recorded on the source row.
        state.failures++;
        state.lastError = e && e.message ? e.message : String(e);
        log.warn('Walking router failed: {}', state.lastError);
      }
    }
    state.estimated = true;
    var meters = straight * WALK_DETOUR_FACTOR;
    legBase.durationSeconds = Math.round(meters / WALK_SPEED_MPS);
    legBase.distanceMeters = Math.round(meters);
    legBase.isEstimated = true;
    legBase.encodedPolyline = encodePolyline([[a.lat, a.lon], [b.lat, b.lon]]);
    return legBase;
  };
  state.record = function () {
    if (!state.calls) {
      return;
    }
    if (state.lastError) {
      TransitDataSource.make({
        id: WALK_ROUTER_SOURCE,
        status: TransitDataSource.Status.ERROR,
        lastAttemptAt: DateTime.now(),
        lastError: state.lastError.substring(0, 3900),
      }).merge();
    } else {
      recordSuccess(WALK_ROUTER_SOURCE, state.calls, Math.round(state.latencyMs / state.calls));
    }
  };
  return state;
}

function walkOnlyOption(leg, startMs) {
  var depart = DateTime.fromMillisUtc(startMs);
  var arrive = DateTime.fromMillisUtc(startMs + leg.durationSeconds * 1000);
  return TransitFeed.TripPlan.Option.make({
    kind: TransitFeed.TripPlan.Option.Kind.WALK,
    summary: 'Walk ' + minutesText(leg.durationSeconds),
    departAt: depart,
    arriveAt: arrive,
    totalSeconds: leg.durationSeconds,
    walkSeconds: leg.durationSeconds,
    walkMeters: leg.distanceMeters,
    waitSeconds: 0,
    transfers: 0,
    legs: [TransitFeed.TripPlan.Leg.make(withTimes(leg, depart, arrive))],
  });
}

function withTimes(leg, depart, arrive) {
  var out = {};
  Object.keys(leg).forEach(function (k) {
    out[k] = leg[k];
  });
  out.departAt = depart;
  out.arriveAt = arrive;
  return out;
}

/** Stops within `radius` meters of a point, nearest first, as `{stop, meters}`. */
function stopsNear(point, radius) {
  var dLat = radius / 111320;
  var dLon = radius / (111320 * Math.cos(point.lat * Math.PI / 180));
  var rows = TransitStop.fetch({
    filter: Filter.ge('latitude', point.lat - dLat).and().le('latitude', point.lat + dLat)
      .and().ge('longitude', point.lon - dLon).and().le('longitude', point.lon + dLon),
    include: 'id, provider, stopName, stopCode, latitude, longitude, externalId, servedRouteCodes',
    limit: 600,
  }).objs || [];
  var out = [];
  rows.forEach(function (s) {
    var m = haversineMeters(point.lat, point.lon, s.latitude, s.longitude);
    if (m <= radius) {
      out.push({ stop: s, meters: m });
    }
  });
  out.sort(function (a, b) {
    return a.meters - b.meters;
  });
  return out;
}

/**
 * For every route that serves both ends, the boarding/alighting stop pair (board before alight along a path) with the
 * smallest estimated walk + scheduled ride time. Returns one candidate per route.
 */
function rideCandidates(originStops, destStops) {
  var originById = {};
  var destById = {};
  var codes = {};
  originStops.forEach(function (o) {
    originById[o.stop.id] = o;
    (o.stop.servedRouteCodes || []).forEach(function (c) {
      codes[o.stop.provider + '|' + c] = 1;
    });
  });
  destStops.forEach(function (d) {
    destById[d.stop.id] = d;
    (d.stop.servedRouteCodes || []).forEach(function (c) {
      var key = d.stop.provider + '|' + c;
      if (codes[key] === 1) {
        codes[key] = 2;
      }
    });
  });

  var routes = [];
  [TransitProvider.PRT, TransitProvider.CMU_SHUTTLE].forEach(function (provider) {
    var shared = Object.keys(codes).filter(function (k) {
      return codes[k] === 2 && k.indexOf(provider + '|') === 0;
    }).map(function (k) {
      return k.substring(provider.length + 1);
    });
    if (shared.length) {
      routes = routes.concat(TransitRoute.fetch({
        filter: Filter.eq('provider', provider).and().intersects('routeCode', shared),
        include: 'id, provider, routeCode, longName, color, externalId, mode',
        limit: shared.length + 5,
      }).objs || []);
    }
  });
  if (!routes.length) {
    return [];
  }
  var routeById = indexById(routes);
  var paths = TransitRoute.Path.fetch({
    filter: Filter.intersects('route.id', Object.keys(routeById)),
    include: 'id, route.id, directionName, headsign, encodedPolyline, stopSequence, stopOffsetsSec',
    limit: 500,
  }).objs || [];

  var best = {};
  paths.forEach(function (path) {
    var seq = path.stopSequence || [];
    var offsets = path.stopOffsetsSec || [];
    var bestBoard = null;
    for (var j = 0; j < seq.length; j++) {
      var d = destById[seq[j]];
      if (d && bestBoard) {
        var rideSec = rideSeconds(offsets, bestBoard.index, j, bestBoard.o.stop, d.stop);
        var estimate = walkSecondsEstimate(bestBoard.o.meters) + rideSec + walkSecondsEstimate(d.meters);
        var routeId = path.route.id;
        if (!best[routeId] || estimate < best[routeId].estimateSec) {
          best[routeId] = {
            route: routeById[routeId],
            path: path,
            boardIndex: bestBoard.index,
            alightIndex: j,
            board: bestBoard.o,
            alight: d,
            rideSec: rideSec,
            estimateSec: estimate,
          };
        }
      }
      var o = originById[seq[j]];
      // Track the boarding stop that minimizes walk minus elapsed schedule time, so a later alight compares fairly.
      if (o) {
        var score = walkSecondsEstimate(o.meters) - (offsets[j] || 0);
        if (!bestBoard || score < bestBoard.score) {
          bestBoard = { o: o, index: j, score: score };
        }
      }
    }
  });
  return Object.keys(best).map(function (k) {
    return best[k];
  });
}

function rideSeconds(offsets, i, j, boardStop, alightStop) {
  var scheduled = (offsets[j] || 0) - (offsets[i] || 0);
  if (scheduled > 0) {
    return scheduled;
  }
  // No usable schedule offsets: assume 15 km/h door-to-door bus speed on the straight line.
  return Math.round(haversineMeters(boardStop.latitude, boardStop.longitude, alightStop.latitude, alightStop.longitude) * 1.3 / 4.2);
}

function walkSecondsEstimate(meters) {
  return Math.round(meters * WALK_DETOUR_FACTOR / WALK_SPEED_MPS);
}

/** Adds live departures (`{boardMs, alightMs, tripId, vehicleLabel, realtime}`) to PRT candidates from trip updates. */
function attachPrtLiveDepartures(candidates, startMs) {
  var base = TransitConfig.inst().getConfig().prtRealtimeBaseUrl;
  var byRouteExternal = {};
  var needsRail = false;
  candidates.forEach(function (c) {
    (byRouteExternal[c.route.externalId] = byRouteExternal[c.route.externalId] || []).push(c);
    if (c.route.mode === 'rail') {
      needsRail = true;
    }
  });
  var feeds = ['/gtfsrt-bus/trips?debug'];
  if (needsRail) {
    feeds.push('/gtfsrt-train/trips?debug');
  }
  pull(PRT_TRIPS_SOURCE, function () {
    var scanned = 0;
    feeds.forEach(function (feedPath) {
      var blocks = fetchText(base + feedPath).text.split('\nentity {');
      scanned += blocks.length - 1;
      for (var b = 1; b < blocks.length; b++) {
        var m = /route_id: "([^"]*)"/.exec(blocks[b]);
        var list = m ? byRouteExternal[m[1]] : null;
        if (!list) {
          continue;
        }
        var update = first(first(parsePbText('entity {' + blocks[b]), 'entity'), 'trip_update');
        if (!update) {
          continue;
        }
        var trip = first(update, 'trip');
        var veh = first(update, 'vehicle');
        var times = {};
        (update.stop_time_update || []).forEach(function (stu) {
          if (!isSkipped(stu)) {
            times['PRT:' + first(stu, 'stop_id')] = stopTimeSeconds(stu);
          }
        });
        list.forEach(function (c) {
          var boardSec = times[c.board.stop.id];
          var alightSec = times[c.alight.stop.id];
          if (!boardSec || boardSec * 1000 < startMs || boardSec * 1000 > startMs + DEPARTURE_HORIZON_SECONDS * 1000) {
            return;
          }
          // PRT predicts only the next stops of each trip; past that window, add the scheduled ride time.
          var predictedAlight = alightSec && alightSec > boardSec;
          c.departures.push({
            boardMs: boardSec * 1000,
            alightMs: predictedAlight ? alightSec * 1000 : (boardSec + c.rideSec) * 1000,
            tripId: trip ? String(first(trip, 'trip_id')) : null,
            vehicleLabel: veh ? String(first(veh, 'id')) : null,
            realtime: !!veh,
            arrivalScheduled: !predictedAlight,
          });
        });
      }
    });
    return scanned;
  });
}

/**
 * Adds timetable departures to PRT candidates: trips on the candidate path's GTFS shape that run on the service day
 * of `startMs` (or the day before, for trips past midnight). Stop times are the path's scheduled offsets scaled to
 * each trip's own running time. Trips already covered by a live prediction are skipped.
 */
function attachPrtScheduledDepartures(candidates, startMs) {
  var calendars = indexById(TransitServiceCalendar.fetch({ filter: Filter.eq('provider', TransitProvider.PRT), limit: 500 }).objs || []);
  var today = easternDate(startMs);
  var serviceDays = [easternDate(startMs - 86400000), today];
  candidates.forEach(function (c) {
    var shapeId = c.path.id.indexOf('PRT:') === 0 ? c.path.id.substring(4) : null;
    var offsets = c.path.stopOffsetsSec || [];
    var patternSec = offsets.length ? offsets[offsets.length - 1] : 0;
    if (!shapeId || !patternSec) {
      return;
    }
    var live = {};
    c.departures.forEach(function (d) {
      if (d.tripId) {
        live[d.tripId] = true;
      }
    });
    var trips = TransitRoute.Trip.fetch({
      filter: Filter.eq('route.id', c.route.id).and().eq('shapeId', shapeId),
      include: 'id, serviceId, startSeconds, endSeconds',
      limit: 3000,
    }).objs || [];
    serviceDays.forEach(function (day) {
      trips.forEach(function (t) {
        var tripId = t.id.substring(4);
        if (live[tripId] || t.startSeconds == null || !serviceRuns(calendars[t.serviceId], day)) {
          return;
        }
        var scale = t.endSeconds > t.startSeconds ? (t.endSeconds - t.startSeconds) / patternSec : 1;
        var boardMs = day.midnightUtcMs + (t.startSeconds + (offsets[c.boardIndex] || 0) * scale) * 1000;
        var alightMs = day.midnightUtcMs + (t.startSeconds + (offsets[c.alightIndex] || 0) * scale) * 1000;
        if (boardMs >= startMs && boardMs <= startMs + DEPARTURE_HORIZON_SECONDS * 1000) {
          c.departures.push({
            boardMs: Math.round(boardMs),
            alightMs: Math.round(alightMs),
            tripId: tripId,
            vehicleLabel: null,
            realtime: false,
            arrivalScheduled: false,
          });
        }
      });
    });
  });
}

function serviceRuns(calendar, day) {
  if (!calendar) {
    return false;
  }
  // Calendar fields are C3 collections; copy them into plain lookups (they have forEach, not some/indexOf).
  var keys = function (list) {
    var out = {};
    (list || []).forEach(function (v) {
      out[String(v).substring(0, 10)] = true;
    });
    return out;
  };
  if (keys(calendar.removedDates)[day.key]) {
    return false;
  }
  if (keys(calendar.addedDates)[day.key]) {
    return true;
  }
  var runsOnWeekday = false;
  (calendar.weekdays || []).forEach(function (w) {
    if (w == day.isoWeekday) {
      runsOnWeekday = true;
    }
  });
  return runsOnWeekday &&
    (!calendar.startDate || String(calendar.startDate).substring(0, 10) <= day.key) &&
    (!calendar.endDate || String(calendar.endDate).substring(0, 10) >= day.key);
}

/**
 * The America/New_York calendar date containing `utcMs`, with its ISO weekday and the UTC instant of its local
 * midnight. US rules: daylight time from the second Sunday of March 2:00 to the first Sunday of November 2:00.
 */
function easternDate(utcMs) {
  var local = new Date(utcMs + easternOffsetMs(utcMs));
  var y = local.getUTCFullYear();
  var m = local.getUTCMonth();
  var d = local.getUTCDate();
  var midnightGuess = Date.UTC(y, m, d) - easternOffsetMs(Date.UTC(y, m, d) + 5 * 3600000);
  var pad = function (n) {
    return (n < 10 ? '0' : '') + n;
  };
  var dow = local.getUTCDay();
  return { key: y + '-' + pad(m + 1) + '-' + pad(d), isoWeekday: dow === 0 ? 7 : dow, midnightUtcMs: midnightGuess };
}

function easternOffsetMs(utcMs) {
  var y = new Date(utcMs).getUTCFullYear();
  var nthSunday = function (month, n) {
    var firstDow = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return Date.UTC(y, month, 1 + ((7 - firstDow) % 7) + (n - 1) * 7);
  };
  var dstStart = nthSunday(2, 2) + 7 * 3600000;
  var dstEnd = nthSunday(10, 1) + 6 * 3600000;
  return utcMs >= dstStart && utcMs < dstEnd ? -4 * 3600000 : -5 * 3600000;
}

/** Adds departures to CMU shuttle candidates from TripShot's ride list for today (live or scheduled). */
function attachCmuDepartures(candidates, startMs) {
  var byRoute = {};
  candidates.forEach(function (c) {
    (byRoute[c.route.externalId] = byRoute[c.route.externalId] || []).push(c);
  });
  pull(CMU_LIVE_SOURCE, function () {
    var live = fetchTripShotLive();
    (live.rides || []).forEach(function (ride) {
      var list = byRoute[ride.routeId];
      var state = rideState(ride);
      if (!list || (state !== 'Active' && state !== 'Accepted' && state !== 'Scheduled')) {
        return;
      }
      list.forEach(function (c) {
        var boardMs = null;
        var alightMs = null;
        (ride.stopStatus || []).forEach(function (s) {
          if (!s.Awaiting || !s.Awaiting.expectedArrivalTime) {
            return;
          }
          var t = DateTime.fromString(s.Awaiting.expectedArrivalTime).millis;
          if (boardMs == null && 'CMU:' + s.Awaiting.stopId === c.board.stop.id && t >= startMs) {
            boardMs = t;
          } else if (boardMs != null && alightMs == null && 'CMU:' + s.Awaiting.stopId === c.alight.stop.id) {
            alightMs = t;
          }
        });
        if (boardMs != null && alightMs != null && boardMs <= startMs + DEPARTURE_HORIZON_SECONDS * 1000) {
          c.departures.push({
            boardMs: boardMs,
            alightMs: alightMs,
            tripId: ride.rideId,
            vehicleLabel: ride.vehicleName,
            realtime: !!(ride.liveDataAvailable && state !== 'Scheduled'),
          });
        }
      });
    });
    return (live.vehicleStatuses || []).length;
  });
}

function sortDepartures(c) {
  c.departures.sort(function (a, b) {
    return a.boardMs - b.boardMs;
  });
}

/** Arrival estimate used to rank candidates before the walking legs are routed. */
function estimatedArrivalMs(c, startMs) {
  var earliestBoard = startMs + walkSecondsEstimate(c.board.meters) * 1000;
  var dep = c.departures.filter(function (d) {
    return d.boardMs >= earliestBoard;
  })[0] || c.departures[c.departures.length - 1];
  return dep.alightMs + walkSecondsEstimate(c.alight.meters) * 1000;
}

/** Builds up to `count` walk + ride + walk options for a candidate, from the first departures the rider can reach. */
function rideOptionsFor(c, from, to, walker, startMs, count) {
  var boardPoint = { lat: c.board.stop.latitude, lon: c.board.stop.longitude, name: c.board.stop.stopName };
  var alightPoint = { lat: c.alight.stop.latitude, lon: c.alight.stop.longitude, name: c.alight.stop.stopName };
  var access = walker.leg(from, boardPoint);
  var egress = walker.leg(alightPoint, to);
  // The boarding buffer is a preference; a departure reachable without it is still offered.
  var reachable = c.departures.filter(function (d) {
    return d.boardMs >= startMs + access.durationSeconds * 1000;
  });
  var ridePolyline = slicePath(c.path.encodedPolyline, c.board.stop, c.alight.stop);
  return reachable.slice(0, count).map(function (dep) {
    return rideOption(c, dep, access, egress, ridePolyline, startMs);
  });
}

function rideOption(c, dep, access, egress, ridePolyline, startMs) {
  var leaveMs = Math.max(startMs, dep.boardMs - (access.durationSeconds + BOARDING_BUFFER_SECONDS) * 1000);
  var atStopMs = leaveMs + access.durationSeconds * 1000;
  var arriveMs = dep.alightMs + egress.durationSeconds * 1000;
  var isCmu = c.route.provider == TransitProvider.CMU_SHUTTLE;
  var mode = isCmu ? TransitFeed.TripPlan.Leg.Mode.SHUTTLE
    : c.route.mode === 'rail' ? TransitFeed.TripPlan.Leg.Mode.RAIL : TransitFeed.TripPlan.Leg.Mode.BUS;

  var ride = TransitFeed.TripPlan.Leg.make({
    mode: mode,
    fromName: c.board.stop.stopName,
    toName: c.alight.stop.stopName,
    fromLatitude: c.board.stop.latitude,
    fromLongitude: c.board.stop.longitude,
    toLatitude: c.alight.stop.latitude,
    toLongitude: c.alight.stop.longitude,
    departAt: DateTime.fromMillisUtc(dep.boardMs),
    arriveAt: DateTime.fromMillisUtc(dep.alightMs),
    durationSeconds: Math.round((dep.alightMs - dep.boardMs) / 1000),
    route: { id: c.route.id },
    routeCode: c.route.routeCode,
    routeColor: c.route.color,
    headsign: c.path.headsign,
    boardStop: { id: c.board.stop.id },
    alightStop: { id: c.alight.stop.id },
    stopCount: c.alightIndex - c.boardIndex,
    tripId: dep.tripId,
    vehicleLabel: dep.vehicleLabel,
    isRealtime: dep.realtime,
    isArrivalScheduled: !!dep.arrivalScheduled,
    encodedPolyline: ridePolyline,
  });
  return TransitFeed.TripPlan.Option.make({
    kind: isCmu ? TransitFeed.TripPlan.Option.Kind.CMU_SHUTTLE : TransitFeed.TripPlan.Option.Kind.PRT,
    summary: 'Walk ' + minutesText(access.durationSeconds) + ' · ' + c.route.routeCode + ' · Walk ' +
      minutesText(egress.durationSeconds),
    departAt: DateTime.fromMillisUtc(leaveMs),
    arriveAt: DateTime.fromMillisUtc(arriveMs),
    totalSeconds: Math.round((arriveMs - leaveMs) / 1000),
    walkSeconds: access.durationSeconds + egress.durationSeconds,
    walkMeters: access.distanceMeters + egress.distanceMeters,
    waitSeconds: Math.round((dep.boardMs - atStopMs) / 1000),
    transfers: 0,
    isRealtime: dep.realtime,
    legs: [
      TransitFeed.TripPlan.Leg.make(withTimes(access, DateTime.fromMillisUtc(leaveMs), DateTime.fromMillisUtc(atStopMs))),
      ride,
      TransitFeed.TripPlan.Leg.make(withTimes(egress, DateTime.fromMillisUtc(dep.alightMs), DateTime.fromMillisUtc(arriveMs))),
    ],
  });
}

/** Attaches the active service alerts that list each option's route. */
function attachAlerts(options) {
  if (!options.length) {
    return;
  }
  var alerts = TransitServiceAlert.fetch({ limit: 1000 }).objs || [];
  for (var i = 0; i < options.length; i++) {
    var ride = options[i].legs[1];
    var matching = alerts.filter(function (a) {
      return (a.routeCodes || []).indexOf(ride.routeCode) >= 0;
    });
    if (matching.length) {
      options[i] = options[i].withAlerts(matching);
    }
  }
}

/** The part of a route path between the vertices nearest the boarding and alighting stops. */
function slicePath(encoded, boardStop, alightStop) {
  var points = decodePolyline(encoded);
  if (points.length < 2) {
    return encodePolyline([[boardStop.latitude, boardStop.longitude], [alightStop.latitude, alightStop.longitude]]);
  }
  var nearest = function (stop, startIdx) {
    var bestIdx = startIdx;
    var bestDist = Infinity;
    for (var i = startIdx; i < points.length; i++) {
      var d = haversineMeters(stop.latitude, stop.longitude, points[i][0], points[i][1]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  };
  var start = nearest(boardStop, 0);
  var end = nearest(alightStop, start);
  var slice = points.slice(start, end + 1);
  slice.unshift([boardStop.latitude, boardStop.longitude]);
  slice.push([alightStop.latitude, alightStop.longitude]);
  return encodePolyline(slice);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  var r = 6371000;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

function minutesText(seconds) {
  return Math.max(1, Math.round(seconds / 60)) + ' min';
}

function unique(values) {
  var seen = {};
  return values.filter(function (v) {
    if (seen[v]) {
      return false;
    }
    seen[v] = true;
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Route trip lists (every trip of the focused routes in the next few hours) and per-trip timetables
// ---------------------------------------------------------------------------------------------------------------

var MAX_ROUTE_TRIP_ROUTES = 10;
var DEFAULT_TRIP_HORIZON_MINUTES = 180;
var MAX_TRIP_HORIZON_MINUTES = 360;
/** A trip whose last stop is this far in the past is no longer listed. */
var TRIP_GRACE_MS = 60 * 1000;

function routeTrips(routeIds, horizonMinutes) {
  var now = DateTime.now();
  var nowMs = now.millis;
  var horizon = horizonMinutes > 0 ? Math.min(horizonMinutes, MAX_TRIP_HORIZON_MINUTES) : DEFAULT_TRIP_HORIZON_MINUTES;
  var windowEndMs = nowMs + horizon * 60000;
  var ids = [];
  (routeIds || []).forEach(function (id) {
    if (id && ids.indexOf(String(id)) < 0) {
      ids.push(String(id));
    }
  });
  if (ids.length > MAX_ROUTE_TRIP_ROUTES) {
    throw new Error('Pick at most ' + MAX_ROUTE_TRIP_ROUTES + ' routes to list trips for.');
  }
  var routes = ids.length ? toArray(TransitRoute.fetch({
    filter: Filter.intersects('id', ids),
    include: 'id, provider, routeCode, longName, color, externalId, mode',
    limit: ids.length + 1,
  }).objs) : [];

  var notes = [];
  var prt = [];
  var cmu = [];
  routes.forEach(function (r) {
    (r.provider == TransitProvider.PRT ? prt : cmu).push(r);
  });
  var trips = [];
  if (prt.length) {
    trips = trips.concat(prtRouteTrips(prt, nowMs, windowEndMs, notes));
  }
  if (cmu.length) {
    trips = trips.concat(cmuRouteTrips(cmu, nowMs, windowEndMs, notes));
  }
  trips.sort(function (a, b) {
    return a.startMs - b.startMs;
  });
  routes.forEach(function (r) {
    var any = trips.some(function (t) {
      return t.routeId === r.id;
    });
    if (!any) {
      notes.push(r.routeCode + ' has no trips running now or starting in the next ' + hoursText(horizon) + '.');
    }
  });
  ids.forEach(function (id) {
    var known = routes.some(function (r) {
      return r.id === id;
    });
    if (!known) {
      notes.push('Route ' + id + ' is not in the loaded network.');
    }
  });

  return TransitFeed.RouteTrips.make({
    trips: trips.map(toRouteTrip),
    windowStart: now,
    windowEnd: DateTime.fromMillisUtc(windowEndMs),
    notes: notes,
    fetchedAt: DateTime.now(),
  });
}

function tripTimetable(routeId, tripId, serviceDate) {
  var route = TransitRoute.forId(routeId);
  if (!route) {
    throw new Error('Route not found: ' + routeId);
  }
  if (route.provider == TransitProvider.PRT) {
    return prtTripTimetable(route, tripId, serviceDate);
  }
  return cmuTripTimetable(route, tripId);
}

function hoursText(minutes) {
  return minutes % 60 === 0 ? minutes / 60 + (minutes === 60 ? ' hour' : ' hours') : minutes + ' minutes';
}

/** Copies a C3 collection (or JS array) into a plain JS array. */
function toArray(list) {
  var out = [];
  (list || []).forEach(function (v) {
    out.push(v);
  });
  return out;
}

/** The service day for a `YYYY-MM-DD` key, via its local noon (well clear of any DST change). */
function easternDateFromKey(key) {
  var parts = String(key).split('-');
  return easternDate(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 17, 0, 0));
}

function toRouteTrip(t) {
  return TransitFeed.RouteTrip.make({
    provider: t.provider,
    routeId: t.routeId,
    routeCode: t.routeCode,
    routeColor: t.routeColor,
    tripId: t.tripId,
    serviceDate: t.serviceDate,
    headsign: t.headsign,
    directionName: t.directionName,
    status: t.running ? TransitFeed.RouteTrip.Status.RUNNING : TransitFeed.RouteTrip.Status.UPCOMING,
    startAt: DateTime.fromMillisUtc(Math.round(t.startMs)),
    endAt: DateTime.fromMillisUtc(Math.round(t.endMs)),
    firstStopName: t.firstStopName,
    lastStopName: t.lastStopName,
    stopCount: t.stopCount,
    isRealtime: !!t.realtime,
    vehicleId: t.vehicleId,
    vehicleLabel: t.vehicleLabel,
    delaySeconds: t.delaySeconds,
    nextStopName: t.nextStopName,
    nextStopAt: t.nextStopMs != null ? DateTime.fromMillisUtc(Math.round(t.nextStopMs)) : null,
  });
}

function toTimetableStop(s) {
  return TransitFeed.TripTimetable.Stop.make({
    stopId: s.stopId,
    stopName: s.stopName || 'Unnamed stop',
    latitude: s.latitude,
    longitude: s.longitude,
    scheduledAt: s.scheduledMs != null ? DateTime.fromMillisUtc(Math.round(s.scheduledMs)) : null,
    expectedAt: s.expectedMs != null ? DateTime.fromMillisUtc(Math.round(s.expectedMs)) : null,
    isRealtime: !!s.realtime,
    passed: !!s.passed,
    skipped: !!s.skipped,
  });
}

// --- PRT ---------------------------------------------------------------------------------------------------------

/**
 * Stop patterns for PRT routes: each GTFS shape that has a stored {@link TransitRoute.Path}, plus the main path of each
 * direction for trips whose shape variant has none.
 */
function prtPatterns(routeIds, tripRows) {
  var paths = TransitRoute.Path.fetch({
    filter: Filter.intersects('route.id', routeIds),
    include: 'id, route.id, directionName, headsign, stopSequence, stopOffsetsSec',
    limit: 400,
  }).objs || [];
  var byId = {};
  paths.forEach(function (p) {
    byId[p.id] = {
      id: p.id,
      directionName: p.directionName,
      headsign: p.headsign,
      stops: toArray(p.stopSequence),
      offsets: toArray(p.stopOffsetsSec),
    };
  });
  var tripsPerShape = {};
  tripRows.forEach(function (t) {
    if (t.shapeId) {
      tripsPerShape[t.shapeId] = (tripsPerShape[t.shapeId] || 0) + 1;
    }
  });
  var byDirection = {};
  tripRows.forEach(function (t) {
    var p = byId['PRT:' + t.shapeId];
    var key = t.route.id + '|' + t.directionId;
    if (p && (!byDirection[key] || tripsPerShape[t.shapeId] > tripsPerShape[byDirection[key].id.substring(4)])) {
      byDirection[key] = p;
    }
  });
  return {
    forTrip: function (t) {
      var exact = byId['PRT:' + t.shapeId];
      if (exact) {
        return { pattern: exact, exact: true };
      }
      var fallback = byDirection[t.route.id + '|' + t.directionId];
      return fallback ? { pattern: fallback, exact: false } : null;
    },
  };
}

/** Scheduled time (ms) at each stop of `pattern` for a trip, scaling the pattern's offsets to the trip's run time. */
function prtScheduledTimes(row, day, pattern) {
  var startMs = day.midnightUtcMs + row.startSeconds * 1000;
  var offsets = pattern ? pattern.offsets : [];
  var patternSec = offsets.length ? offsets[offsets.length - 1] : 0;
  var scale = patternSec > 0 && row.endSeconds > row.startSeconds ? (row.endSeconds - row.startSeconds) / patternSec : 1;
  return offsets.map(function (o) {
    return startMs + (o || 0) * scale * 1000;
  });
}

/** Live trip updates for the given PRT routes, keyed by GTFS trip id. */
function prtLiveTrips(routes, notes) {
  var base = TransitConfig.inst().getConfig().prtRealtimeBaseUrl;
  var wanted = {};
  var needsRail = false;
  var needsBus = false;
  routes.forEach(function (r) {
    wanted[r.externalId] = true;
    if (r.mode === 'rail' || isRailRoute(r.routeCode)) {
      needsRail = true;
    } else {
      needsBus = true;
    }
  });
  var feeds = [];
  if (needsBus) {
    feeds.push('/gtfsrt-bus/trips?debug');
  }
  if (needsRail) {
    feeds.push('/gtfsrt-train/trips?debug');
  }
  var live = {};
  var ok = pull(PRT_TRIPS_SOURCE, function () {
    var scanned = 0;
    feeds.forEach(function (feedPath) {
      var blocks = fetchText(base + feedPath).text.split('\nentity {');
      scanned += blocks.length - 1;
      for (var b = 1; b < blocks.length; b++) {
        var m = /route_id: "([^"]*)"/.exec(blocks[b]);
        if (!m || !wanted[m[1]]) {
          continue;
        }
        var entry = parsePrtLiveTrip('entity {' + blocks[b]);
        if (entry) {
          live[entry.tripId] = entry;
        }
      }
    });
    return scanned;
  });
  if (!ok) {
    notes.push('PRT live predictions could not be read, so PRT times are from the timetable only.');
  }
  return live;
}

/** Parses one GTFS-Realtime `entity { trip_update { ... } }` block into `{tripId, vehicleId, times, skipped, order}`. */
function parsePrtLiveTrip(blockText) {
  var update = first(first(parsePbText(blockText), 'entity'), 'trip_update');
  var trip = update ? first(update, 'trip') : null;
  if (!trip) {
    return null;
  }
  var veh = first(update, 'vehicle');
  var times = {};
  var skipped = {};
  var order = [];
  (update.stop_time_update || []).forEach(function (stu) {
    var stopId = 'PRT:' + first(stu, 'stop_id');
    if (isSkipped(stu)) {
      skipped[stopId] = true;
      return;
    }
    var sec = stopTimeSeconds(stu);
    if (sec) {
      times[stopId] = sec * 1000;
      order.push(stopId);
    }
  });
  return {
    tripId: String(first(trip, 'trip_id')),
    vehicleId: veh ? String(first(veh, 'id')) : null,
    times: times,
    skipped: skipped,
    order: order,
  };
}

/**
 * Builds the trip summary (plain object) for one PRT trip on one service day, overlaying `live` predictions when the
 * trip is tracked. Stop names are filled in afterwards by {@link attachStopNames}.
 */
function prtTrip(route, row, day, match, live, nowMs) {
  var pattern = match ? match.pattern : null;
  var stops = pattern ? pattern.stops : live ? live.order : [];
  var sched = pattern ? prtScheduledTimes(row, day, pattern) : [];
  var schedStart = day.midnightUtcMs + row.startSeconds * 1000;
  var schedEnd = day.midnightUtcMs + (row.endSeconds != null ? row.endSeconds : row.startSeconds) * 1000;

  var t = {
    provider: TransitProvider.PRT,
    routeId: route.id,
    routeCode: route.routeCode,
    routeColor: route.color,
    tripId: row.id.substring(4),
    serviceDate: day.key,
    headsign: row.headsign || (pattern ? pattern.headsign : null),
    directionName: pattern ? pattern.directionName : null,
    startMs: schedStart,
    endMs: schedEnd,
    firstStopId: stops.length ? stops[0] : null,
    lastStopId: stops.length ? stops[stops.length - 1] : null,
    stopCount: stops.length || null,
    realtime: false,
    vehicleId: null,
    vehicleLabel: null,
    delaySeconds: null,
    nextStopId: null,
    nextStopMs: null,
    running: false,
    exactPattern: !!(match && match.exact),
    stops: stops,
    scheduled: sched,
  };

  if (live) {
    t.realtime = !!live.vehicleId;
    t.vehicleId = live.vehicleId ? 'PRT:' + live.vehicleId : null;
    t.vehicleLabel = live.vehicleId;
    var firstPredicted = -1;
    for (var i = 0; i < stops.length; i++) {
      if (live.times[stops[i]] != null) {
        firstPredicted = i;
        break;
      }
    }
    if (firstPredicted >= 0 && sched.length) {
      t.delaySeconds = Math.round((live.times[stops[firstPredicted]] - sched[firstPredicted]) / 1000);
    }
    if (firstPredicted === 0) {
      t.startMs = live.times[stops[0]];
    }
    var lastStop = stops.length ? stops[stops.length - 1] : null;
    if (lastStop && live.times[lastStop] != null) {
      t.endMs = live.times[lastStop];
    } else if (t.delaySeconds != null) {
      t.endMs = schedEnd + t.delaySeconds * 1000;
    }
    t.running = firstPredicted > 0 || t.startMs <= nowMs;
    for (var j = 0; j < stops.length; j++) {
      var at = live.times[stops[j]];
      if (at != null && at >= nowMs - 30000) {
        t.nextStopId = stops[j];
        t.nextStopMs = at;
        break;
      }
    }
  } else {
    t.running = schedStart <= nowMs;
    if (t.running) {
      for (var k = 0; k < sched.length; k++) {
        if (sched[k] >= nowMs) {
          t.nextStopId = stops[k];
          t.nextStopMs = sched[k];
          break;
        }
      }
    }
  }
  return t;
}

function attachStopNames(trips) {
  var ids = [];
  trips.forEach(function (t) {
    [t.firstStopId, t.lastStopId, t.nextStopId].forEach(function (id) {
      if (id) {
        ids.push(id);
      }
    });
  });
  var names = {};
  var list = unique(ids);
  for (var i = 0; i < list.length; i += 500) {
    fetchByIds(TransitStop, list.slice(i, i + 500), 'id, stopName').forEach(function (s) {
      names[s.id] = s.stopName;
    });
  }
  trips.forEach(function (t) {
    t.firstStopName = names[t.firstStopId] || null;
    t.lastStopName = names[t.lastStopId] || null;
    t.nextStopName = names[t.nextStopId] || null;
  });
  return trips;
}

function prtRouteTrips(routes, nowMs, windowEndMs, notes) {
  var routeById = indexById(routes);
  var ids = Object.keys(routeById);
  var rows = TransitRoute.Trip.fetch({
    filter: Filter.intersects('route.id', ids),
    include: 'id, route.id, headsign, directionId, shapeId, serviceId, startSeconds, endSeconds',
    limit: 20000,
  }).objs || [];
  var patterns = prtPatterns(ids, rows);
  var calendars = indexById(TransitServiceCalendar.fetch({ filter: Filter.eq('provider', TransitProvider.PRT), limit: 500 }).objs || []);
  var days = [];
  var seenDays = {};
  [nowMs - 86400000, nowMs, windowEndMs].forEach(function (ms) {
    var d = easternDate(ms);
    if (!seenDays[d.key]) {
      seenDays[d.key] = true;
      days.push(d);
    }
  });
  var rowById = {};
  rows.forEach(function (r) {
    rowById[r.id.substring(4)] = r;
  });

  var live = prtLiveTrips(routes, notes);

  // Candidate (trip, day) pairs inside the window by the timetable.
  var candidates = [];
  days.forEach(function (day) {
    rows.forEach(function (row) {
      if (row.startSeconds == null || !serviceRuns(calendars[row.serviceId], day)) {
        return;
      }
      var startMs = day.midnightUtcMs + row.startSeconds * 1000;
      var endMs = day.midnightUtcMs + (row.endSeconds != null ? row.endSeconds : row.startSeconds) * 1000;
      if (endMs >= nowMs - TRIP_GRACE_MS && startMs <= windowEndMs) {
        candidates.push({ row: row, day: day });
      }
    });
  });

  // A tracked trip running far behind schedule can fall outside the timetable window; add it from its live times.
  var candidateTrip = {};
  candidates.forEach(function (c) {
    candidateTrip[c.row.id.substring(4)] = true;
  });
  Object.keys(live).forEach(function (tripId) {
    var row = rowById[tripId];
    if (!row || candidateTrip[tripId] || row.startSeconds == null) {
      return;
    }
    var firstLive = live[tripId].order.length ? live[tripId].times[live[tripId].order[0]] : nowMs;
    var bestDay = null;
    days.forEach(function (day) {
      var diff = Math.abs(day.midnightUtcMs + row.startSeconds * 1000 - firstLive);
      if (!bestDay || diff < bestDay.diff) {
        bestDay = { day: day, diff: diff };
      }
    });
    if (bestDay) {
      candidates.push({ row: row, day: bestDay.day });
    }
  });

  // GTFS-RT has no service date here: a trip id that appears on two days takes the live data on the closer one.
  var liveDay = {};
  candidates.forEach(function (c) {
    var tripId = c.row.id.substring(4);
    var entry = live[tripId];
    if (!entry || !entry.order.length) {
      return;
    }
    var diff = Math.abs(c.day.midnightUtcMs + c.row.startSeconds * 1000 - entry.times[entry.order[0]]);
    if (!liveDay[tripId] || diff < liveDay[tripId].diff) {
      liveDay[tripId] = { key: c.day.key, diff: diff };
    }
  });

  var trips = candidates.map(function (c) {
    var tripId = c.row.id.substring(4);
    var useLive = liveDay[tripId] && liveDay[tripId].key === c.day.key ? live[tripId] : null;
    return prtTrip(routeById[c.row.route.id], c.row, c.day, patterns.forTrip(c.row), useLive, nowMs);
  }).filter(function (t) {
    return t.endMs >= nowMs - TRIP_GRACE_MS && (t.running || t.startMs <= windowEndMs);
  });
  return attachStopNames(trips);
}

function prtTripTimetable(route, tripId, serviceDate) {
  var now = DateTime.now();
  var nowMs = now.millis;
  var row = TransitRoute.Trip.forId('PRT:' + tripId);
  if (!row || !row.route || row.route.id !== route.id) {
    throw new Error('Trip ' + tripId + ' is not a ' + route.routeCode + ' trip in the loaded timetable.');
  }
  var rows = TransitRoute.Trip.fetch({
    filter: Filter.eq('route.id', route.id),
    include: 'id, route.id, directionId, shapeId',
    limit: 20000,
  }).objs || [];
  var match = prtPatterns([route.id], rows).forTrip(row);
  var day = serviceDate ? easternDateFromKey(serviceDate) : easternDate(nowMs);

  var base = TransitConfig.inst().getConfig().prtRealtimeBaseUrl;
  var feedPath = route.mode === 'rail' || isRailRoute(route.routeCode) ? '/gtfsrt-train/trips?debug' : '/gtfsrt-bus/trips?debug';
  var live = null;
  pull(PRT_TRIPS_SOURCE, function () {
    var block = entityBlockContaining(fetchText(base + feedPath).text, 'trip_id: "' + tripId + '"');
    live = block ? parsePrtLiveTrip(block) : null;
    return live ? 1 : 0;
  });
  if (live && !live.order.length) {
    live = null;
  }
  var t = attachStopNames([prtTrip(route, row, day, match, live, nowMs)])[0];

  var stops = t.stops;
  var stopRows = indexById(fetchByIds(TransitStop, stops, 'id, stopName, latitude, longitude'));
  var firstPredicted = -1;
  if (live) {
    for (var i = 0; i < stops.length; i++) {
      if (live.times[stops[i]] != null) {
        firstPredicted = i;
        break;
      }
    }
  }
  var out = stops.map(function (stopId, idx) {
    var s = stopRows[stopId];
    var scheduledMs = t.scheduled.length ? t.scheduled[idx] : null;
    var predicted = live ? live.times[stopId] : null;
    var expectedMs = predicted != null ? predicted : scheduledMs != null && t.delaySeconds != null ? scheduledMs + t.delaySeconds * 1000 : scheduledMs;
    return {
      stopId: s ? s.id : null,
      stopName: s ? s.stopName : stopId.substring(4),
      latitude: s ? s.latitude : null,
      longitude: s ? s.longitude : null,
      scheduledMs: scheduledMs,
      expectedMs: expectedMs,
      realtime: predicted != null,
      passed: live && firstPredicted >= 0 ? idx < firstPredicted : expectedMs != null && expectedMs < nowMs,
      skipped: !!(live && live.skipped[stopId]),
    };
  });

  var note = null;
  if (!t.exactPattern && match) {
    note = 'This trip runs a variant of the route; stops and times follow the main ' + (match.pattern.directionName || '') +
      ' pattern and may differ slightly.';
  } else if (!match) {
    note = 'The stop list for this trip is not loaded' + (live ? ', so only stops with live predictions are shown.' : '.');
  } else if (live && !t.realtime) {
    note = 'PRT predicts this trip but has not reported a vehicle for it yet.';
  }
  return TransitFeed.TripTimetable.make({
    trip: toRouteTrip(t),
    stops: out.map(toTimetableStop),
    note: note,
    fetchedAt: now,
  });
}

// --- CMU shuttles ------------------------------------------------------------------------------------------------

/** Normalizes one TripShot stop status (`{Awaiting: {...}}`, `{Departed: {...}}`, ...) into a flat record. */
function cmuStopEntry(status) {
  var kind = Object.keys(status)[0];
  var body = status[kind] || {};
  var ms = function (iso) {
    return iso ? DateTime.fromString(iso).millis : null;
  };
  var expected = null;
  if (kind === 'Departed') {
    expected = ms(body.departureTime) || ms(body.arrivalTime);
  } else if (kind === 'Present') {
    expected = ms(body.arrivalTime) || ms(body.expectedArrivalTime);
  } else if (kind === 'Awaiting') {
    expected = ms(body.expectedArrivalTime);
  }
  var scheduled = ms(body.scheduledDepartureTime);
  return {
    kind: kind,
    viaIdx: body.viaIdx,
    stopId: body.stopId,
    scheduledMs: scheduled,
    expectedMs: expected != null ? expected : scheduled,
    passed: kind === 'Departed',
    skipped: kind === 'Skipped',
    actual: kind === 'Departed' || kind === 'Present',
  };
}

/** Splits a ride's stop statuses into loops: a new loop starts whenever the via index goes back to an earlier stop. */
function cmuLoops(ride) {
  var loops = [];
  var current = [];
  var lastIdx = null;
  (ride.stopStatus || []).forEach(function (s) {
    var e = cmuStopEntry(s);
    if (lastIdx != null && e.viaIdx != null && e.viaIdx <= lastIdx && current.length) {
      loops.push(current);
      current = [];
    }
    current.push(e);
    if (e.viaIdx != null) {
      lastIdx = e.viaIdx;
    }
  });
  if (current.length) {
    loops.push(current);
  }
  return loops;
}

function cmuViaStop(ride, entry, stopsById) {
  var via = entry.viaIdx != null && ride.vias ? ride.vias[entry.viaIdx] : null;
  var s = via && via.ViaStop ? via.ViaStop.stop : null;
  if (!s || s.stopId !== entry.stopId) {
    s = stopsById[entry.stopId] || null;
  }
  return s;
}

/** Summary (plain object) of loop `loopNo` (1-based) of a TripShot ride, or null when the loop serves no stop. */
function cmuLoopTrip(route, ride, loop, loopNo, nowMs, stopsById) {
  var served = loop.filter(function (e) {
    return !e.skipped;
  });
  if (!served.length) {
    return null;
  }
  var state = rideState(ride);
  var realtime = !!(ride.liveDataAvailable && state !== 'Scheduled');
  var firstStop = cmuViaStop(ride, served[0], stopsById);
  var lastStop = cmuViaStop(ride, served[served.length - 1], stopsById);
  var next = served.filter(function (e) {
    return !e.passed;
  })[0];
  var nextStop = next ? cmuViaStop(ride, next, stopsById) : null;
  var started = served.some(function (e) {
    return e.actual;
  });
  var startMs = served[0].expectedMs;
  var dash = String(ride.rideId).lastIndexOf(':');
  return {
    provider: TransitProvider.CMU_SHUTTLE,
    routeId: route.id,
    routeCode: route.routeCode,
    routeColor: route.color,
    tripId: ride.rideId + '#' + loopNo,
    serviceDate: dash > 0 ? String(ride.rideId).substring(dash + 1) : null,
    headsign: lastStop ? lastStop.name : null,
    directionName: !ride.direction || ride.direction === 'NonDirectional' ? 'Loop' : ride.direction,
    startMs: startMs,
    endMs: served[served.length - 1].expectedMs,
    firstStopName: firstStop ? firstStop.name : null,
    lastStopName: lastStop ? lastStop.name : null,
    stopCount: served.length,
    realtime: realtime,
    vehicleId: ride.vehicleId ? 'CMU:' + ride.vehicleId : null,
    vehicleLabel: ride.vehicleName || null,
    delaySeconds: realtime && next && next.scheduledMs != null && next.expectedMs != null
      ? Math.round((next.expectedMs - next.scheduledMs) / 1000)
      : null,
    nextStopName: (started || startMs <= nowMs) && nextStop ? nextStop.name : null,
    nextStopMs: (started || startMs <= nowMs) && next ? next.expectedMs : null,
    running: !!next && (started || startMs <= nowMs),
    done: !next,
  };
}

function cmuRouteTrips(routes, nowMs, windowEndMs, notes) {
  var byExternal = {};
  routes.forEach(function (r) {
    byExternal[r.externalId] = r;
  });
  var live = null;
  var ok = pull(CMU_LIVE_SOURCE, function () {
    live = fetchTripShotLive();
    return (live.vehicleStatuses || []).length;
  });
  if (!ok || !live) {
    notes.push('CMU shuttle trips are unavailable because TripShot could not be read.');
    return [];
  }
  var trips = [];
  (live.rides || []).forEach(function (ride) {
    var route = byExternal[ride.routeId];
    var state = rideState(ride);
    if (!route || (state !== 'Active' && state !== 'Accepted' && state !== 'Scheduled')) {
      return;
    }
    var stopsById = viaStopNames(ride);
    cmuLoops(ride).forEach(function (loop, i) {
      var t = cmuLoopTrip(route, ride, loop, i + 1, nowMs, stopsById);
      if (t && !t.done && t.endMs >= nowMs - TRIP_GRACE_MS && (t.running || t.startMs <= windowEndMs)) {
        trips.push(t);
      }
    });
  });
  return trips;
}

function cmuTripTimetable(route, tripId) {
  var now = DateTime.now();
  var hash = String(tripId).lastIndexOf('#');
  var rideId = hash > 0 ? tripId.substring(0, hash) : tripId;
  var loopNo = hash > 0 ? Number(tripId.substring(hash + 1)) : 1;
  var ride = null;
  pull(CMU_LIVE_SOURCE, function () {
    var live = fetchTripShotLive();
    ride = (live.rides || []).filter(function (r) {
      return r.rideId === rideId;
    })[0] || null;
    return (live.vehicleStatuses || []).length;
  });
  if (!ride) {
    throw new Error('TripShot no longer lists this shuttle ride. It may have finished or been canceled.');
  }
  var loops = cmuLoops(ride);
  var loop = loops[loopNo - 1];
  if (!loop) {
    throw new Error('This shuttle ride has no loop ' + loopNo + '.');
  }
  var stopsById = viaStopNames(ride);
  var t = cmuLoopTrip(route, ride, loop, loopNo, now.millis, stopsById);
  if (!t) {
    throw new Error('This shuttle loop serves no stops.');
  }
  var stops = loop.map(function (e) {
    var s = cmuViaStop(ride, e, stopsById);
    return {
      stopId: e.stopId ? 'CMU:' + e.stopId : null,
      stopName: s ? s.name : 'Stop',
      latitude: s && s.location ? s.location.lt : null,
      longitude: s && s.location ? s.location.lg : null,
      scheduledMs: e.scheduledMs,
      expectedMs: e.skipped ? null : e.expectedMs,
      realtime: t.realtime && !e.skipped,
      passed: e.passed,
      skipped: e.skipped,
    };
  });
  return TransitFeed.TripTimetable.make({
    trip: toRouteTrip(t),
    stops: stops.map(toTimetableStop),
    note: loop.some(function (e) {
      return e.skipped;
    }) ? 'Skipped stops are on-request stops nobody booked, or stops the driver will not serve.' : null,
    fetchedAt: now,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Persistence and source bookkeeping
// ---------------------------------------------------------------------------------------------------------------

/** Writes the provider's current vehicles and removes rows for vehicles that left the operator feed. */
function replaceVehicles(provider, objs) {
  if (objs.length) {
    TransitVehicle.upsertBatch(objs);
  }
  var keep = {};
  objs.forEach(function (o) {
    keep[o.id] = true;
  });
  var stale = [];
  (TransitVehicle.fetch({ filter: Filter.eq('provider', provider), include: 'id', limit: 5000 }).objs || [])
    .forEach(function (v) {
      if (!keep[v.id]) {
        stale.push(v);
      }
    });
  if (stale.length) {
    TransitVehicle.removeBatch(stale);
  }
}

function sourcesById(ids) {
  return indexById(TransitDataSource.fetch({ filter: Filter.intersects('id', ids), limit: ids.length + 1 }).objs || []);
}

function isDue(source, seconds, force) {
  if (force || !source || !source.lastAttemptAt) {
    return true;
  }
  return DateTime.deltaSeconds(source.lastAttemptAt, DateTime.now()) >= seconds;
}

/**
 * Runs one upstream pull and records the outcome on its {@link TransitDataSource}. A failed pull is logged and
 * recorded (status ERROR with the message) so the UI shows the outage; it does not abort pulls of other sources.
 */
function pull(sourceId, fn) {
  var started = Date.now();
  TransitDataSource.make({ id: sourceId, lastAttemptAt: DateTime.now() }).merge();
  try {
    var count = fn();
    recordSuccess(sourceId, count, Date.now() - started);
    return true;
  } catch (e) {
    var message = e && e.message ? e.message : String(e);
    log.error('Feed {} failed: {}', sourceId, message);
    TransitDataSource.make({
      id: sourceId,
      status: TransitDataSource.Status.ERROR,
      lastAttemptAt: DateTime.now(),
      lastLatencyMs: Date.now() - started,
      lastError: message.substring(0, 3900),
    }).merge();
    return false;
  }
}

function recordSuccess(sourceId, count, latencyMs) {
  var now = DateTime.now();
  TransitDataSource.make({
    id: sourceId,
    status: TransitDataSource.Status.OK,
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastRecordCount: count,
    lastLatencyMs: latencyMs,
    lastError: null,
  }).merge({ include: 'id, status, lastAttemptAt, lastSuccessAt, lastRecordCount, lastLatencyMs, lastError' });
}

function fetchText(url) {
  var config = TransitConfig.inst().getConfig();
  var started = Date.now();
  var rsp = HttpRequest.make({ url: url, method: 'GET' })
    .withHeader('User-Agent', config.userAgent)
    .withHeader('Accept', 'application/json, text/plain, */*')
    .sendSync();
  if (rsp.statusCode < 200 || rsp.statusCode >= 300) {
    throw new Error('HTTP ' + rsp.statusCode + ' from ' + url.split('?')[0]);
  }
  return { text: String(rsp.string()), latencyMs: Date.now() - started };
}

function fetchByIds(type, ids, include) {
  var unique = {};
  ids.forEach(function (id) {
    unique[id] = true;
  });
  var list = Object.keys(unique);
  if (!list.length) {
    return [];
  }
  return type.fetch({ filter: Filter.intersects('id', list), include: include, limit: list.length + 1 }).objs || [];
}

function indexById(objs) {
  var out = {};
  (objs || []).forEach(function (o) {
    out[o.id] = o;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Protobuf text format and polyline encoding
// ---------------------------------------------------------------------------------------------------------------

/**
 * Parses protobuf text format (as served by `?debug`) into nested objects. Every field maps to an array of values,
 * because any field may repeat; read single values with {@link first}.
 */
function parsePbText(text) {
  var root = {};
  var stack = [root];
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) {
      continue;
    }
    var cur = stack[stack.length - 1];
    if (line === '}') {
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }
    if (line.charAt(line.length - 1) === '{') {
      var key = line.substring(0, line.length - 1).trim();
      var child = {};
      (cur[key] = cur[key] || []).push(child);
      stack.push(child);
      continue;
    }
    var idx = line.indexOf(':');
    if (idx < 0) {
      continue;
    }
    var k = line.substring(0, idx);
    (cur[k] = cur[k] || []).push(pbScalar(line.substring(idx + 1).trim()));
  }
  return root;
}

function pbScalar(v) {
  if (v.charAt(0) === '"') {
    return pbString(v.substring(1, v.length - 1));
  }
  if (/^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(v)) {
    return Number(v);
  }
  return v;
}

/** Decodes a protobuf text-format string literal: octal byte escapes are UTF-8, plus the usual C escapes. */
function pbString(raw) {
  var s = raw
    .replace(/%/g, '%25')
    .replace(/\\([0-7]{3})/g, function (_m, octal) {
      var hex = parseInt(octal, 8).toString(16);
      return '%' + (hex.length < 2 ? '0' + hex : hex);
    })
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
  try {
    return decodeURIComponent(s);
  } catch (e) {
    // Malformed UTF-8 in operator text: keep the undecoded text rather than dropping the alert.
    return s.replace(/%25/g, '%');
  }
}

function first(obj, key) {
  return obj && obj[key] && obj[key].length ? obj[key][0] : null;
}

/** Returns the `entity { ... }` block of a GTFS-Realtime text feed that contains `marker`, or null. */
function entityBlockContaining(text, marker) {
  var idx = text.indexOf(marker);
  if (idx < 0) {
    return null;
  }
  var start = text.lastIndexOf('\nentity {', idx);
  var end = text.indexOf('\nentity {', idx);
  return text.substring(start < 0 ? 0 : start + 1, end < 0 ? text.length : end);
}

/** Decodes a Google encoded polyline (precision 5) into `[[lat, lng], ...]`. */
function decodePolyline(encoded) {
  var points = [];
  var index = 0;
  var lat = 0;
  var lng = 0;
  while (index < encoded.length) {
    var deltas = [];
    for (var axis = 0; axis < 2; axis++) {
      var result = 0;
      var shift = 0;
      var b;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < encoded.length);
      deltas.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    lat += deltas[0];
    lng += deltas[1];
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/** Encodes `[[lat, lng], ...]` with the Google encoded-polyline algorithm at precision 5. */
function encodePolyline(points) {
  var out = '';
  var prevLat = 0;
  var prevLng = 0;
  points.forEach(function (p) {
    var lat = Math.round(p[0] * 1e5);
    var lng = Math.round(p[1] * 1e5);
    out += encodeSigned(lat - prevLat) + encodeSigned(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  });
  return out;
}

function encodeSigned(value) {
  var s = value < 0 ? ~(value << 1) : value << 1;
  var out = '';
  while (s >= 0x20) {
    out += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
    s >>= 5;
  }
  return out + String.fromCharCode(s + 63);
}
