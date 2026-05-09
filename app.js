// ═══════════════════════════════════════════════════════════════════
// app.js  —  Main application controller
// State, extraction workflow, viewer, GRN, settings, tabs, modals
// ═══════════════════════════════════════════════════════════════════

// ── GLOBALS ───────────────────────────────────────────────────────
let pdfName    = '';
let totalPages = 0;
let results    = {};   // { [pageNum]: { vendor, invoice, gstin, amount, ocrText, status, confidence, cost, invoiceDate } }
let curPage    = 1;
let activeTab  = 'viewer';
let processing = false;
let abortFlag  = false;
let showOCR    = false;
let grnFiles   = [];   // [{ name, rows, count, error }]
let reconRows  = null;

// credentials state (mirrored in Extractor)
let credMode          = 'vision';
let visionApiKey      = '';
let serviceAccountJson = null;
let claudeApiKey      = '';

// zoom state
let zoomLevel = 1, zoomPanX = 0, zoomPanY = 0;
let zoomDragging = false, zoomDX = 0, zoomDY = 0;

// confirm modal callback
let _confirmOkFn = null;

// ── INIT ──────────────────────────────────────────────────────────
(function init() {
  // load saved credentials
  const saved = Storage.loadCreds();
  if (saved) {
    try {
      credMode           = saved.mode          || 'vision';
      visionApiKey       = saved.visionKey     || '';
      serviceAccountJson = saved.saJson ? JSON.parse(saved.saJson) : null;
      claudeApiKey       = saved.claudeKey     || '';
      Extractor.setCredentials(credMode, visionApiKey, serviceAccountJson, claudeApiKey);
      updateCredStatus();
    } catch {}
  }

  // keyboard nav
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeZoom(); closeSettings(); }
    if (document.getElementById('zoom-overlay').style.display === 'none') {
      if (e.key === 'ArrowRight') navigate(1);
      if (e.key === 'ArrowLeft')  navigate(-1);
    }
  });

  // beforeunload — warn if unsaved
  window.addEventListener('beforeunload', e => {
    if (Object.keys(results).length > 0) {
      e.preventDefault();
      e.returnValue = 'You have unsaved extraction data — click "💾 Save Data" before leaving.';
    }
  });

  // start auto-save
  Storage.startAutosave(() => ({ pdfName, totalPages, results, grnFiles, reconRows }));
})();

// ── HELPERS ───────────────────────────────────────────────────────
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtINR(v) { const n = parseFloat(v); return isNaN(n) ? '' : '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function badgeHTML(status) {
  const m = { ok: ['badge-ok', 'Extracted'], error: ['badge-error', 'Error'], review: ['badge-review', 'Review'], manual: ['badge-manual', 'Manual'], wait: ['badge-wait', '…'] };
  const [cls, lbl] = m[status] || ['badge-wait', '?'];
  return `<span class="badge ${cls}">${lbl}</span>`;
}

function reconBadgeHTML(s) {
  const m = { MATCHED: ['#def7ec', '#03543f'], DISCREPANCY: ['#fef3c7', '#92400e'], UNMATCHED: ['#fde8e8', '#9b1c1c'], 'GRN ONLY': ['#dbeafe', '#1e3a5f'] };
  const [bg, col] = m[s] || ['#f3f4f6', '#6b7280'];
  return `<span style="font-size:10px;padding:3px 7px;border-radius:10px;font-weight:600;background:${bg};color:${col}">${s}</span>`;
}

function setStatus(t) { document.getElementById('status-txt').textContent = t; }
function showProgress(v) { document.getElementById('progress-wrap').style.display = v ? 'block' : 'none'; }
function showSaveIndicator(msg = '✓ Saved') {
  const el = document.getElementById('save-indicator');
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 2000);
}

// ── CREDENTIAL STATUS ─────────────────────────────────────────────
function updateCredStatus() {
  const el = document.getElementById('cred-status');
  const s  = Extractor.getCredSummary();
  if (s) { el.className = 'cred-ok'; el.textContent = s; }
  else   { el.className = 'cred-warn'; el.textContent = '⚠ No API key — open Settings to configure'; }
}

// ── PDF LOADING ───────────────────────────────────────────────────
function handlePdfDrop(ev) { ev.preventDefault(); if (ev.dataTransfer.files[0]) loadPDF(ev.dataTransfer.files[0]); }

async function loadPDF(file) {
  if (!file) return;
  setStatus('Loading PDF…'); showProgress(true);
  try {
    const ab = await file.arrayBuffer();
    const n  = await PDFViewer.loadPDF(ab);
    pdfName    = file.name;
    totalPages = n;
    results    = {};
    reconRows  = null;
    grnFiles   = [];

    document.getElementById('upload-zone').style.display  = 'none';
    document.getElementById('controls').style.display     = 'flex';
    document.getElementById('pdf-name-lbl').textContent   = pdfName;
    document.getElementById('total-pages-lbl').textContent = `${totalPages} pages`;
    document.getElementById('page-range-input').value     = `1-${Math.min(10, totalPages)}`;
    showProgress(false);

    // check localStorage for saved session with same filename
    const saved = Storage.loadFromLS(pdfName);
    if (saved && saved.pages && Object.keys(saved.pages).length > 0) {
      const pageCount = Object.keys(saved.pages).length;
      const okCount   = Object.values(saved.pages).filter(r => r.status === 'ok' || r.status === 'manual').length;
      document.getElementById('session-banner').style.display = 'flex';
      document.getElementById('session-info-text').textContent =
        `${pageCount} pages extracted · ${okCount} OK · last saved ${new Date(saved.savedAt).toLocaleString()}`;
    }
  } catch (e) { setStatus('Error loading PDF: ' + e.message); showProgress(false); }
}

function resumeSession() {
  const saved = Storage.loadFromLS(pdfName);
  if (!saved || !saved.pages) return;
  results = saved.pages;
  // restore GRN if present
  if (saved.grnData && saved.grnData.length) {
    grnFiles = saved.grnData.map(f => ({ ...f }));
    grnFiles.forEach(f => f.rows && f.rows.forEach((r, i) => r._id = `${f.name}_${i}`));
  }
  reconRows = saved.reconRows || null;
  document.getElementById('session-banner').style.display  = 'none';
  document.getElementById('tabs-wrap').style.display       = 'block';
  document.getElementById('export-inv-btn').disabled       = false;

  const pgs = sortedPages();
  if (pgs.length) { curPage = pgs[0]; switchTab('viewer'); renderViewer(); }
  updateStatBars(); renderTable(); renderReviewQueue(); updateReconReadiness();
  setStatus(`✓ Restored ${Object.keys(results).length} pages`);
  showProgress(true);
  document.getElementById('status-dot').className        = 'dot done';
  document.getElementById('status-dot').style.animation = 'none';
}

function discardSession() {
  Storage.deleteSession(pdfName);
  document.getElementById('session-banner').style.display = 'none';
}

function changePDF() {
  PDFViewer.unload();
  pdfName = ''; totalPages = 0; results = {}; reconRows = null; grnFiles = [];
  document.getElementById('upload-zone').style.display  = 'block';
  document.getElementById('controls').style.display     = 'none';
  document.getElementById('tabs-wrap').style.display    = 'none';
  document.getElementById('progress-wrap').style.display = 'none';
  document.getElementById('session-banner').style.display = 'none';
  // reset pdf input so same file can be re-selected
  document.getElementById('pdf-input').value = '';
}

// ── JSON IMPORT / EXPORT ─────────────────────────────────────────
async function importSessionJSON(file) {
  try {
    const payload = await Storage.importJSON(file);
    results = payload.pages || {};
    if (payload.grnData && payload.grnData.length) {
      grnFiles = payload.grnData.map(f => ({ ...f }));
      grnFiles.forEach(f => f.rows && f.rows.forEach((r, i) => r._id = `${f.name}_${i}`));
    }
    reconRows = payload.reconRows || null;
    // show tabs even if PDF not loaded
    document.getElementById('upload-zone').style.display  = 'none';
    document.getElementById('controls').style.display     = 'flex';
    document.getElementById('tabs-wrap').style.display    = 'block';
    document.getElementById('export-inv-btn').disabled    = false;
    if (payload.pdfName) {
      pdfName = payload.pdfName;
      document.getElementById('pdf-name-lbl').textContent = pdfName + ' (from JSON)';
    }
    if (payload.totalPages) {
      totalPages = payload.totalPages;
      document.getElementById('total-pages-lbl').textContent = `${totalPages} pages`;
    }
    const pgs = sortedPages();
    if (pgs.length) { curPage = pgs[0]; switchTab('viewer'); renderViewer(); }
    updateStatBars(); renderTable(); renderReviewQueue(); updateReconReadiness();
    setStatus(`✓ Imported ${Object.keys(results).length} pages from JSON`);
    showProgress(true);
    document.getElementById('status-dot').className = 'dot done';
    document.getElementById('status-dot').style.animation = 'none';
    showSaveIndicator('✓ JSON loaded');
    document.getElementById('json-input').value = '';
  } catch (e) {
    alert('Error importing JSON: ' + e.message);
  }
}

function saveSessionJSON() {
  if (!Object.keys(results).length) { alert('No data to save yet. Extract some pages first.'); return; }
  Storage.exportJSON(pdfName, totalPages, results, grnFiles, reconRows);
  showSaveIndicator('✓ Saved to file');
}

// ── EXTRACTION ────────────────────────────────────────────────────
function startExtraction() {
  const rangeStr = document.getElementById('page-range-input').value || '1-10';
  const pages    = Extractor.parsePageRange(rangeStr, totalPages);
  if (!pages.length) { alert('No valid pages in range. Example: 1-10, 25, 50-60'); return; }
  _runExtractionPages(pages);
}

function startExtractionAll() {
  const cost = totalPages * Extractor.costPerPage;
  showConfirm(`Extract all ${totalPages} pages?`, `Estimated cost: $${cost.toFixed(2)}`, () => {
    confirmCancel();
    document.getElementById('page-range-input').value = 'all';
    _runExtractionPages(Array.from({ length: totalPages }, (_, i) => i + 1));
  });
}

function stopExtraction() { abortFlag = true; }

function retryFailed() {
  const failedPages = Object.values(results)
    .filter(r => r.status === 'error' || r.status === 'review')
    .map(r => r.page).sort((a, b) => a - b);
  if (!failedPages.length) { alert('No failed pages to retry.'); return; }
  showConfirm(`Re-extract ${failedPages.length} failed pages?`,
    `Pages: ${failedPages.slice(0, 20).join(', ')}${failedPages.length > 20 ? '…' : ''}`,
    () => { confirmCancel(); _runExtractionPages(failedPages, true); }
  );
}

async function _runExtractionPages(pagesList, forceRetry = false) {
  if (!Extractor.hasCred()) { openSettings(); return; }
  if (!PDFViewer.isLoaded()) { alert('Please load a PDF first.'); return; }
  if (processing) return;

  processing = true; abortFlag = false;
  document.getElementById('tabs-wrap').style.display        = 'block';
  document.getElementById('extract-btn').disabled           = true;
  document.getElementById('extract-all-btn').disabled       = true;
  document.getElementById('retry-btn').style.display        = 'none';
  document.getElementById('stop-btn').style.display         = 'inline-block';
  document.getElementById('export-inv-btn').disabled        = true;
  document.getElementById('progress-fill').style.width      = '0%';
  document.getElementById('status-dot').className           = 'dot';
  document.getElementById('status-dot').style.animation     = 'pulse 1s infinite';
  showProgress(true);

  const pending = forceRetry
    ? pagesList
    : pagesList.filter(pg => { const r = results[pg]; return !r || (r.status !== 'ok' && r.status !== 'manual'); });
  const skipped = pagesList.length - pending.length;

  let done = 0;
  const total = pending.length;
  const conc  = Math.min(parseInt(document.getElementById('batch-size').value) || 3, 8);
  let navDone = false;

  const processOne = async (pg) => {
    if (abortFlag) return;
    setStatus(`Extracting page ${pg}… (${done}/${total})`);
    let b64 = null;
    try {
      b64 = await PDFViewer.renderToBase64(pg);
      const data = await Extractor.extractOnePage(b64);
      const needsReview = data.confidence === 'low' || !data.vendor || !data.invoice || !data.amount;
      results[pg] = { page: pg, ...data, status: needsReview ? 'review' : 'ok', error: null };
    } catch (e) {
      results[pg] = { page: pg, vendor: '', invoice: '', gstin: '', amount: '', ocrText: '', status: 'error', error: e.message, cost: 0 };
    }
    done++;
    document.getElementById('progress-fill').style.width = Math.round(done / total * 100) + '%';
    setStatus(`Processing… (${done}/${total})`);
    const totalCost = Object.values(results).reduce((s, r) => s + (r.cost || 0), 0);
    document.getElementById('cost-display').textContent = `Cost: $${totalCost.toFixed(4)}`;
    Storage.markDirty();
    if (!navDone) { navDone = true; curPage = pg; if (activeTab === 'viewer') renderViewer(); }
    if (done % 5 === 0 || done === total) { updateStatBars(); }
  };

  for (let i = 0; i < pending.length; i += conc) {
    if (abortFlag) break;
    await Promise.all(pending.slice(i, i + conc).map(processOne));
  }

  // final save to localStorage
  Storage.saveToLS(pdfName, totalPages, results, grnFiles, reconRows);

  const doneMsg = abortFlag
    ? `⏹ Stopped — ${done}/${total} extracted`
    : `✓ Done — ${pending.length} extracted${skipped ? ` (${skipped} already done)` : ''}`;
  setStatus(doneMsg);
  document.getElementById('status-dot').className        = 'dot done';
  document.getElementById('status-dot').style.animation = 'none';
  document.getElementById('extract-btn').disabled        = false;
  document.getElementById('extract-all-btn').disabled    = false;
  document.getElementById('stop-btn').style.display      = 'none';
  document.getElementById('export-inv-btn').disabled     = false;
  processing = false;
  updateStatBars(); renderTable(); renderReviewQueue(); updateReviewBtn();
}

// ── VIEWER ────────────────────────────────────────────────────────
function sortedPages() { return Object.keys(results).map(Number).sort((a, b) => a - b); }

async function renderViewer() {
  const r = results[curPage];
  document.getElementById('page-info').textContent       = `Page ${curPage} of ${totalPages || Object.keys(results).length}`;
  document.getElementById('img-panel-title').textContent = `Page ${curPage}`;
  document.getElementById('status-badge').innerHTML      = r ? badgeHTML(r.status) : '';
  document.getElementById('confidence-badge').textContent = r?.status === 'ok' && r.confidence ? `confidence: ${r.confidence}` : '';
  const cb = document.getElementById('confidence-badge');
  cb.style.color = r?.confidence === 'high' ? '#057a55' : r?.confidence === 'low' ? '#c81e1e' : '#92400e';
  document.getElementById('page-cost').textContent = r?.cost > 0 ? `API cost: $${r.cost.toFixed(5)}` : '';
  document.getElementById('ocr-text-display').textContent = r?.ocrText || 'No OCR text available.';

  // render PDF page live
  await PDFViewer.renderMainCanvas(curPage);

  // fields panel
  const fp = document.getElementById('fields-panel');
  if (!r) { fp.innerHTML = '<div class="empty-state">Not extracted yet.</div>'; return; }
  if (r.status === 'wait') { fp.innerHTML = '<div class="empty-state"><span class="spinner"></span> Re-extracting…</div>'; return; }

  let html = '';
  if (r.status === 'error' || r.status === 'review') {
    html += `<div class="alert ${r.status === 'error' ? 'alert-error' : 'alert-warn'}" style="margin-bottom:12px">
      <strong>${r.status === 'error' ? '⚠ Extraction failed — fill in manually' : '⚠ Low confidence — please verify'}</strong>
      ${r.error ? `<div style="font-size:11px;margin-top:4px">${esc(r.error)}</div>` : ''}
    </div>`;
  }

  html += `
    <div class="field-row"><div class="field-lbl">Vendor name</div>
      <div contenteditable="true" class="field-val" onblur="saveField(${curPage},'vendor',this)">${esc(r.vendor || '')}</div></div>
    <div class="field-row"><div class="field-lbl">Invoice no.</div>
      <div contenteditable="true" class="field-val" onblur="saveField(${curPage},'invoice',this)">${esc(r.invoice || '')}</div></div>
    <div class="field-row"><div class="field-lbl">Vendor GSTIN</div>
      <div contenteditable="true" class="field-val" onblur="saveField(${curPage},'gstin',this)">${esc(r.gstin || '')}</div></div>
    <div class="field-row"><div class="field-lbl">Total amount</div>
      <div contenteditable="true" class="field-val" onblur="saveField(${curPage},'amount',this)">${esc(r.amount || '')}</div></div>
    <div class="field-row" style="border-bottom:none"><div class="field-lbl">Invoice date</div>
      <div contenteditable="true" class="field-val" onblur="saveField(${curPage},'invoiceDate',this)">${esc(r.invoiceDate || '')}</div></div>
  `;

  const hasEmpty = !r.vendor || !r.invoice || !r.amount;
  if (r.status === 'error' || r.status === 'review' || (r.status === 'ok' && hasEmpty)) {
    html += `<button class="btn-success" style="width:100%;margin-top:14px;padding:9px" onclick="markManual(${curPage})">✓ Mark as reviewed (save complete)</button>`;
  }
  if (r.status === 'manual') html += `<div style="font-size:11px;color:#1e429f;margin-top:10px">✓ Marked as reviewed.</div>`;
  if (r.status === 'ok' && !hasEmpty) html += `<div class="hint">Click any field to edit inline. Click away to save.</div>`;
  if (r.status === 'ok' && hasEmpty) html += `<div class="hint" style="color:#92400e">⚠ Fill empty fields above then click Mark Reviewed.</div>`;
  fp.innerHTML = html;
}

function navigate(dir) {
  const pgs = sortedPages();
  const idx = pgs.indexOf(curPage);
  const nxt = pgs[idx + dir];
  if (nxt !== undefined) { curPage = nxt; renderViewer(); }
}

function jumpToReview() {
  const pg = sortedPages().find(p => results[p]?.status === 'error' || results[p]?.status === 'review');
  if (pg) { curPage = pg; switchTab('viewer'); renderViewer(); }
}

function saveField(pg, key, el) {
  if (!results[pg]) return;
  results[pg][key] = el.textContent.trim();
  Storage.markDirty();
  showSaveIndicator();
  updateStatBars(); renderTable();
}

function markManual(pg) {
  if (!results[pg]) return;
  results[pg].status = 'manual';
  Storage.markDirty();
  renderViewer(); updateStatBars(); renderTable(); renderReviewQueue(); updateReviewBtn();
  showSaveIndicator('✓ Marked reviewed');
}

function toggleOCR() {
  showOCR = !showOCR;
  document.getElementById('ocr-panel').style.display       = showOCR ? 'block' : 'none';
  document.getElementById('viewer-grid').className         = showOCR ? 'viewer-grid three' : 'viewer-grid';
  document.getElementById('ocr-toggle-btn').textContent    = showOCR ? 'Hide OCR Text' : 'Show OCR Text';
}

async function rotatePage(deg) {
  PDFViewer.rotate(curPage, deg);
  await PDFViewer.renderMainCanvas(curPage);
}

async function reextract() {
  if (!PDFViewer.isLoaded() || !Extractor.hasCred()) { openSettings(); return; }
  if (results[curPage]) results[curPage].status = 'wait';
  renderViewer();
  try {
    const b64  = await PDFViewer.renderToBase64(curPage);
    const data = await Extractor.extractOnePage(b64);
    const needsReview = data.confidence === 'low' || !data.vendor || !data.invoice || !data.amount;
    results[curPage] = { page: curPage, ...data, status: needsReview ? 'review' : 'ok', error: null };
  } catch (e) {
    if (results[curPage]) results[curPage] = { ...results[curPage], status: 'error', error: e.message };
  }
  Storage.markDirty();
  renderViewer(); updateStatBars(); renderTable(); renderReviewQueue(); updateReviewBtn();
}

// ── STATS ─────────────────────────────────────────────────────────
function getStats() {
  const all  = Object.values(results);
  const ok   = all.filter(r => r.status === 'ok' || r.status === 'manual');
  const rev  = all.filter(r => r.status === 'error' || r.status === 'review');
  const total = ok.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const cost  = all.reduce((s, r) => s + (r.cost || 0), 0);
  return { all, ok, rev, total, cost };
}

function statsHTML(s) {
  return `
    <div class="stat-card"><div class="stat-num">${s.all.length}<span style="font-size:14px;color:#9ca3af">/${totalPages || '?'}</span></div><div class="stat-lbl">Processed</div></div>
    <div class="stat-card"><div class="stat-num" style="color:#057a55">${s.ok.length}</div><div class="stat-lbl">Extracted OK</div><div class="stat-sub">${s.all.length ? Math.round(s.ok.length / s.all.length * 100) : 0}%</div></div>
    <div class="stat-card" style="${s.rev.length > 0 ? 'border:1px solid #fbbf24' : ''}"><div class="stat-num" style="color:${s.rev.length > 0 ? '#92400e' : '#1a1a2e'}">${s.rev.length}</div><div class="stat-lbl">Needs Review</div><div class="stat-sub">${s.rev.length > 0 ? '⚠ action needed' : '✓ all clear'}</div></div>
    <div class="stat-card"><div class="stat-num" style="font-size:16px">${fmtINR(s.total) || '—'}</div><div class="stat-lbl">Grand Total</div></div>
    <div class="stat-card"><div class="stat-num" style="font-size:16px">$${s.cost.toFixed(4)}</div><div class="stat-lbl">API Cost</div><div class="stat-sub">est full: $${((totalPages || 0) * Extractor.costPerPage).toFixed(3)}</div></div>
  `;
}

function updateStatBars() {
  const s = getStats();
  const h = statsHTML(s);
  ['stats-viewer', 'stats-review', 'stats-table', 'stats-grn'].forEach(id => {
    const el = document.getElementById(id); if (el) el.innerHTML = h;
  });
  updateReviewBtn();
  updateReconReadiness();
}

function updateReviewBtn() {
  const needsAttention = r => r.status === 'error' || r.status === 'review' || (r.status === 'ok' && (!r.vendor || !r.invoice || !r.amount));
  const rev     = Object.values(results).filter(needsAttention);
  const btn     = document.getElementById('review-jump-btn');
  const retryBtn = document.getElementById('retry-btn');
  if (rev.length > 0) {
    if (btn)      { btn.style.display = 'inline-block'; btn.textContent = `⚠ ${rev.length} to review`; }
    if (retryBtn && !processing) { retryBtn.style.display = 'inline-block'; }
  } else {
    if (btn)      btn.style.display = 'none';
    if (retryBtn) retryBtn.style.display = 'none';
  }
}

// ── REVIEW QUEUE ──────────────────────────────────────────────────
function renderReviewQueue() {
  const needsAttention = r => r.status === 'error' || r.status === 'review' || (r.status === 'ok' && (!r.vendor || !r.invoice || !r.amount));
  const rev = Object.values(results).filter(needsAttention).sort((a, b) => a.page - b.page);
  const el  = document.getElementById('review-list');
  if (!rev.length) {
    el.innerHTML = '<div style="text-align:center;padding:3rem;color:#9ca3af;font-size:13px"><div style="font-size:36px;margin-bottom:8px">✅</div>No items need review!</div>';
    return;
  }
  el.innerHTML = rev.map(r => `
    <div class="review-card">
      <div class="review-head" style="background:${r.status === 'error' ? '#fef2f2' : '#fffbeb'}">
        ${badgeHTML(r.status)}
        <strong style="font-size:13px">Page ${r.page}</strong>
        ${r.error ? `<span style="font-size:12px;color:#6b7280">${esc(r.error)}</span>`
          : (!r.vendor || !r.invoice || !r.amount) ? `<span style="font-size:12px;color:#92400e">Missing: ${[!r.vendor ? 'vendor' : '', !r.invoice ? 'invoice no' : '', !r.amount ? 'amount' : ''].filter(Boolean).join(', ')}</span>` : ''}
        <span style="flex:1"></span>
        <button class="btn-sm" onclick="curPage=${r.page};switchTab('viewer');renderViewer()">Open →</button>
      </div>
      <div class="review-body">
        ${['Vendor', 'Invoice', 'GSTIN', 'Amount'].map((l, i) => {
          const k = ['vendor', 'invoice', 'gstin', 'amount'][i]; const v = r[k];
          return `<div><div class="review-fld-lbl">${l}</div><div class="review-fld-val" style="${!v ? 'color:#c81e1e;font-style:italic' : ''}">${v || '⚠ Missing'}</div></div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

// ── ALL RESULTS TABLE ─────────────────────────────────────────────
function renderTable() {
  const q    = (document.getElementById('table-search')?.value || '').toLowerCase();
  const rows = sortedPages().map(p => results[p]).filter(r => !q || JSON.stringify(r).toLowerCase().includes(q));
  document.getElementById('results-tbody').innerHTML = rows.map(r => `
    <tr class="${r.page === curPage ? 'selected' : ''}" onclick="curPage=${r.page};switchTab('viewer');renderViewer()">
      <td class="td-muted">${r.page}</td>
      <td title="${esc(r.vendor || '')}">${esc(r.vendor) || '—'}</td>
      <td>${esc(r.invoice) || '—'}</td>
      <td class="td-mono">${esc(r.gstin) || '—'}</td>
      <td class="td-r">${r.amount ? fmtINR(r.amount) : '—'}</td>
      <td>${badgeHTML(r.status)}</td>
      <td class="td-muted td-mono" style="font-size:10px">${r.cost ? ('$' + r.cost.toFixed(5)) : '—'}</td>
    </tr>
  `).join('');
}

// ── GRN ───────────────────────────────────────────────────────────
function handleGrnDrop(ev) { ev.preventDefault(); loadGRNFiles(ev.dataTransfer.files); }

async function loadGRNFiles(files) {
  for (const f of Array.from(files)) {
    try {
      const ab   = await f.arrayBuffer();
      const rows = Reconcile.parseGRNFile(ab, f.name);
      rows.forEach((r, i) => r._id = `${f.name}_${i}`);
      grnFiles.push({ name: f.name, rows, count: rows.length });
    } catch (e) {
      grnFiles.push({ name: f.name, rows: [], count: 0, error: e.message });
    }
  }
  renderGRNFileList();
  updateReconReadiness();
  Storage.markDirty();
}

function renderGRNFileList() {
  document.getElementById('grn-file-list').innerHTML =
    grnFiles.map((f, i) => `
      <div class="grn-file-row">
        <span style="font-size:20px">📊</span>
        <div style="flex:1">
          <div class="grn-file-name">${esc(f.name)}</div>
          <div class="grn-file-sub">${f.error ? 'Error: ' + esc(f.error) : f.count + ' GRN records loaded'}</div>
        </div>
        <span class="badge ${f.error ? 'badge-error' : 'badge-ok'}">${f.error ? 'Error' : f.count + ' rows'}</span>
        <button class="btn-sm btn-danger-outline" onclick="removeGRNFile(${i})">✕</button>
      </div>
    `).join('') +
    (grnFiles.length
      ? `<div style="font-size:12px;color:#9ca3af;padding:4px">Total: ${grnFiles.reduce((s, f) => s + f.count, 0)} records from ${grnFiles.length} files</div>`
      : '');
}

function removeGRNFile(i) {
  grnFiles.splice(i, 1);
  renderGRNFileList();
  updateReconReadiness();
  Storage.markDirty();
}

function updateReconReadiness() {
  const invCount = Object.values(results).filter(r => r.status === 'ok' || r.status === 'manual').length;
  const grnCount = grnFiles.reduce((s, f) => s + f.count, 0);
  document.getElementById('recon-readiness').innerHTML =
    `<span style="font-weight:600">${invCount} invoices</span> extracted &nbsp;·&nbsp; ` +
    `<span style="font-weight:600">${grnCount} GRN records</span> loaded` +
    (reconRows ? ` &nbsp;·&nbsp; <span style="color:#057a55">✓ Last run: ${reconRows.length} rows</span>` : '');
  document.getElementById('run-recon-btn').disabled = !(invCount > 0 && grnCount > 0);
}

// ── RECONCILIATION ────────────────────────────────────────────────
function runReconciliation() {
  reconRows = Reconcile.run(results, grnFiles);
  document.getElementById('recon-results').style.display    = 'block';
  document.getElementById('export-recon-btn').style.display = 'inline-block';
  renderReconStats();
  renderReconTable();
  updateReconReadiness();
  Storage.markDirty();
}

function renderReconStats() {
  if (!reconRows) return;
  const matched  = reconRows.filter(r => r.status === 'MATCHED').length;
  const disc     = reconRows.filter(r => r.status === 'DISCREPANCY').length;
  const unm      = reconRows.filter(r => r.status === 'UNMATCHED').length;
  const grnOnly  = reconRows.filter(r => r.status === 'GRN ONLY').length;
  const totalInv = reconRows.filter(r => r.page).reduce((s, r) => s + (r.invAmount || 0), 0);
  const totalGrn = reconRows.reduce((s, r) => s + (r.grnAmount || 0), 0);
  document.getElementById('recon-stat-cards').innerHTML = `
    <div class="recon-stat" style="background:#f0fdf4;border:1px solid #86efac"><div class="recon-stat-num" style="color:#166534">${matched}</div><div class="recon-stat-lbl">✅ Matched</div></div>
    <div class="recon-stat" style="background:#fffbeb;border:1px solid #fcd34d"><div class="recon-stat-num" style="color:#92400e">${disc}</div><div class="recon-stat-lbl">⚠ Discrepancy</div></div>
    <div class="recon-stat" style="background:#fff5f5;border:1px solid #fca5a5"><div class="recon-stat-num" style="color:#991b1b">${unm}</div><div class="recon-stat-lbl">❌ Not in GRN</div></div>
    <div class="recon-stat" style="background:#f0f9ff;border:1px solid #7dd3fc"><div class="recon-stat-num" style="color:#0c4a6e">${grnOnly}</div><div class="recon-stat-lbl">📋 GRN Only</div></div>
    <div class="recon-stat"><div class="recon-stat-num" style="font-size:15px">${fmtINR(totalInv)}</div><div class="recon-stat-lbl">Invoice Total</div></div>
    <div class="recon-stat"><div class="recon-stat-num" style="font-size:15px">${fmtINR(totalGrn)}</div><div class="recon-stat-lbl">GRN Total</div></div>
  `;
  const diff = totalInv - totalGrn;
  document.getElementById('recon-diff-alert').innerHTML = Math.abs(diff) > 1
    ? `<div class="alert alert-warn">⚠ Amount mismatch: Invoice total ${fmtINR(totalInv)} vs GRN total ${fmtINR(totalGrn)} · Difference: <strong>${fmtINR(diff)}</strong></div>`
    : '';
}

function renderReconTable() {
  const q    = (document.getElementById('recon-search')?.value || '').toLowerCase();
  const f    = document.getElementById('recon-filter')?.value || '';
  const rcls = { MATCHED: 'rc-matched', DISCREPANCY: 'rc-discrepancy', UNMATCHED: 'rc-unmatched', 'GRN ONLY': 'rc-grnonly' };
  document.getElementById('recon-tbody').innerHTML = (reconRows || [])
    .filter(r => (!f || r.status === f) && (!q || JSON.stringify(r).toLowerCase().includes(q)))
    .map(r => {
      const ad = r.discrepancies.find(d => d.field === 'Amount');
      return `<tr class="${rcls[r.status] || ''}">
        <td>${reconBadgeHTML(r.status)}</td>
        <td class="td-muted" style="text-align:center">${r.page || ''}</td>
        <td title="${esc(r.invVendor)}">${esc(r.invVendor) || '—'}</td>
        <td class="td-mono">${esc(r.invInvoice) || '—'}</td>
        <td class="td-r">${r.invAmount ? fmtINR(r.invAmount) : '—'}</td>
        <td title="${esc(r.grnSupplier)}">${esc(r.grnSupplier) || '—'}</td>
        <td class="td-mono">${esc(r.grnInvoice) || '—'}</td>
        <td class="td-r">${r.grnAmount ? fmtINR(r.grnAmount) : '—'}</td>
        <td class="td-r" style="color:${ad ? (Math.abs(ad.diff) > 100 ? '#c81e1e' : '#92400e') : '#9ca3af'};font-weight:${ad ? 600 : 400}">
          ${ad ? `${ad.diff > 0 ? '+' : ''}${fmtINR(ad.diff)}<br><span style="font-size:10px">${ad.pct}%</span>` : r.status === 'MATCHED' ? '✓' : '—'}
        </td>
        <td class="td-mono" style="font-size:10px">${esc(r.grnNo) || '—'}</td>
        <td>${esc(r.grnType) || '—'}</td>
        <td style="color:#9ca3af;font-size:10px">${esc(r.matchBy) || '—'}</td>
      </tr>`;
    }).join('');
}

// ── EXCEL EXPORTS ─────────────────────────────────────────────────
function exportInvoicesExcel() {
  const wb  = XLSX.utils.book_new();
  const all = sortedPages().map(p => results[p]);
  const ws1 = XLSX.utils.json_to_sheet(all.map(r => ({
    'Page':            r.page,
    'Vendor Name':     r.vendor,
    'Invoice Number':  r.invoice,
    'GSTIN':           r.gstin,
    'Invoice Date':    r.invoiceDate || '',
    'Total Amount (₹)': r.amount ? parseFloat(r.amount) : '',
    'Confidence':      r.confidence || '',
    'Status':          r.status === 'ok' ? 'Extracted' : r.status === 'manual' ? 'Manual' : 'Error/Review',
    'API Cost (USD)':  r.cost ? parseFloat(r.cost.toFixed(6)) : ''
  })));
  ws1['!cols'] = [6, 35, 20, 20, 14, 18, 12, 16, 12].map(w => ({ wch: w }));
  const ok = all.filter(r => r.status === 'ok' || r.status === 'manual');
  XLSX.utils.sheet_add_aoa(ws1, [
    [], ['SUMMARY'], ['Total processed', all.length], ['Extracted OK', ok.length],
    ['Errors/Review', all.length - ok.length],
    ['Grand total (₹)', ok.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)],
    ['Total API cost (USD)', parseFloat(all.reduce((s, r) => s + (r.cost || 0), 0).toFixed(6))],
  ], { origin: -1 });
  XLSX.utils.book_append_sheet(wb, ws1, 'Extracted Invoices');
  const rev = all.filter(r => r.status === 'error' || r.status === 'review');
  if (rev.length) {
    const ws2 = XLSX.utils.json_to_sheet(rev.map(r => ({
      'Page': r.page, 'Error': r.error || 'Review',
      'Vendor': r.vendor || '', 'Invoice': r.invoice || '',
      'GSTIN': r.gstin || '', 'Amount': r.amount || '', 'Notes': ''
    })));
    ws2['!cols'] = [6, 30, 30, 20, 20, 16, 25].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws2, 'Needs Review');
  }
  XLSX.writeFile(wb, `invoices_${new Date().toISOString().slice(0, 7)}.xlsx`);
}

function exportReconciliationExcel() { Reconcile.exportExcel(reconRows, results); }

// ── TABS ──────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  ['viewer', 'review', 'table', 'grn'].forEach(t => {
    document.getElementById('pane-' + t).style.display = t === tab ? 'block' : 'none';
    const btn = document.getElementById('tab-' + t); if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'table')  renderTable();
  if (tab === 'review') renderReviewQueue();
  if (tab === 'grn')    renderGRNFileList();
}

// ── SETTINGS ──────────────────────────────────────────────────────
let _credModeSetting = 'vision';

function openSettings() {
  _credModeSetting = credMode;
  document.getElementById('settings-modal').style.display = 'flex';
  document.getElementById('vision-key-input').value  = visionApiKey || '';
  document.getElementById('claude-key-input').value  = claudeApiKey || '';
  setCredMode(credMode);
  if (serviceAccountJson) {
    document.getElementById('sa-status').innerHTML  = `✅ <strong>${serviceAccountJson.client_email}</strong>`;
    document.getElementById('sa-status').style.color = '#057a55';
    document.getElementById('sa-dropzone').style.borderColor = '#6ee7b7';
    document.getElementById('sa-info').style.display = 'block';
    document.getElementById('sa-info').textContent   = `Project: ${serviceAccountJson.project_id} · ${serviceAccountJson.client_email}`;
  }
}

function closeSettings() { document.getElementById('settings-modal').style.display = 'none'; }

function setCredMode(mode) {
  _credModeSetting = mode;
  document.getElementById('vision-inputs').style.display = mode === 'vision' ? 'block' : 'none';
  document.getElementById('claude-inputs').style.display = mode === 'claude' ? 'block' : 'none';
  document.getElementById('mode-vision-btn').className   = 'mode-btn' + (mode === 'vision' ? ' active' : '');
  document.getElementById('mode-claude-btn').className   = 'mode-btn' + (mode === 'claude' ? ' active' : '');
}

async function loadSAFile(file) {
  if (!file) return;
  try {
    const txt = await file.text();
    const p   = JSON.parse(txt);
    if (!p.private_key || !p.client_email) throw new Error('Missing private_key or client_email');
    serviceAccountJson = p;
    document.getElementById('sa-status').innerHTML  = `✅ <strong>${p.client_email}</strong>`;
    document.getElementById('sa-status').style.color = '#057a55';
    document.getElementById('sa-dropzone').style.borderColor = '#6ee7b7';
    document.getElementById('sa-info').style.display = 'block';
    document.getElementById('sa-info').textContent   = `Project: ${p.project_id} · ${p.client_email}`;
    document.getElementById('test-result').innerHTML = '';
  } catch (e) {
    document.getElementById('test-result').innerHTML = `<div class="alert alert-error">Error: ${esc(e.message)}</div>`;
  }
}

function saveSettings() {
  credMode     = _credModeSetting;
  visionApiKey = document.getElementById('vision-key-input').value.trim();
  claudeApiKey = document.getElementById('claude-key-input').value.trim();
  Extractor.setCredentials(credMode, visionApiKey, serviceAccountJson, claudeApiKey);
  Storage.saveCreds({
    mode:      credMode,
    visionKey: visionApiKey,
    saJson:    serviceAccountJson ? JSON.stringify(serviceAccountJson) : null,
    claudeKey: claudeApiKey
  });
  updateCredStatus();
  closeSettings();
}

async function testConnection() {
  const mode  = _credModeSetting;
  const vKey  = document.getElementById('vision-key-input').value.trim();
  const saJ   = serviceAccountJson;
  const cKey  = document.getElementById('claude-key-input').value.trim();
  document.getElementById('test-spinner').style.display = 'inline-block';
  document.getElementById('test-result').innerHTML = '';
  const steps = await Extractor.testConnection(mode, vKey, saJ, cKey);
  const allOk = steps.every(s => s.ok);
  document.getElementById('test-result').innerHTML = `
    <div style="padding:12px;background:${allOk ? '#ecfdf5' : '#fef2f2'};border:1px solid ${allOk ? '#6ee7b7' : '#fca5a5'};border-radius:8px">
      <div style="font-size:12px;font-weight:600;color:${allOk ? '#064e3b' : '#7f1d1d'};margin-bottom:8px">
        ${allOk ? '✅ All checks passed — ready to extract!' : '❌ Connection failed'}
      </div>
      ${steps.map(s => `
        <div class="test-step">
          <span class="test-icon">${s.ok ? '✅' : '❌'}</span>
          <div>
            <div style="font-weight:500;color:${s.ok ? '#065f46' : '#991b1b'}">${s.label}</div>
            ${s.detail ? `<div class="test-detail">${s.detail}</div>` : ''}
          </div>
        </div>
      `).join('')}
    </div>`;
  document.getElementById('test-spinner').style.display = 'none';
}

// ── ZOOM ──────────────────────────────────────────────────────────
async function openZoom() {
  if (!PDFViewer.isLoaded()) return;
  document.getElementById('zoom-overlay').style.display = 'flex';
  zoomLevel = 1; zoomPanX = 0; zoomPanY = 0;
  applyZoom();
  await PDFViewer.renderZoomCanvas(curPage);
}

function closeZoom() { document.getElementById('zoom-overlay').style.display = 'none'; }
function adjZoom(d)  { zoomLevel = Math.min(8, Math.max(.4, zoomLevel + d)); applyZoom(); }
function resetZoom() { zoomLevel = 1; zoomPanX = 0; zoomPanY = 0; applyZoom(); }
function applyZoom() {
  document.getElementById('zoom-pct').textContent = Math.round(zoomLevel * 100) + '%';
  document.getElementById('zoom-img-wrap').style.transform = `translate(${zoomPanX}px,${zoomPanY}px) scale(${zoomLevel})`;
}
function zoomWheel(e) { e.preventDefault(); zoomLevel = Math.min(8, Math.max(.4, zoomLevel - e.deltaY * .001)); applyZoom(); }
function zoomDragStart(e) { zoomDragging = true; zoomDX = e.clientX - zoomPanX; zoomDY = e.clientY - zoomPanY; document.getElementById('zoom-img-wrap').classList.add('dragging'); }
function zoomDragMove(e)  { if (!zoomDragging) return; zoomPanX = e.clientX - zoomDX; zoomPanY = e.clientY - zoomDY; applyZoom(); }
function zoomDragEnd()    { zoomDragging = false; document.getElementById('zoom-img-wrap').classList.remove('dragging'); }
document.getElementById('zoom-overlay').addEventListener('wheel', zoomWheel, { passive: false });

// ── CONFIRM DIALOG ────────────────────────────────────────────────
function showConfirm(title, msg, onOk) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-msg').textContent   = msg;
  _confirmOkFn = onOk;
  document.getElementById('confirm-modal').style.display = 'flex';
}
function confirmOK()     { document.getElementById('confirm-modal').style.display = 'none'; if (_confirmOkFn) _confirmOkFn(); }
function confirmCancel() { document.getElementById('confirm-modal').style.display = 'none'; }

function confirmExportInvoices() {
  const n = Object.values(results).filter(r => r.status === 'ok' || r.status === 'manual').length;
  showConfirm('Export invoices to Excel?', `${n} invoices ready.`, exportInvoicesExcel);
}
function confirmExportRecon() {
  showConfirm('Export reconciliation to Excel?', 'Creates 3 sheets: Reconciliation · Discrepancies · Summary', exportReconciliationExcel);
}
