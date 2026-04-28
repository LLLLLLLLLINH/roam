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

// ── Real event search — RA + Google + Eventbrite + Meetup ─────
app.get('/api/explore-events', async (req, res) => {
  const { lat, lng, label, start, end, when } = req.query;
  if(!lat || !lng) return res.status(400).json({ error: 'lat/lng required' });

  const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
  const startDate = start || new Date().toISOString().slice(0,10);
  const endDate   = end   || new Date(Date.now() + 30*86400000).toISOString().slice(0,10);
  const location  = label || `${lat},${lng}`;
  const results   = [];

  const fetchSafe = async (url, opts={}, ms=12000) => {
    try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) }); }
    catch(_) { return null; }
  };

  // ── 1. SerpAPI Google Events — best for community/free events ──
  // Indexes Facebook Events, council sites, Eventbrite free, local blogs
  const fetchGoogle = async () => {
    if(!SERPAPI_KEY) return;
    try {
      const whenParam = when==='weekend' ? 'this_weekend' : when==='week' ? 'next_week' : 'next_month';
      const queries = [
        `free events ${location} this weekend`,
        `markets ${location}`,
        `community events ${location}`,
        `things to do ${location}`,
        `local events ${location}`,
      ];
      const seen = new Set();
      for(const q of queries) {
        const url = `https://serpapi.com/search.json?engine=google_events&q=${encodeURIComponent(q)}&location=${encodeURIComponent(location + ', Australia')}&hl=en&gl=au&htichips=date:${whenParam}&api_key=${SERPAPI_KEY}`;
        const r = await fetchSafe(url, {}, 8000);
        if(!r?.ok) continue;
        const data = await r.json();
        for(const e of (data.events_results || []).slice(0, 10)) {
          if(!e.title) continue;
          const key = e.title.toLowerCase().slice(0,30);
          if(seen.has(key)) continue; seen.add(key);
          results.push({
            id: 'serp_'+Buffer.from(e.title+(e.date?.start_date||'')).toString('base64').slice(0,14),
            name: e.title,
            date: parseGoogleDate(e.date?.start_date, e.date?.when),
            time: parseGoogleTime(e.date?.when),
            location: [e.venue?.name, e.address?.[0], e.address?.[1]].filter(Boolean).join(', '),
            suburb: e.address?.[1] || location,
            category: guessCategory(e.title+' '+(e.description||'')),
            url: e.link || e.ticket_info?.[0]?.link,
            image: e.thumbnail,
            description: e.description || '',
            priceRange: e.ticket_info?.[0]?.price || 'Free',
            source: 'Google Events'
          });
        }
      }
      console.log('Google:', results.filter(r=>r.source==='Google Events').length, 'events');
    } catch(e) { console.log('SerpAPI error:', e.message); }
  };

  // ── 2. Resident Advisor — music/club/electronic ────────────────
  const fetchRA = async () => {
    try {
      const citySlug = deriveRACity(location, lat, lng);
      const query = JSON.stringify({
        query: `query EventListings($filters:FilterInputDtoInput,$pageSize:Int){
          eventListings(filters:$filters,pageSize:$pageSize,page:1,sort:{startTime:ASCENDING}){
            data{event{id title date startTime images{filename}venue{name area{name}}
              pick{blurb}artists{name}cost contentUrl}}}}`,
        variables: {
          filters: { areas:{slug:citySlug}, listingDate:{gte:startDate,lte:endDate} },
          pageSize: 15
        }
      });
      const r = await fetchSafe('https://ra.co/graphql', {
        method:'POST',
        headers:{'Content-Type':'application/json','Accept':'application/json',
          'User-Agent':'Mozilla/5.0','Referer':'https://ra.co','Origin':'https://ra.co'},
        body: query
      });
      if(!r?.ok) return;
      const data = await r.json();
      for(const item of (data?.data?.eventListings?.data || [])) {
        const e = item.event; if(!e?.title) continue;
        const dt = e.startTime || e.date || '';
        const artists = (e.artists||[]).map(a=>a.name).filter(Boolean);
        results.push({
          id: 'ra_'+e.id, name: e.title,
          date: dt.slice(0,10), time: dt.length>10 ? dt.slice(11,16) : null,
          location: [e.venue?.name, e.venue?.area?.name].filter(Boolean).join(', '),
          suburb: e.venue?.area?.name || location, category: 'music',
          url: e.contentUrl ? 'https://ra.co'+e.contentUrl : 'https://ra.co/events',
          image: e.images?.[0]?.filename ? 'https://ra.co'+e.images[0].filename : null,
          description: [e.pick?.blurb, artists.length ? 'Artists: '+artists.join(', ') : null].filter(Boolean).join('\n\n'),
          priceRange: e.cost || null, source: 'Resident Advisor'
        });
      }
      console.log('RA:', results.filter(r=>r.source==='Resident Advisor').length, 'events');
    } catch(e) { console.log('RA error:', e.message); }
  };

  // ── 3. Meetup — community groups, social events ────────────────
  const fetchMeetup = async () => {
    try {
      const body = JSON.stringify({
        operationName: 'recommendedEventsWithSeries',
        variables: {
          first: 20, lat: parseFloat(lat), lon: parseFloat(lng),
          radius: 30, startDateRange: startDate+'T00:00:00',
          endDateRange: endDate+'T23:59:59', eventType: 'PHYSICAL'
        },
        query: `query recommendedEventsWithSeries($lat:Float!,$lon:Float!,$radius:Int,$first:Int,$startDateRange:ZonedDateTime,$endDateRange:ZonedDateTime,$eventType:EventType){
          result:recommendedEvents(filter:{lat:$lat,lon:$lon,radius:$radius,startDateRange:$startDateRange,endDateRange:$endDateRange,eventType:$eventType},first:$first){
            edges{node{id title dateTime description{html}
              venue{name city} eventUrl isFree
              images{baseUrl} group{name} topics{name}
            }}
          }
        }`
      });
      const r = await fetchSafe('https://www.meetup.com/gql', {
        method:'POST',
        headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'Mozilla/5.0'},
        body
      }, 8000);
      if(!r?.ok) return;
      const data = await r.json();
      for(const edge of (data?.data?.result?.edges || [])) {
        const e = edge.node; if(!e?.title) continue;
        const dt = e.dateTime || '';
        results.push({
          id: 'mu_'+e.id, name: e.title,
          date: dt.slice(0,10), time: dt.slice(11,16)||null,
          location: [e.venue?.name, e.venue?.city].filter(Boolean).join(', '),
          suburb: e.venue?.city || location,
          category: guessCategory((e.topics||[]).map(t=>t.name).join(' ')+' '+e.title),
          url: e.eventUrl, image: e.images?.[0]?.baseUrl,
          description: [
            (e.description?.html||'').replace(/<[^>]*>/g,'').slice(0,300),
            e.group?.name ? `Organised by: ${e.group.name}` : null
          ].filter(Boolean).join('\n\n'),
          priceRange: e.isFree ? 'Free' : null,
          source: 'Meetup'
        });
      }
      console.log('Meetup:', results.filter(r=>r.source==='Meetup').length, 'events');
    } catch(e) { console.log('Meetup error:', e.message); }
  };

  // ── 4. Eventbrite free/community events ───────────────────────
  const fetchEventbrite = async () => {
    try {
      const city = deriveEBCity(location, lat, lng);
      // Target free and community categories specifically
      const pages = [
        `https://www.eventbrite.com.au/d/australia--${city}/free--events/?start_date=${startDate}&end_date=${endDate}`,
        `https://www.eventbrite.com.au/d/australia--${city}/community--events/?start_date=${startDate}&end_date=${endDate}`,
        `https://www.eventbrite.com.au/d/australia--${city}/food-and-drink--events/?start_date=${startDate}&end_date=${endDate}`,
        `https://www.eventbrite.com.au/d/australia--${city}/arts--events/?start_date=${startDate}&end_date=${endDate}`,
      ];
      for(const url of pages) {
        const r = await fetchSafe(url, { headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html', 'Accept-Language': 'en-AU,en;q=0.9'
        }}, 14000);
        if(!r?.ok) continue;
        const html = await r.text();
        // Extract JSON-LD structured data
        for(const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
          try {
            const raw = JSON.parse(m[1]);
            const items = Array.isArray(raw) ? raw : (raw['@graph'] || [raw]);
            for(const item of items) {
              if(item['@type'] !== 'Event' || !item.name) continue;
              const dt = item.startDate || '';
              const price = parseFloat(item.offers?.price);
              results.push({
                id: 'eb_'+Buffer.from(item.name+(item.startDate||'')).toString('base64').slice(0,14),
                name: item.name, date: dt.slice(0,10),
                time: dt.length>10 ? dt.slice(11,16) : null,
                location: [item.location?.name, item.location?.address?.streetAddress, item.location?.address?.addressLocality].filter(Boolean).join(', '),
                suburb: item.location?.address?.addressLocality,
                category: guessCategory(item.name+' '+(item.description||'')),
                url: item.url,
                image: Array.isArray(item.image) ? item.image[0] : item.image,
                description: (item.description||'').replace(/<[^>]*>/g,'').slice(0,400),
                priceRange: isNaN(price) ? null : (price === 0 ? 'Free' : '$'+price.toFixed(0)),
                source: 'Eventbrite'
              });
            }
          } catch(_) {}
        }
      }
      console.log('Eventbrite:', results.filter(r=>r.source==='Eventbrite').length, 'events');
    } catch(e) { console.log('Eventbrite error:', e.message); }
  };

  // ── 5. Humanitix — Australian community/charity events ─────────
  const fetchHumanitix = async () => {
    try {
      const startISO = startDate + 'T00:00:00';
      const endISO   = endDate   + 'T23:59:59';
      const url = `https://events.humanitix.com/api/v1/events/search?lat=${lat}&lng=${lng}&radius=30&startDate=${startISO}&endDate=${endISO}&limit=15&status=published`;
      const r = await fetchSafe(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }, 8000);
      if(!r?.ok) return;
      const data = await r.json();
      for(const e of (data.events || []).slice(0,15)) {
        if(!e.name) continue;
        results.push({
          id: 'hx_'+e._id, name: e.name,
          date: e.startDate?.slice(0,10), time: e.startDate?.slice(11,16),
          location: [e.location?.name, e.location?.suburb, e.location?.state].filter(Boolean).join(', '),
          suburb: e.location?.suburb,
          category: guessCategory((e.tags||[]).join(' ')+' '+e.name),
          url: 'https://events.humanitix.com/'+e.slug,
          image: e.coverImage?.url,
          description: (e.description||'').replace(/<[^>]*>/g,'').slice(0,400),
          priceRange: e.isFree ? 'Free' : (e.minPrice ? '$'+e.minPrice+(e.maxPrice&&e.maxPrice!==e.minPrice?'–$'+e.maxPrice:'') : null),
          source: 'Humanitix'
        });
      }
      console.log('Humanitix:', results.filter(r=>r.source==='Humanitix').length, 'events');
    } catch(e) { console.log('Humanitix error:', e.message); }
  };

  await Promise.allSettled([fetchGoogle(), fetchRA(), fetchMeetup(), fetchEventbrite(), fetchHumanitix()]);

  // Filter to correct city using coordinates
  const expectedCity = deriveEBCity(location, lat, lng);
  const cityKeywords = {
    sydney:      /sydney|nsw|barangaroo|pyrmont|newtown|bondi|manly|parramatta|surry.hills|darlinghurst|paddington|glebe|balmain|redfern|waterloo|chippendale|haymarket|ultimo|mosman|chatswood|2\d{3}/i,
    melbourne:   /melbourne|vic|fitzroy|collingwood|richmond|brunswick|st.kilda|southbank|docklands|prahran|windsor|hawthorn|footscray|3\d{3}/i,
    brisbane:    /brisbane|qld|fortitude.valley|south.bank|west.end|new.farm|teneriffe|woolloongabba|4\d{3}/i,
    perth:       /perth|wa|fremantle|subiaco|northbridge|leederville|6\d{3}/i,
    adelaide:    /adelaide|sa|glenelg|5\d{3}/i,
    'gold-coast':/gold.coast|surfers.paradise|broadbeach|burleigh/i,
    australia:   /.*/
  };
  const cityPat = cityKeywords[expectedCity] || /.*/;
  const otherCityPats = {
    sydney:/\bsydney\b/i, melbourne:/\bmelbourne\b/i, brisbane:/\bbrisbane\b/i,
    perth:/\bperth\b/i, adelaide:/\badelaide\b/i, 'gold-coast':/gold.coast/i
  };

  const locationFiltered = results.filter(e => {
    const loc = ((e.location||'')+' '+(e.suburb||'')).trim();
    if(!loc) return true;
    if(cityPat.test(loc)) return true;
    for(const [city, pat] of Object.entries(otherCityPats)) {
      if(city !== expectedCity && pat.test(loc)) return false;
    }
    return true;
  });

  const seen = new Set();
  const unique = locationFiltered.filter(e => {
    if(!e.name || !e.date) return false;
    const key = (e.name+e.date).toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,35);
    if(seen.has(key)) return false; seen.add(key); return true;
  });
  unique.sort((a,b)=>(a.date||'').localeCompare(b.date||'')||(a.time||'').localeCompare(b.time||''));

  console.log(`Total: ${unique.length} events near ${location} [${[...new Set(unique.map(e=>e.source))].join(', ')}]`);
  res.json({ events: unique, sources: [...new Set(unique.map(e=>e.source))] });
});


function deriveRACity(l, lat, lng) {
  // Use coordinates first (most accurate)
  if(lat && lng) {
    const lt = parseFloat(lat), ln = parseFloat(lng);
    if(lt > -34.5 && lt < -33 && ln > 150 && ln < 152) return 'sydney';
    if(lt > -38.5 && lt < -37 && ln > 144 && ln < 146) return 'melbourne';
    if(lt > -28 && lt < -27 && ln > 152 && ln < 154) return 'brisbane';
    if(lt > -32.5 && lt < -31 && ln > 115 && ln < 116.5) return 'perth';
    if(lt > -35.5 && lt < -34.5 && ln > 138 && ln < 139) return 'adelaide';
  }
  l = l.toLowerCase();
  if(/sydney|nsw|2\d{3}/.test(l)) return 'sydney';
  if(/melbourne|vic|fitzroy|collingwood|richmond|3\d{3}/.test(l)) return 'melbourne';
  if(/brisbane|qld|4\d{3}/.test(l)) return 'brisbane';
  if(/perth|wa|6\d{3}/.test(l)) return 'perth';
  if(/adelaide|sa|5\d{3}/.test(l)) return 'adelaide';
  return 'australia';
}

function deriveEBCity(l, lat, lng) {
  // Use coordinates first
  if(lat && lng) {
    const lt = parseFloat(lat), ln = parseFloat(lng);
    if(lt > -34.5 && lt < -33 && ln > 150 && ln < 152) return 'sydney';
    if(lt > -38.5 && lt < -37 && ln > 144 && ln < 146) return 'melbourne';
    if(lt > -28 && lt < -27 && ln > 152 && ln < 154) return 'brisbane';
    if(lt > -32.5 && lt < -31 && ln > 115 && ln < 116.5) return 'perth';
    if(lt > -35.5 && lt < -34.5 && ln > 138 && ln < 139) return 'adelaide';
    if(lt > -28.5 && lt < -27.5 && ln > 153 && ln < 154) return 'gold-coast';
    if(lt > -33.5 && lt < -32.5 && ln > 151 && ln < 152) return 'newcastle';
    if(lt > -34.7 && lt < -34.3 && ln > 150.5 && ln < 151) return 'wollongong';
  }
  l = l.toLowerCase();
  if(/sydney|barangaroo|pyrmont|surry.hills|newtown|glebe|balmain|darlinghurst|paddington|bondi|manly|parramatta|chatswood/.test(l)) return 'sydney';
  if(/melbourne|fitzroy|collingwood|richmond|brunswick|st.kilda|southbank|docklands|prahan/.test(l)) return 'melbourne';
  if(/brisbane|fortitude.valley|south.bank|west.end/.test(l)) return 'brisbane';
  if(/perth|fremantle|subiaco|northbridge/.test(l)) return 'perth';
  if(/adelaide/.test(l)) return 'adelaide';
  if(/gold.coast|surfers/.test(l)) return 'gold-coast';
  return 'australia';
}
function parseGoogleDate(startDate,when){
  if(startDate){if(/^\d{4}-\d{2}-\d{2}$/.test(startDate))return startDate;const m=startDate.match(/(\w+)\s+(\d+),?\s+(\d{4})/);if(m){const mo={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12}[m[1].toLowerCase().slice(0,3)];if(mo)return`${m[3]}-${String(mo).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;}}
  if(when){const m=when.match(/(\w+)\s+(\d+)/);if(m){const mo={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12}[m[1].toLowerCase().slice(0,3)];if(mo)return`${new Date().getFullYear()}-${String(mo).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;}}
  return null;
}
function parseGoogleTime(when){
  if(!when)return null;const m=when.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);if(!m)return null;
  let h=parseInt(m[1]),min=parseInt(m[2]||'0');
  if(m[3].toLowerCase()==='pm'&&h<12)h+=12;if(m[3].toLowerCase()==='am'&&h===12)h=0;
  return`${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}
function guessCategory(text){
  if(!text)return'other';const t=text.toLowerCase();
  if(/rock|pop|jazz|music|concert|hip.?hop|rnb|r&b|electronic|classical|band|gig|dj|acoustic|rave|techno|house|club/.test(t))return'music';
  if(/food|wine|beer|culinary|market|dining|brunch|feast|tasting|coffee/.test(t))return'food';
  if(/art|theatre|theater|film|comedy|dance|exhibition|gallery|opera|circus|museum|standup|improv/.test(t))return'art';
  if(/sport|fitness|run|yoga|swim|marathon|cycling|triathlon|gym|pilates|hike|surf|cricket|football|soccer|tennis/.test(t))return'sports';
  if(/community|festival|fair|market|street|neighbourhood|family|kids|charity|fundrais|volunteer|pride/.test(t))return'community';
  return'other';
}

// Start with WebSocket support
server.listen(PORT, () => console.log('Roam. server (WS enabled) on port', PORT));
