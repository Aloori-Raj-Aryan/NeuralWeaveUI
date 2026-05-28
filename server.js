const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { readdirSync } = require('fs');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json({ limit: '5mb' }));

// Helper: recursively read JSON files under blocks/
async function readBlocks() {
  const base = path.join(__dirname, 'blocks');
  const results = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.json')) {
        try {
          const content = await fs.readFile(full, 'utf8');
          const parsed = JSON.parse(content);
          parsed.__file = path.relative(base, full).replace(/\\/g, '/');
          results.push(parsed);
        } catch (err) {
          console.error('Failed to read/parse', full, err.message);
        }
      }
    }
  }

  await walk(base);
  return results;
}

app.get('/api/blocks', async (req, res) => {
  try {
    const blocks = await readBlocks();
    res.json({ ok: true, blocks });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Save graph to workspace/saved_graphs/graphs.json
app.post('/api/save_graph', async (req, res) => {
  try {
    const graphsDir = path.join(__dirname, 'saved_graphs');
    try { await fs.mkdir(graphsDir); } catch (e) {}
    const name = req.body.name || `graph-${Date.now()}.json`;
    const dest = path.join(graphsDir, name);
    await fs.writeFile(dest, JSON.stringify(req.body.graph, null, 2), 'utf8');
    res.json({ ok: true, path: path.relative(__dirname, dest) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});
