(function (global) {
  const BATCH = 'B';

  function isKnownShape(shape) {
    return Array.isArray(shape) && shape.length > 0 &&
      shape.every(d => d === BATCH || (Number.isInteger(d) && d > 0));
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
    if (typeof value === 'boolean') return fallback;
    const text = String(value).trim();
    if (!text) return fallback;
    const n = Number(text);
    return Number.isFinite(n) ? n : fallback;
  }

  function parseDimPair(value, fallback) {
    if (Array.isArray(value) && value.length) {
      const nums = value.map(v => parseNum(v, null)).filter(n => n !== null);
      if (!nums.length) return fallback;
      return nums.length === 1 ? nums[0] : nums;
    }
    if (value === null || value === undefined || value === '') return fallback;

    let text = String(value).trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1).trim();
    }

    if ((text.startsWith('(') && text.endsWith(')')) ||
        (text.startsWith('[') && text.endsWith(']'))) {
      const parts = text.slice(1, -1).split(/[,\s]+/).filter(Boolean)
        .map(s => parseNum(s, null))
        .filter(n => n !== null);
      if (!parts.length) return fallback;
      return parts.length === 1 ? parts[0] : parts;
    }

    if (/[,\s]/.test(text)) {
      const parts = text.split(/[,\s]+/).filter(Boolean)
        .map(s => parseNum(s, null))
        .filter(n => n !== null);
      if (!parts.length) return fallback;
      return parts.length === 1 ? parts[0] : parts;
    }

    return parseNum(text, fallback);
  }

  function normalizeDims(value, fallback, spatialRank) {
    const parsed = parseDimPair(value, fallback);
    if (parsed === null || parsed === undefined) {
      return Array(spatialRank).fill(fallback);
    }
    if (!Array.isArray(parsed)) {
      return Array(spatialRank).fill(parsed);
    }
    if (parsed.length === spatialRank) return parsed;
    if (parsed.length === 1) return Array(spatialRank).fill(parsed[0]);
    if (parsed.length > spatialRank) return parsed.slice(0, spatialRank);
    const out = parsed.slice();
    while (out.length < spatialRank) out.push(parsed[parsed.length - 1]);
    return out;
  }

  function dimAt(dims, axis) {
    return dims[Math.min(axis, dims.length - 1)];
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
    return normalizeDims(value, fallback, 2);
  }

  function ok(shape) {
    return { ok: true, shape: shape || null };
  }

  function fail(error) {
    return { ok: false, error };
  }

  function expectRank(input, rank) {
    if (!isKnownShape(input)) return null;
    if (input.length !== rank) {
      return fail(`Expected ${rank}D tensor, got ${formatShape(input)}`);
    }
    return null;
  }

  function checkChannelMatch(input, expected, label) {
    if (expected === null || expected <= 0) return null;
    if (input[1] !== expected) {
      return fail(`Input has ${input[1]} channels but ${label} is ${expected}`);
    }
    return null;
  }

  function checkLastDim(input, expected, label) {
    if (expected === null || expected <= 0) return null;
    if (input[input.length - 1] !== expected) {
      return fail(`Input last dim is ${input[input.length - 1]} but ${label} is ${expected}`);
    }
    return null;
  }

  function identity(inputShapes) {
    return ok(inputShapes[0] ? cloneShape(inputShapes[0]) : null);
  }

  function broadcastShapes(shapes) {
    const known = shapes.filter(isKnownShape);
    if (!known.length) return ok(null);
    if (known.length === 1) return ok(cloneShape(known[0]));

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
        if (dim !== BATCH && dim !== 1 && d !== 1 && dim !== d) return fail('Inputs are not broadcast-compatible');
        if (d !== 1) dim = d;
      }
      out.push(dim);
    }
    return ok(out);
  }

  function convRule(node, inputShapes, spatialRank, transpose, checkInChannels) {
    const input = inputShapes[0];
    if (!isKnownShape(input)) return ok(null);

    const rankErr = expectRank(input, spatialRank + 2);
    if (rankErr) return rankErr;

    if (checkInChannels) {
      const channelErr = checkChannelMatch(input, getInit(node, 'in_channels', null), 'in_channels');
      if (channelErr) return channelErr;
    }

    const outChannels = getInit(node, 'out_channels', null);
    if (outChannels === null || outChannels <= 0) return ok(null);

    const kernel = getInitPair(node, 'kernel_size', 1);
    const stride = getInitPair(node, 'stride', 1);
    const padding = getInitPair(node, 'padding', 0);
    const dilation = getInitPair(node, 'dilation', 1);
    const outputPadding = transpose ? getInitPair(node, 'output_padding', 0) : 0;

    const kernels = normalizeDims(kernel, 1, spatialRank);
    const strides = normalizeDims(stride, 1, spatialRank);
    const paddings = normalizeDims(padding, 0, spatialRank);
    const dilations = normalizeDims(dilation, 1, spatialRank);
    const outPads = normalizeDims(outputPadding, 0, spatialRank);
    const fn = transpose ? spatialOutTranspose : spatialOut;

    const out = [input[0], outChannels];
    for (let i = 0; i < spatialRank; i += 1) {
      const next = fn(
        input[2 + i],
        dimAt(kernels, i),
        dimAt(strides, i),
        dimAt(paddings, i),
        dimAt(dilations, i),
        transpose ? dimAt(outPads, i) : 0
      );
      if (next === null || next <= 0) {
        return fail(`Invalid output size for ${formatShape(input)} with kernel/stride/padding`);
      }
      out.push(next);
    }
    return ok(out);
  }

  function normRule(node, inputShapes, spatialRank, featureKey) {
    const input = inputShapes[0];
    if (!isKnownShape(input)) return ok(null);

    const rankErr = expectRank(input, spatialRank + 2);
    if (rankErr) return rankErr;

    const featureErr = checkChannelMatch(input, getInit(node, featureKey, null), featureKey);
    if (featureErr) return featureErr;

    return ok(cloneShape(input));
  }

  function poolRule(node, inputShapes, spatialRank) {
    const input = inputShapes[0];
    if (!isKnownShape(input)) return ok(null);

    const rankErr = expectRank(input, spatialRank + 2);
    if (rankErr) return rankErr;

    const kernel = getInitPair(node, 'kernel_size', 1);
    const stride = getInitPair(node, 'stride', null);
    const padding = getInitPair(node, 'padding', 0);
    const dilation = getInitPair(node, 'dilation', 1);

    const kernels = normalizeDims(kernel, 1, spatialRank);
    const strides = stride === null ? kernels : normalizeDims(stride, 1, spatialRank);
    const paddings = normalizeDims(padding, 0, spatialRank);
    const dilations = normalizeDims(dilation, 1, spatialRank);

    const out = input.slice(0, 2);
    for (let i = 0; i < spatialRank; i += 1) {
      const next = spatialOut(
        input[2 + i],
        dimAt(kernels, i),
        dimAt(strides, i),
        dimAt(paddings, i),
        dimAt(dilations, i)
      );
      if (next === null || next <= 0) {
        return fail(`Invalid pool output size for ${formatShape(input)}`);
      }
      out.push(next);
    }
    return ok(out);
  }

  function adaptivePoolRule(node, inputShapes, spatialRank) {
    const input = inputShapes[0];
    if (!isKnownShape(input)) return ok(null);

    const rankErr = expectRank(input, spatialRank + 2);
    if (rankErr) return rankErr;

    const target = getInitPair(node, 'output_size', null);
    if (target === null) return ok(null);
    const sizes = normalizeDims(target, 1, spatialRank);
    const out = input.slice(0, 2);
    for (let i = 0; i < spatialRank; i += 1) {
      out.push(parseNum(dimAt(sizes, i), null));
    }
    if (out.some((d, idx) => idx >= 2 && (d === null || d <= 0))) return ok(null);
    return ok(out);
  }

  function linearRule(node, inputShapes, checkInFeatures) {
    const input = inputShapes[0];
    if (!isKnownShape(input)) return ok(null);
    if (input.length < 2) return fail(`Expected at least 2D input, got ${formatShape(input)}`);

    if (checkInFeatures) {
      const inErr = checkLastDim(input, getInit(node, 'in_features', null), 'in_features');
      if (inErr) return inErr;
    }

    const outFeatures = getInit(node, 'out_features', null);
    if (outFeatures === null || outFeatures <= 0) return ok(null);
    return ok(input.slice(0, -1).concat(outFeatures));
  }

  function flattenRule(_node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length < 2) return ok(null);
    return ok(cloneShape(input));
  }

  function matmulRule(_node, inputShapes) {
    const a = inputShapes[0];
    const b = inputShapes[1];
    if (!isKnownShape(a) || !isKnownShape(b)) return ok(null);
    if (a.length < 2 || b.length < 2) {
      return fail('matmul inputs must be at least 2D');
    }
    if (a[a.length - 1] !== b[b.length - 2]) {
      return fail(`Inner dims mismatch: ${a[a.length - 1]} vs ${b[b.length - 2]}`);
    }

    const aBatch = a.slice(0, -2);
    const bBatch = b.slice(0, -2);
    const batchResult = aBatch.length || bBatch.length
      ? broadcastShapes([aBatch.length ? aBatch : [1], bBatch.length ? bBatch : [1]])
      : ok([]);
    if (!batchResult.ok) return batchResult;
    const batch = batchResult.shape || [];
    return ok(batch.concat(a[a.length - 2], b[b.length - 1]));
  }

  function gluRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length < 2) return ok(null);
    const dim = getInit(node, 'dim', -1);
    const rank = input.length;
    const index = dim < 0 ? rank + dim : dim;
    if (index < 1 || index >= rank) return fail(`GLU dim ${dim} invalid for ${formatShape(input)}`);
    const d = input[index];
    if (d === BATCH || d % 2 !== 0) {
      return fail(`GLU requires even size at dim ${index}, got ${d}`);
    }
    const out = input.slice();
    out[index] = d / 2;
    return ok(out);
  }

  function pixelShuffleRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input)) return ok(null);
    const rankErr = expectRank(input, 4);
    if (rankErr) return rankErr;
    const factor = getInit(node, 'upscale_factor', null);
    if (factor === null || factor <= 0) return ok(null);
    const c = input[1];
    if (c === BATCH || c % (factor * factor) !== 0) {
      return fail(`Channels ${c} not divisible by upscale_factor² (${factor * factor})`);
    }
    return ok([input[0], c / (factor * factor), input[2] * factor, input[3] * factor]);
  }

  function upsampleRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input) || input.length < 3) return ok(null);
    const scale = getInitPair(node, 'scale_factor', null);
    const size = getInitPair(node, 'size', null);
    const out = input.slice();
    if (size !== null) {
      const sizes = normalizeDims(size, null, input.length === 4 ? 2 : 1);
      if (input.length === 4) {
        out[2] = parseNum(dimAt(sizes, 0), out[2]);
        out[3] = parseNum(dimAt(sizes, 1), out[3]);
      } else if (input.length === 3) {
        out[2] = parseNum(dimAt(sizes, 0), out[2]);
      }
      return ok(out);
    }
    if (scale === null) return ok(null);
    const scales = normalizeDims(scale, null, input.length === 4 ? 2 : 1);
    if (input.length === 4) {
      out[2] = Math.floor(out[2] * parseNum(dimAt(scales, 0), 1));
      out[3] = Math.floor(out[3] * parseNum(dimAt(scales, 1), dimAt(scales, 0)));
    } else if (input.length === 3) {
      out[2] = Math.floor(out[2] * parseNum(dimAt(scales, 0), 1));
    }
    return ok(out);
  }

  function embeddingRule(node, inputShapes) {
    const input = inputShapes[0];
    if (!isKnownShape(input)) return ok(null);
    const dim = getInit(node, 'embedding_dim', null);
    if (dim === null || dim <= 0) return ok(null);
    return ok(input.concat(dim));
  }

  const RULES = {
    'io.input': function (node) {
      if (!Array.isArray(node.shape) || !node.shape.length) return ok(null);
      if (!node.shape.every(d => Number.isInteger(d) && d > 0)) {
        return fail('Input shape must be positive integers');
      }
      return ok(withBatch(node.shape));
    },
    'io.output': function () {
      return ok(null);
    },
    'torch.nn.Identity': identity,
    'torch.nn.Linear': function (node, inputs) { return linearRule(node, inputs, true); },
    'torch.nn.LazyLinear': function (node, inputs) { return linearRule(node, inputs, false); },
    'torch.nn.Conv1d': function (node, inputs) { return convRule(node, inputs, 1, false, true); },
    'torch.nn.Conv2d': function (node, inputs) { return convRule(node, inputs, 2, false, true); },
    'torch.nn.Conv3d': function (node, inputs) { return convRule(node, inputs, 3, false, true); },
    'torch.nn.LazyConv1d': function (node, inputs) { return convRule(node, inputs, 1, false, false); },
    'torch.nn.LazyConv2d': function (node, inputs) { return convRule(node, inputs, 2, false, false); },
    'torch.nn.LazyConv3d': function (node, inputs) { return convRule(node, inputs, 3, false, false); },
    'torch.nn.ConvTranspose1d': function (node, inputs) { return convRule(node, inputs, 1, true, true); },
    'torch.nn.ConvTranspose2d': function (node, inputs) { return convRule(node, inputs, 2, true, true); },
    'torch.nn.ConvTranspose3d': function (node, inputs) { return convRule(node, inputs, 3, true, true); },
    'torch.nn.BatchNorm1d': function (node, inputs) { return normRule(node, inputs, 1, 'num_features'); },
    'torch.nn.BatchNorm2d': function (node, inputs) { return normRule(node, inputs, 2, 'num_features'); },
    'torch.nn.BatchNorm3d': function (node, inputs) { return normRule(node, inputs, 3, 'num_features'); },
    'torch.nn.InstanceNorm1d': function (node, inputs) { return normRule(node, inputs, 1, 'num_features'); },
    'torch.nn.InstanceNorm2d': function (node, inputs) { return normRule(node, inputs, 2, 'num_features'); },
    'torch.nn.InstanceNorm3d': function (node, inputs) { return normRule(node, inputs, 3, 'num_features'); },
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
    'torch.nn.AlphaDropout', 'torch.nn.FeatureAlphaDropout', 'torch.nn.GroupNorm',
    'torch.nn.LayerNorm', 'torch.nn.LocalResponseNorm', 'torch.nn.SyncBatchNorm',
    'torch.abs', 'torch.exp', 'torch.log', 'torch.sqrt', 'torch.pow', 'torch.clamp',
    'torch.quantization.QuantStub', 'torch.quantization.DeQuantStub', 'torch.nn.ChannelShuffle',
  ];

  function hasRequiredInputs(node, inputShapes) {
    return node.inputs.every((inp, idx) => {
      if (!inp.required) return true;
      return isKnownShape(inputShapes[idx]);
    });
  }

  function asOutputShapes(shape, outputCount) {
    if (!shape) return Array(outputCount).fill(null);
    const outputs = [shape];
    while (outputs.length < outputCount) outputs.push(null);
    return outputs;
  }

  function computeNodeResult(node, inputShapes) {
    const path = node.block.path || '';
    const rule = RULES[path];
    if (rule) return rule(node, inputShapes);

    if (IDENTITY_PREFIXES.includes(path)) return identity(inputShapes);

    if (node.block.category === 'Module' && isKnownShape(inputShapes[0])) {
      return ok(cloneShape(inputShapes[0]));
    }

    if (node.block.category === 'Function' && isKnownShape(inputShapes[0])) {
      if (inputShapes.length > 1 && inputShapes.some(isKnownShape)) {
        return broadcastShapes(inputShapes);
      }
      return ok(cloneShape(inputShapes[0]));
    }

    return ok(null);
  }

  function evaluateNode(node, inputShapes) {
    const result = computeNodeResult(node, inputShapes);
    if (!result.ok) {
      return { outputs: node.outputs.map(() => null), error: result.error };
    }
    return { outputs: asOutputShapes(result.shape, node.outputs.length), error: null };
  }

  function topoSort(nodes, connections) {
    const depth = new Map();

    function getDepth(id, visiting) {
      if (depth.has(id)) return depth.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let d = 0;
      connections.forEach(c => {
        if (c.to === id) d = Math.max(d, getDepth(c.from, visiting) + 1);
      });
      visiting.delete(id);
      depth.set(id, d);
      return d;
    }

    nodes.forEach(n => getDepth(n.id, new Set()));
    return nodes.slice().sort((a, b) => {
      const diff = depth.get(a.id) - depth.get(b.id);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
  }

  function findFirstErrorNode(nodes, connections) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const queue = nodes.filter(n => n.block.path === 'io.input').map(n => n.id);
    const visited = new Set();

    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const node = byId.get(id);
      if (node && node.shapeError) return node;
      connections.forEach(c => {
        if (c.from === id) queue.push(c.to);
      });
    }

    return nodes.find(n => n.shapeError) || null;
  }

  function propagateShapes(nodes, connections) {
    const byId = new Map(nodes.map(n => [n.id, n]));

    nodes.forEach(node => {
      node.inputShapes = node.inputs.map(() => null);
      node.outputShapes = node.outputs.map(() => null);
      node.shapeError = null;
    });

    topoSort(nodes, connections).forEach(node => {
      const inputShapes = node.inputs.map(() => null);

      connections.forEach(conn => {
        if (conn.to !== node.id) return;
        const src = byId.get(conn.from);
        if (!src || src.shapeError) return;
        const shape = src.outputShapes && src.outputShapes[conn.fromIndex];
        if (isKnownShape(shape)) inputShapes[conn.toIndex] = shape;
      });

      node.inputShapes = inputShapes;

      if (!node.outputs.length) return;
      if (!hasRequiredInputs(node, inputShapes) && node.block.path !== 'io.input') return;

      const { outputs, error } = evaluateNode(node, inputShapes);
      node.shapeError = error;
      node.outputShapes = error ? node.outputs.map(() => null) : outputs;
    });

    return { firstErrorNode: findFirstErrorNode(nodes, connections) };
  }

  global.NWUI_shape = {
    propagateShapes,
    formatShape,
    withBatch,
    isKnownShape,
  };
})(window);
