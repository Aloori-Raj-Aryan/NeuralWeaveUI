#!/bin/bash
# NeuralWeave Pipeline Editor - Setup and Run Script

echo ""
echo "========================================"
echo "NeuralWeave Pipeline Editor Setup"
echo "========================================"
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed"
    exit 1
fi

echo "Detected Python:"
python3 --version
echo ""

# Check if venv exists
if [ ! -d venv ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
    echo "Virtual environment created."
fi

# Activate virtual environment
source venv/bin/activate

echo ""
echo "Installing dependencies..."
pip install -q -r requirements.txt

if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install dependencies"
    exit 1
fi

echo ""
echo "========================================"
echo "Starting NeuralWeave Pipeline Editor"
echo "========================================"
echo ""

# Run the editor
python3 run_editor.py
