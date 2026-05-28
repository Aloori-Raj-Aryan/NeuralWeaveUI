# NeuralWeaveUI - Local Node Editor

Visual node editor for assembling neural network blocks from the `blocks/` folder.

## Requirements

| Requirement | Notes |
|-------------|--------|
| **Node.js** | **12.10+** minimum; **18 LTS recommended** |
| **npm** | Optional — you can start the server with `node server.js` directly |

If you use [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install
nvm use
```

## Quick start

```bash
cd /path/to/NeuralWeaveUI
npm install
node server.js
```

Open [http://localhost:3000](http://localhost:3000)

You should see in the terminal:

```text
NeuralWeaveUI v0.2.0 (Node v18.x.x)
Server listening at http://localhost:3000
Health check: GET /api/health
```

Verify the API:

```bash
curl http://localhost:3000/api/health
# {"ok":true,"version":"0.2.0","node":"v18.x.x","sessionApi":true}
```

## Sessions

Each **browser tab** gets its own session while it stays open:

- Saved graphs are stored under `saved_graphs/<session-id>/`
- A tab can only list, load, save, and delete graphs in **its own** session
- **Reloading the page** ends the previous session (its saved graphs are deleted) and starts a **new empty session**
- Opening a **new tab** (first visit) also cleans up saved graphs from sessions that were closed without a reload

You can save **multiple graphs per session** — use different names (`graph-1`, `graph-2`, …). The save dialog suggests the next free name automatically.

The session id is shown above **Save Graph** in the left panel.

## Features

- Block palette grouped by `blocks/` folder categories
- Click a block, then click the canvas to place it (or drag from palette)
- Connect outputs (green) to inputs (red) with directed arrows
- Box-select, Shift+click, copy/cut/paste/delete
- Canvas zoom (pinch / Ctrl+scroll) and two-finger scroll
- Per-node init arguments with required-field validation
- Save/load graphs scoped to the current session

## Troubleshooting

### `Could not start session: randomUUID is not a function`

**Cause:** An old server process is still running code that used `crypto.randomUUID()` (Node 14+ only) while your Node version is 12.x.

**Fix:**

1. Stop every process on port 3000:

   ```bash
   lsof -ti:3000 | xargs kill -9
   ```

2. Confirm the fix is in your tree — `server.js` must define `createSessionId()`, not import `randomUUID`:

   ```bash
   grep createSessionId server.js
   ```

3. Start the server from the project root:

   ```bash
   node server.js
   ```

4. Hard-refresh the browser (Cmd+Shift+R / Ctrl+Shift+R).

5. A reload always starts a **new session** (previous saved graphs in that tab are removed). Use unique names (`graph-1`, `graph-2`, …) to keep multiple graphs before reloading.

### `Could not start session: ... non-JSON response`

**Cause:** Nothing is listening on port 3000, or another app is bound to that port.

**Fix:** Start NeuralWeaveUI with `node server.js` and check `curl http://localhost:3000/api/health`.

### `EADDRINUSE: address already in use :::3000`

**Cause:** Another process is already using port 3000.

**Fix:**

```bash
lsof -ti:3000 | xargs kill -9
node server.js
```

Or use a different port:

```bash
PORT=3001 node server.js
```

### `npm start` fails with `Cannot find module 'node:path'`

**Cause:** Very old npm bundled with Node 12.

**Fix:** Start the server directly (recommended):

```bash
node server.js
```

Or upgrade Node to 18+ and reinstall dependencies.

### Save graph fails / empty saved graphs list

**Cause:** Session not initialized (see session errors above), or you reloaded the page (which starts a new empty session).

**Fix:** Resolve the session startup error first. Save each graph under a **unique name** — the prompt suggests `graph-1`, `graph-2`, etc. If the name already exists, the save dialog asks again for a different name.

## API (session-scoped)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Server version and readiness |
| POST | `/api/session` | Create a new session |
| GET | `/api/session/:id` | Validate a session |
| DELETE | `/api/session/:id` | Delete session and its graphs |
| GET | `/api/graphs` | List saved graphs (requires `X-Session-Id`) |
| GET | `/api/graphs/:name` | Load a graph |
| POST | `/api/save_graph` | Save a graph |
| DELETE | `/api/graphs/:name` | Delete a graph |
| GET | `/api/blocks` | List block definitions |

## Project layout

```text
blocks/           Block JSON definitions (read-only at runtime)
public/           Frontend (app.js, index.html, styles.css)
saved_graphs/     Session graph storage (gitignored)
server.js         Express API + static file server
```

## Notes

- `saved_graphs/` is gitignored; graphs are local only.
- Block definitions are loaded from `blocks/**/*.json` on each page load.
- This is a local development UI, not a production deployment.
