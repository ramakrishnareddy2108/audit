// ═══════════════════════════════════════════════════════════════════
// pdf-viewer.js  —  PDF rendering via PDF.js (live, no stored images)
// ═══════════════════════════════════════════════════════════════════

const PDFViewer = (() => {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  let _pdfDoc     = null;
  let _rotations  = {};  // page -> degrees (0,90,180,270)
  let _renderTask = null;

  // ── load PDF from ArrayBuffer ──────────────────────────────────
  async function loadPDF(arrayBuffer) {
    _pdfDoc    = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    _rotations = {};
    return _pdfDoc.numPages;
  }

  function isLoaded() { return _pdfDoc !== null; }
  function unload()   { _pdfDoc = null; _rotations = {}; }

  // ── render page to a given <canvas> element ────────────────────
  async function renderToCanvas(pageNum, canvas, scale = 2.0) {
    if (!_pdfDoc) throw new Error('No PDF loaded');
    // cancel any running render
    if (_renderTask) { try { _renderTask.cancel(); } catch {} }

    const rot  = _rotations[pageNum] || 0;
    const page = await _pdfDoc.getPage(pageNum);
    const vp   = page.getViewport({ scale, rotation: rot });

    canvas.width  = vp.width;
    canvas.height = vp.height;

    _renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    await _renderTask.promise;
    _renderTask = null;
    return canvas;
  }

  // ── render page to base64 JPEG (for Vision API) ────────────────
  async function renderToBase64(pageNum, scale = 2.0) {
    if (!_pdfDoc) throw new Error('No PDF loaded');
    const rot  = _rotations[pageNum] || 0;
    const page = await _pdfDoc.getPage(pageNum);
    const vp   = page.getViewport({ scale, rotation: rot });

    const canvas     = document.createElement('canvas');
    canvas.width     = vp.width;
    canvas.height    = vp.height;
    const renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    await renderTask.promise;
    return canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
  }

  // ── rotate page by delta degrees ──────────────────────────────
  function rotate(pageNum, deltaDeg) {
    const cur       = _rotations[pageNum] || 0;
    _rotations[pageNum] = (cur + deltaDeg + 360) % 360;
  }

  function getRotation(pageNum) { return _rotations[pageNum] || 0; }

  // ── render page into the main viewer canvas ───────────────────
  async function renderMainCanvas(pageNum) {
    const canvas = document.getElementById('page-canvas');
    const ph     = document.getElementById('img-placeholder');
    if (!_pdfDoc) {
      canvas.style.display = 'none';
      ph.style.display     = 'block';
      ph.innerHTML         = '<div style="font-size:36px;margin-bottom:8px">📄</div><div>Load PDF to view pages</div>';
      return;
    }
    try {
      canvas.style.display = 'block';
      ph.style.display     = 'none';
      await renderToCanvas(pageNum, canvas);
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      canvas.style.display = 'none';
      ph.style.display     = 'block';
      ph.textContent       = 'Error rendering page ' + pageNum;
    }
  }

  // ── render page into the zoom overlay canvas ──────────────────
  async function renderZoomCanvas(pageNum) {
    const canvas = document.getElementById('zoom-canvas');
    if (!_pdfDoc) return;
    await renderToCanvas(pageNum, canvas, 3.0);
  }

  return {
    loadPDF, isLoaded, unload,
    renderToCanvas, renderToBase64,
    rotate, getRotation,
    renderMainCanvas, renderZoomCanvas
  };
})();
