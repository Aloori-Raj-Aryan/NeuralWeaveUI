# NeuralWeaveUI - Local Node Editor

This is a minimal local web UI to visually assemble nodes (blocks) from the `blocks/` folder.

Quick start:

```bash
cd /path/to/NeuralWeaveUI
npm install
npm start
# open http://localhost:3000
```

Features:
- Palette populated from `blocks/**/*.json`
- Drag-and-drop (drag node header) nodes on canvas
- Click a node to open the right-hand properties pane (init arguments)
- The "Save Node" button is enabled only when all `required: True` init args are filled
- Connect node outputs to other node inputs (many-to-many allowed)
- Outputs show as multiple handles when block `output` is an array
- Save/export graph to `saved_graphs/` via `POST /api/save_graph`
- Add a new block JSON file under `blocks/` and click the Reload Blocks button in the UI to load it automatically

Notes:
- This is a minimal prototype; feel free to request additional UX/feature improvements.
