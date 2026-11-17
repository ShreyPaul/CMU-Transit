/*
 * TransitGeocoder — autocomplete over three sources, merged:
 *  1. Allegheny County address points (official ArcGIS service) for queries that start with a house number,
 *  2. Photon (OpenStreetMap) for places, streets, and neighborhoods,
 *  3. loaded transit stops by name.
 * A failing provider is recorded on its TransitDataSource and skipped; the others still answer.
 */
var log = Logger.for('TransitGeocoder');

var PHOTON_SOURCE = 'photon-geocoder';
var COUNTY_SOURCE = 'alcogis-address-points';
/** Pittsburgh-area search box as `minLon,minLat,maxLon,maxLat`. */
var PITTSBURGH_BBOX = '-80.25,40.25,-79.65,40.65';
var MIN_QUERY_LENGTH = 3;

/** Address-point spellings: what people type mapped to the county's USPS abbreviations. */
var STREET_WORDS = {
  AVENUE: 'AVE', AV: 'AVE', STREET: 'ST', STR: 'ST', ROAD: 'RD', BOULEVARD: 'BLVD', DRIVE: 'DR', PLACE: 'PL',
  LANE: 'LN', COURT: 'CT', TERRACE: 'TER', PARKWAY: 'PKWY', HIGHWAY: 'HWY', CIRCLE: 'CIR', SQUARE: 'SQ',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
};
var DIRECTIONALS = ['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW'];
var STREET_TYPES = ['AVE', 'ST', 'RD', 'BLVD', 'DR', 'PL', 'LN', 'CT', 'TER', 'PKWY', 'HWY', 'CIR', 'SQ', 'WAY', 'ALY'];

function search(query, limit, nearLatitude, nearLongitude) {
  var max = Math.min(limit || 8, 15);
  var q = String(query).trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return [];
  }
  var failures = [];
  var addresses = [];
  var places = [];

  if (/^\d+\s+[A-Za-z]/.test(q)) {
    try {
      addresses = countyAddresses(q, max, nearLatitude, nearLongitude);
    } catch (e) {
      failures.push('county address points: ' + (e && e.message ? e.message : String(e)));
    }
  }
  try {
    places = photonPlaces(q, max, nearLatitude, nearLongitude);
  } catch (e) {
    failures.push('Photon: ' + (e && e.message ? e.message : String(e)));
  }

  var stopSlots = Math.max(2, Math.floor(max / 3));
  var stops = TransitStop.fetch({
    filter: Filter.containsIgnoreCase('stopName', q),
    include: 'id, provider, stopName, stopCode, latitude, longitude, servedRouteCodes',
    order: 'descending(provider), stopName',
    limit: stopSlots,
  }).objs || [];
  var stopResults = [];
  stops.forEach(function (s) {
    var routes = s.servedRouteCodes && s.servedRouteCodes.length ? ' · ' + s.servedRouteCodes.join(', ') : '';
    var kind = s.provider == TransitProvider.CMU_SHUTTLE ? 'CMU shuttle stop' : 'PRT stop' + (s.stopCode ? ' #' + s.stopCode : '');
    stopResults.push(TransitGeocoder.Place.make({
      label: s.stopName,
      detail: kind + routes,
      latitude: s.latitude,
      longitude: s.longitude,
      kind: TransitGeocoder.Place.Kind.STOP,
      stopId: s.id,
    }));
  });

  // Exact street addresses first, then named places, with stops at the end; drop near-duplicates across sources.
  // A result is a duplicate when an earlier one has the same name and lies within 400 m (OSM often maps a building,
  // its entrance, and its grounds separately).
  var merged = [];
  addresses.concat(places).forEach(function (p) {
    var name = p.label.toUpperCase().replace(/[^A-Z0-9]/g, '');
    var duplicate = merged.some(function (m) {
      return m.label.toUpperCase().replace(/[^A-Z0-9]/g, '') === name &&
        distanceMeters(m.latitude, m.longitude, p.latitude, p.longitude) < 400;
    });
    if (!duplicate) {
      merged.push(p);
    }
  });
  var results = merged.slice(0, Math.max(0, max - stopResults.length)).concat(stopResults);
  if (!results.length && failures.length) {
    throw new Error('Address search is unavailable right now (' + failures.join('; ') + ').');
  }
  return results;
}

/** Street-address suggestions from the county address points for queries like `417 s craig`. */
function countyAddresses(q, max, nearLatitude, nearLongitude) {
  var tokens = q.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map(function (t) {
    return STREET_WORDS[t] || t;
  });
  var number = parseInt(tokens.shift(), 10);
  if (tokens.length && DIRECTIONALS.indexOf(tokens[0]) >= 0) {
    tokens.shift();
  }
  if (tokens.length > 1 && STREET_TYPES.indexOf(tokens[tokens.length - 1]) >= 0) {
    tokens.pop();
  }
  var street = tokens.join(' ');
  if (!number || street.length < 2) {
    return [];
  }
  // Only digits, letters, and spaces reach the ArcGIS where clause.
  var where = 'ADDR_NUM = ' + number + " AND ST_NAME LIKE '" + street + "%'";
  var config = TransitConfig.inst().getConfig();
  var url = config.countyAddressBaseUrl + '/query?f=json&outSR=4326&returnGeometry=true&resultRecordCount=25' +
    '&outFields=FULL_ADDRESS,MUNICIPALITY,ZIP_CODE&where=' + encodeURIComponent(where);
  var json = callSource(COUNTY_SOURCE, url, config.userAgent, function (j) {
    return (j.features || []).length;
  });
  var seen = {};
  var out = [];
  (json.features || []).forEach(function (f) {
    var a = f.attributes;
    var key = a.FULL_ADDRESS + '|' + a.MUNICIPALITY;
    if (seen[key] || !f.geometry) {
      return;
    }
    seen[key] = true;
    out.push({
      place: TransitGeocoder.Place.make({
        label: titleCase(a.FULL_ADDRESS),
        detail: [titleCase(String(a.MUNICIPALITY || '').replace(/^CITY OF /, '')), 'PA ' + (a.ZIP_CODE || '')].join(', ').trim(),
        latitude: f.geometry.y,
        longitude: f.geometry.x,
        kind: TransitGeocoder.Place.Kind.PLACE,
      }),
      meters: nearLatitude != null ? distanceMeters(nearLatitude, nearLongitude, f.geometry.y, f.geometry.x) : 0,
    });
  });
  out.sort(function (a, b) {
    return a.meters - b.meters;
  });
  return out.slice(0, Math.ceil(max / 2)).map(function (o) {
    return o.place;
  });
}

/** Place, street, and neighborhood suggestions from Photon, retried once because the public server sheds load. */
function photonPlaces(q, max, nearLatitude, nearLongitude) {
  var config = TransitConfig.inst().getConfig();
  var url = config.geocoderBaseUrl + '/api/?lang=en&limit=' + max + '&bbox=' + PITTSBURGH_BBOX +
    (nearLatitude != null && nearLongitude != null ? '&lat=' + nearLatitude + '&lon=' + nearLongitude : '') +
    '&q=' + encodeURIComponent(q);
  var json;
  try {
    json = callSource(PHOTON_SOURCE, url, config.userAgent, countFeatures);
  } catch (first) {
    log.warn('Photon failed, retrying once: {}', first.message);
    json = callSource(PHOTON_SOURCE, url, config.userAgent, countFeatures);
  }
  return (json.features || []).map(toPlace);
}

function countFeatures(j) {
  return (j.features || []).length;
}

/** GETs JSON from one source and records the outcome on its TransitDataSource row; failures are recorded, then thrown. */
function callSource(sourceId, url, userAgent, countFn) {
  var started = Date.now();
  var now = DateTime.now();
  try {
    var rsp = HttpRequest.make({ url: url, method: 'GET' })
      .withHeader('User-Agent', userAgent)
      .withHeader('Accept', 'application/json')
      .sendSync();
    if (rsp.statusCode < 200 || rsp.statusCode >= 300) {
      throw new Error('HTTP ' + rsp.statusCode);
    }
    var json = JSON.parse(String(rsp.string()));
    if (json.error) {
      throw new Error(json.error.message || 'service error');
    }
    TransitDataSource.make({
      id: sourceId,
      status: TransitDataSource.Status.OK,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastLatencyMs: Date.now() - started,
      lastRecordCount: countFn(json),
      lastError: null,
    }).merge({ include: 'id, status, lastAttemptAt, lastSuccessAt, lastLatencyMs, lastRecordCount, lastError' });
    return json;
  } catch (e) {
    var message = e && e.message ? e.message : String(e);
    log.error('Geocoder source {} failed: {}', sourceId, message);
    TransitDataSource.make({
      id: sourceId,
      status: TransitDataSource.Status.ERROR,
      lastAttemptAt: now,
      lastLatencyMs: Date.now() - started,
      lastError: message.substring(0, 3900),
    }).merge();
    throw new Error(message);
  }
}

/** Turns a Photon GeoJSON feature into a label (name or street address) and a detail line (rest of the address). */
function toPlace(feature) {
  var p = feature.properties || {};
  var coords = feature.geometry.coordinates;
  var streetLine = [p.housenumber, p.street].filter(Boolean).join(' ');
  var label = p.name || streetLine || p.city || 'Unnamed place';
  var area = [p.district || p.locality, p.city, [p.state, p.postcode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .filter(function (part, i, all) {
      return all.indexOf(part) === i && part !== label;
    });
  var detailParts = (p.name && streetLine ? [streetLine] : []).concat(area);
  return TransitGeocoder.Place.make({
    label: label,
    detail: detailParts.join(', '),
    latitude: coords[1],
    longitude: coords[0],
    kind: TransitGeocoder.Place.Kind.PLACE,
  });
}

function titleCase(text) {
  return String(text || '').toLowerCase().replace(/\b([a-z])/g, function (m) {
    return m.toUpperCase();
  });
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  var dLat = (lat2 - lat1) * 111320;
  var dLon = (lon2 - lon1) * 111320 * Math.cos(lat1 * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}
