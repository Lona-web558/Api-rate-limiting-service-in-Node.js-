# Api-rate-limiting-service-in-Node.js-
Api rate limiting service in Node.js

# API Rate Limiting Service

A lightweight, zero-dependency API rate limiting service written in traditional Node.js — no Express, no arrow functions, `var` only, built-in modules exclusively.

---

## Requirements

- Node.js v12 or higher
- No `npm install` needed

---

## Getting Started

```bash
node rate-limiter.js
```

The server starts on `http://127.0.0.1:3000` and prints a startup summary to the console.

---

## Configuration

All settings live at the top of `rate-limiter.js` and can be edited directly.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `WINDOW_MS` | `60000` (60s) | Sliding window duration in milliseconds |
| `MAX_REQUESTS` | `10` | Max allowed requests per client per window |
| `BAN_THRESHOLD` | `3` | Number of window violations before a client is banned |
| `BAN_DURATION_MS` | `300000` (5 min) | How long a ban lasts in milliseconds |

---

## How It Works

### Sliding Window

Every client is identified by their IP address (or the first value in `X-Forwarded-For` when behind a proxy). Each request timestamp is stored in a rolling array. On every incoming request, timestamps older than `WINDOW_MS` are pruned, and the remaining count is checked against `MAX_REQUESTS`.

### Violations & Banning

When a client exhausts their window allowance, it counts as a **violation**. After `BAN_THRESHOLD` violations, the client is **banned** for `BAN_DURATION_MS`. Once a ban expires, the client's record is automatically reset and they can make requests again.

```
Request → Check ban → Prune old timestamps → Count remaining
       → Allowed  → log timestamp, return 200
       → Exceeded → increment violations
                  → violations >= BAN_THRESHOLD → ban client (403)
                  → else → return 429 with retry info
```

### Memory Cleanup

A background job runs every **2 minutes** and removes:
- Expired bans
- Idle clients with no recent requests and no violations

This keeps the in-memory store from growing unbounded.

---

## Endpoints

### `GET /api`
The rate-limited sample endpoint. Use this to test the limiter.

**Success response (200):**
```json
{
  "success": true,
  "message": "Hello from the rate-limited API endpoint!",
  "client": "127.0.0.1",
  "remaining": 8,
  "reset_in_s": 57
}
```

**Rate limited (429):**
```json
{
  "error": "Rate limit exceeded. 2 violation(s) remaining before ban.",
  "remaining": 0,
  "reset_in_s": 43,
  "violations": 1
}
```

**Banned (403):**
```json
{
  "error": "Client is banned. Too many violations.",
  "remaining": 0,
  "reset_in_s": 284,
  "violations": "N/A"
}
```

**Response headers on every `/api` call:**

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Max requests allowed per window |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Seconds until the window resets |
| `Retry-After` | Seconds to wait (only on 429 / 403 responses) |

---

### `GET /status`
Returns current service configuration and live stats.

```json
{
  "service": "Rate Limiter",
  "uptime_seconds": 142,
  "window_ms": 60000,
  "max_requests": 10,
  "ban_threshold": 3,
  "ban_duration_ms": 300000,
  "tracked_clients": 4,
  "banned_clients": 1
}
```

---

### `GET /admin/clients`
Returns a snapshot of every tracked client and their current state.

```json
{
  "clients": {
    "127.0.0.1": {
      "active_requests_in_window": 7,
      "violations": 0,
      "banned": false,
      "banned_until": null
    },
    "192.168.1.5": {
      "active_requests_in_window": 0,
      "violations": 3,
      "banned": true,
      "banned_until": "2025-06-01T12:34:56.000Z"
    }
  }
}
```

---

### `POST /admin/unban/:clientKey`
Resets a banned client's record so they can make requests again immediately.

```bash
curl -X POST http://127.0.0.1:3000/admin/unban/127.0.0.1
```

```json
{ "message": "Client unbanned: 127.0.0.1" }
```

---

### `DELETE /admin/reset/:clientKey`
Completely removes a client's record from the store.

```bash
curl -X DELETE http://127.0.0.1:3000/admin/reset/127.0.0.1
```

```json
{ "message": "Client record deleted: 127.0.0.1" }
```

---

### `DELETE /admin/reset-all`
Clears all tracked client records at once.

```bash
curl -X DELETE http://127.0.0.1:3000/admin/reset-all
```

```json
{ "message": "All records cleared.", "count": 5 }
```

---

## Testing

### Trigger the rate limiter quickly
```bash
for i in $(seq 1 15); do
  curl -s http://127.0.0.1:3000/api | python3 -m json.tool
done
```

### Watch the headers
```bash
curl -v http://127.0.0.1:3000/api 2>&1 | grep -E "< X-Rate|< Retry"
```

### Check all tracked clients
```bash
curl -s http://127.0.0.1:3000/admin/clients | python3 -m json.tool
```

### Manually unban yourself
```bash
curl -X POST http://127.0.0.1:3000/admin/unban/127.0.0.1
```

---

## Graceful Shutdown

The server handles `SIGINT` (Ctrl+C) and `SIGTERM` cleanly — it stops the cleanup interval and waits for in-flight requests to finish before exiting.

---

## Project Structure

```
rate-limiter.js   ← entire service, single file
README.md         ← this file
```

---

## Design Decisions

**No dependencies.** Only Node's built-in `http` and `url` modules are used, so there is nothing to install and nothing to break.

**Traditional JavaScript style.** Written with `var`, named `function` declarations, and no arrow functions — compatible with older Node runtimes and easy to read for developers coming from a classical JS background.

**IP-based identification.** Client identity is derived from the socket's remote address, with automatic fallback to `X-Forwarded-For` for proxied environments.

**Sliding window over fixed window.** A fixed window can allow a burst of 2× the limit at window boundaries. The sliding window here tracks individual request timestamps, so the limit is accurately enforced at all times.

**Violation escalation to ban.** A simple 429 alone can be trivially retried. The violation counter and eventual ban add a meaningful deterrent for abusive clients while still giving legitimate clients a small grace margin.

