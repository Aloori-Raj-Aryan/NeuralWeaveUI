import json
import os
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QGraphicsView, QGraphicsScene, QGraphicsRectItem, QGraphicsLineItem,
    QGraphicsTextItem, QGraphicsEllipseItem, QListWidget, QListWidgetItem,
    QSplitter, QMenu, QDialog, QLabel, QLineEdit, QSpinBox, QDoubleSpinBox,
    QCheckBox, QComboBox, QFormLayout, QPushButton, QMessageBox, QFileDialog,
    QScrollArea, QAction
)
from PyQt5.QtCore import Qt, QPointF, QRectF, QSize, QTimer, pyqtSignal
from PyQt5.QtGui import QColor, QPainter, QPen, QBrush, QFont


@dataclass
class BlockInfo:
    """Represents a block from JSON"""
    category: str
    module: str
    full_path: str
    arguments: List[Dict]
    doc: str


class NodeSocket:
    """Represents an input/output socket on a node"""
    def __init__(self, node: 'PipelineNode', socket_type: str, name: str, is_input: bool):
        self.node = node
        self.socket_type = socket_type
        self.name = name
        self.is_input = is_input
        self.connections: List['Connection'] = []
        
    def get_position(self) -> QPointF:
        """Get the position of this socket in scene coordinates"""
        # Will be calculated based on node position
        return self.node.get_socket_position(self)


class Connection:
    """Represents a connection between two sockets"""
    def __init__(self, from_socket: NodeSocket, to_socket: NodeSocket):
        self.from_socket = from_socket
        self.to_socket = to_socket
        self.line = None


class PipelineNode(QGraphicsRectItem):
    """Visual representation of a neural network block"""
    
    WIDTH = 200
    HEADER_HEIGHT = 40
    ITEM_HEIGHT = 25
    
    def __init__(self, block_info: BlockInfo, x: float, y: float, scene_ref):
        super().__init__(0, 0, self.WIDTH, 100)
        self.block_info = block_info
        self.scene_ref = scene_ref
        self.sockets: Dict[str, NodeSocket] = {}
        self.connections: List[Connection] = []
        self.selected_socket: Optional[NodeSocket] = None
        
        # Set position
        self.setPos(x, y)
        
        # Visual properties
        self.setBrush(QBrush(QColor(70, 130, 180)))
        self.setPen(QPen(QColor(0, 0, 0), 2))
        self.setAcceptHoverEvents(True)
        self.setFlag(self.ItemIsMovable, True)
        self.setFlag(self.ItemIsSelectable, True)
        
        # Add to scene
        if scene_ref:
            scene_ref.addItem(self)
        
        # Create visual elements
        self._create_sockets()
        self._update_size()
        self._add_labels()
        
    def _create_sockets(self):
        """Create input/output sockets based on arguments"""
        # Input socket (for the main input)
        input_socket = NodeSocket(self, "tensor", "input", is_input=True)
        self.sockets["input"] = input_socket
        
        # Parameter sockets (optional parameters as inputs)
        for arg in self.block_info.arguments:
            if not arg['required'] and arg['name'] != 'input':
                param_socket = NodeSocket(self, "parameter", arg['name'], is_input=True)
                self.sockets[arg['name']] = param_socket
        
        # Output socket
        output_socket = NodeSocket(self, "tensor", "output", is_input=False)
        self.sockets["output"] = output_socket
    
    def _update_size(self):
        """Update node size based on number of sockets"""
        num_inputs = sum(1 for s in self.sockets.values() if s.is_input)
        num_outputs = sum(1 for s in self.sockets.values() if not s.is_input)
        max_sockets = max(num_inputs, num_outputs)
        
        height = self.HEADER_HEIGHT + (max_sockets * self.ITEM_HEIGHT) + 10
        self.setRect(0, 0, self.WIDTH, height)
    
    def _add_labels(self):
        """Add text labels to the node"""
        # Header text
        header = QGraphicsTextItem(self)
        header.setPlainText(self.block_info.module)
        header.setDefaultTextColor(QColor(255, 255, 255))
        font = QFont()
        font.setBold(True)
        font.setPointSize(10)
        header.setFont(font)
        header.setPos(5, 5)
        
        # Category label
        category = QGraphicsTextItem(self)
        category.setPlainText(f"[{self.block_info.category}]")
        category.setDefaultTextColor(QColor(200, 200, 200))
        small_font = QFont()
        small_font.setPointSize(7)
        category.setFont(small_font)
        category.setPos(5, 20)
    
    def get_socket_position(self, socket: NodeSocket) -> QPointF:
        """Get the scene position of a socket"""
        input_sockets = [s for s in self.sockets.values() if s.is_input]
        output_sockets = [s for s in self.sockets.values() if not s.is_input]
        
        if socket.is_input:
            idx = input_sockets.index(socket)
            y = self.HEADER_HEIGHT + (idx + 1) * self.ITEM_HEIGHT
            return self.pos() + QPointF(-5, y)
        else:
            idx = output_sockets.index(socket)
            y = self.HEADER_HEIGHT + (idx + 1) * self.ITEM_HEIGHT
            return self.pos() + QPointF(self.WIDTH + 5, y)
    
    def paint(self, painter: QPainter, option, widget):
        """Custom paint to show socket circles"""
        super().paint(painter, option, widget)
        
        # Draw input sockets
        input_sockets = [s for s in self.sockets.values() if s.is_input]
        for idx, socket in enumerate(input_sockets):
            y = self.HEADER_HEIGHT + (idx + 1) * self.ITEM_HEIGHT - 12
            painter.setBrush(QBrush(QColor(100, 200, 100)))
            painter.drawEllipse(int(-8), int(y), 6, 6)
        
        # Draw output sockets
        output_sockets = [s for s in self.sockets.values() if not s.is_input]
        for idx, socket in enumerate(output_sockets):
            y = self.HEADER_HEIGHT + (idx + 1) * self.ITEM_HEIGHT - 12
            painter.setBrush(QBrush(QColor(200, 100, 100)))
            painter.drawEllipse(int(self.WIDTH + 2), int(y), 6, 6)
    
    def mousePressEvent(self, event):
        """Handle mouse press"""
        # Check if clicking on a socket
        input_sockets = [s for s in self.sockets.values() if s.is_input]
        output_sockets = [s for s in self.sockets.values() if not s.is_input]
        
        scene_pos = event.scenePos()
        
        for idx, socket in enumerate(input_sockets):
            y = self.HEADER_HEIGHT + (idx + 1) * self.ITEM_HEIGHT - 12
            socket_rect = QRectF(self.pos().x() - 8, self.pos().y() + y, 6, 6)
            if socket_rect.contains(scene_pos):
                self.selected_socket = socket
                self.scene_ref.start_connection(socket)
                return
        
        for idx, socket in enumerate(output_sockets):
            y = self.HEADER_HEIGHT + (idx + 1) * self.ITEM_HEIGHT - 12
            socket_rect = QRectF(self.pos().x() + self.WIDTH + 2, self.pos().y() + y, 6, 6)
            if socket_rect.contains(scene_pos):
                self.selected_socket = socket
                self.scene_ref.start_connection(socket)
                return
        
        super().mousePressEvent(event)
    
    def mouseDoubleClickEvent(self, event):
        """Open configuration dialog"""
        self.scene_ref.open_node_config(self)


class PipelineScene(QGraphicsScene):
    """Custom graphics scene for the pipeline editor"""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.nodes: List[PipelineNode] = []
        self.connections: List[Connection] = []
        self.connection_line: Optional[QGraphicsLineItem] = None
        self.temp_socket: Optional[NodeSocket] = None
        self.setBackgroundBrush(QBrush(QColor(45, 45, 50)))
        
    def add_node(self, block_info: BlockInfo, x: float, y: float) -> PipelineNode:
        """Add a new node to the scene"""
        node = PipelineNode(block_info, x, y, self)
        self.nodes.append(node)
        return node
    
    def start_connection(self, socket: NodeSocket):
        """Start drawing a connection"""
        self.temp_socket = socket
        pos = socket.get_position()
        self.connection_line = self.addLine(
            pos.x(), pos.y(), pos.x(), pos.y(),
            QPen(QColor(150, 150, 255), 2)
        )
    
    def mouseMoveEvent(self, event):
        """Update connection line while dragging"""
        if self.connection_line and self.temp_socket:
            end_pos = event.scenePos()
            start_pos = self.temp_socket.get_position()
            self.connection_line.setLine(
                start_pos.x(), start_pos.y(), end_pos.x(), end_pos.y()
            )
        super().mouseMoveEvent(event)
    
    def mouseReleaseEvent(self, event):
        """Complete connection"""
        if self.connection_line:
            # Check if released on another socket
            items = self.items(event.scenePos())
            for item in items:
                if isinstance(item, PipelineNode):
                    # Try to connect to this node's sockets
                    node = item
                    scene_pos = event.scenePos()
                    
                    # Check input sockets
                    input_sockets = [s for s in node.sockets.values() if s.is_input]
                    output_sockets = [s for s in node.sockets.values() if not s.is_input]
                    
                    for idx, socket in enumerate(input_sockets):
                        y = node.HEADER_HEIGHT + (idx + 1) * node.ITEM_HEIGHT - 12
                        socket_rect = QRectF(node.pos().x() - 8, node.pos().y() + y, 6, 6)
                        if socket_rect.contains(scene_pos):
                            self._complete_connection(socket)
                            break
                    else:
                        for idx, socket in enumerate(output_sockets):
                            y = node.HEADER_HEIGHT + (idx + 1) * node.ITEM_HEIGHT - 12
                            socket_rect = QRectF(node.pos().x() + node.WIDTH + 2, node.pos().y() + y, 6, 6)
                            if socket_rect.contains(scene_pos):
                                self._complete_connection(socket)
                                break
            
            self.removeItem(self.connection_line)
            self.connection_line = None
        
        self.temp_socket = None
        super().mouseReleaseEvent(event)
    
    def _complete_connection(self, to_socket: NodeSocket):
        """Complete a connection between two sockets"""
        if not self.temp_socket or self.temp_socket == to_socket:
            return
        
        from_socket = self.temp_socket
        
        # Validate connection (output -> input)
        if from_socket.is_input == to_socket.is_input:
            QMessageBox.warning(None, "Invalid Connection", "Cannot connect input to input or output to output")
            return
        
        if from_socket.is_input:
            from_socket, to_socket = to_socket, from_socket
        
        # Create connection
        connection = Connection(from_socket, to_socket)
        self.connections.append(connection)
        from_socket.connections.append(connection)
        to_socket.connections.append(connection)
        
        # Draw connection line
        line = self.addLine(
            from_socket.get_position().x(), from_socket.get_position().y(),
            to_socket.get_position().x(), to_socket.get_position().y(),
            QPen(QColor(100, 200, 100), 2)
        )
        connection.line = line
    
    def open_node_config(self, node: PipelineNode):
        """Open configuration dialog for a node"""
        dialog = NodeConfigDialog(node)
        dialog.exec()


class NodeConfigDialog(QDialog):
    """Dialog for configuring node parameters"""
    
    def __init__(self, node: PipelineNode):
        super().__init__()
        self.node = node
        self.setWindowTitle(f"Configure {node.block_info.module}")
        self.setGeometry(100, 100, 400, 300)
        
        layout = QFormLayout()
        
        # Add controls for each parameter
        self.controls = {}
        for arg in node.block_info.arguments:
            label = QLabel(arg['name'])
            
            if arg.get('default') is True or arg.get('default') is False:
                control = QCheckBox()
                control.setChecked(arg['default'] if arg['default'] is not None else False)
            elif 'int' in str(arg.get('annotation', '')):
                control = QSpinBox()
                control.setValue(int(arg['default']) if arg['default'] else 0)
            elif 'float' in str(arg.get('annotation', '')):
                control = QDoubleSpinBox()
                control.setValue(float(arg['default']) if arg['default'] else 0.0)
            else:
                control = QLineEdit()
                control.setText(str(arg['default']) if arg['default'] else '')
            
            self.controls[arg['name']] = control
            layout.addRow(label, control)
        
        # Add buttons
        button_layout = QHBoxLayout()
        ok_btn = QPushButton("OK")
        cancel_btn = QPushButton("Cancel")
        ok_btn.clicked.connect(self.accept)
        cancel_btn.clicked.connect(self.reject)
        button_layout.addWidget(ok_btn)
        button_layout.addWidget(cancel_btn)
        
        layout.addRow(button_layout)
        self.setLayout(layout)


class PipelineEditor(QMainWindow):
    """Main pipeline editor window"""
    
    def __init__(self):
        super().__init__()
        self.setWindowTitle("NeuralWeave Pipeline Editor")
        self.setGeometry(100, 100, 1400, 800)
        
        # Load block information
        self.blocks = self._load_blocks()
        
        # Create main widget
        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        
        layout = QHBoxLayout()
        
        # Left panel: Node library
        left_panel = self._create_node_library()
        layout.addWidget(left_panel, 1)
        
        # Right panel: Canvas
        self.scene = PipelineScene()
        self.view = QGraphicsView(self.scene)
        self.view.setRenderHint(QPainter.Antialiasing)
        layout.addWidget(self.view, 3)
        
        main_widget.setLayout(layout)
        
        # Add menu bar
        self._create_menu_bar()
    
    def _load_blocks(self) -> Dict[str, BlockInfo]:
        """Load all block JSON files"""
        blocks = {}
        block_dir = Path(__file__).parent.parent / "block_info"
        
        for category_dir in block_dir.iterdir():
            if not category_dir.is_dir():
                continue
            
            for json_file in category_dir.glob("*.json"):
                try:
                    with open(json_file) as f:
                        data = json.load(f)
                        name = f"{data['category']}/{data['module']}"
                        blocks[name] = BlockInfo(
                            category=data['category'],
                            module=data['module'],
                            full_path=data['full_path'],
                            arguments=data['arguments'],
                            doc=data.get('doc', '')
                        )
                except Exception as e:
                    print(f"Error loading {json_file}: {e}")
        
        return blocks
    
    def _create_node_library(self) -> QWidget:
        """Create the node library panel"""
        widget = QWidget()
        layout = QVBoxLayout()
        
        # Title
        title = QLabel("Available Blocks")
        title.setStyleSheet("font-weight: bold; font-size: 14px;")
        layout.addWidget(title)
        
        # Node list
        self.node_list = QListWidget()
        for block_name in sorted(self.blocks.keys()):
            item = QListWidgetItem(block_name)
            item.setData(Qt.UserRole, block_name)
            self.node_list.addItem(item)
        
        layout.addWidget(self.node_list)
        
        # Info panel
        self.info_label = QLabel("Select a block to see details")
        self.info_label.setWordWrap(True)
        self.info_label.setStyleSheet("border: 1px solid #ccc; padding: 5px;")
        layout.addWidget(self.info_label)
        
        # Add button
        add_btn = QPushButton("Add to Canvas")
        add_btn.clicked.connect(self._add_selected_node)
        layout.addWidget(add_btn)
        
        self.node_list.itemSelectionChanged.connect(self._on_block_selected)
        
        widget.setLayout(layout)
        return widget
    
    def _on_block_selected(self):
        """Update info when block is selected"""
        items = self.node_list.selectedItems()
        if items:
            block_name = items[0].data(Qt.UserRole)
            block = self.blocks[block_name]
            
            info = f"<b>{block.module}</b><br>"
            info += f"<i>Category: {block.category}</i><br>"
            info += f"<i>Path: {block.full_path}</i><br><br>"
            info += f"<b>Arguments:</b><br>"
            for arg in block.arguments:
                required = "required" if arg['required'] else "optional"
                info += f"• {arg['name']} ({required})<br>"
            
            self.info_label.setText(info)
    
    def _add_selected_node(self):
        """Add selected node to canvas"""
        items = self.node_list.selectedItems()
        if not items:
            QMessageBox.warning(self, "No Selection", "Please select a block first")
            return
        
        block_name = items[0].data(Qt.UserRole)
        block = self.blocks[block_name]
        
        # Add node at center of view
        center = self.view.mapToScene(self.view.rect().center())
        self.scene.add_node(block, center.x() - 100, center.y() - 50)
    
    def _create_menu_bar(self):
        """Create menu bar"""
        menubar = self.menuBar()
        
        # File menu
        file_menu = menubar.addMenu("File")
        
        save_action = QAction("Save Pipeline", self)
        save_action.triggered.connect(self._save_pipeline)
        file_menu.addAction(save_action)
        
        load_action = QAction("Load Pipeline", self)
        load_action.triggered.connect(self._load_pipeline)
        file_menu.addAction(load_action)
        
        file_menu.addSeparator()
        
        exit_action = QAction("Exit", self)
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)
        
        # Edit menu
        edit_menu = menubar.addMenu("Edit")
        
        clear_action = QAction("Clear Canvas", self)
        clear_action.triggered.connect(self._clear_canvas)
        edit_menu.addAction(clear_action)
    
    def _save_pipeline(self):
        """Save pipeline to JSON"""
        file_path, _ = QFileDialog.getSaveFileName(
            self, "Save Pipeline", "", "JSON Files (*.json)"
        )
        if not file_path:
            return
        
        pipeline_data = {
            "nodes": [],
            "connections": []
        }
        
        # Save node info
        node_map = {}
        for idx, node in enumerate(self.scene.nodes):
            node_map[id(node)] = idx
            pipeline_data["nodes"].append({
                "id": idx,
                "category": node.block_info.category,
                "module": node.block_info.module,
                "x": node.pos().x(),
                "y": node.pos().y()
            })
        
        # Save connections
        for conn in self.scene.connections:
            pipeline_data["connections"].append({
                "from_node": node_map.get(id(conn.from_socket.node)),
                "from_socket": conn.from_socket.name,
                "to_node": node_map.get(id(conn.to_socket.node)),
                "to_socket": conn.to_socket.name
            })
        
        with open(file_path, 'w') as f:
            json.dump(pipeline_data, f, indent=2)
        
        QMessageBox.information(self, "Success", f"Pipeline saved to {file_path}")
    
    def _load_pipeline(self):
        """Load pipeline from JSON"""
        file_path, _ = QFileDialog.getOpenFileName(
            self, "Load Pipeline", "", "JSON Files (*.json)"
        )
        if not file_path:
            return
        
        try:
            with open(file_path) as f:
                data = json.load(f)
            
            # Clear current pipeline
            self._clear_canvas()
            
            # Load nodes
            node_map = {}
            for node_data in data["nodes"]:
                block_key = f"{node_data['category']}/{node_data['module']}"
                if block_key in self.blocks:
                    node = self.scene.add_node(
                        self.blocks[block_key],
                        node_data['x'],
                        node_data['y']
                    )
                    node_map[node_data['id']] = node
            
            # Load connections
            for conn_data in data["connections"]:
                from_node = node_map.get(conn_data['from_node'])
                to_node = node_map.get(conn_data['to_node'])
                
                if from_node and to_node:
                    from_socket = from_node.sockets.get(conn_data['from_socket'])
                    to_socket = to_node.sockets.get(conn_data['to_socket'])
                    
                    if from_socket and to_socket:
                        connection = Connection(from_socket, to_socket)
                        self.scene.connections.append(connection)
                        from_socket.connections.append(connection)
                        to_socket.connections.append(connection)
                        
                        line = self.scene.addLine(
                            from_socket.get_position().x(), from_socket.get_position().y(),
                            to_socket.get_position().x(), to_socket.get_position().y(),
                            QPen(QColor(100, 200, 100), 2)
                        )
                        connection.line = line
            
            QMessageBox.information(self, "Success", "Pipeline loaded successfully")
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Failed to load pipeline: {e}")
    
    def _clear_canvas(self):
        """Clear all nodes and connections"""
        self.scene.clear()
        self.scene.nodes = []
        self.scene.connections = []


def main():
    app = QApplication([])
    editor = PipelineEditor()
    editor.show()
    app.exec()


if __name__ == "__main__":
    main()
