#!/usr/bin/env python3
"""Generate NeuralWeaveUI block JSON from a PyTorch path."""

import argparse
import inspect
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import torch
import torch.nn as nn

SKIP_PARAMS = frozenset({"out", "self"})
# Init args with PyTorch default None that hand-written blocks still mark required.
INIT_REQUIRED_IF_NONE = frozenset({"modules", "parameters"})


def resolve_torch_path(path: str) -> Any:
    """Resolve dotted path like torch.nn.Conv2d or torch.add."""
    parts = path.split(".")
    if parts[0] != "torch":
        raise ValueError("Path must start with 'torch.'")
    obj = torch
    for part in parts[1:]:
        obj = getattr(obj, part)
    return obj


def display_name(obj: Any, path: str) -> str:
    if isinstance(obj, type) and issubclass(obj, nn.Module):
        name = obj.__name__
        if re.fullmatch(r"Conv[123]d", name):
            return name[:-1] + "D"
        return name
    return path.rsplit(".", 1)[-1]


def category_for(_path: str, obj: Any) -> str:
    if isinstance(obj, type) and issubclass(obj, nn.Module):
        return "Module"
    return "Function"


def annotation_to_type(annotation: Any) -> Optional[str]:
    if annotation is inspect.Parameter.empty:
        return None
    if annotation is torch.Tensor or getattr(annotation, "__name__", "") == "Tensor":
        return "Tensor"
    name = getattr(annotation, "__name__", None)
    if name in ("int", "float", "bool", "str"):
        return name
    origin = getattr(annotation, "__origin__", None)
    args = getattr(annotation, "__args__", ())
    if origin is Union:
        for arg in args:
            if arg is type(None):
                continue
            mapped = annotation_to_type(arg)
            if mapped:
                return mapped
    if origin in (list, tuple) and args:
        inner = annotation_to_type(args[0])
        if inner:
            return inner + "[]"
    text = str(annotation)
    if "Tensor" in text:
        if "Tuple" in text or "tuple" in text:
            return "Tuple[Tensor,Tensor]" if text.count("Tensor") >= 2 else "Tensor"
        if "List" in text or "list" in text or "Sequence" in text:
            return "Tensor[]"
        return "Tensor"
    if "int" in text:
        return "int"
    if "float" in text:
        return "float"
    if "bool" in text:
        return "bool"
    if "str" in text:
        return "str"
    return None


def default_to_json(value: Any) -> Any:
    if value is inspect.Parameter.empty:
        return None
    if value is None:
        return None
    if callable(value):
        return getattr(value, "__name__", "relu")
    if isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (tuple, list)):
        return list(value)
    return str(value)


def is_required_init(param: inspect.Parameter) -> bool:
    if param.default is inspect.Parameter.empty:
        return True
    if param.default is None and param.name in INIT_REQUIRED_IF_NONE:
        return True
    return False


def is_required_forward(param: inspect.Parameter) -> bool:
    return param.default is inspect.Parameter.empty


def format_param_entry(
    required: bool,
    default: Any,
    type_name: Optional[str] = None,
) -> OrderedDict:
    entry: OrderedDict = OrderedDict()
    if type_name:
        entry["type"] = type_name
    entry["required"] = "True" if required else "False"
    entry["default"] = None if required else default_to_json(default)
    return entry


def param_spec(param: inspect.Parameter, include_type: bool, for_init: bool) -> OrderedDict:
    required = is_required_init(param) if for_init else is_required_forward(param)
    type_name = None
    if include_type:
        type_name = annotation_to_type(param.annotation)
    default = (
        inspect.Parameter.empty if required else param.default
    )
    return format_param_entry(
        required,
        default,
        type_name,
    )


def signature_parameters(fn: Any) -> List[inspect.Parameter]:
    sig = inspect.signature(fn)
    params = []
    for param in sig.parameters.values():
        if param.name in SKIP_PARAMS:
            continue
        if param.kind in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        ):
            continue
        params.append(param)
    return params


def _type_from_doc_hint(hint: str) -> Optional[str]:
    hint = hint.strip()
    if "Tensor" in hint:
        return "Tensor"
    if hint in ("Number", "float", "double"):
        return "float"
    if hint in ("int", "Int"):
        return "int"
    if hint in ("bool", "Bool"):
        return "bool"
    if hint in ("str", "String"):
        return "str"
    return None


def _arg_types_from_doc(doc: str) -> Dict[str, str]:
    types: Dict[str, str] = {}
    for match in re.finditer(r"^\s*(\w+)\s*\(([^)]+)\)\s*:", doc, re.MULTILINE):
        mapped = _type_from_doc_hint(match.group(2))
        if mapped:
            types[match.group(1)] = mapped
    return types


def parse_docstring_signature(obj: Any) -> List[Tuple[str, bool, Any, Optional[str]]]:
    """Parse (name, required, default, type_hint) from torch builtin docstrings."""
    doc = inspect.getdoc(obj) or ""
    doc_types = _arg_types_from_doc(doc)
    match = re.search(
        r"^[a-zA-Z0-9_.]+\(([^)]*)\)",
        doc,
        re.MULTILINE,
    )
    if not match:
        return []
    raw = match.group(1).replace("\n", " ")
    parts = []
    current = ""
    depth = 0
    for ch in raw:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(current.strip())
            current = ""
        else:
            current += ch
    if current.strip():
        parts.append(current.strip())

    parsed = []
    for part in parts:
        part = part.strip()
        if not part or part == "*":
            continue
        type_hint = None
        name = part
        default = inspect.Parameter.empty
        if "=" in part:
            name, default_str = part.split("=", 1)
            name = name.strip()
            default_str = default_str.strip()
            if default_str == "None":
                default = None
            elif default_str in ("True", "False"):
                default = default_str == "True"
            else:
                try:
                    default = float(default_str) if "." in default_str else int(default_str)
                except ValueError:
                    default = default_str.strip("\"'")
        if "(" in name and ")" in name:
            inner = re.match(r"(\w+)\s*\(([^)]+)\)", name)
            if inner:
                name = inner.group(1)
                hint = inner.group(2)
                if "Tensor" in hint:
                    type_hint = "Tensor"
                elif hint in ("int", "float", "bool", "str"):
                    type_hint = hint
        required = default is inspect.Parameter.empty
        if not type_hint:
            type_hint = doc_types.get(name)
        if type_hint == "float" and isinstance(default, int):
            default = float(default)
        parsed.append((name, required, default, type_hint))
    return parsed


def collect_arguments(
    fn: Any, include_type: bool, for_init: bool = False
) -> OrderedDict:
    params = signature_parameters(fn)
    if params:
        return OrderedDict(
            (p.name, param_spec(p, include_type, for_init)) for p in params
        )

    result = OrderedDict()
    for name, required, default, type_hint in parse_docstring_signature(fn):
        if name in SKIP_PARAMS:
            continue
        result[name] = format_param_entry(
            required,
            default,
            type_hint if include_type else None,
        )
    return result


def build_block_spec(torch_path: str) -> Dict[str, Any]:
    obj = resolve_torch_path(torch_path)
    cat = category_for(torch_path, obj)
    spec: Dict[str, Any] = {
        "name": display_name(obj, torch_path),
        "category": cat,
        "path": torch_path,
    }

    if cat == "Module":
        spec["init_arguments"] = collect_arguments(
            obj.__init__, include_type=False, for_init=True
        )
        spec["forward_arguments"] = collect_arguments(
            obj.forward, include_type=True, for_init=False
        )
    else:
        spec["forward_arguments"] = collect_arguments(obj, include_type=True)

    spec["output"] = ["output"]
    return spec


def write_block_json(spec: Dict[str, Any], file_path: Union[str, Path]) -> Path:
    path = Path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(spec, f, indent=4)
        f.write("\n")
    return path


def create_block_json(torch_path: str, file_path: Union[str, Path]) -> Dict[str, Any]:
    """Create a block JSON file from a PyTorch dotted path."""
    spec = build_block_spec(torch_path)
    write_block_json(spec, Path(file_path))
    return spec


def parse_cli(argv: Optional[List[str]] = None) -> Tuple[str, str]:
    parser = argparse.ArgumentParser(
        prog="create_block.py",
        description="Generate a NeuralWeaveUI block JSON from a PyTorch dotted path.",
        usage="%(prog)s torch_path PATH file_path FILE",
        epilog=(
            "example:\n"
            "  python3 scripts/create_block.py "
            "torch_path torch.nn.Conv2d file_path blocks/convolution/conv2d.json"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "torch_path_key",
        choices=["torch_path"],
        help="literal keyword 'torch_path'",
    )
    parser.add_argument(
        "torch_path",
        metavar="PATH",
        help="PyTorch dotted path, e.g. torch.nn.Conv2d or torch.add",
    )
    parser.add_argument(
        "file_path_key",
        choices=["file_path"],
        help="literal keyword 'file_path'",
    )
    parser.add_argument(
        "file_path",
        metavar="FILE",
        help="output JSON path, e.g. blocks/convolution/conv2d.json",
    )
    args = parser.parse_args(argv)
    return args.torch_path, args.file_path


def main(argv: Optional[List[str]] = None) -> int:
    torch_path, file_path = parse_cli(argv)

    repo_root = Path(__file__).resolve().parent.parent
    out = Path(file_path)
    if not out.is_absolute():
        out = repo_root / out

    create_block_json(torch_path, out)
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
