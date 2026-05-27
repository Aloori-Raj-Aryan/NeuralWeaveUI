#!/usr/bin/env python3
"""
Cross-platform launcher for NeuralWeave Pipeline Editor
Works on Windows, Mac, and Linux without requiring bash or WSL
"""

import subprocess
import sys
import os
import venv
from pathlib import Path


def create_venv():
    """Create virtual environment if it doesn't exist"""
    venv_path = Path("venv")
    
    if not venv_path.exists():
        print("Creating virtual environment...")
        venv.create(str(venv_path), with_pip=True)
        print("✓ Virtual environment created")
    else:
        print("✓ Virtual environment already exists")


def install_dependencies():
    """Install required packages"""
    print("\nInstalling dependencies...")
    
    # Get the pip executable
    if sys.platform == "win32":
        pip_exe = Path("venv") / "Scripts" / "pip.exe"
    else:
        pip_exe = Path("venv") / "bin" / "pip"
    
    # Install from requirements.txt
    result = subprocess.run(
        [str(pip_exe), "install", "-q", "-r", "requirements.txt"],
        capture_output=True,
        text=True
    )
    
    if result.returncode != 0:
        print(f"✗ Error installing dependencies:\n{result.stderr}")
        return False
    
    print("✓ Dependencies installed")
    return True


def run_editor():
    """Run the pipeline editor"""
    print("\n" + "="*50)
    print("Starting NeuralWeave Pipeline Editor")
    print("="*50 + "\n")
    
    # Get the Python executable in venv
    if sys.platform == "win32":
        python_exe = Path("venv") / "Scripts" / "python.exe"
    else:
        python_exe = Path("venv") / "bin" / "python"
    
    # Run the editor
    result = subprocess.run(
        [str(python_exe), "run_editor.py"],
        capture_output=False
    )
    
    return result.returncode


def main():
    """Main entry point"""
    print("="*50)
    print("NeuralWeave Pipeline Editor - Setup & Launch")
    print("="*50 + "\n")
    
    try:
        # Create venv
        create_venv()
        
        # Install dependencies
        if not install_dependencies():
            sys.exit(1)
        
        # Run editor
        exit_code = run_editor()
        sys.exit(exit_code)
        
    except Exception as e:
        print(f"✗ Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
