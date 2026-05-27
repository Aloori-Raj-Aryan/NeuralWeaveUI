import json
import inspect
import os
import torch
import torch.nn as nn
import torch.nn.functional as F


# =========================================================
# CATEGORY DETECTION
# =========================================================

def get_category(obj):

    if inspect.isclass(obj):
        print(f"Class: {obj.__name__}")
        return "module"

    elif inspect.isfunction(obj):
        print(f"Function: {obj.__name__}")
        return "functional"

    elif inspect.isbuiltin(obj):
        print(f"Built-in Function: {obj.__name__}")
        return "builtin"

    elif callable(obj):
        print(f"Callable: {obj.__name__}")
        return "callable"

    return "unknown"


# =========================================================
# SAFE SERIALIZATION
# =========================================================

def safe_serialize(value):

    try:
        json.dumps(value)
        return value

    except:
        return str(value)


# =========================================================
# PARSE __text_signature__
# =========================================================

def parse_text_signature(text_signature):

    if text_signature is None:
        return []

    text_signature = text_signature.strip()

    if text_signature.startswith("("):
        text_signature = text_signature[1:]

    if text_signature.endswith(")"):
        text_signature = text_signature[:-1]

    arguments = []

    for item in text_signature.split(","):

        item = item.strip()

        if not item:
            continue

        # Ignore "/" and "*"
        if item in ["/", "*"]:
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

    # Example:
    # conv2d(input, weight, bias=None, ...)

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
# FIX FULL PATH FOR BUILTIN TORCH OPS
# =========================================================

def resolve_full_path(obj):

    # ---------------------------------------------
    # NORMAL PYTHON OBJECTS
    # ---------------------------------------------

    module_name = getattr(obj, "__module__", None)

    if module_name is not None:

        return f"{module_name}.{obj.__name__}"

    # ---------------------------------------------
    # FALLBACK FOR TORCH BUILTIN OPS
    # ---------------------------------------------

    # Many torch builtin ops have:
    # __module__ == None
    #
    # So we manually check if they exist in F

    if hasattr(F, obj.__name__):

        candidate = getattr(F, obj.__name__)

        if candidate is obj:
            return f"torch.nn.functional.{obj.__name__}"

    # ---------------------------------------------
    # CHECK torch namespace
    # ---------------------------------------------

    if hasattr(torch, obj.__name__):

        candidate = getattr(torch, obj.__name__)

        if candidate is obj:
            return f"torch.{obj.__name__}"

    return f"unknown.{obj.__name__}"


# =========================================================
# MAIN EXTRACTION FUNCTION
# =========================================================

def extract_callable_info(obj):

    arguments = []

    # =====================================================
    # TRY inspect.signature()
    # =====================================================

    try:

        sig = inspect.signature(obj)

        for name, param in sig.parameters.items():

            arguments.append({

                "name": name,

                "default":
                    None
                    if param.default == inspect.Parameter.empty
                    else safe_serialize(param.default),

                "required":
                    param.default == inspect.Parameter.empty,

                "kind":
                    str(param.kind),

                "annotation":
                    None
                    if param.annotation == inspect.Parameter.empty
                    else str(param.annotation)
            })

    # =====================================================
    # FALLBACKS FOR BUILTIN/C++ FUNCTIONS
    # =====================================================

    except (ValueError, TypeError):

        # ---------------------------------------------
        # FALLBACK 1 -> __text_signature__
        # ---------------------------------------------

        text_sig = getattr(obj, "__text_signature__", None)

        arguments = parse_text_signature(text_sig)

        # ---------------------------------------------
        # FALLBACK 2 -> DOCSTRING PARSING
        # ---------------------------------------------

        if not arguments:

            doc = inspect.getdoc(obj)

            arguments = parse_doc_signature(
                doc,
                obj.__name__
            )

    # =====================================================
    # RETURN NORMALIZED STRUCTURE
    # =====================================================

    return {

        "category": get_category(obj),

        "module": obj.__name__,

        "full_path": resolve_full_path(obj),

        "arguments": arguments,

        "doc":
            inspect.getdoc(obj)
    }

def save_json(data):

    filename = os.path.join("block_info", data['category'], f"{data['module']}.json")
    dir = os.path.dirname(filename)
    os.makedirs(dir, exist_ok=True)


    with open(filename, "w") as f:
        json.dump(data, f, indent=4)

    print(f"Saved -> {filename}")


# =========================================================
# TESTS
# =========================================================

examples = [

    # nn.Modules
    nn.Conv2d,
    nn.BatchNorm2d,
    nn.Linear,

    # Functional APIs
    F.relu,
    F.softmax,
    F.conv2d,

    # torch ops
    torch.matmul
]

for item in examples:

    print("\n========================================")

    extracted = extract_callable_info(item)

    # print(json.dumps(extracted, indent=4))

    save_json(extracted)