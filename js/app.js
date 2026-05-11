// ═══════════════════════════════════════════════════════════════════
// app.js  —  v4: cycle management, master-detail recon, virtual list
// ═══════════════════════════════════════════════════════════════════

// ── STATE ─────────────────────────────────────────────────────────
let cycle       = null;   // v4 cycle object (single source of truth)
let activePdfName  = '';  // currently loaded PDF filename
let activePdfAB    = null;// loaded PDF ArrayBuffer (for appending)
let curPage     = 1;
let activeTab   = 'viewer';
let processing  = false;
let abortFlag   = false;
let showOCR     = false;
let reconRows   = [];     // flattened working copy for rendering
let grnOnlyRows = [];
let selectedReconKey = null;  // currently selected invoice in master-detail
let reconSectionState = { action: true, partial: true, matched: false, grnonly: false, resolved: false, carried: false };

// virtual list state
const VL_ROW_H    = 68;
const VL_BUFFER   = 5;
let vlSections    = [];   // [{key, label, cls, items, collapsed}]
let vlScrollTop   = 0;

// credentials
let credMode = 'vision', visionApiKey = '', serviceAccountJson = null, claudeApiKey = '';
let _confirmOkFn = null;

// zoom
let zoomLevel=1, zoomPanX=0, zoomPanY=0, zoomDragging=false, zoomDX=0, zoomDY=0;

// ── INIT ──────────────────────────────────────────────────────────
(function init() {
  const saved = Storage.loadCreds();
  if (saved) {
    try {
      credMode=saved.mode||'vision'; visionApiKey=saved.visionKey||'';
      serviceAccountJson=saved.saJson?JSON.parse(saved.saJson):null;
      claudeApiKey=saved.claudeKey||'';
      Extractor.setCredentials(credMode,visionApiKey,serviceAccountJson,claudeApiKey);
      updateCredStatus();
    } catch {}
  }
  document.addEventListener('keydown', e => {
    if (e.key==='Escape') { closeZoom(); closeSettings(); }
    if (document.getElementById('zoom-overlay').style.display==='none') {
      if (e.key==='ArrowRight') navigate(1);
      if (e.key==='ArrowLeft')  navigate(-1);
    }
  });
  window.addEventListener('beforeunload', e => {
    if (cycle && Object.keys(cycle.pages||{}).length) {
      e.preventDefault(); e.returnValue='You have unsaved data — save JSON before leaving.';
    }
  });
  Storage.startAutosave(() => cycle);
})();

// ── HELPERS ───────────────────────────────────────────────────────
const esc    = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtINR = v => { const n=parseFloat(v); return isNaN(n)?'':'₹'+n.toLocaleString('en-IN',{maximumFractionDigits:0}); };
const sleep  = ms => new Promise(r=>setTimeout(r,ms));
function setStatus(t)  { const el=document.getElementById('status-txt'); if(el) el.textContent=t; }
function showProgress(v){ const el=document.getElementById('progress-wrap'); if(el) el.style.display=v?'block':'none'; }
function showSaveIndicator(msg='✓ Saved') {
  const el=document.getElementById('save-indicator'); if(!el) return;
  el.textContent=msg; setTimeout(()=>{ el.textContent=''; },2000);
}
function badgeHTML(status) {
  const m={ok:['badge-ok','Extracted'],error:['badge-error','Error'],review:['badge-review','Review'],manual:['badge-manual','Manual'],wait:['badge-wait','…']};
  const[cls,lbl]=m[status]||['badge-wait','?'];
  return `<span class="badge ${cls}">${lbl}</span>`;
}

// ── CREDENTIAL STATUS ─────────────────────────────────────────────
function updateCredStatus() {
  const el=document.getElementById('cred-status');
  const s=Extractor.getCredSummary();
  if(s){el.className='cred-ok';el.textContent=s;}
  else{el.className='cred-warn';el.textContent='⚠ No API key — open Settings to configure';}
}

// ── CYCLE MANAGEMENT ──────────────────────────────────────────────
function ensureCycle(pdfName) {
  if (!cycle) {
    const existing = Storage.loadCycleFromLS();
    if (existing && Object.keys(existing.pages||{}).length) {
      // active cycle exists — check if this PDF is already in it
      const alreadyIn = (existing.sources||[]).some(s=>s.pdfName===pdfName);
      if (alreadyIn) {
        cycle = existing; return 'resume';
      }
      // different PDF — show append banner
      return 'append';
    }
    // no existing cycle — create new
    cycle = Storage.newCycle();
  }
  return 'new';
}

function showCycleBanner() {
  if (!cycle) return;
  const b = document.getElementById('cycle-banner');
  const inp = document.getElementById('cycle-label-input');
  const sub = document.getElementById('cycle-banner-sub');
  const title = document.getElementById('cycle-banner-title');
  b.style.display='flex';
  inp.value = cycle.cycleLabel||'';
  const pgCount = Object.keys(cycle.pages||{}).length;
  const srcCount = (cycle.sources||[]).length;
  title.textContent = 'Active Cycle';
  sub.textContent   = `${pgCount} pages · ${srcCount} PDF source(s) · updated ${new Date(cycle.updatedAt||cycle.createdAt).toLocaleString('en-IN')}`;
}

function updateCycleLabel(val) {
  if (!cycle) return;
  cycle.cycleLabel = val;
  Storage.markDirty();
}

function newCyclePrompt() {
  showConfirm('Start a new cycle?',
    'Current cycle will be saved to localStorage. Open items can be carried forward to the new cycle.',
    () => {
      confirmCancel();
      // carry forward open items
      const openItems = Storage.getOpenItems(cycle);
      const newC = Storage.newCycle();
      if (openItems.length) {
        newC.carriedForward = openItems.map(r=>({
          fromCycle: cycle.cycleLabel,
          originalRow: {...r},
          carryNote: ''
        }));
      }
      Storage.saveCycleToLS(cycle); // archive current
      cycle = newC;
      activePdfName=''; activePdfAB=null;
      reconRows=[]; grnOnlyRows=[]; selectedReconKey=null;
      document.getElementById('upload-zone').style.display='block';
      document.getElementById('controls').style.display='none';
      document.getElementById('tabs-wrap').style.display='none';
      showProgress(false);
      showCycleBanner();
      updateReconReadiness();
      if(openItems.length){
        document.getElementById('carry-banner').style.display='flex';
        document.getElementById('carry-banner-text').textContent=
          `${openItems.length} open item(s) carried from ${cycle.carriedForward[0]?.fromCycle||'previous cycle'}`;
      }
    }
  );
}

// ── PDF LOADING ───────────────────────────────────────────────────
function handlePdfDrop(ev){ ev.preventDefault(); if(ev.dataTransfer.files[0]) loadPDF(ev.dataTransfer.files[0]); }

async function loadPDF(file) {
  if (!file) return;
  setStatus('Loading PDF…'); showProgress(true);
  try {
    const ab = await file.arrayBuffer();
    activePdfAB = ab.slice(0); // keep for potential append
    const n = await PDFViewer.loadPDF(ab);
    activePdfName = file.name;

    const cycleState = ensureCycle(file.name);

    if (cycleState === 'append') {
      // show append banner — don't load yet
      const existing = Storage.loadCycleFromLS();
      const pgCount  = Object.keys(existing.pages||{}).length;
      document.getElementById('append-banner').style.display='flex';
      document.getElementById('append-banner-sub').textContent=
        `Active cycle "${existing.cycleLabel}" has ${pgCount} pages from ${(existing.sources||[]).length} PDF(s) — append "${file.name}" or start fresh?`;
      showProgress(false);
      return;
    }

    // source registration
    if (cycleState==='new' || cycleState==='resume') {
      if (!cycle.sources) cycle.sources=[];
      if (!cycle.sources.some(s=>s.pdfName===file.name)) {
        cycle.sources.push({ pdfName:file.name, addedAt:new Date().toISOString(), pageCount:n });
      }
    }

    _finishPDFLoad(file.name, n);
    showProgress(false);
  } catch(e) { setStatus('Error loading PDF: '+e.message); showProgress(false); }
}

function appendToCycle() {
  const existing = Storage.loadCycleFromLS();
  if (existing) {
    cycle = existing;
    if (!cycle.sources) cycle.sources=[];
    if (!cycle.sources.some(s=>s.pdfName===activePdfName)) {
      cycle.sources.push({ pdfName:activePdfName, addedAt:new Date().toISOString(), pageCount:0 });
    }
  }
  document.getElementById('append-banner').style.display='none';
  const pageCount = cycle.sources.find(s=>s.pdfName===activePdfName)?.pageCount||0;
  _finishPDFLoad(activePdfName, pageCount || 0);
}

function discardAppend() {
  document.getElementById('append-banner').style.display='none';
  cycle = Storage.newCycle();
  if (!cycle.sources) cycle.sources=[];
  cycle.sources.push({ pdfName:activePdfName, addedAt:new Date().toISOString(), pageCount:0 });
  PDFViewer.loadPDF(activePdfAB); // re-load since we stored it
  _finishPDFLoad(activePdfName, 0);
}

function _finishPDFLoad(pdfName, totalPages) {
  document.getElementById('upload-zone').style.display='none';
  document.getElementById('controls').style.display='flex';
  document.getElementById('pdf-name-lbl').textContent=pdfName;
  document.getElementById('total-pages-lbl').textContent = totalPages ? `${totalPages} pages` : '';
  document.getElementById('page-range-input').value=`1-${Math.min(10,totalPages||10)}`;
  showCycleBanner();
  // if cycle has pages, show tabs
  if (Object.keys(cycle.pages||{}).length) {
    document.getElementById('tabs-wrap').style.display='block';
    document.getElementById('export-inv-btn').disabled=false;
    const pgs=sortedPageKeys();
    if(pgs.length){ curPage=cycle.pages[pgs[0]].page||1; switchTab('viewer'); renderViewer(); }
    updateStatBars(); renderTable(); renderReviewQueue(); updateReconReadiness();
  }
  // check session banner (same PDF already extracted)
  const samePdfPages = Object.values(cycle.pages||{}).filter(p=>p.sourcePdf===pdfName);
  if (samePdfPages.length>0) {
    document.getElementById('session-banner').style.display='flex';
    document.getElementById('session-info-text').textContent=
      `${samePdfPages.length} pages already extracted for this PDF in the active cycle`;
  }
}

function resumeSession() { document.getElementById('session-banner').style.display='none'; }
function discardSession() {
  if (!cycle) return;
  // remove pages from this PDF only
  for (const k of Object.keys(cycle.pages||{})) {
    if (cycle.pages[k].sourcePdf===activePdfName) delete cycle.pages[k];
  }
  Storage.markDirty();
  document.getElementById('session-banner').style.display='none';
  reconRows=[]; grnOnlyRows=[];
  updateStatBars(); renderTable(); renderReviewQueue(); updateReconReadiness();
}

function changePDF() {
  PDFViewer.unload(); activePdfName=''; activePdfAB=null;
  document.getElementById('upload-zone').style.display='block';
  document.getElementById('controls').style.display='none';
  document.getElementById('tabs-wrap').style.display='none';
  document.getElementById('session-banner').style.display='none';
  document.getElementById('append-banner').style.display='none';
  document.getElementById('progress-wrap').style.display='none';
  document.getElementById('pdf-input').value='';
}

// ── JSON IMPORT / EXPORT ──────────────────────────────────────────
async function importSessionJSON(file) {
  try {
    const imported = await Storage.importJSON(file);
    cycle = imported;
    activePdfName = (cycle.sources||[])[0]?.pdfName || cycle.pdfName || '';
    document.getElementById('upload-zone').style.display='none';
    document.getElementById('controls').style.display='flex';
    document.getElementById('tabs-wrap').style.display='block';
    document.getElementById('export-inv-btn').disabled=false;
    document.getElementById('pdf-name-lbl').textContent=activePdfName+' (from JSON)';
    const pgCount=(cycle.sources||[])[0]?.pageCount||0;
    document.getElementById('total-pages-lbl').textContent=pgCount?`${pgCount} pages`:'';
    showCycleBanner();
    reconRows   = cycle.reconRows    || [];
    grnOnlyRows = cycle.grnOnlyRows  || [];
    const pgs=sortedPageKeys();
    if(pgs.length){ curPage=cycle.pages[pgs[0]].page||1; switchTab('viewer'); renderViewer(); }
    updateStatBars(); renderTable(); renderReviewQueue(); updateReconReadiness();
    if(reconRows.length){ renderReconList(); document.getElementById('recon-results').style.display='block'; document.getElementById('export-recon-btn').style.display='inline-block'; }
    renderCNList();
    Storage.saveCycleToLS(cycle);
    setStatus(`✓ Imported ${Object.keys(cycle.pages||{}).length} pages`);
    showProgress(true);
    document.getElementById('status-dot').className='dot done';
    document.getElementById('status-dot').style.animation='none';
    document.getElementById('json-input').value='';
  } catch(e) { alert('Error importing JSON: '+e.message); }
}

function saveSessionJSON() {
  if (!cycle||!Object.keys(cycle.pages||{}).length) { alert('No data to save yet.'); return; }
  cycle.reconRows   = reconRows;
  cycle.grnOnlyRows = grnOnlyRows;
  Storage.exportJSON(cycle);
  showSaveIndicator('✓ Saved to file');
}

// ── EXTRACTION ────────────────────────────────────────────────────
function startExtraction() {
  const rangeStr=document.getElementById('page-range-input').value||'1-10';
  const srcTotal=(cycle?.sources||[]).find(s=>s.pdfName===activePdfName)?.pageCount||0;
  const pages=Extractor.parsePageRange(rangeStr,srcTotal||999);
  if(!pages.length){alert('No valid pages in range.');return;}
  _runExtractionPages(pages);
}
// ── state for extract-choice modal ───────────────────────────────
let _ecAllPages = [], _ecRemainingPages = [];

function startExtractionAll() {
  const srcTotal = (cycle?.sources||[]).find(s=>s.pdfName===activePdfName)?.pageCount || 0;
  if (!srcTotal) { alert('PDF not loaded or page count unknown.'); return; }

  const allPages  = Array.from({length:srcTotal}, (_,i) => i+1);
  const done      = allPages.filter(pg => {
    const r = cycle?.pages?.[`${activePdfName}::${pg}`];
    return r && (r.status === 'ok' || r.status === 'manual');
  });
  const remaining = allPages.filter(pg => {
    const r = cycle?.pages?.[`${activePdfName}::${pg}`];
    return !r || (r.status !== 'ok' && r.status !== 'manual');
  });

  _ecAllPages       = allPages;
  _ecRemainingPages = remaining;

  if (done.length > 0 && remaining.length > 0) {
    // Some already done, some pending — give user the choice
    const remCost = (remaining.length * Extractor.costPerPage).toFixed(4);
    const allCost = (allPages.length  * Extractor.costPerPage).toFixed(4);
    document.getElementById('ec-title').textContent = `${done.length} of ${srcTotal} pages already extracted`;
    document.getElementById('ec-msg').textContent   =
      `${remaining.length} page${remaining.length>1?'s':''} still pending. What would you like to do?`;
    document.getElementById('ec-remaining-btn').textContent =
      `Extract remaining ${remaining.length} pages  (~$${remCost})`;
    document.getElementById('ec-all-btn').textContent =
      `Re-extract all ${srcTotal} pages  (~$${allCost})`;
    document.getElementById('extract-choice-modal').style.display = 'flex';
  } else if (remaining.length === 0) {
    // All already extracted — confirm re-extract
    const cost = (allPages.length * Extractor.costPerPage).toFixed(4);
    showConfirm(
      `All ${srcTotal} pages already extracted`,
      `Re-extract everything? Estimated cost: $${cost}`,
      () => { confirmCancel(); document.getElementById('page-range-input').value='all'; _runExtractionPages(allPages, true); }
    );
  } else {
    // Nothing extracted yet — simple confirm
    const cost = (srcTotal * Extractor.costPerPage).toFixed(4);
    showConfirm(`Extract all ${srcTotal} pages?`, `Estimated cost: $${cost}`, () => {
      confirmCancel();
      document.getElementById('page-range-input').value = 'all';
      _runExtractionPages(allPages);
    });
  }
}

function extractChoiceRemaining() {
  document.getElementById('extract-choice-modal').style.display = 'none';
  document.getElementById('page-range-input').value = 'remaining';
  _runExtractionPages(_ecRemainingPages);
}

function extractChoiceAll() {
  document.getElementById('extract-choice-modal').style.display = 'none';
  document.getElementById('page-range-input').value = 'all';
  _runExtractionPages(_ecAllPages, true);
}

function extractChoiceCancel() {
  document.getElementById('extract-choice-modal').style.display = 'none';
}
function stopExtraction(){ abortFlag=true; }
function retryFailed() {
  const failed=Object.values(cycle?.pages||{}).filter(r=>r.sourcePdf===activePdfName&&(r.status==='error'||r.status==='review')).map(r=>r.page).sort((a,b)=>a-b);
  if(!failed.length){alert('No failed pages to retry.');return;}
  showConfirm(`Re-extract ${failed.length} failed pages?`,`Pages: ${failed.slice(0,20).join(', ')}${failed.length>20?'…':''}`,()=>{confirmCancel();_runExtractionPages(failed,true);});
}

async function _runExtractionPages(pagesList, forceRetry=false) {
  if (!Extractor.hasCred()){openSettings();return;}
  if (!PDFViewer.isLoaded()){alert('Please load a PDF first.');return;}
  if (!cycle) cycle=Storage.newCycle();
  if (processing) return;
  processing=true; abortFlag=false;
  document.getElementById('tabs-wrap').style.display='block';
  document.getElementById('extract-btn').disabled=true;
  document.getElementById('extract-all-btn').disabled=true;
  document.getElementById('retry-btn').style.display='none';
  document.getElementById('reparse-all-btn').style.display='none';
  document.getElementById('stop-btn').style.display='inline-block';
  document.getElementById('export-inv-btn').disabled=true;
  document.getElementById('progress-fill').style.width='0%';
  document.getElementById('status-dot').className='dot';
  document.getElementById('status-dot').style.animation='pulse 1s infinite';
  showProgress(true);

  const pending=forceRetry?pagesList:pagesList.filter(pg=>{
    const key=`${activePdfName}::${pg}`;
    const r=cycle.pages[key];
    return !r||(r.status!=='ok'&&r.status!=='manual');
  });
  const skipped=pagesList.length-pending.length;
  let done=0, navDone=false;
  const conc=Math.min(parseInt(document.getElementById('batch-size').value)||3,8);

  const processOne=async(pg)=>{
    if(abortFlag) return;
    setStatus(`Extracting page ${pg}… (${done}/${pending.length})`);
    const key=`${activePdfName}::${pg}`;
    try {
      const b64=await PDFViewer.renderToBase64(pg);
      const data=await Extractor.extractOnePage(b64);
      const needsReview=data.confidence==='low'||!data.vendor||!data.invoice||!data.amount;
      if (!cycle.pages) cycle.pages={};
      cycle.pages[key]={pageKey:key,sourcePdf:activePdfName,page:pg,...data,status:needsReview?'review':'ok',error:null};
    } catch(e) {
      if (!cycle.pages) cycle.pages={};
      cycle.pages[key]={pageKey:key,sourcePdf:activePdfName,page:pg,vendor:'',invoice:'',gstin:'',amount:'',invoiceDate:'',ocrText:'',status:'error',error:e.message,cost:0};
    }
    done++;
    document.getElementById('progress-fill').style.width=Math.round(done/pending.length*100)+'%';
    setStatus(`Processing… (${done}/${pending.length})`);
    const totalCost=Object.values(cycle.pages||{}).reduce((s,r)=>s+(r.cost||0),0);
    document.getElementById('cost-display').textContent=`Cost: $${totalCost.toFixed(4)}`;
    Storage.markDirty();
    if(!navDone){navDone=true;curPage=pg;if(activeTab==='viewer')renderViewer();}
    if(done%5===0||done===pending.length){updateStatBars();}
  };

  for(let i=0;i<pending.length;i+=conc){
    if(abortFlag) break;
    await Promise.all(pending.slice(i,i+conc).map(processOne));
  }

  Storage.saveCycleToLS(cycle);
  const doneMsg=abortFlag?`⏹ Stopped — ${done}/${pending.length}`:`✓ Done — ${pending.length} extracted${skipped?` (${skipped} already done)`:''}`;
  setStatus(doneMsg);
  document.getElementById('status-dot').className='dot done';
  document.getElementById('status-dot').style.animation='none';
  document.getElementById('extract-btn').disabled=false;
  document.getElementById('extract-all-btn').disabled=false;
  document.getElementById('stop-btn').style.display='none';
  document.getElementById('export-inv-btn').disabled=false;
  processing=false;
  updateStatBars(); renderTable(); renderReviewQueue(); updateReviewBtn();
}

// ── VIEWER ────────────────────────────────────────────────────────
function sortedPageKeys() {
  return Object.keys(cycle?.pages||{}).sort((a,b)=>{
    const pa=cycle.pages[a], pb=cycle.pages[b];
    return (pa.sourcePdf||'').localeCompare(pb.sourcePdf||'')||(pa.page-pb.page);
  });
}
function curPageKey() { return `${activePdfName}::${curPage}`; }

async function renderViewer() {
  const key=curPageKey();
  const r=cycle?.pages?.[key];
  document.getElementById('page-info').textContent=`Page ${curPage}`;
  document.getElementById('img-panel-title').textContent=`Page ${curPage}`;
  document.getElementById('status-badge').innerHTML=r?badgeHTML(r.status):'';
  document.getElementById('confidence-badge').textContent=r?.status==='ok'&&r.confidence?`confidence: ${r.confidence}`:'';
  const cb=document.getElementById('confidence-badge');
  cb.style.color=r?.confidence==='high'?'#057a55':r?.confidence==='low'?'#c81e1e':'#92400e';
  document.getElementById('page-cost').textContent=r?.cost>0?`API cost: $${r.cost.toFixed(5)}`:'';
  document.getElementById('ocr-text-display').textContent=r?.ocrText||'No OCR text available.';
  const reparseBtn=document.getElementById('reparse-btn');
  if(reparseBtn){
    const hasOCR=!!(r?.ocrText);
    reparseBtn.disabled=!hasOCR;
    reparseBtn.title=hasOCR?`Re-parse cached OCR (${r.ocrText.length} chars) — free`:'No OCR text — use Re-extract first';
  }
  await PDFViewer.renderMainCanvas(curPage);
  const fp=document.getElementById('fields-panel');
  if(!r){fp.innerHTML='<div class="empty-state">Not extracted yet.</div>';return;}
  if(r.status==='wait'){fp.innerHTML='<div class="empty-state"><span class="spinner"></span> Re-extracting…</div>';return;}
  let html='';
  if(r.status==='error'||r.status==='review'){
    html+=`<div class="alert ${r.status==='error'?'alert-error':'alert-warn'}" style="margin-bottom:12px">
      <strong>${r.status==='error'?'⚠ Extraction failed — fill in manually':'⚠ Low confidence — please verify'}</strong>
      ${r.error?`<div style="font-size:11px;margin-top:4px">${esc(r.error)}</div>`:''}
    </div>`;
  }
  html+=`
    <div class="field-row"><div class="field-lbl">Vendor name</div><div contenteditable="true" class="field-val" onblur="saveField('${key}','vendor',this)">${esc(r.vendor||'')}</div></div>
    <div class="field-row"><div class="field-lbl">Invoice no.</div><div contenteditable="true" class="field-val" onblur="saveField('${key}','invoice',this)">${esc(r.invoice||'')}</div></div>
    <div class="field-row"><div class="field-lbl">Vendor GSTIN</div><div contenteditable="true" class="field-val" onblur="saveField('${key}','gstin',this)">${esc(r.gstin||'')}</div></div>
    <div class="field-row"><div class="field-lbl">Total amount</div><div contenteditable="true" class="field-val" onblur="saveField('${key}','amount',this)">${esc(r.amount||'')}</div></div>
    <div class="field-row" style="border-bottom:none"><div class="field-lbl">Invoice date</div><div contenteditable="true" class="field-val" onblur="saveField('${key}','invoiceDate',this)">${esc(r.invoiceDate||'')}</div></div>`;
  const hasEmpty=!r.vendor||!r.invoice||!r.amount;
  if(r.status==='error'||r.status==='review'||(r.status==='ok'&&hasEmpty)){
    html+=`<button class="btn-success" style="width:100%;margin-top:14px;padding:9px" onclick="markManual('${key}')">✓ Mark as reviewed</button>`;
  }
  if(r.status==='manual') html+=`<div style="font-size:11px;color:#1e429f;margin-top:10px">✓ Marked as reviewed.</div>`;
  if(r.status==='ok'&&!hasEmpty) html+=`<div class="hint">Click any field to edit inline.</div>`;
  fp.innerHTML=html;
}

function navigate(dir) {
  const pgs=sortedPageKeys().map(k=>cycle.pages[k]).filter(p=>p.sourcePdf===activePdfName);
  const idx=pgs.findIndex(p=>p.page===curPage);
  const nxt=pgs[idx+dir];
  if(nxt){curPage=nxt.page;renderViewer();}
}

function jumpToReview() {
  const pg=Object.values(cycle?.pages||{}).find(p=>p.sourcePdf===activePdfName&&(p.status==='error'||p.status==='review'));
  if(pg){curPage=pg.page;switchTab('viewer');renderViewer();}
}

function saveField(key,field,el) {
  if(!cycle?.pages?.[key]) return;
  cycle.pages[key][field]=el.textContent.trim();
  Storage.markDirty(); showSaveIndicator(); updateStatBars(); renderTable();
}

function markManual(key) {
  if(!cycle?.pages?.[key]) return;
  cycle.pages[key].status='manual';
  Storage.markDirty(); renderViewer(); updateStatBars(); renderTable(); renderReviewQueue(); updateReviewBtn();
  showSaveIndicator('✓ Marked reviewed');
}

function toggleOCR() {
  showOCR=!showOCR;
  document.getElementById('ocr-panel').style.display=showOCR?'block':'none';
  document.getElementById('viewer-grid').className=showOCR?'viewer-grid three':'viewer-grid';
  document.getElementById('ocr-toggle-btn').textContent=showOCR?'Hide OCR Text':'Show OCR Text';
}

async function rotatePage(deg) { PDFViewer.rotate(curPage,deg); await PDFViewer.renderMainCanvas(curPage); }

function reparseFromOCR() {
  const key=curPageKey(); const r=cycle?.pages?.[key];
  if(!r?.ocrText){alert('No OCR text found. Use ↻ Re-extract first.');return;}
  const data=Extractor.parseFromOCR(r.ocrText);
  const needsReview=data.confidence==='low'||!data.vendor||!data.invoice||!data.amount;
  cycle.pages[key]={...r,...data,ocrText:r.ocrText,cost:r.cost,status:needsReview?'review':'ok',error:null};
  Storage.markDirty(); renderViewer(); updateStatBars(); renderTable(); renderReviewQueue(); updateReviewBtn();
  showSaveIndicator('⚡ Re-parsed');
}

function reparseAllFromOCR() {
  const eligible=Object.values(cycle?.pages||{}).filter(r=>r.ocrText);
  if(!eligible.length){alert('No pages have cached OCR text.');return;}
  showConfirm(`Re-parse ${eligible.length} pages from OCR?`,'Free — no API call.',()=>{
    confirmCancel();
    let ok=0;
    for(const r of eligible){
      const data=Extractor.parseFromOCR(r.ocrText);
      const needsReview=data.confidence==='low'||!data.vendor||!data.invoice||!data.amount;
      cycle.pages[r.pageKey||`${r.sourcePdf}::${r.page}`]={...r,...data,ocrText:r.ocrText,cost:r.cost,status:needsReview?'review':'ok',error:null};
      if(!needsReview) ok++;
    }
    Storage.markDirty(); renderViewer(); updateStatBars(); renderTable(); renderReviewQueue(); updateReviewBtn();
    setStatus(`⚡ Re-parsed ${eligible.length} pages — ${ok} OK`);
    showSaveIndicator(`⚡ ${eligible.length} re-parsed`);
  });
}

async function reextract() {
  if(!PDFViewer.isLoaded()||!Extractor.hasCred()){openSettings();return;}
  const key=curPageKey();
  if(cycle?.pages?.[key]) cycle.pages[key].status='wait';
  renderViewer();
  try {
    const b64=await PDFViewer.renderToBase64(curPage);
    const data=await Extractor.extractOnePage(b64);
    const needsReview=data.confidence==='low'||!data.vendor||!data.invoice||!data.amount;
    if(!cycle.pages) cycle.pages={};
    cycle.pages[key]={...(cycle.pages[key]||{}),pageKey:key,sourcePdf:activePdfName,page:curPage,...data,status:needsReview?'review':'ok',error:null};
  } catch(e) {
    if(cycle?.pages?.[key]) cycle.pages[key]={...cycle.pages[key],status:'error',error:e.message};
  }
  Storage.markDirty(); renderViewer(); updateStatBars(); renderTable(); renderReviewQueue(); updateReviewBtn();
}

// ── STATS ──────────────────────────────────────────────────────────
function getStats() {
  const all=Object.values(cycle?.pages||{});
  const ok=all.filter(r=>r.status==='ok'||r.status==='manual');
  const rev=all.filter(r=>r.status==='error'||r.status==='review');
  const total=ok.reduce((s,r)=>s+(parseFloat(r.amount)||0),0);
  const cost=all.reduce((s,r)=>s+(r.cost||0),0);
  return{all,ok,rev,total,cost};
}
function statsHTML(s){
  const srcCount=(cycle?.sources||[]).length;
  return`
    <div class="stat-card"><div class="stat-num">${s.all.length}</div><div class="stat-lbl">Processed</div><div class="stat-sub">${srcCount} PDF source(s)</div></div>
    <div class="stat-card"><div class="stat-num" style="color:#057a55">${s.ok.length}</div><div class="stat-lbl">Extracted OK</div><div class="stat-sub">${s.all.length?Math.round(s.ok.length/s.all.length*100):0}%</div></div>
    <div class="stat-card" style="${s.rev.length>0?'border:1px solid #fbbf24':''}"><div class="stat-num" style="color:${s.rev.length>0?'#92400e':'#1a1a2e'}">${s.rev.length}</div><div class="stat-lbl">Needs Review</div></div>
    <div class="stat-card"><div class="stat-num" style="font-size:16px">${s.total?('₹'+s.total.toLocaleString('en-IN',{maximumFractionDigits:0})):'—'}</div><div class="stat-lbl">Grand Total</div></div>
    <div class="stat-card"><div class="stat-num" style="font-size:16px">$${s.cost.toFixed(4)}</div><div class="stat-lbl">API Cost</div></div>`;
}
function updateStatBars(){
  const s=getStats(); const h=statsHTML(s);
  ['stats-viewer','stats-review','stats-table'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML=h;});
  updateReviewBtn();
}
function updateReviewBtn(){
  const needs=r=>r.status==='error'||r.status==='review'||(r.status==='ok'&&(!r.vendor||!r.invoice||!r.amount));
  const rev=Object.values(cycle?.pages||{}).filter(needs);
  const withOCR=Object.values(cycle?.pages||{}).filter(r=>r.ocrText);
  const btn=document.getElementById('review-jump-btn');
  const retryBtn=document.getElementById('retry-btn');
  const reparseAllBtn=document.getElementById('reparse-all-btn');
  if(rev.length>0){
    if(btn){btn.style.display='inline-block';btn.textContent=`⚠ ${rev.length} to review`;}
    if(retryBtn&&!processing) retryBtn.style.display='inline-block';
  } else {
    if(btn) btn.style.display='none';
    if(retryBtn) retryBtn.style.display='none';
  }
  if(reparseAllBtn) reparseAllBtn.style.display=withOCR.length>0&&!processing?'inline-block':'none';
}

// ── REVIEW QUEUE ───────────────────────────────────────────────────
function renderReviewQueue(){
  const needs=r=>r.status==='error'||r.status==='review'||(r.status==='ok'&&(!r.vendor||!r.invoice||!r.amount));
  const rev=Object.values(cycle?.pages||{}).filter(needs).sort((a,b)=>a.page-b.page);
  const el=document.getElementById('review-list');
  if(!rev.length){el.innerHTML='<div style="text-align:center;padding:3rem;color:#9ca3af;font-size:13px"><div style="font-size:36px;margin-bottom:8px">✅</div>No items need review!</div>';return;}
  el.innerHTML=rev.map(r=>`
    <div class="review-card">
      <div class="review-head" style="background:${r.status==='error'?'#fef2f2':'#fffbeb'}">
        ${badgeHTML(r.status)}<strong style="font-size:13px">Page ${r.page}</strong>
        <span style="font-size:11px;color:#6b7280">${r.sourcePdf||''}</span>
        ${r.error?`<span style="font-size:12px;color:#6b7280">${esc(r.error)}</span>`:(!r.vendor||!r.invoice||!r.amount)?`<span style="font-size:12px;color:#92400e">Missing: ${[!r.vendor?'vendor':'',!r.invoice?'invoice no':'',!r.amount?'amount':''].filter(Boolean).join(', ')}</span>`:''}
        <span style="flex:1"></span>
        <button class="btn-sm" onclick="curPage=${r.page};activePdfName='${esc(r.sourcePdf||activePdfName)}';switchTab('viewer');renderViewer()">Open →</button>
      </div>
      <div class="review-body">
        ${['Vendor','Invoice','GSTIN','Amount'].map((l,i)=>{const k=['vendor','invoice','gstin','amount'][i];const v=r[k];return`<div><div class="review-fld-lbl">${l}</div><div class="review-fld-val" style="${!v?'color:#c81e1e;font-style:italic':''}">${v||'⚠ Missing'}</div></div>`;}).join('')}
      </div>
    </div>`).join('');
}

// ── ALL RESULTS TABLE ──────────────────────────────────────────────
function renderTable(){
  const q=(document.getElementById('table-search')?.value||'').toLowerCase();
  const rows=sortedPageKeys().map(k=>cycle.pages[k]).filter(r=>!q||JSON.stringify(r).toLowerCase().includes(q));
  document.getElementById('results-tbody').innerHTML=rows.map(r=>`
    <tr class="${r.page===curPage&&r.sourcePdf===activePdfName?'selected':''}" onclick="curPage=${r.page};activePdfName='${esc(r.sourcePdf||activePdfName)}';switchTab('viewer');renderViewer()">
      <td class="td-muted">${r.page}</td>
      <td title="${esc(r.vendor||'')}">${esc(r.vendor)||'—'}</td>
      <td>${esc(r.invoice)||'—'}</td>
      <td class="td-mono">${esc(r.gstin)||'—'}</td>
      <td class="td-r">${r.amount?fmtINR(r.amount):'—'}</td>
      <td>${badgeHTML(r.status)}</td>
      <td class="td-muted td-mono" style="font-size:10px">${r.cost?('$'+r.cost.toFixed(5)):'—'}</td>
    </tr>`).join('');
}

// ── GRN FILE MANAGEMENT ───────────────────────────────────────────
function handleGrnDrop(ev){ev.preventDefault();loadGRNFiles(ev.dataTransfer.files);}

async function loadGRNFiles(files) {
  if (!cycle) cycle=Storage.newCycle();
  if (!cycle.grnData) cycle.grnData=[];
  for(const f of Array.from(files)){
    try{
      const ab=await f.arrayBuffer();
      const rows=Reconcile.parseGRNFile(ab,f.name);
      rows.forEach((r,i)=>r._id=`${f.name}_${i}`);
      // replace if same filename already loaded
      const existIdx=cycle.grnData.findIndex(g=>g.name===f.name);
      const entry={name:f.name,rows,count:rows.length,addedAt:new Date().toISOString()};
      if(existIdx>=0) cycle.grnData[existIdx]=entry; else cycle.grnData.push(entry);
    }catch(e){
      const existIdx=cycle.grnData.findIndex(g=>g.name===f.name);
      const entry={name:f.name,rows:[],count:0,error:e.message};
      if(existIdx>=0) cycle.grnData[existIdx]=entry; else cycle.grnData.push(entry);
    }
  }
  renderGRNFileList(); updateReconReadiness(); Storage.markDirty();
}

function renderGRNFileList(){
  const grnData=cycle?.grnData||[];
  document.getElementById('grn-file-list').innerHTML=
    grnData.map((f,i)=>`
      <div class="grn-file-row">
        <span style="font-size:20px">📊</span>
        <div style="flex:1">
          <div class="grn-file-name">${esc(f.name)}</div>
          <div class="grn-file-sub">${f.error?'Error: '+esc(f.error):f.count+' GRN records loaded'}</div>
        </div>
        <span class="badge ${f.error?'badge-error':'badge-ok'}">${f.error?'Error':f.count+' rows'}</span>
        <button class="btn-sm btn-danger-outline" onclick="removeGRNFile(${i})">✕</button>
      </div>`).join('')+
    (grnData.length?`<div style="font-size:12px;color:#9ca3af;padding:4px">Total: ${grnData.reduce((s,f)=>s+f.count,0)} records from ${grnData.length} files</div>`:'');
}

function removeGRNFile(i){
  if(!cycle?.grnData) return;
  cycle.grnData.splice(i,1);
  renderGRNFileList(); updateReconReadiness(); Storage.markDirty();
}

function updateReconReadiness(){
  const invCount=Object.values(cycle?.pages||{}).filter(r=>r.status==='ok'||r.status==='manual').length;
  const grnCount=(cycle?.grnData||[]).reduce((s,f)=>s+f.count,0);
  document.getElementById('recon-readiness').innerHTML=
    `<span style="font-weight:600">${invCount} invoices</span> extracted &nbsp;·&nbsp; <span style="font-weight:600">${grnCount} GRN records</span> loaded`+
    (reconRows.length?` &nbsp;·&nbsp; <span style="color:#057a55">✓ Last run: ${reconRows.length} rows</span>`:'');
  document.getElementById('run-recon-btn').disabled=!(invCount>0&&grnCount>0);
  // update summary cards if results shown
  if(reconRows.length) renderReconSummaryCards();
}

// ── RECONCILIATION ────────────────────────────────────────────────
function runReconciliation(){
  const prevRows=reconRows.length?reconRows:null;
  const result=Reconcile.run(cycle,prevRows);
  reconRows  =result.reconRows;
  grnOnlyRows=result.grnOnlyRows;
  cycle.reconRows   =reconRows;
  cycle.grnOnlyRows =grnOnlyRows;
  document.getElementById('recon-results').style.display='block';
  document.getElementById('export-recon-btn').style.display='inline-block';
  renderReconSummaryCards();
  buildVLSections();
  renderReconList();
  selectedReconKey=null;
  document.getElementById('recon-detail-panel').innerHTML='<div class="recon-right-empty"><div style="font-size:36px;margin-bottom:8px">←</div>Select an invoice from the list</div>';
  updateReconReadiness();
  Storage.markDirty();
}

// ── SUMMARY CARDS ─────────────────────────────────────────────────
function renderReconSummaryCards(){
  const st=Reconcile.getStats(reconRows,grnOnlyRows,cycle?.carriedForward);
  const netDiff=st.invTotal-st.grnTotal;
  document.getElementById('recon-summary-cards').innerHTML=`
    <div class="rsc rsc-action" onclick="filterSection('ACTION')" title="Needs Action">
      <div class="rsc-num">${st.needsAction}</div><div class="rsc-lbl">⚠ Needs Action</div>
      <div class="rsc-amt">${fmtINR(reconRows.filter(r=>Reconcile.needsAction(r)).reduce((s,r)=>s+(r.invAmount||0),0))}</div>
    </div>
    <div class="rsc rsc-matched" onclick="filterSection('MATCHED')" title="Matched">
      <div class="rsc-num">${st.matched}</div><div class="rsc-lbl">✅ Matched</div>
      <div class="rsc-amt">${fmtINR(reconRows.filter(r=>r.status==='MATCHED'&&!r.resolution).reduce((s,r)=>s+(r.invAmount||0),0))}</div>
    </div>
    <div class="rsc rsc-resolved" onclick="filterSection('RESOLVED')" title="Resolved">
      <div class="rsc-num">${st.accepted+st.disputed+st.creditNote+st.excluded}</div><div class="rsc-lbl">🔵 Resolved</div>
    </div>
    <div class="rsc rsc-grnonly" onclick="filterSection('GRN_ONLY')" title="GRN Only">
      <div class="rsc-num">${st.grnOnly}</div><div class="rsc-lbl">📋 GRN Only</div>
    </div>
    <div class="rsc rsc-total" title="Totals">
      <div class="rsc-num">${fmtINR(st.invTotal)}</div><div class="rsc-lbl">Invoice Total</div>
      <div class="rsc-amt" style="color:${Math.abs(netDiff)>100?'#c81e1e':'#057a55'}">GRN: ${fmtINR(st.grnTotal)} · Diff: ${netDiff>=0?'+':''}${fmtINR(netDiff)}</div>
    </div>`;
}

function filterSection(key){
  document.getElementById('recon-filter').value=key;
  renderReconList();
}

// ── VIRTUAL LIST (master-detail left panel) ───────────────────────
function buildVLSections(){
  const q=(document.getElementById('recon-search')?.value||'').toLowerCase();
  const filt=document.getElementById('recon-filter')?.value||'';
  const unresolvedOnly=document.getElementById('recon-unresolved-only')?.checked;

  const filter=r=>{
    if(unresolvedOnly&&['ACCEPTED','EXCLUDED'].includes(r.resolution)) return false;
    if(q&&!JSON.stringify(r).toLowerCase().includes(q)) return false;
    if(!filt) return true;
    if(filt==='ACTION')   return Reconcile.needsAction(r);
    if(filt==='RESOLVED') return ['ACCEPTED','DISPUTED','CREDIT_NOTE','EXCLUDED'].includes(r.resolution);
    if(filt==='GRN_ONLY') return false; // handled separately
    return r.status===filt;
  };

  vlSections=[];

  // Needs Action (DISCREPANCY + PARTIAL + UNMATCHED, unresolved)
  const action=reconRows.filter(r=>Reconcile.needsAction(r)&&filter(r));
  if(action.length||filt===''||filt==='ACTION')
    vlSections.push({key:'action',label:`⚠ Needs Action`,cls:'shr-attention',items:action,collapsed:reconSectionState.action===false});

  // Matched
  const matched=reconRows.filter(r=>r.status==='MATCHED'&&!r.resolution&&filter(r));
  if(matched.length||filt==='MATCHED')
    vlSections.push({key:'matched',label:'✅ Matched',cls:'shr-matched',items:matched,collapsed:reconSectionState.matched!==false});

  // Resolved
  const resolved=reconRows.filter(r=>['ACCEPTED','DISPUTED','CREDIT_NOTE','EXCLUDED'].includes(r.resolution)&&filter(r));
  if(resolved.length||filt==='RESOLVED')
    vlSections.push({key:'resolved',label:'🔵 Resolved',cls:'shr-resolved',items:resolved,collapsed:reconSectionState.resolved!==false});

  // GRN Only
  const grnOnly=grnOnlyRows.filter(g=>{
    if(q&&!JSON.stringify(g).toLowerCase().includes(q)) return false;
    return filt===''||filt==='GRN_ONLY';
  });
  if(grnOnly.length||filt==='GRN_ONLY')
    vlSections.push({key:'grnonly',label:'📋 GRN Only',cls:'shr-grnonly',items:grnOnly.map(g=>({...g,_isGrnOnly:true})),collapsed:reconSectionState.grnonly!==false});

  // Carried forward
  const carried=(cycle?.carriedForward||[]).filter(c=>{
    if(q&&!JSON.stringify(c).toLowerCase().includes(q)) return false;
    return filt===''||filt==='ACTION';
  });
  if(carried.length)
    vlSections.push({key:'carried',label:'📦 Carried Forward',cls:'shr-carried',items:carried.map(c=>({...c.originalRow,_isCarried:true,_carryFrom:c.fromCycle})),collapsed:reconSectionState.carried!==false});
}

function renderReconList(){
  buildVLSections();
  const container=document.getElementById('recon-sections');
  if(!container) return;
  let html='';
  for(const sec of vlSections){
    const collapsed=sec.collapsed;
    html+=`<div class="recon-section-hdr ${sec.cls}${collapsed?' collapsed':''}" onclick="toggleSection('${sec.key}')">
      <span>${sec.label}</span>
      <span class="count">${sec.items.length}</span>
      <span class="chevron">▾</span>
    </div>`;
    if(!collapsed){
      // render up to 50 items per section (performance guard; full virtual scroll TODO for 1000+)
      const visible=sec.items.slice(0,200);
      for(const r of visible){
        const isGrnOnly=r._isGrnOnly, isCarried=r._isCarried;
        const key=r.invoiceKey||r._id||'';
        const active=key===selectedReconKey;
        const statusKey=r.resolution||r.status;
        const dotCls=`sd-${isGrnOnly?'GRN_ONLY':r.resolution?r.resolution:r.status}`;
        const diff=r.amountDiff;
        const diffStr=diff!==undefined&&diff!==0?(diff>0?`+${fmtINR(diff)}`:fmtINR(diff)):'';
        const diffCls=diff>0?'neg':diff<0?'pos':'';
        html+=`<div class="recon-card${active?' active':''}" onclick="selectReconRow(${JSON.stringify(key).replace(/"/g,'&quot;')},${isGrnOnly?'true':'false'})">
          <div class="rc-card-row">
            <div class="rc-status-dot ${dotCls}"></div>
            <div style="flex:1;min-width:0">
              <div class="rc-vendor">${esc(r.invVendor||r.supplier||'—')}</div>
              <div class="rc-meta">
                <span>${esc(r.invInvoice||r.invoiceNo||'—')}</span>
                <span>${fmtINR(r.invAmount||r.amount||0)}</span>
                ${isGrnOnly?'<span style="color:#3b82f6">GRN only</span>':''}
                ${isCarried?`<span style="color:#92400e">from ${esc(r._carryFrom)}</span>`:''}
                ${r.grnEntries?.length>1?`<span>${r.grnEntries.length} GRNs</span>`:''}
                ${r.resolution?`<span class="res-badge res-${r.resolution}" style="font-size:9px">${r.resolution}</span>`:''}
                ${r.previousStatus?`<span class="status-changed-badge">changed</span>`:''}
              </div>
              ${diffStr?`<div class="rc-diff ${diffCls}">${diffStr}</div>`:''}
            </div>
          </div>
        </div>`;
      }
      if(sec.items.length>200){
        html+=`<div style="padding:8px 12px;font-size:11px;color:#9ca3af">+ ${sec.items.length-200} more — use search to narrow</div>`;
      }
    }
  }
  container.innerHTML=html||'<div style="padding:2rem;text-align:center;color:#9ca3af;font-size:13px">No items match filters</div>';
}

function toggleSection(key){
  const sec=vlSections.find(s=>s.key===key);
  if(sec) sec.collapsed=!sec.collapsed;
  reconSectionState[key]=!sec?.collapsed;
  renderReconList();
}

// ── DETAIL PANEL ──────────────────────────────────────────────────
function selectReconRow(key, isGrnOnly){
  selectedReconKey=key;
  renderReconList(); // re-render to update active state
  if(isGrnOnly){
    const r=grnOnlyRows.find(g=>g._id===key);
    renderGrnOnlyDetail(r); return;
  }
  const r=reconRows.find(r=>r.invoiceKey===key);
  if(r) renderReconDetail(r);
}

function renderGrnOnlyDetail(g){
  if(!g){document.getElementById('recon-detail-panel').innerHTML='<div class="recon-right-empty">Not found</div>';return;}
  const panel=document.getElementById('recon-detail-panel');
  panel.innerHTML=`
    <div class="recon-detail-head">
      <h3>📋 GRN Only</h3>
      <span class="badge badge-manual">No Invoice</span>
    </div>
    <div class="recon-detail-body">
      <div class="detail-section">
        <div class="detail-section-title">GRN Details</div>
        <div class="detail-kv">
          <span class="detail-k">Supplier</span><span class="detail-v">${esc(g.supplier||'—')}</span>
          <span class="detail-k">Invoice No</span><span class="detail-v">${esc(g.invoiceNo||'—')}</span>
          <span class="detail-k">GRN No</span><span class="detail-v">${esc(g.grnNo||'—')}</span>
          <span class="detail-k">GRN Date</span><span class="detail-v">${esc(g.grnDate||'—')}</span>
          <span class="detail-k">Amount</span><span class="detail-v" style="font-weight:700">${fmtINR(g.amount||0)}</span>
          <span class="detail-k">Type</span><span class="detail-v">${esc(g.grnType||'—')}</span>
          <span class="detail-k">Location</span><span class="detail-v">${esc(g.location||'—')}</span>
        </div>
      </div>
      <div class="resolution-panel">
        <div class="detail-section-title">Resolution</div>
        <div class="resolution-btns">
          <button class="res-btn res-btn-exclude ${g.resolution==='EXCLUDED'?'active':''}" onclick="resolveGrnOnly(${JSON.stringify(g._id||'').replace(/"/g,"'")}, 'EXCLUDED')">⊘ Exclude</button>
          <button class="res-btn res-btn-clear ${!g.resolution?'active':''}" onclick="resolveGrnOnly(${JSON.stringify(g._id||'').replace(/"/g,"'")}, null)">✕ Clear</button>
        </div>
        <textarea class="resolution-note-input" placeholder="Notes (optional)…" onblur="saveGrnOnlyNote(${JSON.stringify(g._id||'').replace(/"/g,"'")} ,this.value)">${esc(g.resolutionNote||'')}</textarea>
      </div>
    </div>`;
}

function renderReconDetail(r){
  if(!r){document.getElementById('recon-detail-panel').innerHTML='<div class="recon-right-empty">Not found</div>';return;}
  const panel=document.getElementById('recon-detail-panel');
  const statusColors={MATCHED:'#057a55',DISCREPANCY:'#c81e1e',PARTIAL:'#d97706',UNMATCHED:'#6b7280'};
  const sc=statusColors[r.status]||'#6b7280';
  const diff=r.amountDiff||0;
  const diffCls=Math.abs(diff)<=100?'diff-ok':Math.abs(diff)<=500?'diff-warn':'diff-bad';
  const canViewPage=PDFViewer.isLoaded()&&r.page&&r.sourcePdf===activePdfName;

  let grnTableHTML='<div style="color:#9ca3af;font-size:12px">No GRN entries matched</div>';
  if(r.grnEntries&&r.grnEntries.length){
    grnTableHTML=`<table class="grn-entries-table">
      <thead><tr><th>GRN No</th><th>Date</th><th style="text-align:right">Amount</th><th>Location</th><th>Type</th></tr></thead>
      <tbody>
        ${r.grnEntries.map(g=>`<tr><td>${esc(g.grnNo||'—')}</td><td>${esc(g.grnDate||'—')}</td><td style="text-align:right">${fmtINR(g.amount)}</td><td title="${esc(g.location||'')}">${esc((g.location||'').slice(0,20))}</td><td>${esc(g.grnType||'—')}</td></tr>`).join('')}
        <tr class="grn-total-row"><td colspan="2">GRN Total</td><td style="text-align:right">${fmtINR(r.grnTotal||0)}</td><td colspan="2"></td></tr>
        <tr class="grn-total-row"><td colspan="2">Invoice</td><td style="text-align:right">${fmtINR(r.invAmount||0)}</td><td colspan="2"></td></tr>
        <tr class="grn-diff-row"><td colspan="2">Difference</td><td style="text-align:right" class="${diffCls}">${diff>0?'+':''}${fmtINR(diff)}</td>
          <td colspan="2" class="${diffCls}">${Math.abs(diff)<=100?'✓ Within tolerance':Math.abs(diff)<=500?'⚠ Minor diff':'❌ Significant'}</td></tr>
      </tbody></table>`;
  }

  const resHistHTML=r.previousStatus?`<div class="resolution-history">⚡ Status changed: <strong>${r.previousStatus}</strong> → <strong>${r.status}</strong>${r.statusChangedAt?' on '+new Date(r.statusChangedAt).toLocaleDateString('en-IN'):''}</div>`:'';
  const currentRes=r.resolution;

  panel.innerHTML=`
    <div class="recon-detail-head">
      <h3 style="color:${sc}">${r.status==='MATCHED'?'✅':r.status==='DISCREPANCY'?'⚠':r.status==='PARTIAL'?'🔶':'❌'} ${r.status}</h3>
      ${r.resolution?`<span class="res-badge res-${r.resolution}">${r.resolution.replace('_',' ')}</span>`:''}
      ${r.matchBy?`<span style="font-size:10px;color:#9ca3af">matched by: ${esc(r.matchBy)}</span>`:''}
      <span style="flex:1"></span>
      ${canViewPage?`<button class="btn-sm btn-primary" onclick="curPage=${r.page};switchTab('viewer');renderViewer()">→ Page ${r.page}</button>`:''}
    </div>
    <div class="recon-detail-body">
      <div class="detail-section">
        <div class="detail-section-title">Invoice</div>
        <div class="detail-kv">
          <span class="detail-k">Vendor</span><span class="detail-v">${esc(r.invVendor||'—')}</span>
          <span class="detail-k">Invoice No</span><span class="detail-v">${esc(r.invInvoice||'—')}</span>
          <span class="detail-k">GSTIN</span><span class="detail-v" style="font-family:monospace;font-size:12px">${esc(r.invGstin||'—')}</span>
          <span class="detail-k">Amount</span><span class="detail-v" style="font-weight:700">${fmtINR(r.invAmount||0)}</span>
          <span class="detail-k">Date</span><span class="detail-v">${esc(r.invDate||'—')}</span>
          <span class="detail-k">Source</span><span class="detail-v" style="font-size:11px;color:#9ca3af">${esc(r.sourcePdf||'')} · pg ${r.page||'?'}</span>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">GRN Entries (${(r.grnEntries||[]).length})</div>
        ${grnTableHTML}
      </div>
      <div class="detail-section">
        <div class="detail-section-title">CA Resolution</div>
        <div class="resolution-panel">
          <div class="resolution-btns">
            <button class="res-btn res-btn-accept ${currentRes==='ACCEPTED'?'active':''}" onclick="resolveRow(${JSON.stringify(r.invoiceKey||'').replace(/"/g,"'")}, 'ACCEPTED')">✓ Accept</button>
            <button class="res-btn res-btn-cn ${currentRes==='CREDIT_NOTE'?'active':''}" onclick="resolveRow(${JSON.stringify(r.invoiceKey||'').replace(/"/g,"'")}, 'CREDIT_NOTE')">📝 Credit Note</button>
            <button class="res-btn res-btn-dispute ${currentRes==='DISPUTED'?'active':''}" onclick="resolveRow(${JSON.stringify(r.invoiceKey||'').replace(/"/g,"'")}, 'DISPUTED')">🚩 Dispute</button>
            <button class="res-btn res-btn-exclude ${currentRes==='EXCLUDED'?'active':''}" onclick="resolveRow(${JSON.stringify(r.invoiceKey||'').replace(/"/g,"'")}, 'EXCLUDED')">⊘ Exclude</button>
            ${currentRes?`<button class="res-btn res-btn-clear" onclick="resolveRow(${JSON.stringify(r.invoiceKey||'').replace(/"/g,"'")}, null)">✕ Clear</button>`:''}
          </div>
          <textarea class="resolution-note-input" placeholder="Notes (e.g. Rounding diff, Credit note pending, Under investigation)…"
            onblur="saveReconNote(${JSON.stringify(r.invoiceKey||'').replace(/"/g,"'")}, this.value)">${esc(r.resolutionNote||'')}</textarea>
          ${resHistHTML}
          ${r.resolvedAt?`<div style="font-size:10px;color:#9ca3af;margin-top:4px">Resolved: ${new Date(r.resolvedAt).toLocaleDateString('en-IN')}</div>`:''}
        </div>
      </div>
    </div>`;
}

// ── RESOLUTION ACTIONS ────────────────────────────────────────────
function resolveRow(key, resolution) {
  const r=reconRows.find(r=>r.invoiceKey===key);
  if(!r) return;
  r.resolution   = resolution;
  r.resolvedAt   = resolution ? new Date().toISOString() : null;
  cycle.reconRows=reconRows;
  Storage.markDirty();
  renderReconDetail(r); buildVLSections(); renderReconList(); renderReconSummaryCards();
}

function saveReconNote(key, note) {
  const r=reconRows.find(r=>r.invoiceKey===key);
  if(!r) return;
  r.resolutionNote=note;
  cycle.reconRows=reconRows;
  Storage.markDirty();
}

function resolveGrnOnly(id, resolution) {
  const g=grnOnlyRows.find(g=>g._id===id);
  if(!g) return;
  g.resolution=resolution; g.resolvedAt=resolution?new Date().toISOString():null;
  cycle.grnOnlyRows=grnOnlyRows;
  Storage.markDirty(); renderGrnOnlyDetail(g); renderReconList();
}

function saveGrnOnlyNote(id, note) {
  const g=grnOnlyRows.find(g=>g._id===id);
  if(!g) return;
  g.resolutionNote=note; cycle.grnOnlyRows=grnOnlyRows; Storage.markDirty();
}

// ── CARRY FORWARD VIEW ────────────────────────────────────────────
function viewCarriedItems() {
  document.getElementById('recon-filter').value='ACTION';
  renderReconList();
  document.getElementById('recon-results').style.display='block';
  document.getElementById('pane-grn').scrollIntoView({behavior:'smooth'});
}

// ── CREDIT NOTES ──────────────────────────────────────────────────
function addCreditNote() {
  const f=document.getElementById('cn-add-form');
  f.style.display=f.style.display==='none'?'block':'none';
}

function saveCreditNote() {
  if(!cycle) cycle=Storage.newCycle();
  if(!cycle.creditNotes) cycle.creditNotes=[];
  const cn={
    id:'cn_'+Date.now(),
    vendor:   document.getElementById('cn-vendor').value.trim(),
    cnNumber: document.getElementById('cn-number').value.trim(),
    amount:   parseFloat(document.getElementById('cn-amount').value)||0,
    date:     document.getElementById('cn-date').value.trim(),
    againstInvoice: document.getElementById('cn-invoice').value.trim(),
    note: '', addedAt: new Date().toISOString()
  };
  if(!cn.vendor&&!cn.cnNumber){alert('Enter at least vendor name or CN number.');return;}
  cycle.creditNotes.push(cn);
  ['cn-vendor','cn-number','cn-amount','cn-date','cn-invoice'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('cn-add-form').style.display='none';
  Storage.markDirty(); renderCNList();
}

function deleteCreditNote(id) {
  if(!cycle?.creditNotes) return;
  cycle.creditNotes=cycle.creditNotes.filter(c=>c.id!==id);
  Storage.markDirty(); renderCNList();
}

function renderCNList() {
  const cns=cycle?.creditNotes||[];
  const el=document.getElementById('cn-list');
  if(!el) return;
  if(!cns.length){el.innerHTML='<div class="empty-state">No credit notes recorded.</div>';return;}
  el.innerHTML=`<table class="cn-table"><thead><tr><th>CN No</th><th>Vendor</th><th>Amount</th><th>Date</th><th>Against Invoice</th><th></th></tr></thead><tbody>
    ${cns.map(c=>`<tr>
      <td>${esc(c.cnNumber||'—')}</td>
      <td>${esc(c.vendor||'—')}</td>
      <td style="font-weight:600">${fmtINR(c.amount)}</td>
      <td>${esc(c.date||'—')}</td>
      <td>${esc(c.againstInvoice||'—')}</td>
      <td><button class="btn-sm btn-danger-outline" onclick="deleteCreditNote('${c.id}')">✕</button></td>
    </tr>`).join('')}
  </tbody></table>`;
}

// ── INVOICE EXCEL EXPORT ──────────────────────────────────────────
function exportInvoicesExcel(){
  const wb=XLSX.utils.book_new();
  const all=sortedPageKeys().map(k=>cycle.pages[k]);
  const ws1=XLSX.utils.json_to_sheet(all.map(r=>({
    'Page':r.page,'Source PDF':r.sourcePdf||'','Vendor Name':r.vendor,
    'Invoice Number':r.invoice,'GSTIN':r.gstin,
    'Invoice Date':r.invoiceDate||'','Total Amount (₹)':r.amount?parseFloat(r.amount):'',
    'Confidence':r.confidence||'','Status':r.status==='ok'?'Extracted':r.status==='manual'?'Manual':'Error/Review',
    'API Cost (USD)':r.cost?parseFloat(r.cost.toFixed(6)):''
  })));
  ws1['!cols']=[6,20,35,20,20,14,18,12,16,12].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb,ws1,'Extracted Invoices');
  XLSX.writeFile(wb,`invoices_${(cycle?.cycleLabel||'').replace(/[^a-z0-9]/gi,'_')}_${new Date().toISOString().slice(0,10)}.xlsx`);
}

// ── TABS ──────────────────────────────────────────────────────────
function switchTab(tab){
  activeTab=tab;
  ['viewer','review','table','grn'].forEach(t=>{
    document.getElementById('pane-'+t).style.display=t===tab?'block':'none';
    const btn=document.getElementById('tab-'+t);if(btn) btn.classList.toggle('active',t===tab);
  });
  if(tab==='table')  renderTable();
  if(tab==='review') renderReviewQueue();
  if(tab==='grn')    { renderGRNFileList(); renderCNList(); if(reconRows.length) renderReconSummaryCards(); }
}

// ── SETTINGS ──────────────────────────────────────────────────────
let _credModeSetting='vision';
function openSettings(){
  _credModeSetting=credMode;
  document.getElementById('settings-modal').style.display='flex';
  document.getElementById('vision-key-input').value=visionApiKey||'';
  document.getElementById('claude-key-input').value=claudeApiKey||'';
  setCredMode(credMode);
  if(serviceAccountJson){
    document.getElementById('sa-status').innerHTML=`✅ <strong>${serviceAccountJson.client_email}</strong>`;
    document.getElementById('sa-status').style.color='#057a55';
    document.getElementById('sa-dropzone').style.borderColor='#6ee7b7';
    document.getElementById('sa-info').style.display='block';
    document.getElementById('sa-info').textContent=`Project: ${serviceAccountJson.project_id} · ${serviceAccountJson.client_email}`;
  }
}
function closeSettings(){ document.getElementById('settings-modal').style.display='none'; }
function setCredMode(mode){
  _credModeSetting=mode;
  document.getElementById('vision-inputs').style.display=mode==='vision'?'block':'none';
  document.getElementById('claude-inputs').style.display=mode==='claude'?'block':'none';
  document.getElementById('mode-vision-btn').className='mode-btn'+(mode==='vision'?' active':'');
  document.getElementById('mode-claude-btn').className='mode-btn'+(mode==='claude'?' active':'');
}
async function loadSAFile(file){
  if(!file) return;
  try{
    const p=JSON.parse(await file.text());
    if(!p.private_key||!p.client_email) throw new Error('Missing private_key or client_email');
    serviceAccountJson=p;
    document.getElementById('sa-status').innerHTML=`✅ <strong>${p.client_email}</strong>`;
    document.getElementById('sa-status').style.color='#057a55';
    document.getElementById('sa-dropzone').style.borderColor='#6ee7b7';
    document.getElementById('sa-info').style.display='block';
    document.getElementById('sa-info').textContent=`Project: ${p.project_id} · ${p.client_email}`;
  }catch(e){ document.getElementById('test-result').innerHTML=`<div class="alert alert-error">Error: ${esc(e.message)}</div>`; }
}
function saveSettings(){
  credMode=_credModeSetting; visionApiKey=document.getElementById('vision-key-input').value.trim();
  claudeApiKey=document.getElementById('claude-key-input').value.trim();
  Extractor.setCredentials(credMode,visionApiKey,serviceAccountJson,claudeApiKey);
  Storage.saveCreds({mode:credMode,visionKey:visionApiKey,saJson:serviceAccountJson?JSON.stringify(serviceAccountJson):null,claudeKey:claudeApiKey});
  updateCredStatus(); closeSettings();
}
async function testConnection(){
  const mode=_credModeSetting,vKey=document.getElementById('vision-key-input').value.trim(),saJ=serviceAccountJson,cKey=document.getElementById('claude-key-input').value.trim();
  document.getElementById('test-spinner').style.display='inline-block';
  document.getElementById('test-result').innerHTML='';
  const steps=await Extractor.testConnection(mode,vKey,saJ,cKey);
  const allOk=steps.every(s=>s.ok);
  document.getElementById('test-result').innerHTML=`<div style="padding:12px;background:${allOk?'#ecfdf5':'#fef2f2'};border:1px solid ${allOk?'#6ee7b7':'#fca5a5'};border-radius:8px">
    <div style="font-size:12px;font-weight:600;color:${allOk?'#064e3b':'#7f1d1d'};margin-bottom:8px">${allOk?'✅ All checks passed!':'❌ Connection failed'}</div>
    ${steps.map(s=>`<div class="test-step"><span class="test-icon">${s.ok?'✅':'❌'}</span><div><div style="font-weight:500;color:${s.ok?'#065f46':'#991b1b'}">${s.label}</div>${s.detail?`<div class="test-detail">${s.detail}</div>`:''}</div></div>`).join('')}
  </div>`;
  document.getElementById('test-spinner').style.display='none';
}

// ── ZOOM ──────────────────────────────────────────────────────────
async function openZoom(){ if(!PDFViewer.isLoaded()) return; document.getElementById('zoom-overlay').style.display='flex'; zoomLevel=1;zoomPanX=0;zoomPanY=0;applyZoom(); await PDFViewer.renderZoomCanvas(curPage); }
function closeZoom(){ document.getElementById('zoom-overlay').style.display='none'; }
function adjZoom(d){ zoomLevel=Math.min(8,Math.max(.4,zoomLevel+d)); applyZoom(); }
function resetZoom(){ zoomLevel=1;zoomPanX=0;zoomPanY=0;applyZoom(); }
function applyZoom(){ document.getElementById('zoom-pct').textContent=Math.round(zoomLevel*100)+'%'; document.getElementById('zoom-img-wrap').style.transform=`translate(${zoomPanX}px,${zoomPanY}px) scale(${zoomLevel})`; }
function zoomWheel(e){ e.preventDefault(); zoomLevel=Math.min(8,Math.max(.4,zoomLevel-e.deltaY*.001)); applyZoom(); }
function zoomDragStart(e){ zoomDragging=true;zoomDX=e.clientX-zoomPanX;zoomDY=e.clientY-zoomPanY;document.getElementById('zoom-img-wrap').classList.add('dragging'); }
function zoomDragMove(e){ if(!zoomDragging) return;zoomPanX=e.clientX-zoomDX;zoomPanY=e.clientY-zoomDY;applyZoom(); }
function zoomDragEnd(){ zoomDragging=false;document.getElementById('zoom-img-wrap').classList.remove('dragging'); }
document.getElementById('zoom-overlay').addEventListener('wheel',zoomWheel,{passive:false});

// ── CONFIRM MODAL ─────────────────────────────────────────────────
function showConfirm(title,msg,onOk){ document.getElementById('confirm-title').textContent=title;document.getElementById('confirm-msg').textContent=msg;_confirmOkFn=onOk;document.getElementById('confirm-modal').style.display='flex'; }
function confirmOK(){ document.getElementById('confirm-modal').style.display='none';if(_confirmOkFn)_confirmOkFn(); }
function confirmCancel(){ document.getElementById('confirm-modal').style.display='none'; }
function confirmExportInvoices(){ const n=Object.values(cycle?.pages||{}).filter(r=>r.status==='ok'||r.status==='manual').length;showConfirm('Export invoices to Excel?',`${n} invoices ready.`,exportInvoicesExcel); }
function confirmExportRecon(){ showConfirm('Export reconciliation to Excel?','Creates 7 sheets: Summary · Needs Action · All Transactions · GRN Only · Resolved · Credit Notes · Carry Forward',()=>{confirmCancel();Reconcile.exportExcel(cycle);}); }

// ═══════════════════════════════════════════════════════════════════
// SUPPLIER AUDIT TAB
// ═══════════════════════════════════════════════════════════════════

let _supplierStats = [];   // cached supplier stats array
let _selectedSupplier = null;

function renderSupplierAudit() {
  const emptyEl    = document.getElementById('supplier-empty');
  const insightsEl = document.getElementById('supplier-insights');
  const tableWrap  = document.getElementById('supplier-table-wrap');

  if (!reconRows.length) {
    emptyEl.style.display    = 'block';
    insightsEl.style.display = 'none';
    tableWrap.style.display  = 'none';
    return;
  }

  _supplierStats = Reconcile.getSupplierStats(reconRows, grnOnlyRows);

  const totalSuppliers      = _supplierStats.length;
  const suppliersWithIssues = _supplierStats.filter(s => s.actionCount > 0).length;
  document.getElementById('supplier-audit-sub').textContent =
    `${totalSuppliers} suppliers · ${suppliersWithIssues} with issues · click a row for details`;

  emptyEl.style.display   = 'none';
  tableWrap.style.display = 'block';

  _renderSupplierTableBody(_supplierStats);

  // restore selected supplier if still valid
  if (_selectedSupplier && _supplierStats.find(s => s.vendor === _selectedSupplier)) {
    showSupplierInsights(_selectedSupplier);
  }
}

function _renderSupplierTableBody(list) {
  const tbody = document.getElementById('supplier-table-body');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state" style="text-align:center;padding:20px">No suppliers match.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(s => {
    const diffAbs = Math.abs(s.netDiff);
    const diffCls = diffAbs === 0 ? 'diff-ok' : s.netDiff > 0 ? 'diff-warn' : 'diff-bad';
    const diffStr = diffAbs === 0 ? '✓ Balanced' : (s.netDiff > 0 ? '+' : '') + fmtINR(s.netDiff);
    let statusHtml;
    if (s.actionCount > 0) {
      statusHtml = `<span class="sup-chip sup-chip-disc" style="font-size:10px">⚠ ${s.actionCount} issue${s.actionCount>1?'s':''}</span>`;
    } else if (s.invoiceCount > 0 && diffAbs === 0) {
      statusHtml = `<span class="sup-chip sup-chip-matched" style="font-size:10px">✅ Clear</span>`;
    } else {
      statusHtml = `<span class="sup-chip sup-chip-resolved" style="font-size:10px">✓ Resolved</span>`;
    }
    const isSelected = _selectedSupplier === s.vendor;
    return `<tr class="sup-tbl-row${isSelected ? ' sup-tbl-selected' : ''}"
              data-vendor="${esc(s.vendor)}"
              onclick="showSupplierInsights(this.dataset.vendor)"
              title="Click to view details for ${esc(s.vendor)}">
      <td class="sup-tbl-name">${esc(s.vendor)}</td>
      <td style="text-align:center">${s.invoiceCount}</td>
      <td style="text-align:right;font-weight:600">${fmtINR(s.invoiceTotal)}</td>
      <td style="text-align:right">${fmtINR(s.grnTotal)}</td>
      <td style="text-align:right" class="${diffCls}">${diffStr}</td>
      <td style="text-align:center">${statusHtml}</td>
    </tr>`;
  }).join('');
}

function filterSupplierTable(q) {
  const lq = (q || '').toLowerCase();
  if (!_supplierStats) return;
  const filtered = lq ? _supplierStats.filter(s => s.vendor.toLowerCase().includes(lq)) : _supplierStats;
  _renderSupplierTableBody(filtered);
}

function showSupplierInsights(vendorName) {
  const insightsEl = document.getElementById('supplier-insights');
  if (!vendorName) { insightsEl.style.display = 'none'; return; }

  const s = _supplierStats.find(x => x.vendor === vendorName);
  if (!s) { insightsEl.style.display = 'none'; return; }

  _selectedSupplier = vendorName;
  insightsEl.style.display = 'block';

  // set detail header title
  const titleEl = document.getElementById('sup-detail-title');
  if (titleEl) titleEl.textContent = vendorName;

  // highlight selected row in summary table
  document.querySelectorAll('.sup-tbl-row').forEach(tr => {
    tr.classList.toggle('sup-tbl-selected', tr.querySelector('.sup-tbl-name')?.textContent === vendorName);
  });

  // scroll insights into view
  insightsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const diffAbs   = Math.abs(s.netDiff);
  const matchStr  = Extractor.matchToMaster(vendorName);
  const grnOnly   = (grnOnlyRows || []).filter(g => (g.supplier || 'Unknown') === vendorName);

  // ── KPI bar ──────────────────────────────────────────────────────
  const balCls = diffAbs === 0 ? 'sup-kpi-ok' : s.netDiff > 0 ? 'sup-kpi-warn' : 'sup-kpi-bad';
  const balLbl = diffAbs === 0 ? 'Balanced' : s.netDiff > 0 ? 'Inv > GRN' : 'GRN > Inv';
  const matchPct = s.invoiceCount > 0 ? Math.round(s.matchedCount / s.invoiceCount * 100) : 0;

  document.getElementById('sup-kpis').innerHTML = `
    <div class="sup-kpi-card">
      <div class="sup-kpi-num">${s.invoiceCount}</div>
      <div class="sup-kpi-lbl">Invoices</div>
    </div>
    <div class="sup-kpi-card">
      <div class="sup-kpi-num">${fmtINR(s.invoiceTotal)}</div>
      <div class="sup-kpi-lbl">Invoice Total</div>
    </div>
    <div class="sup-kpi-card">
      <div class="sup-kpi-num">${fmtINR(s.grnTotal)}</div>
      <div class="sup-kpi-lbl">GRN Total</div>
    </div>
    <div class="sup-kpi-card ${balCls}">
      <div class="sup-kpi-num">${diffAbs === 0 ? '✓ 0' : (s.netDiff > 0 ? '+' : '') + fmtINR(s.netDiff)}</div>
      <div class="sup-kpi-lbl">${balLbl}</div>
    </div>
    <div class="sup-kpi-card">
      <div class="sup-kpi-num">${matchPct}%</div>
      <div class="sup-kpi-lbl">Match Rate</div>
    </div>`;

  // ── Action guidance ───────────────────────────────────────────────
  const actions = [];
  if (s.discrepancyCount > 0)
    actions.push({ cls:'sup-action-disc',   icon:'❌', text:`GRN exceeds invoice on <strong>${s.discrepancyCount}</strong> bill${s.discrepancyCount>1?'s':''}. <strong>Request invoice from vendor</strong> for the excess amount.` });
  if (s.partialCount > 0)
    actions.push({ cls:'sup-action-partial', icon:'⚠', text:`GRN is short on <strong>${s.partialCount}</strong> bill${s.partialCount>1?'s':''}. <strong>Create GRNs</strong> to cover the remaining balance and clear the pending bills.` });
  if (s.unmatchedCount > 0)
    actions.push({ cls:'sup-action-unmatched', icon:'◎', text:`<strong>${s.unmatchedCount}</strong> invoice${s.unmatchedCount>1?'s have':' has'} no matching GRN. <strong>Create GRNs</strong> to clear these bills.` });
  if (grnOnly.length > 0)
    actions.push({ cls:'sup-action-disc', icon:'📦', text:`<strong>${grnOnly.length}</strong> GRN entr${grnOnly.length>1?'ies':'y'} received with no matching invoice. <strong>Request invoice from vendor.</strong>` });

  if (!actions.length) {
    document.getElementById('sup-action-box').innerHTML =
      `<div class="sup-action-ok">✅ All invoices matched — no action required for this supplier.</div>`;
  } else {
    document.getElementById('sup-action-box').innerHTML =
      `<div class="sup-action-list">${actions.map(a =>
        `<div class="sup-action-item ${a.cls}"><span class="sup-action-icon">${a.icon}</span><span>${a.text}</span></div>`
      ).join('')}</div>`;
  }

  // ── Breakdown chips ───────────────────────────────────────────────
  const chips = [];
  if (s.matchedCount)     chips.push(`<span class="sup-chip sup-chip-matched">✅ Matched: ${s.matchedCount}</span>`);
  if (s.partialCount)     chips.push(`<span class="sup-chip sup-chip-partial">⚠ GRN Short: ${s.partialCount}</span>`);
  if (s.discrepancyCount) chips.push(`<span class="sup-chip sup-chip-disc">❌ Excess GRN: ${s.discrepancyCount}</span>`);
  if (s.unmatchedCount)   chips.push(`<span class="sup-chip sup-chip-unmatched">◎ No GRN: ${s.unmatchedCount}</span>`);
  if (s.resolvedCount)    chips.push(`<span class="sup-chip sup-chip-resolved">✓ Resolved: ${s.resolvedCount}</span>`);
  if (grnOnly.length)     chips.push(`<span class="sup-chip sup-chip-disc">📦 GRN-only: ${grnOnly.length}</span>`);
  document.getElementById('sup-breakdown-chips').innerHTML = chips.join('');

  // ── Invoice lines table ───────────────────────────────────────────
  const rows = s.rows || [];
  const statusMeta = {
    MATCHED:     { label: '✅ Matched',      cls: 'si-matched',   action: '—' },
    PARTIAL:     { label: '⚠ GRN Short',    cls: 'si-partial',   action: 'Create GRN for balance' },
    DISCREPANCY: { label: '❌ Excess GRN',   cls: 'si-disc',      action: 'Request invoice from vendor' },
    UNMATCHED:   { label: '◎ No GRN',       cls: 'si-unmatched', action: 'Create GRN' },
  };

  document.getElementById('sup-invoice-table').innerHTML = `
    <div class="sup-section-title">Invoice Lines</div>
    <div class="tbl-wrap">
      <table class="sup-drilldown-table">
        <thead><tr>
          <th>Invoice No</th>
          <th>Date</th>
          <th style="text-align:right">Inv Amount</th>
          <th style="text-align:right">GRN Total</th>
          <th style="text-align:right">Difference</th>
          <th>Status</th>
          <th>Action Required</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => {
            const diff    = r.amountDiff || 0;
            const diffAbs = Math.abs(diff);
            const diffCls = diffAbs <= 100 ? 'diff-ok' : diffAbs <= 500 ? 'diff-warn' : 'diff-bad';
            let meta;
            if (r.resolution && ['ACCEPTED','EXCLUDED','DISPUTED','CREDIT_NOTE'].includes(r.resolution)) {
              meta = { label: `✓ Resolved (${r.resolution.replace('_',' ')})`, cls: 'si-resolved', action: '—' };
            } else {
              meta = statusMeta[r.status] || { label: r.status, cls: '', action: '—' };
            }
            return `<tr onclick="switchTab('grn');selectReconRow(${JSON.stringify(r.invoiceKey||'')},false)" title="Click to view in reconciliation tab">
              <td>${esc(r.invInvoice||'—')}</td>
              <td class="td-muted">${esc(r.invDate||'—')}</td>
              <td style="text-align:right;font-weight:600">${fmtINR(r.invAmount||0)}</td>
              <td style="text-align:right">${r.grnTotal ? fmtINR(r.grnTotal) : '—'}</td>
              <td style="text-align:right" class="${diffCls}">${diff !== 0 ? (diff > 0 ? '+' : '') + fmtINR(diff) : '✓'}</td>
              <td><span class="si-status ${meta.cls}">${meta.label}</span></td>
              <td class="si-action-hint">${meta.action}</td>
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr class="sup-tfoot">
            <td colspan="2">Total (${rows.length} invoice${rows.length!==1?'s':''})</td>
            <td style="text-align:right">${fmtINR(s.invoiceTotal)}</td>
            <td style="text-align:right">${fmtINR(s.grnTotal)}</td>
            <td style="text-align:right" class="${diffAbs===0?'diff-ok':diffAbs<=500?'diff-warn':'diff-bad'}">${diffAbs===0?'✓':(s.netDiff>0?'+':'')+fmtINR(s.netDiff)}</td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>`;

  // ── GRN-only section ──────────────────────────────────────────────
  if (grnOnly.length) {
    document.getElementById('sup-grn-only').innerHTML = `
      <div class="sup-section-title" style="margin-top:18px">GRN-Only Entries <span class="sup-section-note">(GRN received — no matching invoice found)</span></div>
      <div class="tbl-wrap">
        <table class="sup-drilldown-table">
          <thead><tr>
            <th>GRN Ref / Details</th>
            <th>Vendor (GRN)</th>
            <th style="text-align:right">Amount</th>
            <th>Action Required</th>
          </tr></thead>
          <tbody>
            ${grnOnly.map(g => `<tr>
              <td>${esc(g.invoice||g.ref||'—')}</td>
              <td>${esc(g.supplier||'—')}</td>
              <td style="text-align:right;font-weight:600">${fmtINR(g.amount||0)}</td>
              <td class="si-action-hint">Request invoice from vendor</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } else {
    document.getElementById('sup-grn-only').innerHTML = '';
  }

  // unrecognised vendor warning — replace each time, don't stack
  const existingWarn = document.getElementById('sup-unknown-warn');
  if (existingWarn) existingWarn.remove();
  if (!matchStr.isKnown) {
    document.getElementById('sup-kpis').insertAdjacentHTML('beforebegin',
      `<div id="sup-unknown-warn" class="alert alert-warn" style="margin-bottom:12px;font-size:12px">⚠ <strong>"${esc(vendorName)}"</strong> is not in the supplier master list — verify this vendor name is correct.</div>`);
  }
}

function openSupplierDrilldown(vendorName) {
  showSupplierInsights(vendorName);
}

function closeSupplierDrilldown() {
  document.getElementById('supplier-insights').style.display = 'none';
  _selectedSupplier = null;
  document.querySelectorAll('.sup-tbl-row').forEach(tr => tr.classList.remove('sup-tbl-selected'));
}


// hook into switchTab to auto-render supplier audit
const _origSwitchTab = switchTab;
// override switchTab to trigger supplier audit render
(function() {
  const orig = switchTab;
  window.switchTab = function(tab) {
    // add supplier to pane toggle list
    ['viewer','review','table','grn','supplier'].forEach(t => {
      const pane = document.getElementById('pane-'+t);
      if (pane) pane.style.display = t === tab ? 'block' : 'none';
      const btn = document.getElementById('tab-'+t);
      if (btn) btn.classList.toggle('active', t === tab);
    });
    if (tab === 'table')    renderTable();
    if (tab === 'review')   renderReviewQueue();
    if (tab === 'grn')      { renderGRNFileList(); renderCNList(); if (reconRows.length) renderReconSummaryCards(); }
    if (tab === 'supplier') renderSupplierAudit();
    activeTab = tab;
  };
})();
