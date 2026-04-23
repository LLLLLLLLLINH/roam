const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static('.'));

// ── Data store — persisted to a JSON file ─────────────────────
const DATA_FILE = path.join('/tmp', 'roam_data.json');

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(_) { return { gardens: {}, users: {}, events: {} }; }
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data)); } catch(_) {}
}

// ── CORS ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
  if(req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── API: Sync user (upsert) ────────────────────────────────────
app.post('/api/user', (req, res) => {
  const { username, passwordHash, name, color, gardenId, joinedAt, pending, isOwner } = req.body;
  if(!username || !gardenId) return res.status(400).json({ error: 'Missing fields' });
  const data = loadData();
  data.users = data.users || {};
  // Don't overwrite password if already set and new one is empty
  const existing = data.users[username] || {};
  data.users[username] = {
    username, name, color, gardenId, joinedAt, pending: !!pending, isOwner: !!isOwner,
    password: passwordHash || existing.password || ''
  };
  saveData(data);
  res.json({ ok: true });
});

// ── API: Get all users for a garden ───────────────────────────
app.get('/api/garden/:gardenId/users', (req, res) => {
  const data = loadData();
  const users = Object.values(data.users || {})
    .filter(u => u.gardenId === req.params.gardenId)
    .map(u => ({ ...u, password: undefined })); // never send passwords
  res.json(users);
});

// ── API: Approve member ────────────────────────────────────────
app.post('/api/garden/:gardenId/approve', (req, res) => {
  const { username } = req.body;
  const data = loadData();
  if(data.users[username] && data.users[username].gardenId === req.params.gardenId) {
    data.users[username].pending = false;
    saveData(data);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'User not found' });
});

// ── API: Deny/remove member ────────────────────────────────────
app.delete('/api/garden/:gardenId/user/:username', (req, res) => {
  const data = loadData();
  if(data.users[req.params.username]?.gardenId === req.params.gardenId) {
    delete data.users[req.params.username];
    saveData(data);
  }
  res.json({ ok: true });
});

// ── API: Get events for a garden ──────────────────────────────
app.get('/api/garden/:gardenId/events', (req, res) => {
  const data = loadData();
  res.json((data.events || {})[req.params.gardenId] || []);
});

// ── API: Save events for a garden ─────────────────────────────
app.put('/api/garden/:gardenId/events', (req, res) => {
  const events = req.body;
  if(!Array.isArray(events)) return res.status(400).json({ error: 'Expected array' });
  const data = loadData();
  data.events = data.events || {};
  data.events[req.params.gardenId] = events;
  saveData(data);
  res.json({ ok: true });
});

// ── API: Look up garden by 6-digit code ───────────────────────
app.get('/api/lookup-code/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const data = loadData();
  // Find all unique gardenIds on the server and check their deterministic codes
  const gardenIds = [...new Set(Object.values(data.users || {}).map(u => u.gardenId).filter(Boolean))];
  const match = gardenIds.find(gid => gardenCodeFromId(gid) === code);
  if(match) return res.json({ gardenId: match });
  res.status(404).json({ error: 'Code not found' });
});

// Deterministic code function (mirrors client-side)
function gardenCodeFromId(gardenId) {
  let h = 0x811c9dc5;
  for(let i = 0; i < gardenId.length; i++) { h ^= gardenId.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(36).toUpperCase().padStart(6,'0').slice(-6);
}

// ── API: Login check ──────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, passwordHash } = req.body;
  const data = loadData();
  const user = data.users[username];
  if(!user) return res.status(401).json({ error: 'User not found' });
  if(user.password && user.password !== passwordHash) return res.status(401).json({ error: 'Wrong password' });
  res.json({ ...user, password: undefined });
});

// ── Serve app ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log('Roam. server running on', PORT));
