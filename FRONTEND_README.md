# NeuralWeave Pipeline Editor

A Python-based node pipeline editor for building neural network architectures using blocks defined in JSON format.

## Features

- **Visual Node Editor**: Drag-and-drop interface for creating computational pipelines
- **Block Library**: Browse and add blocks from `block_info/` directory (builtin, functional, module)
- **Node Configuration**: Double-click nodes to configure parameters
- **Connection Management**: Draw connections between compatible node sockets
- **Save/Load**: Export and import pipelines as JSON files
- **Block Information**: View documentation and parameters for each block

## Installation

1. Install dependencies:
```bash
pip install -r requirements.txt
```

## Usage

### Launch the Editor

```bash
python run_editor.py
```

### How to Use

1. **View Available Blocks**: The left panel shows all available blocks organized by category (builtin, functional, module)

2. **Add Nodes to Canvas**:
   - Select a block from the list
   - Click "Add to Canvas"
   - Or drag from the list to the canvas

3. **Configure Nodes**:
   - Double-click a node to open configuration dialog
   - Set parameters like dimensions, activation functions, etc.
   - Click OK to save

4. **Connect Nodes**:
   - Click on a socket (green circle = input, red circle = output)
   - Drag to another socket to create a connection
   - Connections follow PyTorch conventions (output → input)

5. **Save/Load Pipelines**:
   - **File → Save Pipeline**: Export your pipeline as JSON
   - **File → Load Pipeline**: Import a previously saved pipeline
   - **Edit → Clear Canvas**: Remove all nodes

## Pipeline Structure

Saved pipelines are stored in JSON format:

```json
{
  "nodes": [
    {
      "id": 0,
      "category": "module",
      "module": "Linear",
      "x": 100,
      "y": 150
    }
  ],
  "connections": [
    {
      "from_node": 0,
      "from_socket": "output",
      "to_node": 1,
      "to_socket": "input"
    }
  ]
}
```

## Block Information

Each block is loaded from JSON files in `block_info/`:

- **builtin/**: Basic PyTorch operations (conv2d, etc.)
- **functional/**: Functional operations (relu, softmax, etc.)
- **module/**: Module layers (Linear, Conv2d, BatchNorm2d, etc.)

Each JSON contains:
- `category`: Type of block
- `module`: Module name
- `full_path`: Full import path
- `arguments`: List of parameters with types and defaults
- `doc`: Documentation string

## Keyboard Shortcuts

- Click and drag nodes to move them
- Right-click on canvas for context menu (future feature)
- Delete key on selected node to remove (future feature)

## Advanced Features

### Exporting Code

Future versions will support exporting the visual pipeline to PyTorch code.

### Custom Blocks

Add new blocks by creating JSON files in the appropriate `block_info/` subdirectory.

## Troubleshooting

**Blocks not showing?**
- Ensure block_info/ directory is at the project root
- Check JSON files are valid JSON format

**Connections not working?**
- Make sure you're connecting an output socket to an input socket
- Cannot connect input-to-input or output-to-output

**Import errors?**
- Make sure PyQt6 is installed: `pip install PyQt6`

## Future Enhancements

- [ ] Export pipeline to PyTorch code
- [ ] Validation of pipeline connectivity
- [ ] Real-time shape inference
- [ ] Custom node types
- [ ] Undo/Redo functionality
- [ ] Grid snap and alignment tools
- [ ] Pipeline execution simulation
- [ ] Import from PyTorch code
