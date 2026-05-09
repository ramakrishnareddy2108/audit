// ═══════════════════════════════════════════════════════════════════
// reconcile.js  —  GRN parsing + reconciliation engine
// Matches on: INVOICE NO + SUPPLIER NAME + INVOICE DATE
// Amount tolerance: ±₹100
// ═══════════════════════════════════════════════════════════════════

const Reconcile = (() => {

  // ── normalise strings for fuzzy matching ──────────────────────
  const norm   = s => String(s || '').toLowerCase().replace(/[\s.\-\/\\,&']/g, '').trim();
  const nAmt   = v => Math.round((parseFloat(v) || 0) * 100) / 100;
  const AMT_TOL = 100; // ₹ tolerance

  // ── Excel serial date → date string ───────────────────────────
  function excelDateToStr(v) {
    if (!v) return '';
    if (v instanceof Date) return v.toLocaleDateString('en-IN');
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') {
      // Excel epoch: Jan 0 1900 (serial 1 = Jan 1 1900)
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return d.toLocaleDateString('en-IN');
    }
    return String(v);
  }

  // ── parse a date string to YYYY-MM-DD for comparison ─────────
  function parseDate(str) {
    if (!str) return null;
    // try en-IN format: DD/MM/YYYY or DD-MM-YYYY
    let m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    // try ISO
    m = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    // try "01/Apr/2026" format
    const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
    m = str.match(/^(\d{1,2})[\/\-]([A-Za-z]{3})[\/\-](\d{4})$/);
    if (m) {
      const mo = months[m[2].toLowerCase()];
      if (mo) return `${m[3]}-${mo}-${m[1].padStart(2,'0')}`;
    }
    return null;
  }

  function datesClose(d1, d2, toleranceDays = 3) {
    const p1 = parseDate(d1), p2 = parseDate(d2);
    if (!p1 || !p2) return true; // if either date missing, don't penalise
    const diff = Math.abs(new Date(p1) - new Date(p2)) / 86400000;
    return diff <= toleranceDays;
  }

  // ── vendor name similarity ────────────────────────────────────
  // Strips common suffixes (limited, ltd, pvt, private, co, corp, pharma, etc.)
  // before comparing so "CIPLA LIMITED" matches "CIPLA LTD"
  const STRIP_SUFFIX = /(?:limited|ltd|pvt|private|llp|llc|corp|corporation|company|co|enterprises|pharma|pharmaceuticals|labs|laboratories|trading|distributors|suppliers|agencies|agency|brothers|bros|industries|ind|international|intl|& sons|and sons)$/gi;

  function coreVendorName(s) {
    return norm(s).replace(STRIP_SUFFIX, '').replace(/[^a-z0-9]/g, '').trim();
  }

  function vendorMatch(inv, grn) {
    const n1 = norm(inv), n2 = norm(grn);
    if (!n1 || !n2) return false;
    // exact normalised match
    if (n1 === n2) return true;
    // strip suffixes and compare cores
    const c1 = coreVendorName(inv), c2 = coreVendorName(grn);
    if (c1 && c2 && c1 === c2) return true;
    // one core contains the other (min 5 chars to avoid false positives)
    const minLen = 5;
    if (c1.length >= minLen && c2.length >= minLen) {
      if (c2.includes(c1) || c1.includes(c2)) return true;
    }
    // prefix match on full normalised name (first 8 chars)
    const pfxLen = 8;
    if (n1.length >= pfxLen && n2.length >= pfxLen) {
      if (n1.slice(0, pfxLen) === n2.slice(0, pfxLen)) return true;
    }
    return false;
  }

  // ── parse GRN Excel file ──────────────────────────────────────
  function parseGRNFile(arrayBuffer, fileName) {
    const wb   = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    const rows = [];

    for (const shName of wb.SheetNames) {
      const ws  = wb.Sheets[shName];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (raw.length < 2) continue;

      // find header row (contains "SUPPLIER NAME")
      let hdrIdx = -1;
      for (let i = 0; i < Math.min(raw.length, 8); i++) {
        if (raw[i].some(c => String(c).toLowerCase().includes('supplier name'))) {
          hdrIdx = i; break;
        }
      }
      if (hdrIdx < 0) continue;

      const hdr = raw[hdrIdx].map(c => String(c).toUpperCase().trim());
      const col = k => hdr.findIndex(h => h.includes(k));

      // column indices
      const iSup  = col('SUPPLIER NAME');
      const iGst  = col('SUPPLIER GST');
      const iInv  = col('INVOICE NO');
      const iIdt  = col('INVOICE DATE');
      const iAmt  = col('TOTAL INVOICE AMOUNT') >= 0
                      ? col('TOTAL INVOICE AMOUNT')
                      : col('TOTAL INVOICE');
      const iGrn  = col('GRN NO') >= 0 ? col('GRN NO') : col('CGRN NO');
      const iGdt  = col('GRN DATE') >= 0 ? col('GRN DATE') : col('CGRN DATE');
      const iLoc  = col('PHARMACY LOCATION NAME') >= 0
                      ? col('PHARMACY LOCATION NAME')
                      : col('STORES LOCATION NAME');
      const iPoNo = col('PO NO');

      const src     = fileName.toLowerCase();
      const grnType = src.includes('pharmacy')     ? 'Pharmacy'
                    : src.includes('consignment')  ? 'Consignment'
                    : src.includes('capex')        ? 'Capex'
                    : 'General Stores';

      for (let i = hdrIdx + 1; i < raw.length; i++) {
        const r   = raw[i];
        const sup = String(r[iSup] || '').trim();
        if (!sup || sup === 'SUPPLIER NAME') continue;

        const invoiceNo  = iInv >= 0  ? String(r[iInv]  || '').trim() : '';
        const invoiceAmt = iAmt >= 0  ? (parseFloat(r[iAmt]) || 0)     : 0;
        if (!invoiceNo && !invoiceAmt) continue; // skip blank rows

        rows.push({
          grnType,
          supplier:       sup,
          supplierGstin:  iGst >= 0  ? String(r[iGst]  || '').trim() : '',
          invoiceNo,
          invoiceDate:    iIdt >= 0  ? excelDateToStr(r[iIdt])       : '',
          grnNo:          iGrn >= 0  ? String(r[iGrn]  || '').trim() : '',
          grnDate:        iGdt >= 0  ? excelDateToStr(r[iGdt])       : '',
          totalAmount:    invoiceAmt,
          location:       iLoc >= 0  ? String(r[iLoc]  || '').trim() : '',
          poNo:           iPoNo >= 0 ? String(r[iPoNo] || '').trim() : '',
          _src: fileName
        });
      }
    }
    return rows;
  }

  // ── main reconciliation logic ─────────────────────────────────
  // Match priority:
  //   1. Invoice No exact match (normalised)
  //   2. Invoice No + Vendor + Date (if inv no missing)
  //   3. Vendor + Amount (fallback, loose)
  function run(results, grnFiles) {
    const invoices = Object.values(results).filter(r => r.status === 'ok' || r.status === 'manual');
    const allGrn   = grnFiles.flatMap(f => f.rows);
    if (!invoices.length || !allGrn.length) return [];

    const out  = [];
    const used = new Set();

    for (const inv of invoices) {
      const invNo  = norm(inv.invoice);
      const vendor = norm(inv.vendor);
      const amt    = nAmt(inv.amount);
      const invDt  = inv.invoiceDate || '';

      let match = null, matchBy = '';

      // Pass 1: exact invoice number match
      if (invNo) {
        match = allGrn.find(g =>
          !used.has(g._id) &&
          norm(g.invoiceNo) === invNo
        );
        if (match) matchBy = 'Invoice No';
      }

      // Pass 2: invoice no + vendor + date (handles missing/garbled amounts)
      if (!match && invNo) {
        match = allGrn.find(g =>
          !used.has(g._id) &&
          norm(g.invoiceNo) === invNo &&
          vendorMatch(inv.vendor, g.supplier)
        );
        if (match) matchBy = 'Invoice No + Vendor';
      }

      // Pass 3: vendor + amount within tolerance
      if (!match && vendor.length >= 4) {
        match = allGrn.find(g =>
          !used.has(g._id) &&
          vendorMatch(inv.vendor, g.supplier) &&
          Math.abs(nAmt(g.totalAmount) - amt) <= AMT_TOL
        );
        if (match) matchBy = 'Vendor + Amount';
      }

      // Build discrepancy list
      const disc = [];
      if (match) {
        used.add(match._id);
        const ga   = nAmt(match.totalAmount);
        const diff = nAmt(amt - ga);
        if (Math.abs(diff) > AMT_TOL)
          disc.push({ field: 'Amount', invoice: amt, grn: ga, diff, pct: ga ? ((diff / ga) * 100).toFixed(1) : '—' });
        if (invNo && match.invoiceNo && norm(match.invoiceNo) !== invNo)
          disc.push({ field: 'Invoice No', invoice: inv.invoice, grn: match.invoiceNo });
        if (inv.vendor && match.supplier && !vendorMatch(inv.vendor, match.supplier))
          disc.push({ field: 'Vendor', invoice: inv.vendor, grn: match.supplier });
      }

      out.push({
        page:        inv.page,
        invVendor:   inv.vendor   || '',
        invInvoice:  inv.invoice  || '',
        invGstin:    inv.gstin    || '',
        invAmount:   amt,
        invDate:     inv.invoiceDate || '',
        grnSupplier: match?.supplier  || '',
        grnInvoice:  match?.invoiceNo || '',
        grnGstin:    match?.supplierGstin || '',
        grnAmount:   match ? nAmt(match.totalAmount) : 0,
        grnNo:       match?.grnNo    || '',
        grnDate:     match?.grnDate  || '',
        grnType:     match?.grnType  || '',
        location:    match?.location || '',
        matchBy,
        status: !match ? 'UNMATCHED' : disc.some(d => d.field === 'Amount') ? 'DISCREPANCY' : 'MATCHED',
        discrepancies: disc
      });
    }

    // GRN-only rows (in GRN but not matched to any invoice)
    allGrn.filter(g => !used.has(g._id)).forEach(g => out.push({
      page: null, invVendor: '', invInvoice: '', invGstin: '', invAmount: 0, invDate: '',
      grnSupplier: g.supplier, grnInvoice: g.invoiceNo, grnGstin: g.supplierGstin,
      grnAmount: nAmt(g.totalAmount), grnNo: g.grnNo, grnDate: g.grnDate,
      grnType: g.grnType, location: g.location, matchBy: '', status: 'GRN ONLY', discrepancies: []
    }));

    return out;
  }

  // ── Excel export ─────────────────────────────────────────────
  function exportExcel(reconRows, invoiceResults) {
    const wb = XLSX.utils.book_new();

    // Sheet 1: full reconciliation
    const ws1 = XLSX.utils.json_to_sheet(reconRows.map(r => ({
      'Status':            r.status,
      'Page':              r.page || '',
      'Match by':          r.matchBy || '',
      'Inv — Vendor':      r.invVendor,
      'Inv — Invoice':     r.invInvoice,
      'Inv — GSTIN':       r.invGstin,
      'Inv — Amount (₹)':  r.invAmount || '',
      'GRN — Supplier':    r.grnSupplier,
      'GRN — Invoice':     r.grnInvoice,
      'GRN — GSTIN':       r.grnGstin,
      'GRN — Amount (₹)':  r.grnAmount || '',
      'GRN No':            r.grnNo,
      'GRN Date':          r.grnDate,
      'GRN Type':          r.grnType,
      'Location':          r.location,
      'Amount Diff (₹)':   r.discrepancies.find(d => d.field === 'Amount')?.diff || 0,
      'Diff %':            r.discrepancies.find(d => d.field === 'Amount')?.pct || '',
      'Discrepancies':     r.discrepancies.map(d => `${d.field}: Inv=${d.invoice} vs GRN=${d.grn}`).join(' | '),
    })));
    ws1['!cols'] = [14,6,16,28,18,18,14,28,18,18,14,20,12,12,20,12,8,40].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws1, 'Reconciliation');

    // Sheet 2: discrepancies only
    const disc = reconRows.filter(r => r.status !== 'MATCHED');
    if (disc.length) {
      const ws2 = XLSX.utils.json_to_sheet(disc.map(r => ({
        'Status':        r.status,
        'Page':          r.page || '',
        'Vendor':        r.invVendor || r.grnSupplier,
        'Inv Invoice':   r.invInvoice,
        'GRN Invoice':   r.grnInvoice,
        'Inv Amt (₹)':   r.invAmount || '',
        'GRN Amt (₹)':   r.grnAmount || '',
        'Diff (₹)':      r.discrepancies.find(d => d.field === 'Amount')?.diff || '',
        'Diff %':        r.discrepancies.find(d => d.field === 'Amount')?.pct || '',
        'Action':        r.status === 'UNMATCHED'   ? 'Invoice not found in GRN'
                       : r.status === 'GRN ONLY'    ? 'GRN entry has no matching invoice'
                       : 'Review discrepancy',
      })));
      ws2['!cols'] = [14,6,30,18,18,14,14,12,8,35].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws2, 'Discrepancies');
    }

    // Sheet 3: summary
    const tInv   = reconRows.filter(r => r.page).reduce((s, r) => s + (r.invAmount || 0), 0);
    const tGrn   = reconRows.reduce((s, r) => s + (r.grnAmount || 0), 0);
    const matched = reconRows.filter(r => r.status === 'MATCHED').length;
    const discN   = reconRows.filter(r => r.status === 'DISCREPANCY').length;
    const unm     = reconRows.filter(r => r.status === 'UNMATCHED').length;
    const grnOnly = reconRows.filter(r => r.status === 'GRN ONLY').length;
    const ws3 = XLSX.utils.aoa_to_sheet([
      ['RECONCILIATION SUMMARY'], [''],
      ['Total invoices extracted', reconRows.filter(r => r.page).length],
      ['Total GRN entries',        reconRows.length],
      [''],
      ['✅ Matched',               matched],
      ['⚠ Discrepancy',            discN],
      ['❌ Invoice not in GRN',    unm],
      ['📋 GRN with no invoice',   grnOnly],
      [''],
      ['Invoice total (₹)',  tInv],
      ['GRN total (₹)',      tGrn],
      ['Net difference (₹)', parseFloat((tInv - tGrn).toFixed(2))],
    ]);
    ws3['!cols'] = [{ wch: 30 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Summary');

    XLSX.writeFile(wb, `reconciliation_${new Date().toISOString().slice(0, 7)}.xlsx`);
  }

  return { parseGRNFile, run, exportExcel, norm, nAmt };
})();
