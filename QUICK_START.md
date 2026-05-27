# Quick Start Guide

## ⭐ Recommended: All Platforms (Windows, Mac, Linux)

```bash
python launch.py
```

This single command works on all platforms without requiring bash or WSL.

## Windows Users (Alternative)

1. **Double-click** `run.bat` to launch the editor
2. The script will:
   - Create a virtual environment (first run only)
   - Install dependencies
   - Start the NeuralWeave Pipeline Editor

## Mac/Linux Users (Alternative)

1. **Run** `bash run.sh` in terminal
2. The script will:
   - Create a virtual environment (first run only)
   - Install dependencies
   - Start the NeuralWeave Pipeline Editor

## Manual Setup

If the scripts don't work, follow these steps:

```bash
# Create virtual environment
python -m venv venv

# Activate it
# Windows:
venv\Scripts\activate
# Mac/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the editor
python run_editor.py
```

## First Steps in the Editor

1. **Load Blocks**: The left panel automatically loads all blocks from `block_info/`
2. **Add Node**: Select a block (e.g., "module/Linear") and click "Add to Canvas"
3. **Connect**: Click an output socket (red) on one node and drag to an input socket (green) on another
4. **Configure**: Double-click a node to set parameters
5. **Save**: File → Save Pipeline to export your pipeline as JSON

## Example Workflow

Creating a simple neural network pipeline:

1. Add `module/Linear` node
2. Add `functional/relu` node
3. Add another `module/Linear` node
4. Connect: Linear (output) → ReLU (input) → Linear (input)
5. Configure each Linear layer with input/output features
6. Save the pipeline

## Tips & Tricks

- **Right-click Context Menu** (coming soon)
- **Grid Snapping** (coming soon)
- **Zoom** - Use mouse wheel to zoom in/out on canvas
- **Pan** - Click and drag background to pan
- **Move Nodes** - Click and drag any node
- **View Details** - Select a block in the list to see full documentation

## Architecture

```
NeuralWeaveUI/
├── block_info/              # JSON block definitions
│   ├── builtin/
│   ├── functional/
│   └── module/
├── src/
│   ├── pipeline_editor.py   # Main editor UI
│   └── utils/
├── run_editor.py            # Entry point
├── run.bat / run.sh         # Launch scripts
├── requirements.txt         # Python dependencies
└── FRONTEND_README.md       # Full documentation
```

## Saving Your First Pipeline

After creating a pipeline:

1. Go to **File** → **Save Pipeline**
2. Choose a location and filename
3. The pipeline is saved as JSON and can be loaded later

## Loading a Pipeline

1. Go to **File** → **Load Pipeline**
2. Select a previously saved pipeline JSON file
3. Your nodes and connections are restored

---

**Enjoy building with NeuralWeave!**
