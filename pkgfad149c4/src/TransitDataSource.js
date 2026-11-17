/*
 * TransitDataSource — on-demand availability check of every external API the application uses.
 */
var log = Logger.for('TransitDataSource');

function checkAll() {
  var config = TransitConfig.inst();
  var userAgent = config.getConfig().userAgent;
  var sources = TransitDataSource.fetch({ order: 'phase, id', limit: 200 }).objs || [];
  sources.forEach(function (source) {
    if (!source.probeUrl) {
      return;
    }
    var key = null;
    if (source.credentialField) {
      key = config.secretValue(source.credentialField);
      if (!key) {
        TransitDataSource.make({
          id: source.id,
          status: TransitDataSource.Status.NOT_CONFIGURED,
          lastError: null,
        }).merge({ include: 'id, status, lastError' });
        return;
      }
    }
    probe(source, key, userAgent);
  });
  return TransitDataSource.fetch({ order: 'phase, id', limit: 200 }).objs || [];
}

/**
 * Calls one source and records the outcome. A failure is recorded on the row (status ERROR with the message, with any
 * credential masked) rather than thrown, so one unreachable API does not hide the results for the others.
 */
function probe(source, key, userAgent) {
  var url = source.probeUrl.replace('{key}', key ? encodeURIComponent(key) : '');
  var started = Date.now();
  var now = DateTime.now();
  try {
    var req = HttpRequest.make({ url: url, method: source.probeBody ? 'POST' : 'GET' })
      .withHeader('User-Agent', userAgent)
      .withHeader('Accept', 'application/json, application/xml, text/plain, */*');
    if (source.probeKeyHeader && key) {
      req = req.withHeader(source.probeKeyHeader, key);
    }
    if (source.probeBody) {
      req = req.withBodyString(source.probeBody, 'application/json', null);
    }
    var rsp = req.sendSync();
    var latencyMs = Date.now() - started;
    var text = String(rsp.string() || '');
    var ok = rsp.statusCode >= 200 && rsp.statusCode < 300;
    var problem = ok ? bodyProblem(text) : 'HTTP ' + rsp.statusCode + errorDetail(text);
    if (problem) {
      throw new Error(problem);
    }
    TransitDataSource.make({
      id: source.id,
      status: TransitDataSource.Status.OK,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastLatencyMs: latencyMs,
      lastRecordCount: recordCount(text),
      lastError: null,
    }).merge({ include: 'id, status, lastAttemptAt, lastSuccessAt, lastLatencyMs, lastRecordCount, lastError' });
  } catch (e) {
    var message = e && e.message ? e.message : String(e);
    if (key) {
      message = message.split(key).join('***').split(encodeURIComponent(key)).join('***');
    }
    log.warn('Data source {} check failed: {}', source.id, message);
    TransitDataSource.make({
      id: source.id,
      status: TransitDataSource.Status.ERROR,
      lastAttemptAt: now,
      lastLatencyMs: Date.now() - started,
      lastError: message.substring(0, 3900),
    }).merge();
  }
}

/** Detects APIs that answer HTTP 200 with an error payload (Google Maps, PRT TrueTime, NewsAPI). */
function bodyProblem(text) {
  var trimmed = text.trim();
  if (trimmed.charAt(0) !== '{') {
    return null;
  }
  var json;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
  if (json.status === 'REQUEST_DENIED' || json.status === 'INVALID_REQUEST' || json.status === 'OVER_QUERY_LIMIT') {
    return json.status + (json.error_message ? ': ' + json.error_message : '');
  }
  if (json.status === 'error') {
    return json.message || 'API returned status error';
  }
  var bustime = json['bustime-response'];
  if (bustime && bustime.error && bustime.error.length) {
    return bustime.error[0].msg || 'TrueTime error';
  }
  if (json.error && typeof json.error === 'string') {
    return json.error;
  }
  return null;
}

/** Pulls the message out of a Google-style error body (`{error: {status, message}}`) for a non-2xx response. */
function errorDetail(text) {
  try {
    var err = JSON.parse(text.trim()).error;
    if (err && typeof err === 'object' && err.message) {
      return ' ' + (err.status ? err.status + ': ' : '') + err.message;
    }
  } catch (e) {
    // Not JSON: the status code alone is reported.
  }
  return '';
}

function recordCount(text) {
  var trimmed = text.trim();
  if (trimmed.charAt(0) === '[') {
    try {
      return JSON.parse(trimmed).length;
    } catch (e) {
      return 1;
    }
  }
  var entities = trimmed.split('\nentity {').length - 1;
  if (entities > 0) {
    return entities;
  }
  var items = trimmed.split('<item>').length - 1;
  return items > 0 ? items : 1;
}
