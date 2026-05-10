// ═══════════════════════════════════════════════════════════════════
// storage.js  —  v4: cycle-based JSON + localStorage auto-save
// ═══════════════════════════════════════════════════════════════════

const Storage = (() => {
  const LS_CYCLE_KEY   = 'inv_cycle_v4';
  const LS_CRED_KEY    = 'inv_cred_v3';
  const AUTOSAVE_MS    = 30_000;
  let _autosaveTimer   = null;
  let _dirty           = false;

  function guessCycleLabel() {
    return new Date().toLocaleString('en-IN', { month: 'short', year: 'numeric' });
  }
  function guessCycleMonth() {
    return new Date().toISOString().slice(0, 7);
  }

  // ── migrate v3 payload → v4 ───────────────────────────────────
  function migrateV3(p) {
    if (p.version >= 4) return p;
    const pdfName  = p.pdfName || 'unknown.pdf';
    const newPages = {};
    for (const [k, v] of Object.entries(p.pages || {})) {
      const newKey = `${pdfName}::${k}`;
      newPages[newKey] = { ...v, pageKey: newKey, sourcePdf: pdfName, page: parseInt(k) || v.page };
    }
    return {
      version: 4, cycleLabel: guessCycleLabel(), cycleMonth: guessCycleMonth(),
      createdAt: p.savedAt || p.exportedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sources: [{ pdfName, addedAt: p.savedAt || new Date().toISOString(), pageCount: p.totalPages || 0 }],
      pages: newPages, grnData: p.grnData || [],
      creditNotes: [],
      reconRows: (p.reconRows || []).map(r => ({
        ...r, invoiceKey: r.page ? `${pdfName}::${r.page}` : null, sourcePdf: pdfName,
        grnEntries: r.grnNo ? [{ grnNo: r.grnNo, grnDate: r.grnDate, supplier: r.grnSupplier,
          invoiceNo: r.grnInvoice, amount: r.grnAmount, location: r.location, grnType: r.grnType }] : [],
        grnTotal: r.grnAmount || 0, amountDiff: (r.invAmount||0) - (r.grnAmount||0),
        resolution: null, resolutionNote: '', resolvedAt: null,
        previousStatus: null, statusChangedAt: null, carriedFrom: null
      })),
      grnOnlyRows: [], carriedForward: []
    };
  }

  // ── blank v4 cycle ────────────────────────────────────────────
  function newCycle(label) {
    const now = new Date().toISOString();
    return {
      version: 4, cycleLabel: label || guessCycleLabel(),
      cycleMonth: guessCycleMonth(), createdAt: now, updatedAt: now,
      sources: [], pages: {}, grnData: [], creditNotes: [],
      reconRows: [], grnOnlyRows: [], carriedForward: []
    };
  }

  // ── localStorage ──────────────────────────────────────────────
  function saveCycleToLS(cycle) {
    if (!cycle) return false;
    cycle.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(LS_CYCLE_KEY, JSON.stringify(cycle));
      _dirty = false; return true;
    } catch (e) {
      try {
        const slim = JSON.parse(JSON.stringify(cycle));
        for (const v of Object.values(slim.pages || {})) delete v.ocrText;
        localStorage.setItem(LS_CYCLE_KEY, JSON.stringify(slim));
        _dirty = false; return true;
      } catch { return false; }
    }
  }

  function loadCycleFromLS() {
    try {
      const raw = localStorage.getItem(LS_CYCLE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p.version >= 4 ? p : migrateV3(p);
    } catch { return null; }
  }

  function clearCycle() { localStorage.removeItem(LS_CYCLE_KEY); }

  // ── autosave ──────────────────────────────────────────────────
  function startAutosave(getCycle) {
    stopAutosave();
    _autosaveTimer = setInterval(() => {
      if (!_dirty) return;
      const cycle = getCycle();
      if (!cycle || !Object.keys(cycle.pages || {}).length) return;
      const ok = saveCycleToLS(cycle);
      updateDot(ok ? 'saved' : 'error');
    }, AUTOSAVE_MS);
  }
  function stopAutosave() { if (_autosaveTimer) { clearInterval(_autosaveTimer); _autosaveTimer = null; } }
  function markDirty()    { _dirty = true; updateDot('saving'); }
  function updateDot(state) {
    const dot = document.getElementById('autosave-indicator');
    if (!dot) return;
    dot.className = 'autosave-dot ' + state;
    if (state === 'saved') {
      dot.title = 'Auto-saved ' + new Date().toLocaleTimeString();
      setTimeout(() => { dot.className = 'autosave-dot'; }, 2000);
    }
  }

  // ── file export ───────────────────────────────────────────────
  function exportJSON(cycle) {
    if (!cycle) return;
    cycle.updatedAt = new Date().toISOString();
    const blob = new Blob([JSON.stringify(cycle, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const safe = (cycle.cycleLabel || 'cycle').replace(/[^a-z0-9]/gi, '_');
    const dt   = new Date().toISOString().slice(0, 10);
    const a    = document.createElement('a');
    a.href = url; a.download = `recon_${safe}_${dt}.json`;
    a.click(); URL.revokeObjectURL(url);
    _dirty = false; updateDot('saved');
  }

  async function importJSON(file) {
    const text = await file.text();
    const p = JSON.parse(text);
    if (!p.pages) throw new Error('Invalid file — missing pages data');
    return p.version >= 4 ? p : migrateV3(p);
  }

  function getOpenItems(cycle) {
    if (!cycle || !cycle.reconRows) return [];
    return cycle.reconRows.filter(r =>
      ['DISCREPANCY','PARTIAL','UNMATCHED','DISPUTED'].includes(r.status) &&
      !['ACCEPTED','EXCLUDED'].includes(r.resolution)
    );
  }

  function saveCreds(obj)  { try { localStorage.setItem(LS_CRED_KEY, JSON.stringify(obj)); } catch {} }
  function loadCreds()     { try { return JSON.parse(localStorage.getItem(LS_CRED_KEY)||'null'); } catch { return null; } }

  return {
    newCycle, migrateV3, saveCycleToLS, loadCycleFromLS, clearCycle,
    startAutosave, stopAutosave, markDirty, exportJSON, importJSON,
    getOpenItems, saveCreds, loadCreds
  };
})();
