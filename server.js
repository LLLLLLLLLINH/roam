const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static('.'));

// ── CORS ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if(req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── JSONBin persistent store ───────────────────────────────────
const JSONBIN_BIN_ID  = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

let store = { users: {}, events: {} };
let storeReady = false;
let saveQueued = null;
let loadAttempts = 0;

async function loadFromCloud() {
  if(!JSONBIN_BIN_ID || !JSONBIN_API_KEY) { storeReady = true; return; }
  loadAttempts++;
  try {
    const r = await fetch(JSONBIN_URL + '/latest', {
      headers: { 'X-Master-Key': JSONBIN_API_KEY },
    });
    if(r.ok) {
      const j = await r.json();
      const loaded = j.record || {};
      // Only use loaded data if it has actual content
      if(loaded.users || loaded.events) {
        store = { users: loaded.users || {}, events: loaded.events || {} };
        console.log(`Loaded from JSONBin: ${Object.keys(store.users).length} users, ${Object.keys(store.events).length} gardens`);
      }
      storeReady = true;
    } else {
      console.log('JSONBin load HTTP error:', r.status);
      // Retry once after 3s
      if(loadAttempts < 3) setTimeout(loadFromCloud, 3000);
      else storeReady = true;
    }
  } catch(e) {
    console.log('JSONBin load failed:', e.message);
    if(loadAttempts < 3) setTimeout(loadFromCloud, 3000);
    else storeReady = true;
  }
}

async function saveToCloud() {
  if(!JSONBIN_BIN_ID || !JSONBIN_API_KEY) return;
  // Debounce — cancel pending save and schedule new one
  if(saveQueued) clearTimeout(saveQueued);
  saveQueued = setTimeout(async () => {
    saveQueued = null;
    try {
      const r = await fetch(JSONBIN_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
        body: JSON.stringify(store)
      });
      if(r.ok) console.log('Saved to JSONBin');
      else console.log('JSONBin save error:', r.status);
    } catch(e) { console.log('JSONBin save failed:', e.message); }
  }, 800);
}

// Load on startup
loadFromCloud();

// ── Wait for store — with longer timeout and retry ─────────────
async function waitForStore() {
  if(storeReady) return;
  // Wait up to 8 seconds for JSONBin load
  for(let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 500));
    if(storeReady) return;
  }
  console.log('Store wait timeout — proceeding with current state');
  storeReady = true;
}

function ready(fn) {
  return async (req, res) => {
    await waitForStore();
    fn(req, res);
  };
}

// ── Deterministic code from gardenId ──────────────────────────
function gardenCodeFromId(gardenId) {
  let h = 0x811c9dc5;
  for(let i = 0; i < gardenId.length; i++) { h ^= gardenId.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(36).toUpperCase().padStart(6,'0').slice(-6);
}

// ── API ────────────────────────────────────────────────────────

// Upsert user
app.post('/api/user', ready((req, res) => {
  const { username, passwordHash, name, color, gardenId, joinedAt, pending, isOwner } = req.body;
  if(!username || !gardenId) return res.status(400).json({ error: 'Missing fields' });
  const existing = (store.users || {})[username] || {};
  store.users = store.users || {};
  store.users[username] = {
    username, name, color, gardenId, joinedAt,
    pending: !!pending, isOwner: !!isOwner,
    password: passwordHash || existing.password || ''
  };
  saveToCloud();
  res.json({ ok: true });
}));

// Get users for a garden
app.get('/api/garden/:gardenId/users', ready((req, res) => {
  const users = Object.values(store.users || {})
    .filter(u => u.gardenId === req.params.gardenId)
    .map(u => ({ ...u, password: undefined }));
  res.json(users);
}));

// Approve member
app.post('/api/garden/:gardenId/approve', ready((req, res) => {
  const { username } = req.body;
  if(store.users[username]?.gardenId === req.params.gardenId) {
    store.users[username].pending = false;
    saveToCloud();
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'User not found' });
}));

// Remove member
app.delete('/api/garden/:gardenId/user/:username', ready((req, res) => {
  if(store.users[req.params.username]?.gardenId === req.params.gardenId) {
    delete store.users[req.params.username];
    saveToCloud();
  }
  res.json({ ok: true });
}));

// Get events — NEVER returns empty if we have data
app.get('/api/garden/:gardenId/events', ready((req, res) => {
  const events = (store.events || {})[req.params.gardenId];
  // Return null if no data for this garden (client should keep localStorage)
  // Return [] only if explicitly saved as empty
  if(events === undefined) return res.json(null);
  res.json(events);
}));

// Save events — reject empty arrays if server already has data (protection against cold-start wipe)
app.put('/api/garden/:gardenId/events', ready((req, res) => {
  if(!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  const gid = req.params.gardenId;
  const existing = (store.events || {})[gid];
  // Refuse to overwrite real data with empty array
  if(req.body.length === 0 && existing && existing.length > 0) {
    console.log(`Refused to overwrite ${existing.length} events with empty array for garden ${gid}`);
    return res.json({ ok: true, skipped: true });
  }
  store.events = store.events || {};
  store.events[gid] = req.body;
  saveToCloud();
  res.json({ ok: true });
}));

// Lookup garden by 6-digit code
app.get('/api/lookup-code/:code', ready((req, res) => {
  const code = req.params.code.toUpperCase();
  const gardenIds = [...new Set(Object.values(store.users || {}).map(u => u.gardenId).filter(Boolean))];
  const match = gardenIds.find(gid => gardenCodeFromId(gid) === code);
  if(match) return res.json({ gardenId: match });
  res.status(404).json({ error: 'Code not found' });
}));

// Login
app.post('/api/login', ready((req, res) => {
  const { username, passwordHash } = req.body;
  const user = (store.users || {})[username];
  if(!user) return res.status(401).json({ error: 'User not found' });
  if(user.password && user.password !== passwordHash) return res.status(401).json({ error: 'Wrong password' });
  res.json({ ...user, password: undefined });
}));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    storeReady,
    users: Object.keys(store.users||{}).length,
    gardens: Object.keys(store.events||{}).length
  });
});

// ── WebSocket real-time sync ───────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Track connections by gardenId
const gardenSockets = new Map(); // gardenId -> Set<ws>

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const gardenId = params.get('garden');
  const username = params.get('user');
  if(!gardenId) { ws.close(); return; }

  if(!gardenSockets.has(gardenId)) gardenSockets.set(gardenId, new Set());
  gardenSockets.get(gardenId).add(ws);
  console.log(`WS connected: ${username} in garden ${gardenId}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      // Broadcast to all OTHER connections in same garden
      const sockets = gardenSockets.get(msg.gardenId || gardenId);
      if(sockets) {
        sockets.forEach(client => {
          if(client !== ws && client.readyState === 1) {
            client.send(JSON.stringify(msg));
          }
        });
      }
    } catch(_) {}
  });

  ws.on('close', () => {
    const sockets = gardenSockets.get(gardenId);
    if(sockets) { sockets.delete(ws); if(sockets.size === 0) gardenSockets.delete(gardenId); }
  });

  ws.on('error', () => ws.close());
});

// ── Server-side URL fetch (bypasses CORS for Eventbrite, Humanitix etc) ──
app.get('/api/fetch-event-url', async (req, res) => {
  const url = req.query.url;
  if(!url) return res.status(400).json({ error: 'No URL' });
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,*/*',
        'Accept-Language': 'en-AU,en;q=0.9',
        'Origin': 'https://www.eventbrite.com.au',
        'Referer': 'https://www.eventbrite.com.au/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if(!r.ok) return res.status(r.status).json({ error: 'Fetch failed', status: r.status });

    const contentType = r.headers.get('content-type') || '';

    if(contentType.includes('application/json')) {
      // Return JSON APIs directly
      const data = await r.json();
      return res.json({ ok: true, json: data });
    }

    const html = await r.text();
    // Extract meta, scripts, title for HTML pages
    const meta = (html.match(/<meta[^>]+>/gi)||[]).join('\n');
    const scripts = (html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)||[])
      .concat(html.match(/<script[^>]*>([\s\S]{50,8000}?)<\/script>/gi)||[])
      .slice(0,10).join('\n');
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]||'';
    res.json({ meta, scripts, title, ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Start with WebSocket support
server.listen(PORT, () => console.log('Roam. server (WS enabled) on port', PORT));
