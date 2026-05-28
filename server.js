const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const bodyParser = require('body-parser');

const SERVER_VERSION = '0.2.0';
const app = express();
const PORT = process.env.PORT || 3000;
const GRAPHS_ROOT = path.join(__dirname, 'saved_graphs');
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createSessionId(){
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function removePathRecursive(targetPath){
  try {
    if (typeof fs.rm === 'function'){
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    }
    await fs.rmdir(targetPath, { recursive: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    if (err && err.code === 'ENOTDIR'){
      await fs.unlink(targetPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
      return;
    }
    // Node 12 fallback: delete contents manually
    let entries = [];
    try {
      entries = await fs.readdir(targetPath, { withFileTypes: true });
    } catch (readErr) {
      if (readErr.code === 'ENOENT') return;
      throw readErr;
    }
    for (const entry of entries){
      const full = path.join(targetPath, entry.name);
      if (entry.isDirectory()) await removePathRecursive(full);
      else await fs.unlink(full);
    }
    await fs.rmdir(targetPath);
  }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json({ limit: '5mb' }));

function getSessionId(req){
  return req.get('X-Session-Id') || req.body.sessionId || req.query.sessionId;
}

function validateSessionId(sessionId){
  return sessionId && SESSION_ID_RE.test(sessionId);
}

function sessionDir(sessionId){
  return path.join(GRAPHS_ROOT, sessionId);
}

function safeGraphFilename(name){
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..') throw new Error('Invalid graph name');
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.endsWith('.json') ? safe : `${safe}.json`;
}

async function ensureGraphsRoot(){
  await fs.mkdir(GRAPHS_ROOT, { recursive: true });
}

async function readBlocks(){
  const base = path.join(__dirname, 'blocks');
  const results = [];

  async function walk(dir){
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries){
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.json')){
        try {
          const content = await fs.readFile(full, 'utf8');
          const parsed = JSON.parse(content);
          parsed.__file = path.relative(base, full).replace(/\\/g, '/');
          results.push(parsed);
        } catch (err){
          console.error('Failed to read/parse', full, err.message);
        }
      }
    }
  }

  await walk(base);
  return results;
}

async function requireSession(req, res){
  const sessionId = getSessionId(req);
  if (!validateSessionId(sessionId)){
    res.status(400).json({ ok: false, error: 'Missing or invalid session id' });
    return null;
  }
  try {
    await fs.access(sessionDir(sessionId));
    return sessionId;
  } catch {
    res.status(404).json({ ok: false, error: 'Session not found' });
    return null;
  }
}

async function deleteSessionData(sessionId){
  if (!validateSessionId(sessionId)) return;
  await removePathRecursive(sessionDir(sessionId));
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: SERVER_VERSION,
    node: process.version,
    sessionApi: true
  });
});

app.get('/api/blocks', async (req, res) => {
  try {
    const blocks = await readBlocks();
    res.json({ ok: true, blocks });
  } catch (err){
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function cleanupOtherSessions(keepSessionId){
  await ensureGraphsRoot();
  const entries = await fs.readdir(GRAPHS_ROOT, { withFileTypes: true });
  for (const e of entries){
    if (!e.isDirectory() || e.name === keepSessionId) continue;
    if (!validateSessionId(e.name)) continue;
    await removePathRecursive(path.join(GRAPHS_ROOT, e.name));
  }
}

app.post('/api/session', async (req, res) => {
  try {
    await ensureGraphsRoot();
    const sessionId = createSessionId();
    await fs.mkdir(sessionDir(sessionId), { recursive: true });
    if (req.body && req.body.cleanOthers){
      try {
        await cleanupOtherSessions(sessionId);
      } catch (cleanupErr) {
        console.warn('Session cleanup skipped:', cleanupErr.message);
      }
    }
    res.json({ ok: true, sessionId });
  } catch (err){
    console.error('POST /api/session failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/session/:sessionId', async (req, res) => {
  try {
    if (!validateSessionId(req.params.sessionId)){
      return res.status(400).json({ ok: false, error: 'Invalid session id' });
    }
    await fs.access(sessionDir(req.params.sessionId));
    res.json({ ok: true, sessionId: req.params.sessionId });
  } catch {
    res.status(404).json({ ok: false, error: 'Session not found' });
  }
});

app.delete('/api/session/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    if (!validateSessionId(sessionId)){
      return res.status(400).json({ ok: false, error: 'Invalid session id' });
    }
    await deleteSessionData(sessionId);
    res.json({ ok: true });
  } catch (err){
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/graphs', async (req, res) => {
  try {
    const sessionId = await requireSession(req, res);
    if (!sessionId) return;

    const dir = sessionDir(sessionId);
    let entries = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      entries = [];
    }

    const graphs = [];
    for (const name of entries.filter(f => f.endsWith('.json'))){
      const stat = await fs.stat(path.join(dir, name));
      graphs.push({ name, updatedAt: stat.mtime.toISOString() });
    }
    graphs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json({ ok: true, graphs });
  } catch (err){
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/graphs/:name', async (req, res) => {
  try {
    const sessionId = await requireSession(req, res);
    if (!sessionId) return;

    const filename = safeGraphFilename(req.params.name);
    const filePath = path.join(sessionDir(sessionId), filename);
    const content = await fs.readFile(filePath, 'utf8');
    res.json({ ok: true, graph: JSON.parse(content), name: filename });
  } catch (err){
    if (err.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'Graph not found' });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/save_graph', async (req, res) => {
  try {
    const sessionId = await requireSession(req, res);
    if (!sessionId) return;

    const filename = safeGraphFilename(req.body.name || `graph-${Date.now()}.json`);
    const dest = path.join(sessionDir(sessionId), filename);
    await fs.writeFile(dest, JSON.stringify(req.body.graph, null, 2), 'utf8');
    res.json({ ok: true, name: filename });
  } catch (err){
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/graphs/:name', async (req, res) => {
  try {
    const sessionId = await requireSession(req, res);
    if (!sessionId) return;

    const filename = safeGraphFilename(req.params.name);
    await fs.unlink(path.join(sessionDir(sessionId), filename));
    res.json({ ok: true });
  } catch (err){
    if (err.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'Graph not found' });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`NeuralWeaveUI v${SERVER_VERSION} (Node ${process.version})`);
  console.log(`Server listening at http://localhost:${PORT}`);
  console.log('Health check: GET /api/health');
});
