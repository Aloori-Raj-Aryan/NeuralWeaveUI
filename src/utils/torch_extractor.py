import json
import inspect
import os
import re
import typing
import torch
import torch.nn as nn
import torch.nn.functional as F


# =========================================================
# CATEGORY DETECTION
# =========================================================

def get_category(obj):
    if inspect.isclass(obj):
        return "module"
    elif inspect.isfunction(obj):
        return "functional"
    elif inspect.isbuiltin(obj):
        return "builtin"
    elif callable(obj):
        return "callable"
    return "unknown"


# =========================================================
# SAFE SERIALIZATION
# =========================================================

def safe_serialize(value):
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)


# =========================================================
# PARSE __text_signature__
# =========================================================

def parse_text_signature(text_signature):
    if text_signature is None:
        return []

    text_signature = text_signature.strip().lstrip("(").rstrip(")")
    arguments = []

    for item in text_signature.split(","):
        item = item.strip()
        if not item or item in ["/", "*"]:
            continue
        if "=" in item:
            name, default = item.split("=", 1)
            arguments.append({
                "name": name.strip(),
                "default": default.strip(),
                "required": False,
                "kind": "POSITIONAL_OR_KEYWORD",
                "annotation": None
            })
        else:
            arguments.append({
                "name": item,
                "default": None,
                "required": True,
                "kind": "POSITIONAL_OR_KEYWORD",
                "annotation": None
            })

    return arguments


# =========================================================
# PARSE DOCSTRING SIGNATURE
# =========================================================

def parse_doc_signature(doc, function_name):
    if not doc:
        return []

    first_line = doc.split("\n")[0].strip()

    if not first_line.startswith(function_name):
        return []

    start = first_line.find("(")
    end = first_line.rfind(")")

    if start == -1 or end == -1:
        return []

    signature_text = first_line[start + 1:end]
    arguments = []

    for item in signature_text.split(","):
        item = item.strip()
        if not item:
            continue
        if "=" in item:
            name, default = item.split("=", 1)
            arguments.append({
                "name": name.strip(),
                "default": default.strip(),
                "required": False,
                "kind": "POSITIONAL_OR_KEYWORD",
                "annotation": None
            })
        else:
            arguments.append({
                "name": item,
                "default": None,
                "required": True,
                "kind": "POSITIONAL_OR_KEYWORD",
                "annotation": None
            })

    return arguments


# =========================================================
# RESOLVE FULL PATH
# =========================================================

def resolve_full_path(obj):
    module_name = getattr(obj, "__module__", None)
    if module_name is not None:
        return f"{module_name}.{obj.__name__}"

    if hasattr(F, obj.__name__):
        candidate = getattr(F, obj.__name__)
        if candidate is obj:
            return f"torch.nn.functional.{obj.__name__}"

    if hasattr(torch, obj.__name__):
        candidate = getattr(torch, obj.__name__)
        if candidate is obj:
            return f"torch.{obj.__name__}"

    return f"unknown.{obj.__name__}"


# =========================================================
# EXTRACT ARGUMENTS FROM A CALLABLE
# =========================================================

def extract_arguments(obj, skip_self=False):
    arguments = []

    try:
        sig = inspect.signature(obj)
        for name, param in sig.parameters.items():
            if skip_self and name == "self":
                continue
            arguments.append({
                "name": name,
                "default": (
                    None
                    if param.default == inspect.Parameter.empty
                    else safe_serialize(param.default)
                ),
                "required": param.default == inspect.Parameter.empty,
                "kind": str(param.kind),
                "annotation": (
                    None
                    if param.annotation == inspect.Parameter.empty
                    else str(param.annotation)
                )
            })
    except (ValueError, TypeError):
        text_sig = getattr(obj, "__text_signature__", None)
        arguments = parse_text_signature(text_sig)

        if not arguments:
            doc = inspect.getdoc(obj)
            arguments = parse_doc_signature(doc, obj.__name__)

    return arguments


# =========================================================
# OUTPUT COUNT INFERENCE HELPERS
# =========================================================

def _is_union_type(annotation):
    """
    Returns True for both typing.Union[X, Y] (all Python versions)
    and the Python 3.10+ X | Y syntax (types.UnionType).
    """
    if getattr(annotation, "__origin__", None) is typing.Union:
        return True
    import types as _types
    if hasattr(_types, "UnionType") and isinstance(annotation, _types.UnionType):
        return True
    return False


def _infer_num_outputs_from_annotation(annotation):
    """
    Count the number of distinct outputs from a return-type annotation.

    Rules:
      Tensor / any single non-tuple type          -> 1
      Tuple[A, B, C]  / tuple[A, B, C]            -> 3  (each slot = one output)
      tuple[A, B | None]                           -> 2  (Python 3.10+ style)
      Optional[Tensor]  == Union[Tensor, None]     -> recurse into Tensor -> 1
      Optional[Tuple[A,B]]                         -> recurse into Tuple[A,B] -> 2
      Union[X, Y] with multiple non-None arms      -> None (ambiguous)
      bare Tuple / tuple (unparameterised)         -> None
    """
    if annotation is inspect.Parameter.empty or annotation is None:
        return None

    origin = getattr(annotation, "__origin__", None)

    # tuple[...] or typing.Tuple[...] — each slot is one output
    if origin is tuple:
        args = getattr(annotation, "__args__", None)
        if args is None:
            return None          # bare unparameterised Tuple
        if args == ((),):
            return 0             # Tuple[()] -> zero-element tuple
        return len(args)         # Tuple[A, B, C] -> 3

    # Union / Optional
    if _is_union_type(annotation):
        union_args = getattr(annotation, "__args__", ()) or ()
        non_none = [a for a in union_args if a is not type(None)]
        if len(non_none) == 1:
            # Optional[X] -> recurse into X
            # e.g. Optional[Tuple[A, B]] -> 2
            return _infer_num_outputs_from_annotation(non_none[0])
        # True Union (multiple non-None arms) -> ambiguous
        return None

    # Any other single type (Tensor, int, ...)
    return 1


def _infer_num_outputs_from_doc(doc):
    """
    Heuristic output-count from docstring text. Tries four patterns in order:

    1. Inline arrow tuple on first line:  func(...) -> (Tensor, LongTensor)
       Counts comma-separated items inside the parentheses.

    2. PyTorch "Outputs: name, (name, name)" line:
       Flattens nested parens into a single token then counts top-level items.
       e.g. "output, (h_n, c_n)" -> 2

    3. Explicit tuple in a Returns description: Returns: ... (Tensor, Tensor)
       Counts only if every part looks like a tensor/array type.

    4. NumPy-style Returns section with dash-indented fields.
    """
    if not doc:
        return None

    first_line = doc.split("\n")[0].strip()

    # ── Pattern 1: inline arrow  func(...) -> (Type, Type) ──────────────────
    arrow_match = re.search(r"->\s*\(([^)]+)\)", first_line)
    if arrow_match:
        parts = [p.strip() for p in arrow_match.group(1).split(",") if p.strip()]
        if len(parts) >= 2:
            return len(parts)
        if len(parts) == 1:
            return 1

    # ── Pattern 2: PyTorch "Outputs: ..." line ───────────────────────────────
    outputs_match = re.search(r"Outputs?\s*:\s*(.+)", doc.split("\n")[0] if "Outputs" in doc.split("\n")[0] else doc)
    if outputs_match:
        raw = outputs_match.group(1).strip()
        # Replace each (...) group with a single placeholder so inner commas
        # don't get counted as separate top-level outputs
        flat = re.sub(r"\([^)]*\)", "TUPLE", raw)
        items = [x.strip() for x in flat.split(",") if x.strip()]
        if len(items) >= 1:
            return len(items)

    # ── Pattern 3: (Tensor, Tensor) anywhere in a Returns description ────────
    tuple_match = re.search(
        r"[Rr]eturns?\s*[:\-].*?\(([^)]+)\)", doc, re.DOTALL
    )
    if tuple_match:
        parts = [p.strip() for p in tuple_match.group(1).split(",") if p.strip()]
        if parts and all(re.search(r"[Tt]ensor|ndarray|array", p) for p in parts):
            return len(parts)

    # ── Pattern 4: NumPy-style Returns section with indented fields ──────────
    returns_section = re.search(
        r"(?:Returns?|Output)\s*\n\s*[-]+\s*\n(.*?)(?:\n\n|\Z)",
        doc,
        re.DOTALL | re.IGNORECASE
    )
    if returns_section:
        items = re.findall(r"^\s{4}\w", returns_section.group(1), re.MULTILINE)
        if items:
            return len(items)

    return None


def _extract_returns_from_doc(doc):
    """
    Extract the first return-type description line from a docstring.
    Handles both inline arrow syntax and 'Returns:' keyword.
    """
    # Inline arrow on first line: func(...) -> Tensor
    first_line = doc.split("\n")[0].strip()
    arrow = re.search(r"->\s*(.+)$", first_line)
    if arrow:
        return arrow.group(1).strip()

    # Keyword-based
    match = re.search(r"[Rr]eturns?\s*[:\n](.{0,200})", doc, re.DOTALL)
    if match:
        return match.group(1).strip().split("\n")[0].strip()

    return None


# =========================================================
# BUILD FORWARD INFO DICT  (shared by modules and plain fns)
# =========================================================

def _build_forward_info(fn, arguments, fallback_doc=None):
    """
    Given a callable `fn` and a pre-extracted argument list, infer
    num_outputs / returns_annotation and return the forward dict.

    `fallback_doc` is an extra docstring to consult when `fn`'s own doc
    is too generic (e.g. nn.Module base-class forward doc for nn.LSTM).
    """
    num_outputs = None
    returns_annotation = None

    # ── 1. Try return annotation from inspect.signature ──────────────────────
    try:
        sig = inspect.signature(fn)
        ret = sig.return_annotation
        if ret != inspect.Parameter.empty:
            returns_annotation = str(ret)
            num_outputs = _infer_num_outputs_from_annotation(ret)
    except (ValueError, TypeError):
        pass

    # ── 2. Fall back to fn's own docstring ───────────────────────────────────
    doc = inspect.getdoc(fn)
    if num_outputs is None and doc:
        num_outputs = _infer_num_outputs_from_doc(doc)
    if returns_annotation is None and doc:
        returns_annotation = _extract_returns_from_doc(doc)

    # ── 3. Fall back to the caller-supplied extra docstring ──────────────────
    #    (used for nn.LSTM etc. where forward() doc is the base class stub)
    if num_outputs is None and fallback_doc:
        num_outputs = _infer_num_outputs_from_doc(fallback_doc)
    if returns_annotation is None and fallback_doc:
        returns_annotation = _extract_returns_from_doc(fallback_doc)

    return {
        "arguments": arguments,
        "num_outputs": num_outputs,
        "returns_annotation": returns_annotation,
        "doc": doc or fallback_doc
    }


# =========================================================
# EXTRACT FORWARD INFO  (nn.Module subclasses)
# =========================================================

def extract_forward_info(cls):
    """
    Extract forward() parameters and return info for an nn.Module subclass.
    Returns None if the class has no meaningful forward().
    """
    forward_fn = getattr(cls, "forward", None)

    if forward_fn is None:
        return None

    # Skip nn.Module base class itself — no meaningful forward
    if forward_fn is getattr(nn.Module, "forward", None):
        return None

    # Collect forward() arguments, skipping 'self'
    arguments = []
    try:
        sig = inspect.signature(forward_fn)
        for name, param in sig.parameters.items():
            if name == "self":
                continue
            arguments.append({
                "name": name,
                "default": (
                    None
                    if param.default == inspect.Parameter.empty
                    else safe_serialize(param.default)
                ),
                "required": param.default == inspect.Parameter.empty,
                "kind": str(param.kind),
                "annotation": (
                    None
                    if param.annotation == inspect.Parameter.empty
                    else str(param.annotation)
                )
            })
    except (ValueError, TypeError):
        pass

    # Use the class-level docstring as fallback when forward()'s own doc is
    # the useless base-class stub (e.g. nn.LSTM whose forward doc says only
    # "Define the computation performed at every call.")
    forward_doc = inspect.getdoc(forward_fn) or ""
    base_forward_doc = inspect.getdoc(nn.Module.forward) or ""
    fallback = inspect.getdoc(cls) if forward_doc.strip() == base_forward_doc.strip() else None

    return _build_forward_info(forward_fn, arguments, fallback_doc=fallback)


# =========================================================
# MAIN EXTRACTION FUNCTION
# =========================================================

def extract_callable_info(obj):
    category = get_category(obj)

    result = {
        "category": category,
        "module": obj.__name__,
        "full_path": resolve_full_path(obj),
        "doc": inspect.getdoc(obj),
        # init_arguments is only meaningful for nn.Module classes.
        # Plain functions / builtins never have a constructor to configure.
        "init_arguments": [],
        "forward": None,
    }

    if category == "module" and inspect.isclass(obj) and issubclass(obj, nn.Module):
        # nn.Module subclass: __init__ args -> init_arguments
        #                     forward() args + return info -> forward
        result["init_arguments"] = extract_arguments(obj, skip_self=True)
        result["forward"] = extract_forward_info(obj)

    else:
        # Plain function / builtin / generic callable:
        # No constructor -> init_arguments stays [].
        # All call-site arguments + return info go in forward.
        arguments = extract_arguments(obj, skip_self=False)
        result["forward"] = _build_forward_info(obj, arguments)

    return result


# =========================================================
# SAVE TO JSON
# =========================================================

def save_json(data):
    filename = os.path.join("block_info", data["category"], f"{data['module']}.json")
    os.makedirs(os.path.dirname(filename), exist_ok=True)

    with open(filename, "w") as f:
        json.dump(data, f, indent=4)

    print(f"Saved -> {filename}")


# =========================================================
# PRETTY PRINT SUMMARY
# =========================================================

def print_summary(data):
    name = data["full_path"]
    print(f"\n{'='*60}")
    print(f"  {name}")
    print(f"{'='*60}")

    init_args = data.get("init_arguments", [])
    if init_args:
        req = [a["name"] for a in init_args if a["required"]]
        opt = [a["name"] for a in init_args if not a["required"]]
        print(f"  Init args    : required={req}  optional={opt}")
    else:
        print(f"  Init args    : (none — plain function)")

    fwd = data.get("forward")
    if fwd:
        fwd_args = [a["name"] for a in fwd.get("arguments", [])]
        print(f"  Forward args : {fwd_args}")
        print(f"  Num outputs  : {fwd.get('num_outputs')}")
        print(f"  Return type  : {fwd.get('returns_annotation')}")
    else:
        print(f"  Forward      : (none)")


# =========================================================
# EXAMPLES
# =========================================================

examples = [
    # nn.Modules
    nn.Conv2d,
    nn.BatchNorm2d,
    nn.Linear,
    nn.MultiheadAttention,
    nn.LSTM,
    nn.TransformerEncoderLayer,

    # Functional APIs
    F.relu,
    F.softmax,
    F.conv2d,

    # torch ops
    torch.matmul,
    torch.topk,
]

for item in examples:
    extracted = extract_callable_info(item)
    # print_summary(extracted)
    save_json(extracted)