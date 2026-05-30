(function () {
  const VERSION_STORAGE_KEY = 'nwui_torch_version';
  const homePage = document.getElementById('homePage');
  const editorApp = document.getElementById('editorApp');
  const trainingApp = document.getElementById('trainingApp');
  const versionSelect = document.getElementById('torchVersionSelect');
  const versionError = document.getElementById('versionError');
  const createModelBtn = document.getElementById('createModelBtn');
  const trainingLoopBtn = document.getElementById('trainingLoopBtn');
  const homeLoading = document.getElementById('homeLoading');
  const homeLoadingText = document.getElementById('homeLoadingText');
  const editorVersionLabel = document.getElementById('editorVersionLabel');
  const trainingVersionLabel = document.getElementById('trainingVersionLabel');
  const backHomeBtn = document.getElementById('backHomeBtn');
  const backHomeFromTrainingBtn = document.getElementById('backHomeFromTrainingBtn');

  let versions = [];
  let selectedVersion = null;
  let busy = false;

  function setVersionError(message) {
    if (!message) {
      versionError.hidden = true;
      versionError.textContent = '';
      return;
    }
    versionError.hidden = false;
    versionError.textContent = message;
  }

  function updateActionButtons() {
    const enabled = Boolean(selectedVersion) && !busy;
    createModelBtn.disabled = !enabled;
    trainingLoopBtn.disabled = !enabled;
  }

  function onVersionChange() {
    const value = versionSelect.value;
    selectedVersion = value && value.length > 0 ? value : null;
    setVersionError('');
    updateActionButtons();
  }

  function renderVersionDropdown(list) {
    versionSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select PyTorch version…';
    versionSelect.appendChild(placeholder);

    list.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.label;
      versionSelect.appendChild(opt);
    });

    versionSelect.value = '';
    selectedVersion = null;
    versionSelect.disabled = false;
    updateActionButtons();
  }

  function setLoading(active, text) {
    busy = active;
    homeLoading.classList.toggle('hidden', !active);
    if (text) homeLoadingText.textContent = text;
    versionSelect.disabled = active;
    updateActionButtons();
  }

  function hideAllViews() {
    homePage.classList.add('hidden');
    editorApp.classList.add('hidden');
    trainingApp.classList.add('hidden');
  }

  function showHome() {
    hideAllViews();
    homePage.classList.remove('hidden');
    document.title = 'NeuralWeaveUI';
    setLoading(false);
  }

  function showEditor(versionMeta) {
    hideAllViews();
    editorApp.classList.remove('hidden');
    document.title = `NeuralWeaveUI — ${versionMeta.label}`;
    if (editorVersionLabel) {
      editorVersionLabel.textContent = versionMeta.label;
    }
    if (typeof window.NWUI_startEditor === 'function') {
      window.NWUI_startEditor(versionMeta);
    }
  }

  function showTraining(versionMeta) {
    hideAllViews();
    trainingApp.classList.remove('hidden');
    document.title = `NeuralWeaveUI — Training loop`;
    if (trainingVersionLabel) {
      trainingVersionLabel.textContent = versionMeta.label;
    }
  }

  async function prepareBlocks(version) {
    const res = await fetch('/api/prepare-blocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Prepare failed (${res.status})`);
    }
    return data;
  }

  function requireVersion() {
    if (!selectedVersion) {
      setVersionError('Select a PyTorch version from the dropdown first.');
      return null;
    }
    return versions.find(v => v.id === selectedVersion);
  }

  async function runWorkspace(mode) {
    const meta = requireVersion();
    if (!meta) return;

    setLoading(true, `Generating blocks for PyTorch ${selectedVersion}…`);
    setVersionError('');

    try {
      const result = await prepareBlocks(selectedVersion);
      sessionStorage.setItem(VERSION_STORAGE_KEY, selectedVersion);
      const versionMeta = {
        id: selectedVersion,
        label: result.label || meta.label,
        blocksGenerated: result.blocksGenerated,
      };

      setLoading(false);

      if (mode === 'model') {
        showEditor(versionMeta);
        return;
      }

      showTraining(versionMeta);
    } catch (err) {
      setLoading(false);
      setVersionError(err.message);
    }
  }

  async function loadVersions() {
    const res = await fetch('/api/torch-versions');
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Could not load torch versions');
    }
    versions = data.versions || [];
    renderVersionDropdown(versions);
  }

  versionSelect.addEventListener('change', onVersionChange);
  createModelBtn.addEventListener('click', () => runWorkspace('model'));
  trainingLoopBtn.addEventListener('click', () => runWorkspace('training'));
  backHomeBtn.addEventListener('click', showHome);
  backHomeFromTrainingBtn.addEventListener('click', showHome);

  setLoading(false);
  loadVersions().catch(err => {
    versionSelect.innerHTML = '<option value="">Failed to load versions</option>';
    setVersionError(err.message);
  });
})();
