(function (global) {
  const BATCH = 'B';

  function isKnownShape(shape) {
    return Array.isArray(shape) && shape.length > 0 && shape.every(d => d === BATCH || (Number.isInteger(d) && d > 0));
  }

  function withBatch(dims) {
    if (!Array.isArray(dims) || !dims.length) return null;
    if (!dims.every(d => Number.isInteger(d) && d > 0)) return null;
    return [BATCH].concat(dims);
  }

  function cloneShape(shape) {
    return shape ? shape.slice() : null;
  }

  function shapesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((shape, i) => {
      const other = b[i];
      if (shape === other) return true;
      if (!shape || !other) return false;
      if (shape.length !== other.length) return false;
      return shape.every((d, j) => d === other[j]);
    });
  }

  function formatShape(shape) {
    if (!isKnownShape(shape)) return '[B, …]';
    return '[' + shape.join(', ') + ']';
  }

  function parseNum(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const n = Number(String(value).trim());
    return Number.isFinite(n) ? n : fallback;
  }

  function parseDimPair(value, fallback) {
    if (Array.isArray(value) && value.length) {
      return value.map(v => parseNum(v, fallback));
    }
    if (value === null || value === undefined || value === '') return fallback;
    const text = String(value).trim();
    if (text.startsWith('(') && text.endsWith(')')) {
      const parts = text.slice(1, -1).split(',').map(s => parseNum(s.trim(), fallback));
      return parts.length === 1 ? parts[0] : parts;
    }
    if (text.includes(',')) {
      const parts = text.split(',').map(s => parseNum(s.trim(), fallback));
      return parts.length === 1 ? parts[0] : parts;
    }
    return parseNum(text, fallback);
  }

  function getInit(node, key, fallback) {
    return parseNum(node.init_arguments && node.init_arguments[key], fallback);
  }

  function getInitPair(node, key, fallback) {
    const raw = node.init_arguments && node.init_arguments[key];
    return parseDimPair(raw, fallback);
  }

  function spatialOut(inSize, kernel, stride, padding, dilation) {
    const k = parseNum(kernel, 1);
    const s = parseNum(stride, 1);
    const p = parseNum(padding, 0);
    const d = parseNum(dilation, 1);
    const size = parseNum(inSize, null);
    if (size === null || size <= 0) return null;
    return Math.floor((size + 2 * p - d * (k - 1) - 1) / s + 1);
  }

  function spatialOutTranspose(inSize, kernel, stride, padding, dilation, outputPadding) {
    const k = parseNum(kernel, 1);
    const s = parseNum(stride, 1);
    const p = parseNum(padding, 0);
    const d = parseNum(dilation, 1);
    const op = parseNum(outputPadding, 0);
    const size = parseNum(inSize, null);
    if (size === null || size <= 0) return null;
    return (size - 1) * s - 2 * p + d * (k - 1) + op + 1;
  }

  function normalizePair(value, fallback) {
    const parsed = parseDimPair(value, fallback);
    if (Array.isArray(parsed)) return parsed;
    return [parsed, parsed];
  }

  function identity(inputShapes) {
    return inputShapes[0] ? cloneShape(inputShapes[0]) : null;
  }

  function broadcastShapes(shapes) {
    const known = shapes.filter(isKnownShape);
    if (!known.length) return null;
    if (known.length === 1) return cloneShape(known[0]);

    const rank = Math.max(...known.map(s => s.length));
    const aligned = known.map(shape => {
      const pad = rank - shape.length;
      return Array(pad).fill(1).concat(shape);
    });

    const out = [];
    for (let i = 0; i < rank; i += 1) {
      let dim = 1;
      for (let j = 0; j < aligned.length; j += 1) {
        const d = aligned[j][i];
        if (d === BATCH) {
          dim = BATCH;
          continue;
        }
        if (dim !== BATCH && dim !== 1 && d !== 1 && dim !== d) return null;
        if (d !== 1) dim = d;
      }
      out.push(dim);
    }
    return out;
  }

  function convRule(node, inputShapes, spatialRank, transpose) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length !== spatialRank + 2) return null;

    const outChannels = getInit(node, 'out_channels', null);
    if (outChannels === null || outChannels <= 0) return null;

    const kernel = getInitPair(node, 'kernel_size', 1);
    const stride = getInitPair(node, 'stride', 1);
    const padding = getInitPair(node, 'padding', 0);
    const dilation = getInitPair(node, 'dilation', 1);
    const outputPadding = transpose ? getInitPair(node, 'output_padding', 0) : 0;

    const kernels = normalizePair(kernel, 1);
    const strides = normalizePair(stride, 1);
    const paddings = normalizePair(padding, 0);
    const dilations = normalizePair(dilation, 1);
    const outPads = normalizePair(outputPadding, 0);
    const fn = transpose ? spatialOutTranspose : spatialOut;

    const out = [input[0], outChannels];
    for (let i = 0; i < spatialRank; i += 1) {
      const next = fn(
        input[2 + i],
        kernels[Math.min(i, kernels.length - 1)],
        strides[Math.min(i, strides.length - 1)],
        paddings[Math.min(i, paddings.length - 1)],
        dilations[Math.min(i, dilations.length - 1)],
        transpose ? outPads[Math.min(i, outPads.length - 1)] : 0
      );
      if (next === null || next <= 0) return null;
      out.push(next);
    }
    return out;
  }

  function poolRule(node, inputShapes, spatialRank) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length !== spatialRank + 2) return null;

    const kernel = getInitPair(node, 'kernel_size', 1);
    const stride = getInitPair(node, 'stride', null);
    const padding = getInitPair(node, 'padding', 0);
    const dilation = getInitPair(node, 'dilation', 1);

    const kernels = normalizePair(kernel, 1);
    const strides = stride === null ? kernels : normalizePair(stride, 1);
    const paddings = normalizePair(padding, 0);
    const dilations = normalizePair(dilation, 1);

    const out = input.slice(0, 2);
    for (let i = 0; i < spatialRank; i += 1) {
      const next = spatialOut(
        input[2 + i],
        kernels[Math.min(i, kernels.length - 1)],
        strides[Math.min(i, strides.length - 1)],
        paddings[Math.min(i, paddings.length - 1)],
        dilations[Math.min(i, dilations.length - 1)]
      );
      if (next === null || next <= 0) return null;
      out.push(next);
    }
    return out;
  }

  function adaptivePoolRule(node, inputShapes, spatialRank) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length !== spatialRank + 2) return null;
    const target = getInitPair(node, 'output_size', null);
    if (target === null) return null;
    const sizes = normalizePair(target, 1);
    const out = input.slice(0, 2);
    for (let i = 0; i < spatialRank; i += 1) {
      out.push(parseNum(sizes[Math.min(i, sizes.length - 1)], null));
    }
    if (out.some((d, idx) => idx >= 2 && (d === null || d <= 0))) return null;
    return out;
  }

  function linearRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length < 2) return null;
    const outFeatures = getInit(node, 'out_features', null);
    if (outFeatures === null || outFeatures <= 0) return null;
    return input.slice(0, -1).concat(outFeatures);
  }

  function lazyLinearRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length < 2) return null;
    const outFeatures = getInit(node, 'out_features', null);
    if (outFeatures === null || outFeatures <= 0) return null;
    return input.slice(0, -1).concat(outFeatures);
  }

  function flattenRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length < 2) return null;
    const startDim = getInit(node, 'start_dim', 1);
    const endDim = getInit(node, 'end_dim', -1);
    const rank = input.length;
    const start = startDim < 0 ? rank + startDim : startDim;
    let end = endDim < 0 ? rank + endDim : endDim;
    if (start < 1 || end >= rank || start > end) return cloneShape(input);

    let flat = 1;
    for (let i = start; i <= end; i += 1) {
      const d = input[i];
      if (d === BATCH) return null;
      flat *= d;
    }
    return input.slice(0, start).concat(flat).concat(input.slice(end + 1));
  }

  function unsqueezeRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input)) return null;
    const dim = getInit(node, 'dim', 0);
    const rank = input.length;
    const index = dim < 0 ? rank + 1 + dim : dim;
    if (index < 0 || index > rank) return null;
    return input.slice(0, index).concat(1).concat(input.slice(index));
  }

  function squeezeRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input)) return null;
    const dimArg = node.init_arguments && node.init_arguments.dim;
    if (dimArg === null || dimArg === undefined || dimArg === '') {
      return input.filter((d, idx) => idx === 0 || d !== 1);
    }
    const dim = getInit(node, 'dim', 0);
    const rank = input.length;
    const index = dim < 0 ? rank + dim : dim;
    if (index < 0 || index >= rank || input[index] !== 1) return cloneShape(input);
    return input.slice(0, index).concat(input.slice(index + 1));
  }

  function matmulRule(_node, inputShapes) {
    const a = inputShapes[0];
    const b = inputShapes[1];
    if (!isKnownShape(a) || !isKnownShape(b) || a.length < 2 || b.length < 2) return null;
    if (a[a.length - 1] !== b[b.length - 2]) return null;

    const aBatch = a.slice(0, -2);
    const bBatch = b.slice(0, -2);
    const batch = aBatch.length || bBatch.length
      ? broadcastShapes([aBatch.length ? aBatch : [1], bBatch.length ? bBatch : [1]])
      : [];
    if (aBatch.length && bBatch.length && !batch) return null;
    return (batch || []).concat(a[a.length - 2], b[b.length - 1]);
  }

  function gluRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length < 2) return null;
    const dim = getInit(node, 'dim', -1);
    const rank = input.length;
    const index = dim < 0 ? rank + dim : dim;
    if (index < 1 || index >= rank) return null;
    const d = input[index];
    if (d === BATCH || d % 2 !== 0) return null;
    const out = input.slice();
    out[index] = d / 2;
    return out;
  }

  function pixelShuffleRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length !== 4) return null;
    const factor = getInit(node, 'upscale_factor', null);
    if (factor === null || factor <= 0) return null;
    const c = input[1];
    if (c === BATCH || c % (factor * factor) !== 0) return null;
    return [input[0], c / (factor * factor), input[2] * factor, input[3] * factor];
  }

  function upsampleRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length < 3) return null;
    const scale = getInitPair(node, 'scale_factor', null);
    const size = getInitPair(node, 'size', null);
    const out = input.slice();
    if (size !== null) {
      const sizes = normalizePair(size, null);
      if (input.length === 4) {
        out[2] = parseNum(sizes[0], out[2]);
        out[3] = parseNum(sizes[Math.min(1, sizes.length - 1)], out[3]);
      } else if (input.length === 3) {
        out[2] = parseNum(sizes[0], out[2]);
      }
      return out;
    }
    if (scale === null) return null;
    const scales = normalizePair(scale, null);
    if (input.length === 4) {
      out[2] = Math.floor(out[2] * parseNum(scales[0], 1));
      out[3] = Math.floor(out[3] * parseNum(scales[Math.min(1, scales.length - 1)], scales[0]));
    } else if (input.length === 3) {
      out[2] = Math.floor(out[2] * parseNum(scales[0], 1));
    }
    return out;
  }

  function embeddingRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input)) return null;
    const dim = getInit(node, 'embedding_dim', null);
    if (dim === null || dim <= 0) return null;
    return input.concat(dim);
  }

  const RULES = {
    'io.input': function (node) {
      if (!Array.isArray(node.shape) || !node.shape.length) return null;
      if (!node.shape.every(d => Number.isInteger(d) && d > 0)) return null;
      return withBatch(node.shape);
    },
    'io.output': function () {
      return null;
    },
    'torch.nn.Identity': identity,
    'torch.nn.Linear': linearRule,
    'torch.nn.LazyLinear': lazyLinearRule,
    'torch.nn.Conv1d': function (node, inputs) { return convRule(node, inputs, 1, false); },
    'torch.nn.Conv2d': function (node, inputs) { return convRule(node, inputs, 2, false); },
    'torch.nn.Conv3d': function (node, inputs) { return convRule(node, inputs, 3, false); },
    'torch.nn.LazyConv1d': function (node, inputs) { return convRule(node, inputs, 1, false); },
    'torch.nn.LazyConv2d': function (node, inputs) { return convRule(node, inputs, 2, false); },
    'torch.nn.LazyConv3d': function (node, inputs) { return convRule(node, inputs, 3, false); },
    'torch.nn.ConvTranspose1d': function (node, inputs) { return convRule(node, inputs, 1, true); },
    'torch.nn.ConvTranspose2d': function (node, inputs) { return convRule(node, inputs, 2, true); },
    'torch.nn.ConvTranspose3d': function (node, inputs) { return convRule(node, inputs, 3, true); },
    'torch.nn.MaxPool1d': function (node, inputs) { return poolRule(node, inputs, 1); },
    'torch.nn.MaxPool2d': function (node, inputs) { return poolRule(node, inputs, 2); },
    'torch.nn.MaxPool3d': function (node, inputs) { return poolRule(node, inputs, 3); },
    'torch.nn.AvgPool1d': function (node, inputs) { return poolRule(node, inputs, 1); },
    'torch.nn.AvgPool2d': function (node, inputs) { return poolRule(node, inputs, 2); },
    'torch.nn.AvgPool3d': function (node, inputs) { return poolRule(node, inputs, 3); },
    'torch.nn.AdaptiveAvgPool1d': function (node, inputs) { return adaptivePoolRule(node, inputs, 1); },
    'torch.nn.AdaptiveAvgPool2d': function (node, inputs) { return adaptivePoolRule(node, inputs, 2); },
    'torch.nn.AdaptiveAvgPool3d': function (node, inputs) { return adaptivePoolRule(node, inputs, 3); },
    'torch.nn.AdaptiveMaxPool1d': function (node, inputs) { return adaptivePoolRule(node, inputs, 1); },
    'torch.nn.AdaptiveMaxPool2d': function (node, inputs) { return adaptivePoolRule(node, inputs, 2); },
    'torch.nn.AdaptiveMaxPool3d': function (node, inputs) { return adaptivePoolRule(node, inputs, 3); },
    'torch.nn.GLU': gluRule,
    'torch.nn.PixelShuffle': pixelShuffleRule,
    'torch.nn.Upsample': upsampleRule,
    'torch.nn.Embedding': embeddingRule,
    'torch.flatten': flattenRule,
    'torch.add': function (_node, inputs) { return broadcastShapes(inputs); },
    'torch.sub': function (_node, inputs) { return broadcastShapes(inputs); },
    'torch.mul': function (_node, inputs) { return broadcastShapes(inputs); },
    'torch.div': function (_node, inputs) { return broadcastShapes(inputs); },
    'torch.matmul': matmulRule,
    'torch.bmm': matmulRule,
    'torch.nn.functional.interpolate': upsampleRule,
  };

  const IDENTITY_PREFIXES = [
    'torch.nn.ReLU', 'torch.nn.CELU', 'torch.nn.ELU', 'torch.nn.GELU', 'torch.nn.Hardsigmoid',
    'torch.nn.Hardswish', 'torch.nn.Hardtanh', 'torch.nn.LeakyReLU', 'torch.nn.LogSoftmax',
    'torch.nn.Mish', 'torch.nn.PReLU', 'torch.nn.ReLU6', 'torch.nn.SELU', 'torch.nn.Sigmoid',
    'torch.nn.SiLU', 'torch.nn.Softmax', 'torch.nn.Softplus', 'torch.nn.Softsign', 'torch.nn.Tanh',
    'torch.nn.Threshold', 'torch.nn.Dropout', 'torch.nn.Dropout2d', 'torch.nn.Dropout3d',
    'torch.nn.AlphaDropout', 'torch.nn.FeatureAlphaDropout', 'torch.nn.BatchNorm1d',
    'torch.nn.BatchNorm2d', 'torch.nn.BatchNorm3d', 'torch.nn.GroupNorm', 'torch.nn.InstanceNorm1d',
    'torch.nn.InstanceNorm2d', 'torch.nn.InstanceNorm3d', 'torch.nn.LayerNorm',
    'torch.nn.LocalResponseNorm', 'torch.nn.SyncBatchNorm', 'torch.abs', 'torch.exp', 'torch.log',
    'torch.sqrt', 'torch.pow', 'torch.clamp', 'torch.quantization.QuantStub',
    'torch.quantization.DeQuantStub', 'torch.nn.ChannelShuffle',
  ];

  function hasRequiredInputs(node, inputShapes) {
    return node.inputs.every((inp, idx) => {
      if (!inp.required) return true;
      return isKnownShape(inputShapes[idx]);
    });
  }

  function asOutputShapes(result, outputCount) {
    if (!result) return Array(outputCount).fill(null);
    if (Array.isArray(result) && result.length && (Array.isArray(result[0]) || result[0] === null)) {
      return result;
    }
    const outputs = [result];
    while (outputs.length < outputCount) outputs.push(null);
    return outputs;
  }

  function computeOutputShape(node, inputShapes) {
    const path = node.block.path || '';
    const rule = RULES[path];
    if (rule) {
      return asOutputShapes(rule(node, inputShapes), node.outputs.length);
    }

    if (IDENTITY_PREFIXES.includes(path)) {
      return asOutputShapes(identity(inputShapes), node.outputs.length);
    }

    if (path === 'torch.unsqueeze' || path === 'torch.Tensor.unsqueeze') {
      return asOutputShapes(unsqueezeRule(node, inputShapes), node.outputs.length);
    }

    if (path === 'torch.squeeze' || path === 'torch.Tensor.squeeze') {
      return asOutputShapes(squeezeRule(node, inputShapes), node.outputs.length);
    }

    if (node.block.category === 'Module' && inputShapes[0]) {
      return asOutputShapes(cloneShape(inputShapes[0]), node.outputs.length);
    }

    if (node.block.category === 'Function' && inputShapes[0]) {
      if (inputShapes.length > 1 && inputShapes.some(isKnownShape)) {
        return asOutputShapes(broadcastShapes(inputShapes), node.outputs.length);
      }
      return asOutputShapes(cloneShape(inputShapes[0]), node.outputs.length);
    }

    return node.outputs.map(() => null);
  }

  function propagateShapes(nodes, connections) {
    nodes.forEach(node => {
      node.inputShapes = node.inputs.map(() => null);
      node.outputShapes = node.outputs.map(() => null);
    });

    let changed = true;
    let passes = 0;
    const maxPasses = Math.max(4, nodes.length + 2);

    while (changed && passes < maxPasses) {
      changed = false;
      passes += 1;

      nodes.forEach(node => {
        const inputShapes = node.inputs.map(() => null);
        connections.forEach(conn => {
          if (conn.to !== node.id) return;
          const src = nodes.find(n => n.id === conn.from);
          if (!src || !src.outputShapes) return;
          const shape = src.outputShapes[conn.fromIndex];
          if (isKnownShape(shape)) inputShapes[conn.toIndex] = shape;
        });
        node.inputShapes = inputShapes;

        if (!node.outputs.length) return;
        if (!hasRequiredInputs(node, inputShapes) && node.block.path !== 'io.input') return;

        const nextOutputs = computeOutputShape(node, inputShapes);
        if (!shapesEqual(nextOutputs, node.outputShapes)) {
          node.outputShapes = nextOutputs;
          changed = true;
        }
      });
    }
  }

  global.NWUI_shape = {
    propagateShapes,
    formatShape,
    withBatch,
    isKnownShape,
  };
})(window);
