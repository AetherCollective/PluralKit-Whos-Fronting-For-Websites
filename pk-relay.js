/**
 * pk-relay.js  –  PluralKit relay server
 *
 * Replaces octo-relay.js for systems migrating from Octocon to PluralKit.
 *
 * Architecture
 * ────────────
 * PluralKit has no outbound WebSocket — instead it POSTs Dispatch Webhook
 * events to a public HTTP endpoint you provide.  This server:
 *
 *   1. Exposes POST /webhook  to receive PluralKit Dispatch events.
 *   2. Exposes a WebSocket server (same port) that browser clients connect to.
 *   3. On startup, polls the PluralKit REST API for current fronters and
 *      switch history so clients get state immediately on connect.
 *   4. Translates every incoming Dispatch event into the same internal event
 *      shape that octo-relay.js emitted, so pk-client.js is a near-drop-in.
 *
 * Setup
 * ─────
 *  1. npm install ws express
 *  2. Fill in the CONFIG block below.
 *  3. Run:  node pk-relay.js
 *  4. In PluralKit, register your webhook:
 *       pk;webhook set https://YOUR_SERVER/webhook
 *     Then copy the signing token PluralKit gives you into SIGNING_TOKEN.
 *  5. Point pk-client.js RELAY_URL at  wss://YOUR_SERVER
 *
 * Env vars (override CONFIG defaults)
 * ─────────────────────────────────────
 *   PK_TOKEN        – your PluralKit system token  (pk;token in Discord)
 *   PK_SYSTEM_ID    – your system short ID or UUID (or leave as "@me")
 *   PK_SIGNING_TOKEN – the signing token PluralKit gave you for the webhook
 *   PORT            – HTTP/WS listen port (default 3000)
 */

'use strict';

const http       = require('http');
const express    = require('express');
const { WebSocketServer, WebSocket } = require('ws');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  pkToken:       process.env.PK_TOKEN         || 'YOUR_PK_TOKEN_HERE',
  systemId:      process.env.PK_SYSTEM_ID     || '@me',
  signingToken:  process.env.PK_SIGNING_TOKEN || 'YOUR_SIGNING_TOKEN_HERE',
  port:          parseInt(process.env.PORT     || '3000', 10),

  // How many recent switches to pre-load for "last fronted" history (max 100)
  historyLimit:  100,

  // Poll interval (ms) for refreshing fronters/history if the webhook ever
  // misses an event.  Set to 0 to disable polling entirely.
  pollIntervalMs: 60_000,
};

// ─── PluralKit REST helpers ───────────────────────────────────────────────────

const PK_BASE = 'https://api.pluralkit.me/v2';

async function pkGet(path) {
  const res = await fetch(`${PK_BASE}${path}`, {
    headers: {
      'Authorization': CONFIG.pkToken,
      'User-Agent':    'pk-relay/1.0 (self-hosted fronting display)',
    },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`PK API ${res.status} on ${path}`);
  return res.json();
}

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * currentFronters:  array of PK member objects currently fronting
 * lastFrontedMap:   { memberUuid: ISO-timestamp-string }
 *                   timestamp of when each member was last in a switch
 */
let currentFronters = [];
let lastFrontedMap  = {};

// ─── State initialisation ─────────────────────────────────────────────────────

async function loadCurrentFronters() {
  try {
    const data = await pkGet(`/systems/${CONFIG.systemId}/fronters`);
    // data is a switch object with members as full objects, or null (204)
    currentFronters = data?.members ?? [];
    console.log(`[init] loaded ${currentFronters.length} current fronter(s)`);
  } catch (e) {
    console.error('[init] failed to load fronters:', e.message);
  }
}

async function loadSwitchHistory() {
  try {
    const switches = await pkGet(
      `/systems/${CONFIG.systemId}/switches?limit=${CONFIG.historyLimit}`
    );
    if (!Array.isArray(switches)) return;

    // Each switch only contains member IDs here, not full objects.
    // Walk chronologically (oldest first) so later entries overwrite correctly.
    const ordered = [...switches].reverse();
    for (const sw of ordered) {
      const ts = sw.timestamp;
      for (const memberId of sw.members) {
        lastFrontedMap[memberId] = ts;
      }
    }

    // Also record the *current* fronters as "last fronted = now" so the display
    // shows "Actively Fronting Now" rather than a stale timestamp.
    const now = new Date().toISOString();
    for (const m of currentFronters) {
      if (m.uuid) lastFrontedMap[m.uuid] = now;
    }

    console.log(`[init] built last-fronted history for ${Object.keys(lastFrontedMap).length} member(s)`);
  } catch (e) {
    console.error('[init] failed to load switch history:', e.message);
  }
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

let wss; // assigned after server is created

function broadcast(msg) {
  if (!wss) return;
  const raw = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ─── Snapshot senders (called on new client connect or explicit request) ──────

function sendSnapshot(ws) {
  sendTo(ws, {
    event:   'fronts_snapshot',
    fronts:  currentFronters.map(wrapMember),
  });
  sendTo(ws, {
    event:   'last_fronted_all',
    history: lastFrontedMap,
  });
}

/**
 * Wrap a PK member object into the shape octo-client.js expects:
 *   { alter: { id, name, color, security_level }, front: { comment } }
 *
 * PluralKit uses "uuid" as the stable identifier.
 * The "privacy.visibility" field maps to octo's "security_level".
 */
function wrapMember(member, comment = '') {
  return {
    alter: {
      id:             member.uuid,
      name:           member.display_name || member.name,
      color:          member.color ? `#${member.color}` : '#ffffff',
      security_level: member.privacy?.visibility === 'private' ? 'private' : 'public',
    },
    front: { comment },
  };
}

// ─── Dispatch event handler ───────────────────────────────────────────────────

async function handleDispatch(event) {
  const { type, id, data } = event;

  switch (type) {

    // ── A switch was created or updated ──────────────────────────────────────
    case 'CREATE_SWITCH':
    case 'UPDATE_SWITCH': {
      // Reload current fronters from API (the event data for CREATE_SWITCH
      // has member IDs only, not full objects; easiest to just re-fetch).
      await loadCurrentFronters();

      // Update lastFrontedMap for each member in the new switch.
      const ts = data?.timestamp ?? new Date().toISOString();
      if (Array.isArray(data?.members)) {
        for (const memberId of data.members) {
          lastFrontedMap[memberId] = ts;
        }
      }

      // Also stamp currently-fronting members with "now" so the client shows
      // "Actively Fronting Now" rather than the switch start timestamp.
      const nowIso = new Date().toISOString();
      for (const m of currentFronters) {
        if (m.uuid) lastFrontedMap[m.uuid] = nowIso;
      }

      broadcast({
        event:   'fronts_snapshot',
        fronts:  currentFronters.map(wrapMember),
      });
      broadcast({
        event:   'last_fronted_all',
        history: lastFrontedMap,
      });
      console.log(`[dispatch] ${type} → broadcast ${currentFronters.length} fronter(s)`);
      break;
    }

    // ── A switch was deleted ──────────────────────────────────────────────────
    case 'DELETE_SWITCH':
    case 'DELETE_ALL_SWITCHES': {
      await loadCurrentFronters();
      await loadSwitchHistory();
      broadcast({
        event:   'fronts_snapshot',
        fronts:  currentFronters.map(wrapMember),
      });
      broadcast({
        event:   'last_fronted_all',
        history: lastFrontedMap,
      });
      console.log(`[dispatch] ${type} → reloaded and broadcast`);
      break;
    }

    // ── Member updated (name/color/privacy change etc.) ───────────────────────
    case 'UPDATE_MEMBER': {
      // Merge partial update into any currently-fronting member.
      currentFronters = currentFronters.map(m => {
        if (m.uuid === id || m.id === id) return { ...m, ...data };
        return m;
      });
      broadcast({
        event:   'fronts_snapshot',
        fronts:  currentFronters.map(wrapMember),
      });
      console.log(`[dispatch] UPDATE_MEMBER ${id} → rebroadcast fronters`);
      break;
    }

    // ── Member deleted ────────────────────────────────────────────────────────
    case 'DELETE_MEMBER': {
      currentFronters = currentFronters.filter(m => m.uuid !== id && m.id !== id);
      delete lastFrontedMap[id];
      broadcast({
        event:   'fronts_snapshot',
        fronts:  currentFronters.map(wrapMember),
      });
      console.log(`[dispatch] DELETE_MEMBER ${id}`);
      break;
    }

    // ── Successful import — full reload ───────────────────────────────────────
    case 'SUCCESSFUL_IMPORT': {
      await loadCurrentFronters();
      await loadSwitchHistory();
      broadcast({
        event:   'fronts_snapshot',
        fronts:  currentFronters.map(wrapMember),
      });
      broadcast({
        event:   'last_fronted_all',
        history: lastFrontedMap,
      });
      console.log('[dispatch] SUCCESSFUL_IMPORT → full reload');
      break;
    }

    // ── PING — handled by the HTTP layer, nothing to do here ──────────────────
    case 'PING':
      break;

    default:
      // CREATE_MEMBER, UPDATE_SYSTEM, group events, message events, etc.
      // None of these affect the fronting display.
      break;
  }
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check
app.get('/', (_req, res) => res.send('pk-relay running'));

// PluralKit Dispatch webhook endpoint
app.post('/webhook', (req, res) => {
  const body = req.body;

  // Validate signing token
  if (!body || body.signing_token !== CONFIG.signingToken) {
    console.warn('[webhook] rejected request with bad signing token');
    return res.status(401).json({ error: 'invalid signing token' });
  }

  // PluralKit sends PING events to verify the endpoint is live and validating.
  if (body.type === 'PING') {
    console.log('[webhook] PING from PluralKit — acknowledged');
    return res.status(200).json({ ok: true });
  }

  // Acknowledge immediately; process asynchronously.
  res.status(200).json({ ok: true });

  handleDispatch(body).catch(e =>
    console.error(`[dispatch] error handling ${body.type}:`, e.message)
  );
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);
wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log(`[ws] client connected (${wss.clients.size} total)`);

  // Send full state immediately on connect
  sendSnapshot(ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Client can request a fresh snapshot at any time (e.g. after navigation)
    if (msg.event === 'get_current_fronts' || msg.event === 'get_last_fronted_all') {
      sendSnapshot(ws);
    }
  });

  ws.on('close',  () => console.log(`[ws] client disconnected (${wss.clients.size} remaining)`));
  ws.on('error',  (e) => console.error('[ws] client error:', e.message));
});

// ─── Optional polling ─────────────────────────────────────────────────────────

async function poll() {
  try {
    await loadCurrentFronters();
    await loadSwitchHistory();
    broadcast({
      event:   'fronts_snapshot',
      fronts:  currentFronters.map(wrapMember),
    });
    broadcast({
      event:   'last_fronted_all',
      history: lastFrontedMap,
    });
  } catch (e) {
    console.error('[poll] error:', e.message);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('[boot] loading initial state from PluralKit API…');
  await loadCurrentFronters();
  await loadSwitchHistory();
  console.log('[boot] initial state loaded');

  server.listen(CONFIG.port, () => {
    console.log(`[boot] pk-relay listening on port ${CONFIG.port}`);
    console.log(`[boot] webhook endpoint: POST http://localhost:${CONFIG.port}/webhook`);
  });

  if (CONFIG.pollIntervalMs > 0) {
    setInterval(poll, CONFIG.pollIntervalMs);
    console.log(`[boot] polling every ${CONFIG.pollIntervalMs / 1000}s as fallback`);
  }
})();
