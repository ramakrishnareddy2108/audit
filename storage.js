// ═══════════════════════════════════════════════════════════════════
// storage.js  —  JSON file persistence + localStorage auto-save
// ═══════════════════════════════════════════════════════════════════

const Storage = (() => {
  const LS_KEY_PREFIX  = 'inv_session_';
  const LS_CRED_KEY    = 'inv_cred_v3';
  const AUTOSAVE_MS    = 30_000; // 30 seconds
  let _autosaveTimer   = null;
  let _pdfName         = '';
  let _dirty           = false;

  // ── session key derived from PDF filename ──────────────────────
  function sessionKey(name) {
    return LS_KEY_PREFIX + (name || '').replace(/[^a-z0-9]/gi, '_').slice(0, 50);
  }

  // ── save entire results map to localStorage ────────────────────
  function saveToLS(pdfName, totalPages, results, grnFiles, reconRows) {
    const key = sessionKey(pdfName);
    const payload = {
      version: 3,
      pdfName,
      totalPages,
      savedAt: new Date().toISOString(),
      pages: results,
      // save GRN parsed data (not raw binary)
      grnData: grnFiles ? grnFiles.map(f => ({ name: f.name, count: f.count, rows: f.rows, error: f.error })) : [],
      reconRows: reconRows || null
    };
    try {
      localStorage.setItem(key, JSON.stringify(payload));
      _dirty = false;
      return true;
    } catch (e) {
      console.warn('localStorage save failed:', e);
      return false;
    }
  }

  // ── load from localStorage by pdfName ─────────────────────────
  function loadFromLS(pdfName) {
    const key = sessionKey(pdfName);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // ── list all saved sessions ────────────────────────────────────
  function listSessions() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_KEY_PREFIX)) continue;
      try {
        const v = JSON.parse(localStorage.getItem(k));
        if (v && v.pdfName) out.push(v);
      } catch {}
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  // ── delete a session ──────────────────────────────────────────
  function deleteSession(pdfName) {
    localStorage.removeItem(sessionKey(pdfName));
  }

  // ── auto-save: start / stop / ping ────────────────────────────
  function startAutosave(getState) {
    stopAutosave();
    _autosaveTimer = setInterval(async () => {
      if (!_dirty) return;
      const { pdfName, totalPages, results, grnFiles, reconRows } = getState();
      if (!pdfName || !Object.keys(results).length) return;
      const ok = saveToLS(pdfName, totalPages, results, grnFiles, reconRows);
      updateAutosaveDot(ok ? 'saved' : 'error');
    }, AUTOSAVE_MS);
  }

  function stopAutosave() {
    if (_autosaveTimer) { clearInterval(_autosaveTimer); _autosaveTimer = null; }
  }

  function markDirty() { _dirty = true; updateAutosaveDot('saving'); }

  function updateAutosaveDot(state) {
    const dot = document.getElementById('autosave-indicator');
    if (!dot) return;
    dot.className = 'autosave-dot ' + state;
    if (state === 'saved') {
      dot.title = 'Auto-saved at ' + new Date().toLocaleTimeString();
      setTimeout(() => { dot.className = 'autosave-dot'; }, 2000);
    }
  }

  // ── export to JSON file (download) ────────────────────────────
  function exportJSON(pdfName, totalPages, results, grnFiles, reconRows) {
    const payload = {
      version: 3,
      pdfName,
      totalPages,
      exportedAt: new Date().toISOString(),
      pages: results,
      grnData: grnFiles ? grnFiles.map(f => ({ name: f.name, count: f.count, rows: f.rows })) : [],
      reconRows: reconRows || null
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const safe = (pdfName || 'invoices').replace(/[^a-z0-9]/gi, '_').replace(/\.pdf$/i, '');
    const dt   = new Date().toISOString().slice(0, 10);
    const a    = document.createElement('a');
    a.href = url; a.download = `${safe}_${dt}.json`;
    a.click(); URL.revokeObjectURL(url);
    _dirty = false;
    updateAutosaveDot('saved');
  }

  // ── import JSON file (returns parsed payload) ──────────────────
  async function importJSON(file) {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload.pages) throw new Error('Invalid session file — missing pages data');
    return payload;
  }

  // ── credentials ───────────────────────────────────────────────
  function saveCreds(obj) {
    try { localStorage.setItem(LS_CRED_KEY, JSON.stringify(obj)); } catch {}
  }
  function loadCreds() {
    try { return JSON.parse(localStorage.getItem(LS_CRED_KEY) || 'null'); } catch { return null; }
  }

  return {
    saveToLS, loadFromLS, listSessions, deleteSession,
    startAutosave, stopAutosave, markDirty, exportJSON, importJSON,
    saveCreds, loadCreds
  };
})();
