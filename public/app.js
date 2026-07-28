let categories = [];
let activeCategory = '';
let activeSubcategory = '';
let allLoadedDocs = [];

const Toast = {
  container: null,
  init() {
    this.container = document.getElementById('toastContainer');
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'toastContainer';
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },
  show(message, type = 'info', duration = 4000) {
    if (!this.container) this.init();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'warning') icon = '⚠️';
    if (type === 'error') icon = '❌';

    toast.innerHTML = `
      <div style="display: flex; align-items: flex-start; gap: 0.5rem;">
        <span class="toast-icon">${icon}</span>
        <div class="toast-content">${escapeHtml(message)}</div>
      </div>
      <button class="toast-close" title="Dismiss">✕</button>
    `;

    const closeBtn = toast.querySelector('.toast-close');
    if (closeBtn) {
      closeBtn.onclick = () => this.dismiss(toast);
    }

    this.container.appendChild(toast);

    if (duration > 0) {
      setTimeout(() => this.dismiss(toast), duration);
    }
  },
  dismiss(toast) {
    if (!toast || toast.classList.contains('toast-hiding')) return;
    toast.classList.add('toast-hiding');
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  },
  success(msg, duration) { this.show(msg, 'success', duration); },
  info(msg, duration) { this.show(msg, 'info', duration); },
  warning(msg, duration) { this.show(msg, 'warning', duration); },
  error(msg, duration) { this.show(msg, 'error', duration); }
};

document.addEventListener('DOMContentLoaded', () => {
  Toast.init();
  window.Toast = Toast;
  
  // Display initial system toast on load
  Toast.info('🚀 PDF Triage & Agentic Registry Ready\nListening to 10s auto-watcher in __raws', 5000);

  setupLiveReload();
  setupGlobalTriageSSE();
  checkOllamaStatus();
  setInterval(checkOllamaStatus, 10000);

  loadCategories();
  loadDocuments();

  addEv('searchInput', 'input', debounce(loadDocuments, 300));
  addEv('btnScan', 'click', handleScan);
  addEv('btnRepair', 'click', handleRepairRegistry);
  addEv('btnRepairRegistry', 'click', handleRepairRegistry);
  addEv('btnClear', 'click', handleClearRegistry);
  addEv('btnClearRegistry', 'click', handleClearRegistry);
  addEv('btnOpenRaws', 'click', handleOpenRaws);
  addEv('btnOpenArchive', 'click', handleOpenArchive);
  addEv('btnCloseModal', 'click', closeModal);
  addEv('btnCancelEdit', 'click', closeModal);
  addEv('editForm', 'submit', handleSaveEdit);

  // Filter Listeners
  addEv('filterCategory', 'change', (e) => {
    activeCategory = e.target.value;
    activeSubcategory = '';
    updateFilterSubcategoriesDropdown();
    loadCategories();
    loadDocuments();
  });
  addEv('filterSubcategory', 'change', (e) => {
    activeSubcategory = e.target.value;
    loadDocuments();
  });
  addEv('btnResetFilters', 'click', () => {
    activeCategory = '';
    activeSubcategory = '';
    const searchEl = document.getElementById('searchInput');
    if (searchEl) searchEl.value = '';
    loadCategories();
    loadDocuments();
  });

  // Settings Modal Listeners
  addEv('btnSettings', 'click', openSettingsModal);
  addEv('btnOpenSettings', 'click', openSettingsModal);
  addEv('btnCloseSettings', 'click', closeSettingsModal);
  addEv('settingsForm', 'submit', handleSaveSettings);
  addEv('tabBtnSystem', 'click', () => switchSettingsTab('system'));
  addEv('tabBtnCategories', 'click', () => switchSettingsTab('categories'));
  addEv('btnAddCategory', 'click', handleAddCategory);

  addEv('btnStartOllama', 'click', handleStartOllama);
  addEv('btnRestartServer', 'click', handleRestartServer);
});

function addEv(id, event, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, handler);
  } else {
    console.warn(`Element with ID '${id}' not found for event binding '${event}'.`);
  }
}

async function checkOllamaStatus() {
  const badge = document.getElementById('ollamaStatusBadge');
  const textEl = document.getElementById('ollamaStatusText');
  const btnStart = document.getElementById('btnStartOllama');
  const btnRestart = document.getElementById('btnRestartServer');
  if (!badge || !textEl) return;

  try {
    const res = await fetch('/api/ollama/status');
    const data = await res.json();

    if (data.online) {
      badge.className = 'ollama-status-badge online';
      textEl.textContent = `Ollama AI (${data.model})`;
      badge.title = `Connected to local Ollama AI at ${data.host} (${data.modelsCount} models ready)`;
      if (btnStart) btnStart.style.display = 'none';
      if (btnRestart) btnRestart.style.display = 'none';
      if (data.modelExists) {
        setEngineStatus('Ready', '#10b981');
      } else {
        setEngineStatus('Model Missing', '#f59e0b');
      }
    } else {
      badge.className = 'ollama-status-badge offline';
      textEl.textContent = 'Ollama Disconnected';
      badge.title = `Cannot connect to Ollama at ${data.host}. Click 'Start Ollama' to launch.`;
      if (btnStart) btnStart.style.display = 'inline-flex';
      if (btnRestart) btnRestart.style.display = 'inline-flex';
      setEngineStatus('Disconnected', '#ef4444');
    }
  } catch {
    badge.className = 'ollama-status-badge offline';
    textEl.textContent = 'Ollama Offline';
    badge.title = 'Local Ollama server is offline.';
    if (btnStart) btnStart.style.display = 'inline-flex';
    if (btnRestart) btnRestart.style.display = 'inline-flex';
    setEngineStatus('Offline', '#ef4444');
  }
}

function setEngineStatus(label, color) {
  const el = document.getElementById('statSystemStatus');
  if (!el) return;
  el.textContent = label;
  el.style.color = color;
}

async function handleStartOllama() {
  const btn = document.getElementById('btnStartOllama');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Starting...';
  }

  try {
    await fetch('/api/ollama/start', { method: 'POST' });
    Toast.info('⏳ Launching local Ollama server...');
    setTimeout(() => {
      checkOllamaStatus();
      if (btn) {
        btn.disabled = false;
        btn.textContent = '▶️ Start Ollama';
      }
    }, 2500);
  } catch (err) {
    Toast.error('Failed to start Ollama: ' + err.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '▶️ Start Ollama';
    }
  }
}

async function handleRestartServer() {
  if (!confirm('Are you sure you want to restart the backend server?')) return;
  try {
    await fetch('/api/server/restart', { method: 'POST' });
  } catch (err) {}
}

function setupLiveReload() {
  if (!!window.EventSource) {
    const source = new EventSource('/api/dev/livereload');
    source.onmessage = (e) => {
      if (e.data === 'reload') {
        window.location.reload();
      }
    };
    source.onerror = () => {
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    };
  }
}

function setupGlobalTriageSSE() {
  if (!!window.EventSource) {
    const sse = new EventSource('/api/triage/events');
    sse.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        // Quietly update categories & documents live without spamming Toast notifications
        if (
          evt.type === 'FILE_COMPLETED' ||
          evt.type === 'SCAN_COMPLETED' ||
          evt.type === 'REGISTRY_UPDATED' ||
          evt.type === 'CATEGORIES_UPDATED' ||
          evt.type === 'REPAIR_COMPLETED' ||
          evt.type === 'FILE_FAILED'
        ) {
          if (evt.type === 'SCAN_COMPLETED' && (evt.processedCount || 0) > 0) {
            Toast.info(`✨ Triage Scan Completed: Processed ${evt.processedCount} PDF(s).`, 4000);
          }
          // Quiet background live dashboard refresh
          loadCategories();
          loadDocuments();
        }
      } catch (err) {}
    };
  }
}

async function openFileLocation(targetPath) {
  if (!targetPath) return;
  try {
    const res = await fetch('/api/open-location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPath })
    });
    if (!res.ok) {
      const err = await res.json();
      Toast.error('Error opening location: ' + (err.error || 'Path not found'));
    } else {
      Toast.info('📂 Opened Windows Explorer');
    }
  } catch (err) {
    Toast.error('Failed to open location: ' + err.message);
  }
}

async function handleOpenRaws() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg.input_dir) {
      openFileLocation(cfg.input_dir);
    }
  } catch (err) {
    alert('Failed to get input directory: ' + err.message);
  }
}

async function handleOpenArchive() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg.output_root_dir) {
      openFileLocation(cfg.output_root_dir);
    }
  } catch (err) {
    alert('Failed to get output directory: ' + err.message);
  }
}

async function handleRepairRegistry() {
  const btn = document.getElementById('btnRepairRegistry');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Repairing...';
  }

  try {
    const res = await fetch('/api/registry/repair', { method: 'POST' });
    const data = await res.json();
    Toast.success(`Registry Repair Finished:\n- Scanned: ${data.scannedCount}\n- Repaired: ${data.repairedCount}\n- Relocalized: ${data.relocalizedCount || 0}\n- Returned to __raws: ${data.movedToRawsCount || 0}\n- Updated: ${data.updatedCount}`, 6000);
    loadCategories();
    loadDocuments();
  } catch (err) {
    Toast.error('Failed to repair registry: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔧 Repair';
    }
  }
}

async function handleClearRegistry() {
  if (!confirm('Are you sure you want to clear the registry and move all archived PDFs back to __raws?')) return;

  try {
    const res = await fetch('/api/documents', { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      Toast.success(data.message || 'Registry cleared & files returned to __raws!');
      loadCategories();
      loadDocuments();
    } else {
      Toast.error('Error clearing registry: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    Toast.error('Failed to clear registry: ' + err.message);
  }
}

async function handleRelocalizeDoc(docId) {
  try {
    const res = await fetch(`/api/documents/${docId}/relocalize`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      Toast.success(data.message || 'Document relocalized successfully');
      loadCategories();
      loadDocuments();
    } else if (res.status === 404 || data.staleCleaned || (data.error && data.error.includes('not found'))) {
      Toast.info('ℹ️ Registry updated: Document record refreshed.');
      loadCategories();
      loadDocuments();
    } else {
      Toast.warning(data.error || 'Unable to relocalize document.');
    }
  } catch (err) {
    Toast.error('Failed to relocalize document: ' + err.message);
  }
}

async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    const data = await res.json();
    
    categories = Array.isArray(data) ? data : (data.categories || []);
    window.categories = categories;
    const totalDocsCount = data.totalDocuments !== undefined ? data.totalDocuments : 0;

    const statDocs = document.getElementById('statTotalDocs');
    const statCats = document.getElementById('statCategoriesCount');
    const statSubs = document.getElementById('statSubcategoriesCount');

    if (statDocs) statDocs.textContent = totalDocsCount;
    if (statCats) {
      const activeCats = categories.filter(c => (c.count || 0) > 0).length;
      statCats.textContent = activeCats;
    }
    if (statSubs) {
      let subCount = 0;
      categories.forEach(c => {
        if (c.subcategories) {
          subCount += c.subcategories.filter(s => (s.count || 0) > 0).length;
        }
      });
      statSubs.textContent = subCount;
    }

    // Populate filterCategory select if present
    const filterCatSelect = document.getElementById('filterCategory');
    if (filterCatSelect) {
      const currVal = filterCatSelect.value;
      filterCatSelect.innerHTML = `<option value="">All Categories</option>` + categories.map(c => `
        <option value="${c.id}" ${c.id === currVal ? 'selected' : ''}>${c.name} (${c.count || 0})</option>
      `).join('');
    }

    updateFilterSubcategoriesDropdown();

    const pillsContainer = document.getElementById('categoryPills');
    const selectContainer = document.getElementById('editCategory');
    
    if (pillsContainer) {
      pillsContainer.innerHTML = '';
      const allBtn = document.createElement('button');
      allBtn.className = `pill ${!activeCategory ? 'active' : ''} ${totalDocsCount === 0 ? 'disabled' : ''}`;
      allBtn.dataset.cat = '';
      allBtn.textContent = `All Documents (${totalDocsCount})`;
      if (totalDocsCount === 0) {
        allBtn.disabled = true;
      } else {
        allBtn.addEventListener('click', () => {
          document.querySelectorAll('.category-pills .pill').forEach(p => p.classList.remove('active'));
          allBtn.classList.add('active');
          activeCategory = '';
          activeSubcategory = '';
          loadDocuments();
        });
      }
      pillsContainer.appendChild(allBtn);
    }
    if (selectContainer) {
      selectContainer.innerHTML = '';
    }

    categories.forEach(cat => {
      const catCount = cat.count !== undefined ? cat.count : 0;
      if (pillsContainer) {
        const btn = document.createElement('button');
        const isActive = activeCategory === cat.id;
        btn.className = `pill ${isActive ? 'active' : ''} ${catCount === 0 ? 'disabled' : ''}`;
        btn.dataset.cat = cat.id;
        btn.textContent = `${cat.name} (${catCount})`;
        
        if (catCount === 0) {
          btn.disabled = true;
          btn.title = 'No documents in this category';
        } else {
          btn.addEventListener('click', () => {
            document.querySelectorAll('.category-pills .pill').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            activeCategory = cat.id;
            activeSubcategory = '';
            loadDocuments();
          });
        }
        pillsContainer.appendChild(btn);
      }

      if (selectContainer) {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = `${cat.name} (${catCount})`;
        selectContainer.appendChild(opt);
      }
    });

    renderSubcategories();
  } catch (err) {
    console.error('Failed to load categories', err);
  }
}

function updateFilterSubcategoriesDropdown() {
  const filterSubSelect = document.getElementById('filterSubcategory');
  if (!filterSubSelect) return;

  const catList = (window.categories && window.categories.length > 0) ? window.categories : (categories || []);
  const catObj = catList.find(c => c.id === activeCategory);
  const subs = (catObj && catObj.subcategories) ? catObj.subcategories : [];

  filterSubSelect.innerHTML = `<option value="">All Subcategories</option>` + subs.map(s => `
    <option value="${s.id}" ${s.id === activeSubcategory ? 'selected' : ''}>${s.name || s.id} (${s.count || 0})</option>
  `).join('');
}

async function loadDocuments() {
  const searchEl = document.getElementById('searchInput');
  const query = searchEl ? searchEl.value.trim() : '';
  const url = `/api/documents?q=${encodeURIComponent(query)}&category=${encodeURIComponent(activeCategory)}&subcategory=${encodeURIComponent(activeSubcategory)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    allLoadedDocs = data.documents || [];
    renderDocsGrid(allLoadedDocs);
    renderSubcategories();
  } catch (err) {
    console.error('Failed to load documents', err);
  }
}

function renderSubcategories() {
  const container = document.getElementById('subcategoryPills');
  if (!container) return;

  // Map: subId -> { name: string, count: number }
  let subcatsMap = new Map();

  if (activeCategory) {
    const catObj = categories.find(c => c.id.toLowerCase() === activeCategory.toLowerCase());
    if (catObj && catObj.subcategories) {
      catObj.subcategories.forEach(sub => {
        if (sub.id && sub.id !== 'general') {
          subcatsMap.set(sub.id.toLowerCase(), {
            name: sub.name || formatSubName(sub.id),
            count: sub.count !== undefined ? sub.count : 0
          });
        }
      });
    }

    // Also include any dynamic subcategories present in allLoadedDocs matching activeCategory
    allLoadedDocs.forEach(doc => {
      if (doc.category.toLowerCase() === activeCategory.toLowerCase()) {
        const subId = (doc.subcategory || '').toLowerCase();
        if (subId && subId !== 'general' && !subcatsMap.has(subId)) {
          const matchingDocs = allLoadedDocs.filter(d => 
            d.category.toLowerCase() === activeCategory.toLowerCase() && 
            (d.subcategory || '').toLowerCase() === subId
          );
          subcatsMap.set(subId, {
            name: formatSubName(subId),
            count: matchingDocs.length
          });
        }
      }
    });
  } else {
    // When "All Documents" selected, gather subcategories across all categories
    categories.forEach(cat => {
      (cat.subcategories || []).forEach(sub => {
        if (sub.id && sub.id !== 'general') {
          const current = subcatsMap.get(sub.id.toLowerCase());
          subcatsMap.set(sub.id.toLowerCase(), {
            name: sub.name || formatSubName(sub.id),
            count: (current ? current.count : 0) + (sub.count || 0)
          });
        }
      });
    });

    allLoadedDocs.forEach(doc => {
      const subId = (doc.subcategory || '').toLowerCase();
      if (subId && subId !== 'general' && !subcatsMap.has(subId)) {
        const matchingDocs = allLoadedDocs.filter(d => (d.subcategory || '').toLowerCase() === subId);
        subcatsMap.set(subId, {
          name: formatSubName(subId),
          count: matchingDocs.length
        });
      }
    });
  }

  // If no subcategories exist in config or documents, hide container
  if (subcatsMap.size === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = 'flex';
  
  let totalSubItems = 0;
  subcatsMap.forEach(val => totalSubItems += val.count);

  container.innerHTML = `
    <span class="sub-pill-label">📂 Subcategories:</span>
    <button class="sub-pill ${!activeSubcategory ? 'active' : ''} ${totalSubItems === 0 ? 'disabled' : ''}" data-sub="">All Subcategories (${totalSubItems})</button>
  `;

  const allSubBtn = container.querySelector('button[data-sub=""]');
  if (allSubBtn) {
    if (totalSubItems === 0) {
      allSubBtn.disabled = true;
    } else {
      allSubBtn.addEventListener('click', () => {
        activeSubcategory = '';
        container.querySelectorAll('.sub-pill').forEach(p => p.classList.remove('active'));
        allSubBtn.classList.add('active');
        loadDocuments();
      });
    }
  }

  // Render each subcategory pill
  subcatsMap.forEach((info, subId) => {
    const btn = document.createElement('button');
    const isActive = activeSubcategory === subId;
    const isZero = info.count === 0;
    btn.className = `sub-pill ${isActive ? 'active' : ''} ${isZero ? 'disabled' : ''}`;
    btn.dataset.sub = subId;
    btn.textContent = `${info.name} (${info.count})`;
    
    if (isZero) {
      btn.disabled = true;
      btn.title = 'No documents in this subcategory';
    } else {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.sub-pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        activeSubcategory = subId;
        loadDocuments();
      });
    }
    container.appendChild(btn);
  });
}

function formatSubName(str) {
  if (!str) return '';
  return str
    .split(/[\/\\]+/)
    .map(part => part.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))
    .join(' ➔ ');
}

function renderDocsGrid(docs) {
  const grid = document.getElementById('docsGrid') || document.getElementById('documentsGrid');
  if (!grid) return;
  
  grid.innerHTML = '';

  if (docs.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 4rem 1rem; color: #94a3b8;">
        <h3>No documents found in registry</h3>
        <p>Drop PDF files into <code>__raws</code> folder and click 'Scan PDFs'.</p>
      </div>
    `;
    return;
  }

  docs.forEach(doc => {
    const card = document.createElement('div');
    card.className = 'doc-card';

    const tagsHtml = (doc.tags || []).map(t => `<span class="tag">#${t}</span>`).join(' ');
    const categoryBadgeText = doc.subcategory && doc.subcategory !== 'general' 
      ? `${doc.category.toUpperCase()} / ${doc.subcategory.toUpperCase().replace(/[\/\\]+/g, ' / ')}`
      : doc.category.toUpperCase();

    const targetPath = doc.new_path || doc.original_path;
    const displayContent = (doc.markdown_content || doc.raw_text || '').trim();
    const contentHeader = doc.markdown_content ? '📝 Document Markdown (.md):' : '📜 PDF Text Content:';

    card.innerHTML = `
      <div>
        <div class="card-header">
          <h3 class="card-title">${escapeHtml(doc.title)}</h3>
          <span class="badge">${escapeHtml(categoryBadgeText)}</span>
        </div>
        <div class="meta-row">
          <span>📅 ${escapeHtml(doc.date || 'N/A')}</span>
          <span>🏷️ ${escapeHtml(doc.registre || 'No Ref')}</span>
        </div>
        <div class="summary-box" style="background: rgba(15, 23, 42, 0.75); border-left: 3px solid #38bdf8; border-radius: 6px; padding: 0.65rem 0.85rem; margin: 0.5rem 0 0.75rem 0; font-size: 0.85rem; line-height: 1.45; color: #e2e8f0;">
          <strong style="color: #38bdf8; display: block; margin-bottom: 0.25rem;">💡 Executive Summary:</strong>
          ${escapeHtml(doc.summary || 'No summary available.')}
        </div>
        <div class="doc-text-snippet">
          <div class="doc-text-snippet-header">${contentHeader}</div>
          <div>${escapeHtml(displayContent)}</div>
        </div>
        <div class="tags-row">${tagsHtml}</div>
      </div>
      <div class="card-actions">
        <button class="btn-secondary" style="padding: 0.4rem 0.6rem; font-size: 0.8rem;" onclick="openFileLocation('${escapeJsString(targetPath)}')">📂 Location</button>
        <button class="btn-secondary" style="padding: 0.4rem 0.6rem; font-size: 0.8rem; color: #a7f3d0;" onclick="openRelocalizeModal(${doc.id})" title="Relocalize & Correct Category/Subcategory">📍 Relocalize</button>
        <button class="btn-secondary" style="padding: 0.4rem 0.6rem; font-size: 0.8rem;" onclick="openEditModal(${doc.id})">Read & Edit ✏️</button>
      </div>
    `;

    grid.appendChild(card);
  });
}

let activeRelocalizeDoc = null;

async function openRelocalizeModal(docId) {
  try {
    const res = await fetch(`/api/documents/${docId}`);
    const doc = await res.json();
    activeRelocalizeDoc = doc;

    document.getElementById('relocalizeDocId').value = doc.id;
    document.getElementById('relocalizeDocTitle').textContent = doc.title;
    document.getElementById('relocalizeCurrentPath').textContent = `Current Path: ${doc.new_path || doc.original_path}`;
    document.getElementById('relocalizeReason').value = '';
    document.getElementById('relocalizeCustomSubcategory').value = '';
    document.getElementById('relocalizeCustomSubcategory').style.display = 'none';

    // Populate Category select
    const catList = (window.categories && window.categories.length > 0) ? window.categories : (categories || []);
    const catSelect = document.getElementById('relocalizeCategorySelect');
    catSelect.innerHTML = catList.map(c => `
      <option value="${c.id}" ${c.id === doc.category ? 'selected' : ''}>
        ${c.name} (${c.id})
      </option>
    `).join('');

    updateSubcategoriesDropdown(doc.category, doc.subcategory);

    const relModal = document.getElementById('relocalizeModal');
    if (relModal) relModal.classList.add('open', 'active');
  } catch (err) {
    Toast.error('Error opening relocalize modal: ' + err.message);
  }
}

function updateSubcategoriesDropdown(selectedCatId, selectedSubId) {
  const catList = (window.categories && window.categories.length > 0) ? window.categories : (categories || []);
  const catObj = catList.find(c => c.id === selectedCatId);
  const subSelect = document.getElementById('relocalizeSubcategorySelect');
  const subs = (catObj && catObj.subcategories) ? catObj.subcategories : [];

  let optionsHtml = subs.map(s => `
    <option value="${s.id}" ${s.id === selectedSubId ? 'selected' : ''}>
      ${s.name} (${s.id})
    </option>
  `).join('');

  optionsHtml += `<option value="__EDIT__">✏️ Rename / Edit Current Subcategory...</option>`;
  optionsHtml += `<option value="__NEW__">➕ Add New Subcategory...</option>`;
  subSelect.innerHTML = optionsHtml;

  const customInput = document.getElementById('relocalizeCustomSubcategory');
  if (subSelect.value === '__NEW__' || subSelect.value === '__EDIT__') {
    customInput.style.display = 'block';
    if (subSelect.value === '__EDIT__') {
      customInput.value = selectedSubId || '';
      customInput.placeholder = 'Enter updated subcategory slug name...';
    } else {
      customInput.value = '';
      customInput.placeholder = 'Enter new subcategory slug (e.g. credit_mutuel, pacifique4)...';
    }
  } else {
    customInput.style.display = 'none';
  }
}

function combineRelocalizeReasons() {
  const catReason = document.getElementById('relocalizeCatErrorReason')?.value || '';
  const subReason = document.getElementById('relocalizeSubErrorReason')?.value || '';
  const parts = [];
  if (catReason && catReason !== '__CUSTOM__') parts.push(`Category Error: ${catReason}`);
  if (subReason && subReason !== '__CUSTOM__') parts.push(`Subcategory Error: ${subReason}`);
  
  const textarea = document.getElementById('relocalizeReason');
  if (parts.length > 0) {
    textarea.value = parts.join(' | ');
  }
}

document.getElementById('relocalizeCatErrorReason')?.addEventListener('change', combineRelocalizeReasons);
document.getElementById('relocalizeSubErrorReason')?.addEventListener('change', combineRelocalizeReasons);

document.getElementById('relocalizeCategorySelect')?.addEventListener('change', (e) => {
  updateSubcategoriesDropdown(e.target.value);
});

document.getElementById('relocalizeSubcategorySelect')?.addEventListener('change', (e) => {
  const customInput = document.getElementById('relocalizeCustomSubcategory');
  if (e.target.value === '__NEW__' || e.target.value === '__EDIT__') {
    customInput.style.display = 'block';
    if (e.target.value === '__EDIT__') {
      customInput.value = activeRelocalizeDoc?.subcategory || '';
      customInput.placeholder = 'Enter updated subcategory slug name...';
    } else {
      customInput.value = '';
      customInput.placeholder = 'Enter new subcategory slug (e.g. credit_mutuel, pacifique4)...';
    }
    customInput.focus();
  } else {
    customInput.style.display = 'none';
  }
});

document.getElementById('btnCloseRelocalizeModal')?.addEventListener('click', () => {
  const relModal = document.getElementById('relocalizeModal');
  if (relModal) relModal.classList.remove('open', 'active');
});

document.getElementById('btnConfirmRelocalize')?.addEventListener('click', async () => {
  const docId = document.getElementById('relocalizeDocId').value;
  const category = document.getElementById('relocalizeCategorySelect').value;
  let subcategory = document.getElementById('relocalizeSubcategorySelect').value;
  const customSub = document.getElementById('relocalizeCustomSubcategory').value.trim();
  const reason = document.getElementById('relocalizeReason').value.trim();

  if (subcategory === '__NEW__' || subcategory === '__EDIT__') {
    if (!customSub) {
      Toast.error('Please enter a valid custom subcategory slug.');
      return;
    }
    subcategory = customSub.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  }

  try {
    const res = await fetch(`/api/documents/${docId}/relocalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, subcategory, reason })
    });
    const data = await res.json();
    if (res.ok) {
      Toast.success(`📍 Relocalized to: ${category.toUpperCase()} / ${subcategory.toUpperCase()}\n${data.document?.new_path || ''}`, 5000);
      const relModal = document.getElementById('relocalizeModal');
      if (relModal) relModal.classList.remove('open', 'active');
      loadDocuments();
      loadCategories();
    } else {
      Toast.error('Relocalize failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    Toast.error('Failed to relocalize: ' + err.message);
  }
});

document.getElementById('btnAiReanalyze')?.addEventListener('click', async () => {
  const docId = document.getElementById('relocalizeDocId').value;
  const reason = document.getElementById('relocalizeReason').value.trim();

  try {
    Toast.info('🤖 Re-analyzing document with Qwen 3.5 AI & user feedback...', 4000);
    const res = await fetch(`/api/documents/${docId}/relocalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const data = await res.json();
    if (res.ok) {
      Toast.success(`🤖 AI Re-Analysis Complete!\nMoved to: ${data.document?.category.toUpperCase()} / ${data.document?.subcategory.toUpperCase()}`, 5000);
      const relModal = document.getElementById('relocalizeModal');
      if (relModal) relModal.classList.remove('open', 'active');
      loadDocuments();
      loadCategories();
    } else {
      Toast.error('AI Re-Analysis failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    Toast.error('AI Re-Analysis error: ' + err.message);
  }
});

async function openEditModal(docId) {
  try {
    const res = await fetch(`/api/documents/${docId}`);
    const doc = await res.json();

    setVal('editDocId', doc.id);
    setVal('editTitle', doc.title);
    setVal('editRegistre', doc.registre || '');
    setVal('editDate', doc.date || '');
    setVal('editCategory', doc.category || 'other');
    setVal('editSubcategory', doc.subcategory || 'general');
    setVal('editSummary', doc.summary || '');
    setVal('editTags', (doc.tags || []).join(', '));
    
    const rawTextEl = document.getElementById('editRawText');
    if (rawTextEl) {
      rawTextEl.textContent = doc.markdown_content || doc.raw_text || '[No text content extracted]';
    }

    const modal = document.getElementById('editModal');
    if (modal) modal.classList.add('open');
  } catch (err) {
    Toast.error('Failed to load document details: ' + err.message);
  }
}

function closeModal() {
  const modal = document.getElementById('editModal');
  if (modal) modal.classList.remove('open');
}

async function handleSaveEdit(e) {
  e.preventDefault();

  const id = getVal('editDocId');
  const updates = {
    title: getVal('editTitle'),
    registre: getVal('editRegistre'),
    date: getVal('editDate'),
    category: getVal('editCategory'),
    subcategory: getVal('editSubcategory'),
    summary: getVal('editSummary'),
    tags: getVal('editTags').split(',').map(t => t.trim()).filter(Boolean)
  };

  try {
    const res = await fetch(`/api/documents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });

    if (res.ok) {
      closeModal();
      Toast.success('Document updated & synced successfully!');
      loadCategories();
      loadDocuments();
    } else {
      const error = await res.json();
      Toast.error('Error updating document: ' + (error.error || 'Unknown error'));
    }
  } catch (err) {
    Toast.error('Failed to save edit: ' + err.message);
  }
}

async function handleScan() {
  const btn = document.getElementById('btnScan');
  const modal = document.getElementById('scanProgressModal');
  const header = document.getElementById('scanProgressHeader');
  const list = document.getElementById('scanProgressList');
  const btnClose = document.getElementById('btnCloseScanProgress');
  const btnDone = document.getElementById('btnDoneScanProgress');

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Scanning PDFs...';
  }

  if (modal) modal.classList.add('open');
  if (header) header.innerHTML = `Connecting to execution flow stream...`;
  if (list) list.innerHTML = ``;
  if (btnDone) btnDone.style.display = 'none';

  const closeProgressModal = () => {
    if (modal) modal.classList.remove('open');
    loadCategories();
    loadDocuments();
  };

  if (btnClose) btnClose.onclick = closeProgressModal;
  if (btnDone) btnDone.onclick = closeProgressModal;

  const fileRows = new Map();

  let sse = null;
  if (!!window.EventSource) {
    sse = new EventSource('/api/triage/events');
    sse.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === 'SCAN_STARTED') {
          if (header) {
            header.innerHTML = `Found <strong>${evt.totalFiles}</strong> incoming PDF(s) in <code>__raws</code> folder. Following live triage flow:`;
          }
          (evt.files || []).forEach(fname => {
            if (!fileRows.has(fname)) {
              const row = document.createElement('div');
              row.className = 'scan-progress-row';
              row.dataset.file = fname;
              row.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 0.2rem;">
                  <span class="scan-progress-filename">📄 ${escapeHtml(fname)}</span>
                  <span class="step-msg" style="font-size: 0.78rem; color: #94a3b8;">Queued in __raws...</span>
                </div>
                <span class="scan-stage-badge scan-stage-QUEUED">QUEUED</span>
              `;
              list.appendChild(row);
              fileRows.set(fname, row);
            }
          });
        } else if (evt.type === 'FILE_PROGRESS') {
          const row = fileRows.get(evt.filename);
          if (row) {
            const msgEl = row.querySelector('.step-msg');
            const badgeEl = row.querySelector('.scan-stage-badge');
            if (msgEl) msgEl.textContent = evt.message || evt.stage;
            if (badgeEl) {
              badgeEl.className = `scan-stage-badge scan-stage-${evt.stage}`;
              badgeEl.textContent = formatStageName(evt.stage);
            }
          }
        } else if (evt.type === 'FILE_COMPLETED') {
          const row = fileRows.get(evt.filename);
          if (row) {
            const msgEl = row.querySelector('.step-msg');
            const badgeEl = row.querySelector('.scan-stage-badge');
            if (msgEl) {
              msgEl.innerHTML = evt.stage === 'SKIPPED_DUPLICATE' 
                ? `⏭️ Duplicate (ID: ${evt.docId})` 
                : `✅ <strong>${escapeHtml(evt.title)}</strong> (${evt.category.toUpperCase()}/${(evt.subcategory || 'general').toUpperCase()})`;
            }
            if (badgeEl) {
              badgeEl.className = `scan-stage-badge scan-stage-${evt.stage}`;
              badgeEl.textContent = evt.stage === 'SKIPPED_DUPLICATE' ? 'SKIPPED DUPLICATE' : 'COMPLETED';
            }
          }
          // Live dashboard update as each PDF completes
          loadCategories();
          loadDocuments();
        } else if (evt.type === 'FILE_FAILED') {
          const row = fileRows.get(evt.filename);
          if (row) {
            const msgEl = row.querySelector('.step-msg');
            const badgeEl = row.querySelector('.scan-stage-badge');
            if (msgEl) msgEl.textContent = `❌ ${evt.message}`;
            if (badgeEl) {
              badgeEl.className = 'scan-stage-badge scan-stage-FAILED';
              badgeEl.textContent = 'FAILED';
            }
          }
        } else if (evt.type === 'SCAN_COMPLETED') {
          if (header) {
            header.innerHTML = `🎉 <strong>Triage Scan Complete!</strong> Scanned: ${evt.scannedCount} | Processed: ${evt.processedCount} | Skipped: ${evt.skippedCount}`;
          }
          if (btnDone) btnDone.style.display = 'inline-block';
          if (sse) sse.close();
        }
      } catch (err) {}
    };
  }

  try {
    const res = await fetch('/api/triage/scan', { method: 'POST' });
    const data = await res.json();
    if (header) {
      header.innerHTML = `🎉 <strong>Triage Scan Complete!</strong> Scanned: ${data.scannedCount} | Processed: ${data.processedCount} | Skipped: ${data.skippedCount}`;
    }
    if (btnDone) btnDone.style.display = 'inline-block';
  } catch (err) {
    alert('Error running triage scan: ' + err.message);
  } finally {
    if (sse) sse.close();
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Scan PDFs';
    }
  }
}

function formatStageName(stage) {
  switch (stage) {
    case 'EXTRACTING_TEXT': return '📜 Extracting Text';
    case 'AI_CLASSIFYING': return '🤖 AI Classifying';
    case 'RELOCALIZING': return '📂 Relocalizing';
    case 'COMPLETED': return '✅ Completed';
    case 'SKIPPED_DUPLICATE': return '⏭️ Duplicate';
    case 'FAILED': return '❌ Failed';
    default: return stage;
  }
}

/* Settings Modal Handlers */
async function openSettingsModal() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();

    setVal('cfgInputDir', cfg.input_dir || '');
    setVal('cfgOutputDir', cfg.output_root_dir || '');
    setVal('cfgOllamaModel', cfg.ollama_model || 'qwen2.5:7b');
    setVal('cfgOllamaHost', cfg.ollama_host || 'http://127.0.0.1:11434');

    renderCategoriesManager();

    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.add('open');
  } catch (err) {
    alert('Error loading configuration: ' + err.message);
  }
}

function closeSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.classList.remove('open');
}

function switchSettingsTab(tabName) {
  const systemForm = document.getElementById('settingsForm');
  const catEditor = document.getElementById('categoriesEditor');
  const btnSys = document.getElementById('tabBtnSystem');
  const btnCat = document.getElementById('tabBtnCategories');

  if (tabName === 'system') {
    if (systemForm) systemForm.style.display = 'block';
    if (catEditor) catEditor.style.display = 'none';
    if (btnSys) btnSys.style.borderBottom = '2px solid var(--accent-blue)';
    if (btnCat) btnCat.style.borderBottom = 'none';
  } else {
    if (systemForm) systemForm.style.display = 'none';
    if (catEditor) catEditor.style.display = 'block';
    if (btnSys) btnSys.style.borderBottom = 'none';
    if (btnCat) btnCat.style.borderBottom = '2px solid var(--accent-blue)';
  }
}

async function handleSaveSettings(e) {
  e.preventDefault();

  const payload = {
    input_dir: getVal('cfgInputDir').trim(),
    output_root_dir: getVal('cfgOutputDir').trim(),
    ollama_model: getVal('cfgOllamaModel').trim(),
    ollama_host: getVal('cfgOllamaHost').trim()
  };

  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      Toast.success('System configuration updated successfully!');
      closeSettingsModal();
      checkOllamaStatus();
    } else {
      const err = await res.json();
      Toast.error('Error updating config: ' + (err.error || 'Unknown error'));
    }
  } catch (err) {
    Toast.error('Failed to save settings: ' + err.message);
  }
}

function renderCategoriesManager() {
  const container = document.getElementById('categoriesList');
  if (!container) return;
  
  container.innerHTML = '';

  categories.forEach((cat, catIdx) => {
    const card = document.createElement('div');
    card.className = 'category-manage-card';
    card.style.cssText = 'background: rgba(15,23,42,0.7); border: 1px solid var(--border-color); border-radius: 12px; padding: 1rem; margin-bottom: 1rem; display: flex; flex-direction: column; gap: 0.8rem;';

    // 1. Category Bar
    const topRow = document.createElement('div');
    topRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1.5fr 2fr auto; gap: 0.8rem; align-items: center;';
    topRow.innerHTML = `
      <div>
        <span class="badge" style="font-size: 0.85rem;">${escapeHtml(cat.id)}</span>
      </div>
      <div>
        <label style="font-size: 0.75rem; color: var(--text-muted); display: block;">Category Name</label>
        <input type="text" value="${escapeHtml(cat.name)}" id="catName_${catIdx}" style="padding: 0.4rem 0.6rem; font-size: 0.9rem;">
      </div>
      <div>
        <label style="font-size: 0.75rem; color: var(--text-muted); display: block;">Category Aliases</label>
        <input type="text" value="${escapeHtml((cat.aliases || []).join(', '))}" id="catAliases_${catIdx}" style="padding: 0.4rem 0.6rem; font-size: 0.9rem;">
      </div>
      <div style="display: flex; gap: 0.4rem; align-self: flex-end;">
        <button class="btn-secondary" style="padding: 0.4rem 0.8rem;" onclick="saveSingleCategory(${catIdx})">Save Cat</button>
        <button class="btn-secondary" style="padding: 0.4rem 0.8rem; color: #f87171;" onclick="deleteCategory(${catIdx})">🗑️</button>
      </div>
    `;
    card.appendChild(topRow);

    // 2. Subcategories Container
    const subContainer = document.createElement('div');
    subContainer.style.cssText = 'background: rgba(30, 41, 59, 0.5); border: 1px dashed rgba(192, 132, 252, 0.3); border-radius: 8px; padding: 0.8rem; margin-top: 0.2rem;';
    
    let subsHtml = `<div style="font-size: 0.78rem; font-weight: 700; color: var(--accent-purple); margin-bottom: 0.5rem; text-transform: uppercase;">📂 Subcategories:</div>`;
    
    const subList = cat.subcategories || [];
    if (subList.length === 0) {
      subsHtml += `<div style="font-size: 0.8rem; color: #64748b; margin-bottom: 0.5rem;">No subcategories configured.</div>`;
    } else {
      subsHtml += `<div style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.8rem;">`;
      subList.forEach((sub, subIdx) => {
        subsHtml += `
          <div style="display: grid; grid-template-columns: 1fr 1.5fr 2fr auto; gap: 0.5rem; align-items: center; background: rgba(15, 23, 42, 0.5); padding: 0.4rem 0.6rem; border-radius: 6px;">
            <span style="font-size: 0.75rem; color: #e9d5ff; font-weight: 600;">${escapeHtml(sub.id)}</span>
            <input type="text" value="${escapeHtml(sub.name || '')}" id="subName_${catIdx}_${subIdx}" placeholder="Subcategory Name" style="padding: 0.25rem 0.4rem; font-size: 0.8rem;">
            <input type="text" value="${escapeHtml((sub.aliases || []).join(', '))}" id="subAliases_${catIdx}_${subIdx}" placeholder="Aliases (comma separated)" style="padding: 0.25rem 0.4rem; font-size: 0.8rem;">
            <div style="display: flex; gap: 0.3rem;">
              <button class="btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="saveSingleSubcategory(${catIdx}, ${subIdx})">Save</button>
              <button class="btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; color: #f87171;" onclick="deleteSubcategory(${catIdx}, ${subIdx})">🗑️</button>
            </div>
          </div>
        `;
      });
      subsHtml += `</div>`;
    }

    // Form to add a new subcategory
    subsHtml += `
      <div style="display: grid; grid-template-columns: 1fr 1.5fr 2fr auto; gap: 0.5rem; align-items: center; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 0.5rem;">
        <input type="text" id="newSubId_${catIdx}" placeholder="new_slug (e.g. navigo)" style="padding: 0.3rem 0.5rem; font-size: 0.8rem;">
        <input type="text" id="newSubName_${catIdx}" placeholder="Display Name (e.g. Navigo)" style="padding: 0.3rem 0.5rem; font-size: 0.8rem;">
        <input type="text" id="newSubAliases_${catIdx}" placeholder="Aliases (e.g. navigo, ratp)" style="padding: 0.3rem 0.5rem; font-size: 0.8rem;">
        <button class="btn-primary" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" onclick="addNewSubcategory(${catIdx})">+ Add Sub</button>
      </div>
    `;

    subContainer.innerHTML = subsHtml;
    card.appendChild(subContainer);
    container.appendChild(card);
  });
}

function saveSingleCategory(catIdx) {
  const cat = categories[catIdx];
  if (!cat) return;

  const nameVal = getVal(`catName_${catIdx}`).trim();
  const aliasesVal = getVal(`catAliases_${catIdx}`).split(',').map(a => a.trim()).filter(Boolean);

  if (!nameVal) {
    Toast.warning('Category name cannot be empty');
    return;
  }

  cat.name = nameVal;
  cat.aliases = aliasesVal;
  syncCategoriesToServer();
}

function deleteCategory(catIdx) {
  const cat = categories[catIdx];
  if (!cat) return;

  if (confirm(`Are you sure you want to delete category '${cat.name}'?`)) {
    categories.splice(catIdx, 1);
    syncCategoriesToServer();
  }
}

function saveSingleSubcategory(catIdx, subIdx) {
  const cat = categories[catIdx];
  if (!cat || !cat.subcategories || !cat.subcategories[subIdx]) return;

  const sub = cat.subcategories[subIdx];
  const nameVal = getVal(`subName_${catIdx}_${subIdx}`).trim();
  const aliasesVal = getVal(`subAliases_${catIdx}_${subIdx}`).split(',').map(a => a.trim()).filter(Boolean);

  if (!nameVal) {
    Toast.warning('Subcategory name cannot be empty');
    return;
  }

  sub.name = nameVal;
  sub.aliases = aliasesVal;
  syncCategoriesToServer();
}

function deleteSubcategory(catIdx, subIdx) {
  const cat = categories[catIdx];
  if (!cat || !cat.subcategories || !cat.subcategories[subIdx]) return;

  const sub = cat.subcategories[subIdx];
  if (confirm(`Are you sure you want to delete subcategory '${sub.name || sub.id}'?`)) {
    cat.subcategories.splice(subIdx, 1);
    syncCategoriesToServer();
  }
}

function addNewSubcategory(catIdx) {
  const cat = categories[catIdx];
  if (!cat) return;

  const idVal = getVal(`newSubId_${catIdx}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const nameVal = getVal(`newSubName_${catIdx}`).trim();
  const aliasesVal = getVal(`newSubAliases_${catIdx}`).split(',').map(a => a.trim()).filter(Boolean);

  if (!idVal || !nameVal) {
    Toast.warning('Please provide both ID and Display Name for the subcategory.');
    return;
  }

  if (!cat.subcategories) cat.subcategories = [];
  if (cat.subcategories.some(s => s.id === idVal)) {
    Toast.warning(`Subcategory ID '${idVal}' already exists in category '${cat.name}'.`);
    return;
  }

  cat.subcategories.push({
    id: idVal,
    name: nameVal,
    aliases: aliasesVal.length > 0 ? aliasesVal : [idVal]
  });

  syncCategoriesToServer();
}

async function handleAddCategory() {
  const id = getVal('newCatId').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const name = getVal('newCatName').trim();
  const aliases = getVal('newCatAliases').split(',').map(a => a.trim()).filter(Boolean);

  if (!id || !name) {
    Toast.warning('Please provide both ID and Name for the new category.');
    return;
  }

  if (categories.some(c => c.id === id)) {
    Toast.warning(`Category ID '${id}' already exists.`);
    return;
  }

  categories.push({ id, name, description: name, aliases, subcategories: [] });
  
  setVal('newCatId', '');
  setVal('newCatName', '');
  setVal('newCatAliases', '');

  await syncCategoriesToServer();
}

async function syncCategoriesToServer() {
  try {
    const res = await fetch('/api/categories', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories })
    });

    if (res.ok) {
      Toast.success('Categories updated successfully!');
      renderCategoriesManager();
      loadCategories();
    } else {
      const err = await res.json();
      Toast.error('Error updating categories: ' + (err.error || 'Unknown error'));
    }
  } catch (err) {
    Toast.error('Failed to sync categories: ' + err.message);
  }
}

/* Safe Helper Utilities */
function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[m]));
}

function escapeJsString(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
