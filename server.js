const express = require('express');
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

// ── In-memory store + write-through to JSONBin ────────────────
// JSONBin.io: free persistent JSON storage, 10,000 req/day free
// Set JSONBIN_BIN_ID and JSONBIN_API_KEY as Render env variables
const JSONBIN_BIN_ID  = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

let store = { users: {}, events: {} };
let storeReady = false;
let saveQueued = false;

async function loadFromCloud() {
  if(!JSONBIN_BIN_ID || !JSONBIN_API_KEY) { storeReady = true; return; }
  try {
    const r = await fetch(JSONBIN_URL + '/latest', {
      headers: { 'X-Master-Key': JSONBIN_API_KEY }
    });
    if(r.ok) {
      const j = await r.json();
      store = j.record || store;
      console.log('Loaded from JSONBin:', Object.keys(store.users||{}).length, 'users');
    }
  } catch(e) { console.log('JSONBin load failed:', e.message); }
  storeReady = true;
}

async function saveToCloud() {
  if(!JSONBIN_BIN_ID || !JSONBIN_API_KEY) return;
  if(saveQueued) return;
  saveQueued = true;
  setTimeout(async () => {
    saveQueued = false;
    try {
      await fetch(JSONBIN_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
        body: JSON.stringify(store)
      });
    } catch(e) { console.log('JSONBin save failed:', e.message); }
  }, 500); // debounce 500ms
}

loadFromCloud();

// ── Wait for store to be ready ─────────────────────────────────
function ready(fn) {
  return async (req, res) => {
    if(!storeReady) await new Promise(r => setTimeout(r, 1000));
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
  const existing = (store.users||{})[username] || {};
  store.users = store.users || {};
  store.users[username] = {
    username, name, color, gardenId, joinedAt, pending: !!pending, isOwner: !!isOwner,
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

// Get events
app.get('/api/garden/:gardenId/events', ready((req, res) => {
  res.json((store.events || {})[req.params.gardenId] || []);
}));

// Save events
app.put('/api/garden/:gardenId/events', ready((req, res) => {
  if(!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  store.events = store.events || {};
  store.events[req.params.gardenId] = req.body;
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
app.get('/api/health', (req, res) => res.json({ ok: true, users: Object.keys(store.users||{}).length }));

app.listen(PORT, () => console.log('Roam. server on port', PORT));
