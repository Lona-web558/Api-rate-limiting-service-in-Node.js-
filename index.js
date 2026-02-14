/*
  =====================================================
    API Rate Limiting Service
    Node.js — Traditional JS (no arrow functions,
    var only, no const, no express, built-in modules)
  =====================================================
*/

var http = require("http");
var url  = require("url");

// ─── Configuration ────────────────────────────────────────────────────────────

var PORT           = 3000;
var WINDOW_MS      = 60 * 1000;   // 1-minute sliding window
var MAX_REQUESTS   = 10;          // max hits per window per client
var BAN_THRESHOLD  = 3;           // bans after this many window violations
var BAN_DURATION_MS = 5 * 60 * 1000; // ban duration: 5 minutes

// ─── In-Memory Store ──────────────────────────────────────────────────────────

/*
  clientStore schema per key (IP address):
  {
    requests   : [ timestamp, timestamp, ... ],  // rolling timestamps
    violations : Number,                         // windows exceeded
    banned     : Boolean,
    bannedUntil: Number                          // epoch ms
  }
*/
var clientStore = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getClientKey(req) {
  var forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress;
}

function now() {
  return Date.now();
}

function pruneOldRequests(record) {
  var cutoff = now() - WINDOW_MS;
  var fresh  = [];
  var i;
  for (i = 0; i < record.requests.length; i++) {
    if (record.requests[i] > cutoff) {
      fresh.push(record.requests[i]);
    }
  }
  record.requests = fresh;
}

function initRecord() {
  return {
    requests   : [],
    violations : 0,
    banned     : false,
    bannedUntil: 0
  };
}

function sendJSON(res, statusCode, payload) {
  var body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type"  : "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

// ─── Rate Limiter Core ────────────────────────────────────────────────────────

function checkRateLimit(clientKey) {
  /*
    Returns an object:
    {
      allowed    : Boolean,
      status     : 200 | 429 | 403,
      remaining  : Number,
      resetIn    : Number (seconds),
      message    : String
    }
  */

  if (!clientStore[clientKey]) {
    clientStore[clientKey] = initRecord();
  }

  var record  = clientStore[clientKey];
  var current = now();

  // ── Check active ban ──────────────────────────────────────────────────────
  if (record.banned) {
    if (current < record.bannedUntil) {
      return {
        allowed  : false,
        status   : 403,
        remaining: 0,
        resetIn  : Math.ceil((record.bannedUntil - current) / 1000),
        message  : "Client is banned. Too many violations."
      };
    }
    // Ban expired — reset client
    clientStore[clientKey] = initRecord();
    record = clientStore[clientKey];
  }

  // ── Prune timestamps outside the window ───────────────────────────────────
  pruneOldRequests(record);

  var count = record.requests.length;

  if (count >= MAX_REQUESTS) {
    // Window exhausted — record violation
    record.violations += 1;

    if (record.violations >= BAN_THRESHOLD) {
      record.banned     = true;
      record.bannedUntil = current + BAN_DURATION_MS;
      return {
        allowed  : false,
        status   : 403,
        remaining: 0,
        resetIn  : Math.ceil(BAN_DURATION_MS / 1000),
        message  : "Too many violations. Client banned for " +
                   (BAN_DURATION_MS / 1000 / 60) + " minutes."
      };
    }

    var oldestRequest = record.requests[0] || current;
    var resetIn       = Math.ceil((oldestRequest + WINDOW_MS - current) / 1000);

    return {
      allowed    : false,
      status     : 429,
      remaining  : 0,
      resetIn    : resetIn,
      violations : record.violations,
      message    : "Rate limit exceeded. " +
                   (BAN_THRESHOLD - record.violations) +
                   " violation(s) remaining before ban."
    };
  }

  // ── Request is allowed ────────────────────────────────────────────────────
  record.requests.push(current);

  var oldestAllowed = record.requests[0];
  var windowResetIn = Math.ceil((oldestAllowed + WINDOW_MS - current) / 1000);

  return {
    allowed  : true,
    status   : 200,
    remaining: MAX_REQUESTS - record.requests.length,
    resetIn  : windowResetIn,
    message  : "Request allowed."
  };
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

function handleStatus(req, res) {
  var total  = Object.keys(clientStore).length;
  var banned = 0;
  var key;
  for (key in clientStore) {
    if (clientStore[key].banned) {
      banned += 1;
    }
  }
  sendJSON(res, 200, {
    service       : "Rate Limiter",
    uptime_seconds: Math.floor(process.uptime()),
    window_ms     : WINDOW_MS,
    max_requests  : MAX_REQUESTS,
    ban_threshold : BAN_THRESHOLD,
    ban_duration_ms: BAN_DURATION_MS,
    tracked_clients: total,
    banned_clients : banned
  });
}

function handleAdmin(req, res) {
  var snapshot = {};
  var key;
  for (key in clientStore) {
    var r = clientStore[key];
    snapshot[key] = {
      active_requests_in_window: r.requests.length,
      violations               : r.violations,
      banned                   : r.banned,
      banned_until             : r.banned ? new Date(r.bannedUntil).toISOString() : null
    };
  }
  sendJSON(res, 200, { clients: snapshot });
}

function handleUnban(clientKey, res) {
  if (!clientStore[clientKey]) {
    return sendJSON(res, 404, { error: "Client not found: " + clientKey });
  }
  clientStore[clientKey] = initRecord();
  sendJSON(res, 200, { message: "Client unbanned: " + clientKey });
}

function handleReset(clientKey, res) {
  if (!clientStore[clientKey]) {
    return sendJSON(res, 404, { error: "Client not found: " + clientKey });
  }
  delete clientStore[clientKey];
  sendJSON(res, 200, { message: "Client record deleted: " + clientKey });
}

function handleResetAll(res) {
  var count = Object.keys(clientStore).length;
  clientStore = {};
  sendJSON(res, 200, { message: "All records cleared.", count: count });
}

function handleSampleAPI(clientKey, req, res) {
  var result = checkRateLimit(clientKey);

  res.setHeader("X-RateLimit-Limit"    , MAX_REQUESTS);
  res.setHeader("X-RateLimit-Remaining" , result.remaining);
  res.setHeader("X-RateLimit-Reset"     , result.resetIn);

  if (!result.allowed) {
    res.setHeader("Retry-After", result.resetIn);
    return sendJSON(res, result.status, {
      error      : result.message,
      remaining  : result.remaining,
      reset_in_s : result.resetIn,
      violations : result.violations || "N/A"
    });
  }

  sendJSON(res, 200, {
    success    : true,
    message    : "Hello from the rate-limited API endpoint!",
    client     : clientKey,
    remaining  : result.remaining,
    reset_in_s : result.resetIn
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

var server = http.createServer(function(req, res) {
  var parsed    = url.parse(req.url, true);
  var pathname  = parsed.pathname.replace(/\/+$/, "") || "/";
  var clientKey = getClientKey(req);
  var method    = req.method.toUpperCase();

  console.log("[" + new Date().toISOString() + "] " +
    method + " " + pathname + " — " + clientKey);

  // ── Routing ───────────────────────────────────────────────────────────────

  if (pathname === "/api" && method === "GET") {
    return handleSampleAPI(clientKey, req, res);
  }

  if (pathname === "/status" && method === "GET") {
    return handleStatus(req, res);
  }

  if (pathname === "/admin/clients" && method === "GET") {
    return handleAdmin(req, res);
  }

  if (pathname === "/admin/reset-all" && method === "DELETE") {
    return handleResetAll(res);
  }

  // /admin/unban/:clientKey
  var unbanMatch = pathname.match(/^\/admin\/unban\/(.+)$/);
  if (unbanMatch && method === "POST") {
    return handleUnban(decodeURIComponent(unbanMatch[1]), res);
  }

  // /admin/reset/:clientKey
  var resetMatch = pathname.match(/^\/admin\/reset\/(.+)$/);
  if (resetMatch && method === "DELETE") {
    return handleReset(decodeURIComponent(resetMatch[1]), res);
  }

  // 404 fallback
  sendJSON(res, 404, {
    error : "Route not found: " + method + " " + pathname,
    routes: [
      "GET  /api                         — rate-limited endpoint",
      "GET  /status                      — service info",
      "GET  /admin/clients               — view all tracked clients",
      "POST /admin/unban/:clientKey      — unban a client",
      "DELETE /admin/reset/:clientKey    — delete a client's record",
      "DELETE /admin/reset-all           — clear all records"
    ]
  });
});

// ─── Periodic Cleanup ─────────────────────────────────────────────────────────

// Every 2 minutes, remove stale client records to prevent memory bloat.
var cleanupInterval = setInterval(function() {
  var key;
  var now_ts = now();
  var removed = 0;
  for (key in clientStore) {
    var record = clientStore[key];

    // Remove expired bans
    if (record.banned && now_ts >= record.bannedUntil) {
      delete clientStore[key];
      removed++;
      continue;
    }

    // Remove idle clients with no recent requests and no violations
    pruneOldRequests(record);
    if (record.requests.length === 0 && record.violations === 0 && !record.banned) {
      delete clientStore[key];
      removed++;
    }
  }
  if (removed > 0) {
    console.log("[Cleanup] Removed " + removed + " stale client record(s).");
  }
}, 2 * 60 * 1000);

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log("\n[" + signal + "] Shutting down gracefully...");
  clearInterval(cleanupInterval);
  server.close(function() {
    console.log("Server closed. Goodbye.");
    process.exit(0);
  });
}

process.on("SIGTERM", function() { shutdown("SIGTERM"); });
process.on("SIGINT",  function() { shutdown("SIGINT");  });

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, "127.0.0.1", function() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║       API Rate Limiting Service              ║");
  console.log("╠══════════════════════════════════════════════╣");
  console.log("║  Listening : http://127.0.0.1:" + PORT + "          ║");
  console.log("║  Window    : " + (WINDOW_MS / 1000) + "s                         ║");
  console.log("║  Max Reqs  : " + MAX_REQUESTS + " per window                ║");
  console.log("║  Ban After : " + BAN_THRESHOLD + " violations               ║");
  console.log("║  Ban For   : " + (BAN_DURATION_MS / 1000 / 60) + " minutes                   ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  console.log("Endpoints:");
  console.log("  GET    http://127.0.0.1:" + PORT + "/api");
  console.log("  GET    http://127.0.0.1:" + PORT + "/status");
  console.log("  GET    http://127.0.0.1:" + PORT + "/admin/clients");
  console.log("  POST   http://127.0.0.1:" + PORT + "/admin/unban/<ip>");
  console.log("  DELETE http://127.0.0.1:" + PORT + "/admin/reset/<ip>");
  console.log("  DELETE http://127.0.0.1:" + PORT + "/admin/reset-all");
  console.log("");
});
