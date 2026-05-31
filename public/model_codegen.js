(function (global) {
  const SKIP_INIT_KEYS = new Set(['self', 'out', 'device', 'dtype']);

  function isIoBlock(blockDef) {
    return blockDef && (blockDef.category === 'IO' || (blockDef.path || '').startsWith('io.'));
  }

  function isIoInput(blockDef) {
    return isIoBlock(blockDef) && blockDef.path === 'io.input';
  }

  function isIoOutput(blockDef) {
    return isIoBlock(blockDef) && blockDef.path === 'io.output';
  }

  function isModuleNode(node) {
    return node.block.category === 'Module' || (node.block.path || '').startsWith('torch.nn.');
  }

  function sanitizePyName(name, fallback) {
    let s = String(name || fallback || 'x').trim();
    s = s.replace(/[^a-zA-Z0-9_]/g, '_');
    if (!s) s = fallback || 'x';
    if (/^\d/.test(s)) s = '_' + s;
    if (['False', 'True', 'None', 'class', 'def', 'import', 'return'].includes(s)) s = '_' + s;
    return s;
  }

  function toClassName(filename) {
    const base = String(filename || 'model').replace(/\.py$/i, '');
    const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    if (!parts.length) return 'NeuralWeaveModel';
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
  }

  function pyLiteral(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);

    let text = String(value).trim();
    if (!text) return null;
    if (text === 'true' || text === 'True') return 'True';
    if (text === 'false' || text === 'False') return 'False';
    if (text === 'same' || text === 'valid') return `'${text}'`;

    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1);
    }

    if ((text.startsWith('(') && text.endsWith(')')) || (text.startsWith('[') && text.endsWith(']'))) {
      const inner = text.slice(1, -1).trim();
      if (!inner) return '()';
      const parts = inner.split(/[,\s]+/).filter(Boolean).map(part => pyLiteral(part.trim()));
      return '(' + parts.join(', ') + ')';
    }

    if (/^[+-]?\d+(\.\d+)?$/.test(text)) return text;

    if (/[,\s]/.test(text)) {
      const parts = text.split(/[,\s]+/).filter(Boolean).map(part => pyLiteral(part.trim()));
      if (parts.length > 1) return '(' + parts.join(', ') + ')';
      if (parts.length === 1) return parts[0];
    }

    return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  function moduleClassFromPath(path) {
    if (!path || !path.startsWith('torch.nn.')) return null;
    return 'nn.' + path.slice('torch.nn.'.length);
  }

  function functionCallFromPath(path) {
    if (!path || !path.startsWith('torch.')) return null;
    if (path.startsWith('torch.nn.functional.')) {
      return 'F.' + path.slice('torch.nn.functional.'.length);
    }
    return path;
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

  function formatInitArgs(node) {
    const args = node.block.init_arguments || {};
    const parts = [];
    Object.keys(args).forEach(key => {
      if (SKIP_INIT_KEYS.has(key)) return;
      const val = node.init_arguments ? node.init_arguments[key] : args[key].default;
      const lit = pyLiteral(val);
      if (lit === null && args[key].required !== 'True') return;
      if (lit === null) return;
      parts.push(`${key}=${lit}`);
    });
    return parts.join(', ');
  }

  function inputVarForPort(node, portIndex, connections, outputVars) {
    const conn = connections.find(c => c.to === node.id && c.toIndex === portIndex);
    if (!conn) return null;
    return outputVars[`${conn.from}:${conn.fromIndex}`];
  }

  function buildModelSource(graph, options) {
    const nodes = graph.nodes || [];
    const connections = graph.connections || [];
    const className = options.className || 'NeuralWeaveModel';
    const modelNotes = options.torchVersion ? `# PyTorch ${options.torchVersion}\n` : '';

    const inputNodes = nodes.filter(n => isIoInput(n.block));
    const outputNodes = nodes.filter(n => isIoOutput(n.block));
    const computeNodes = nodes.filter(n => !isIoBlock(n.block));

    if (!inputNodes.length) {
      throw new Error('Add at least one Input block with a name before exporting.');
    }
    if (!outputNodes.length) {
      throw new Error('Add at least one Output block with a name before exporting.');
    }

    inputNodes.forEach(n => {
      if (!n.ioName || !n.ioName.trim()) {
        throw new Error('Every Input block needs a name before exporting.');
      }
    });
    outputNodes.forEach(n => {
      if (!n.ioName || !n.ioName.trim()) {
        throw new Error('Every Output block needs a name before exporting.');
      }
    });

    const usesF = computeNodes.some(n => (n.block.path || '').startsWith('torch.nn.functional.'));
    const layerNames = new Map();
    const layerCounts = {};
    const initLines = [];
    const forwardLines = [];
    const outputVars = {};

    computeNodes.filter(isModuleNode).forEach(node => {
      const cls = moduleClassFromPath(node.block.path);
      if (!cls) return;
      const base = sanitizePyName(node.block.name, 'layer').toLowerCase();
      layerCounts[base] = (layerCounts[base] || 0) + 1;
      const attr = layerCounts[base] === 1 ? base : `${base}_${layerCounts[base]}`;
      layerNames.set(node.id, attr);
      const initArgs = formatInitArgs(node);
      initLines.push(`        self.${attr} = ${cls}(${initArgs})`);
    });

    inputNodes.forEach(node => {
      outputVars[`${node.id}:0`] = sanitizePyName(node.ioName, 'input');
    });

    const sorted = topoSort(nodes, connections);
    sorted.forEach(node => {
      if (isIoInput(node.block)) return;

      if (isIoOutput(node.block)) {
        const src = inputVarForPort(node, 0, connections, outputVars);
        if (!src) throw new Error(`Output "${node.ioName}" is not connected.`);
        outputVars[`${node.id}:0`] = sanitizePyName(node.ioName, 'output');
        forwardLines.push(`        ${outputVars[`${node.id}:0`]} = ${src}`);
        return;
      }

      const tensorInputs = (node.inputs || []).map((_inp, idx) =>
        inputVarForPort(node, idx, connections, outputVars)
      );

      if (tensorInputs.some(v => !v)) {
        throw new Error(`Block "${node.block.name}" has unconnected inputs.`);
      }

      const outVar = `t_${sanitizePyName(node.id, 'v')}`;
      outputVars[`${node.id}:0`] = outVar;

      if (isModuleNode(node)) {
        const attr = layerNames.get(node.id);
        forwardLines.push(`        ${outVar} = self.${attr}(${tensorInputs[0]})`);
        return;
      }

      const fn = functionCallFromPath(node.block.path);
      if (!fn) throw new Error(`Unsupported block: ${node.block.path || node.block.name}`);

      const fwd = node.block.forward_arguments || {};
      const argNames = Object.keys(fwd);
      const posArgs = [];
      const kwArgs = [];

      argNames.forEach((name, idx) => {
        const spec = fwd[name];
        if (spec.type === 'Tensor') {
          if (tensorInputs[idx]) posArgs.push(tensorInputs[idx]);
          return;
        }
        const lit = pyLiteral(spec.default);
        if (lit !== null) kwArgs.push(`${name}=${lit}`);
      });

      const callArgs = posArgs.concat(kwArgs).join(', ');
      forwardLines.push(`        ${outVar} = ${fn}(${callArgs})`);
    });

    const forwardParams = inputNodes.map(n => sanitizePyName(n.ioName, 'input')).join(', ');
    const returnValues = outputNodes.map(n => outputVars[`${n.id}:0`]).join(', ');
    const returnStmt = outputNodes.length === 1
      ? `return ${returnValues}`
      : `return ${returnValues}`;

    const exampleInputs = inputNodes.map(node => {
      const name = sanitizePyName(node.ioName, 'input');
      const dims = Array.isArray(node.shape) && node.shape.length
        ? '1, ' + node.shape.join(', ')
        : '1, 3, 224, 224';
      return { name, dims };
    });

    const mainLines = [
      "if __name__ == '__main__':",
      `    model = ${className}()`,
      '    model.eval()',
    ];

    exampleInputs.forEach(inp => {
      mainLines.push(`    ${inp.name} = torch.randn(${inp.dims})`);
    });

    const callArgs = exampleInputs.map(inp => inp.name).join(', ');
    if (outputNodes.length === 1) {
      mainLines.push('    with torch.no_grad():');
      mainLines.push(`        ${returnValues} = model(${callArgs})`);
      mainLines.push(`    print('${returnValues} shape:', tuple(${returnValues}.shape))`);
    } else {
      const outNames = outputNodes.map(n => outputVars[`${n.id}:0`]).join(', ');
      mainLines.push('    with torch.no_grad():');
      mainLines.push(`        ${outNames} = model(${callArgs})`);
      outputNodes.forEach(n => {
        const pname = outputVars[`${n.id}:0`];
        mainLines.push(`    print('${pname} shape:', tuple(${pname}.shape))`);
      });
    }

    const lines = [
      '"""Generated by NeuralWeaveUI."""',
      modelNotes.trim(),
      'import torch',
      'import torch.nn as nn',
      usesF ? 'import torch.nn.functional as F' : '',
      '',
      '',
      `class ${className}(nn.Module):`,
      '    def __init__(self):',
      '        super().__init__()',
      initLines.length ? initLines.join('\n') : '        pass',
      '',
      `    def forward(self, ${forwardParams}):`,
      forwardLines.join('\n'),
      `        ${returnStmt}`,
      '',
      '',
    ].concat(mainLines).concat(['']);

    return lines.filter((line, idx, arr) => !(line === '' && arr[idx - 1] === '')).join('\n');
  }

  global.NWUI_codegen = {
    buildModelSource,
    toClassName,
  };
})(window);
