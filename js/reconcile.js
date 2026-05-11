// ═══════════════════════════════════════════════════════════════════
// reconcile.js  —  v4: multi-GRN grouping, CA-grade status lifecycle
// ═══════════════════════════════════════════════════════════════════

const Reconcile = (() => {
  const norm    = s => String(s||'').toLowerCase().replace(/[\s.\-\/\\,&']/g,'').trim();
  const nAmt    = v => Math.round((parseFloat(v)||0)*100)/100;
  const AMT_TOL = 100;

  // ── month table ───────────────────────────────────────────────
  const _M = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
    january:1,february:2,march:3,april:4,june:6,july:7,august:8,
    september:9,october:10,november:11,december:12
  };

  function parseDate(str) {
    if (!str) return null;
    str = String(str).trim().replace(/\s+/g,' ');
    let m;
    m = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (m && +m[2]>=1 && +m[2]<=12 && +m[1]>=1 && +m[1]<=31)
      return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    m = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    m = str.match(/^(\d{1,2})[\s\/\-]([A-Za-z]{3,9})[\s\/\-,]*(\d{4})$/);
    if (m) { const mo=_M[m[2].toLowerCase()]; if(mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
    m = str.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m) { const mo=_M[m[1].toLowerCase()]; if(mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`; }
    m = str.match(/^(\d{4})(\d{2})(\d{2})$/); if(m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = str.match(/^(\d{2})(\d{2})(\d{4})$/); if(m && +m[1]<=31 && +m[2]<=12) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
  }

  function excelDateToStr(v) {
    if (!v && v!==0) return '';
    let str='';
    if (v instanceof Date) { const d=String(v.getDate()).padStart(2,'0'),mo=String(v.getMonth()+1).padStart(2,'0'); str=`${d}/${mo}/${v.getFullYear()}`; }
    else if (typeof v==='number') { const dt=new Date(Math.round((v-25569)*86400*1000)),d=String(dt.getUTCDate()).padStart(2,'0'),mo=String(dt.getUTCMonth()+1).padStart(2,'0'); str=`${d}/${mo}/${dt.getUTCFullYear()}`; }
    else str=String(v).trim();
    const iso=parseDate(str); if(!iso) return str;
    const[y,mo,d]=iso.split('-'); return `${d}/${mo}/${y}`;
  }

  function datesClose(d1,d2,tol=3) {
    const p1=parseDate(d1),p2=parseDate(d2);
    if(!p1||!p2) return true;
    return Math.abs(new Date(p1)-new Date(p2))/86400000<=tol;
  }

  // ── vendor matching ───────────────────────────────────────────
  const STRIP_SUFFIX = /(?:limited|ltd|pvt|private|llp|llc|corp|corporation|company|co|enterprises|pharma|pharmaceuticals|labs|laboratories|trading|distributors|suppliers|agencies|agency|brothers|bros|industries|ind|international|intl|&sons|andsons)$/gi;
  const coreVendor   = s => norm(s).replace(STRIP_SUFFIX,'').replace(/[^a-z0-9]/g,'').trim();

  function vendorMatch(inv,grn) {
    const n1=norm(inv),n2=norm(grn);
    if(!n1||!n2) return false;
    if(n1===n2) return true;
    const c1=coreVendor(inv),c2=coreVendor(grn);
    if(c1&&c2&&c1===c2) return true;
    if(c1.length>=5&&c2.length>=5&&(c2.includes(c1)||c1.includes(c2))) return true;
    if(n1.length>=8&&n2.length>=8&&n1.slice(0,8)===n2.slice(0,8)) return true;
    return false;
  }

  // ── parse GRN Excel ───────────────────────────────────────────
  function parseGRNFile(arrayBuffer, fileName) {
    const wb  = XLSX.read(arrayBuffer,{type:'array',cellDates:true});
    const out = [];
    for (const shName of wb.SheetNames) {
      const ws  = wb.Sheets[shName];
      const raw = XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      if (raw.length<2) continue;
      let hdrIdx=-1;
      for(let i=0;i<Math.min(raw.length,8);i++){
        if(raw[i].some(c=>String(c).toLowerCase().includes('supplier name'))){hdrIdx=i;break;}
      }
      if(hdrIdx<0) continue;
      const hdr=raw[hdrIdx].map(c=>String(c).toUpperCase().trim());
      const col=k=>hdr.findIndex(h=>h.includes(k));
      const iSup=col('SUPPLIER NAME'),iGst=col('SUPPLIER GST'),iInv=col('INVOICE NO'),
            iIdt=col('INVOICE DATE'),
            iAmt=col('TOTAL INVOICE AMOUNT')>=0?col('TOTAL INVOICE AMOUNT'):col('TOTAL INVOICE'),
            iGrn=col('GRN NO')>=0?col('GRN NO'):col('CGRN NO'),
            iGdt=col('GRN DATE')>=0?col('GRN DATE'):col('CGRN DATE'),
            iLoc=col('PHARMACY LOCATION NAME')>=0?col('PHARMACY LOCATION NAME'):col('STORES LOCATION NAME'),
            iPoNo=col('PO NO');
      const src=fileName.toLowerCase();
      const grnType=src.includes('pharmacy')?'Pharmacy':src.includes('consignment')?'Consignment':src.includes('capex')?'Capex':'General Stores';
      for(let i=hdrIdx+1;i<raw.length;i++){
        const r=raw[i];
        const sup=String(r[iSup]||'').trim();
        if(!sup||sup==='SUPPLIER NAME') continue;
        const invoiceNo=iInv>=0?String(r[iInv]||'').trim():'';
        const invoiceAmt=iAmt>=0?(parseFloat(r[iAmt])||0):0;
        if(!invoiceNo&&!invoiceAmt) continue;
        out.push({
          grnType, supplier:sup, supplierGstin:iGst>=0?String(r[iGst]||'').trim():'',
          invoiceNo, invoiceDate:iIdt>=0?excelDateToStr(r[iIdt]):'',
          grnNo:iGrn>=0?String(r[iGrn]||'').trim():'',
          grnDate:iGdt>=0?excelDateToStr(r[iGdt]):'',
          totalAmount:invoiceAmt,
          location:iLoc>=0?String(r[iLoc]||'').trim():'',
          poNo:iPoNo>=0?String(r[iPoNo]||'').trim():'',
          _src:fileName, _id:`${fileName}_${i}`
        });
      }
    }
    return out;
  }

  // ── group GRN rows by normalised invoice number ───────────────
  function buildGRNIndex(allGrn) {
    // primary index: invoiceNo → [rows]
    const byInv = new Map();
    for (const g of allGrn) {
      const k = norm(g.invoiceNo);
      if (!k) continue;
      if (!byInv.has(k)) byInv.set(k,[]);
      byInv.get(k).push(g);
    }
    return byInv;
  }

  // ── determine status from amounts ─────────────────────────────
  function calcStatus(invAmt, grnTotal, grnCount) {
    if (grnCount === 0)           return 'UNMATCHED';
    const diff = Math.abs(invAmt - grnTotal);
    if (diff <= AMT_TOL)          return 'MATCHED';
    if (grnTotal < invAmt - AMT_TOL) return 'PARTIAL';  // GRNs received but total is short
    return 'DISCREPANCY';
  }

  // ── preserve CA resolution on re-run ─────────────────────────
  function preserveResolution(newRow, prevRow) {
    if (!prevRow || !prevRow.resolution) return newRow;
    const res       = prevRow.resolution;
    const prevDiff  = Math.abs(prevRow.amountDiff || 0);
    const newDiff   = Math.abs(newRow.amountDiff  || 0);
    const diffChanged = Math.abs(newDiff - prevDiff) > AMT_TOL;

    if (res === 'ACCEPTED') {
      if (diffChanged) {
        // amount materially changed — force re-review
        return { ...newRow, status: 'DISCREPANCY',
          previousStatus: 'ACCEPTED', statusChangedAt: new Date().toISOString(),
          resolutionNote: `[Auto] Amount diff changed from ₹${prevDiff.toFixed(0)} to ₹${newDiff.toFixed(0)} — re-review needed. Previous note: ${prevRow.resolutionNote||''}` };
      }
      // same diff — keep accepted
      return { ...newRow, resolution: 'ACCEPTED',
        resolutionNote: prevRow.resolutionNote, resolvedAt: prevRow.resolvedAt };
    }
    if (res === 'DISPUTED' || res === 'EXCLUDED') {
      // always sticky — CA must manually resolve
      return { ...newRow, resolution: res,
        resolutionNote: prevRow.resolutionNote, resolvedAt: prevRow.resolvedAt };
    }
    if (res === 'CREDIT_NOTE') {
      // keep tracking if still unresolved
      return { ...newRow, resolution: 'CREDIT_NOTE',
        resolutionNote: prevRow.resolutionNote, resolvedAt: prevRow.resolvedAt };
    }
    return newRow;
  }

  // ── main reconciliation run ───────────────────────────────────
  function run(cycle, prevReconRows) {
    const pages  = cycle.pages || {};
    const allGrn = (cycle.grnData || []).flatMap(f => f.rows || []);
    if (!allGrn.length) return { reconRows: [], grnOnlyRows: [] };

    // assign stable _id if missing
    allGrn.forEach((g,i) => { if(!g._id) g._id=`${g._src||'grn'}_${i}`; });

    const invoices = Object.values(pages)
      .filter(r => r.status==='ok'||r.status==='manual')
      .sort((a,b) => (a.sourcePdf||'').localeCompare(b.sourcePdf||'')||(a.page-b.page));

    // build lookup maps
    const grnByInv  = buildGRNIndex(allGrn);
    const prevByKey = new Map((prevReconRows||[]).map(r=>[r.invoiceKey,r]));
    const usedIds   = new Set();
    const reconRows = [];

    for (const inv of invoices) {
      const invNo  = norm(inv.invoice);
      const invAmt = nAmt(inv.amount);
      const pageKey = inv.pageKey || `${inv.sourcePdf}::${inv.page}`;

      // ── collect all matching GRN rows ─────────────────────────
      let matched = [];
      let matchBy = '';

      // Pass 1: invoice number → collect ALL matching GRN rows
      if (invNo) {
        const candidates = (grnByInv.get(invNo)||[]).filter(g=>!usedIds.has(g._id));
        if (candidates.length) { matched = candidates; matchBy = 'Invoice No'; }
      }

      // Pass 2: invoice no + vendor (for cases with same inv no from diff vendors)
      if (!matched.length && invNo) {
        const allCandidates = allGrn.filter(g=>!usedIds.has(g._id)&&norm(g.invoiceNo)===invNo&&vendorMatch(inv.vendor,g.supplier));
        if (allCandidates.length) { matched = allCandidates; matchBy = 'Invoice No + Vendor'; }
      }

      // Pass 3: vendor + amount fallback (no invoice no on either side)
      if (!matched.length && norm(inv.vendor).length>=4) {
        const fb = allGrn.filter(g=>!usedIds.has(g._id)&&vendorMatch(inv.vendor,g.supplier)&&Math.abs(nAmt(g.totalAmount)-invAmt)<=AMT_TOL);
        if (fb.length) { matched = fb; matchBy = 'Vendor + Amount'; }
      }

      // mark used
      matched.forEach(g=>usedIds.add(g._id));

      const grnTotal = matched.reduce((s,g)=>s+nAmt(g.totalAmount),0);
      const amountDiff = nAmt(invAmt - grnTotal);
      const status = calcStatus(invAmt, grnTotal, matched.length);

      const newRow = {
        invoiceKey:  pageKey,
        sourcePdf:   inv.sourcePdf || '',
        page:        inv.page,
        invVendor:   inv.vendor    || '',
        invInvoice:  inv.invoice   || '',
        invGstin:    inv.gstin     || '',
        invAmount:   invAmt,
        invDate:     inv.invoiceDate || '',
        grnEntries:  matched.map(g=>({
          grnNo: g.grnNo, grnDate: g.grnDate,
          supplier: g.supplier, invoiceNo: g.invoiceNo,
          amount: nAmt(g.totalAmount), location: g.location,
          grnType: g.grnType, supplierGstin: g.supplierGstin||''
        })),
        grnTotal:    nAmt(grnTotal),
        amountDiff,
        matchBy,
        status,
        resolution:      null,
        resolutionNote:  '',
        resolvedAt:      null,
        previousStatus:  null,
        statusChangedAt: null,
        carriedFrom:     null
      };

      // apply carry-forward / previous resolution
      const prev = prevByKey.get(pageKey);
      const finalRow = preserveResolution(newRow, prev);

      // flag status change for CA awareness
      if (prev && prev.status !== finalRow.status && !finalRow.previousStatus) {
        finalRow.previousStatus  = prev.status;
        finalRow.statusChangedAt = new Date().toISOString();
      }

      reconRows.push(finalRow);
    }

    // GRN-only rows
    const grnOnlyRows = allGrn
      .filter(g=>!usedIds.has(g._id))
      .map(g=>({
        grnNo: g.grnNo, grnDate: g.grnDate,
        supplier: g.supplier, invoiceNo: g.invoiceNo,
        supplierGstin: g.supplierGstin||'',
        amount: nAmt(g.totalAmount),
        location: g.location, grnType: g.grnType,
        resolution: null, resolutionNote: '', resolvedAt: null,
        _id: g._id
      }));

    return { reconRows, grnOnlyRows };
  }

  // ── summary stats ─────────────────────────────────────────────
  function getStats(reconRows, grnOnlyRows, carriedForward) {
    const rows = reconRows || [];
    return {
      total:       rows.length,
      matched:     rows.filter(r=>r.status==='MATCHED'&&!r.resolution).length,
      discrepancy: rows.filter(r=>r.status==='DISCREPANCY'&&!['ACCEPTED','EXCLUDED','DISPUTED','CREDIT_NOTE'].includes(r.resolution)).length,
      partial:     rows.filter(r=>r.status==='PARTIAL'&&!r.resolution).length,
      unmatched:   rows.filter(r=>r.status==='UNMATCHED'&&r.resolution!=='EXCLUDED').length,
      accepted:    rows.filter(r=>r.resolution==='ACCEPTED').length,
      disputed:    rows.filter(r=>r.resolution==='DISPUTED').length,
      creditNote:  rows.filter(r=>r.resolution==='CREDIT_NOTE').length,
      excluded:    rows.filter(r=>r.resolution==='EXCLUDED').length,
      grnOnly:     (grnOnlyRows||[]).length,
      carried:     (carriedForward||[]).length,
      needsAction: rows.filter(r=>needsAction(r)).length,
      invTotal:    rows.reduce((s,r)=>s+(r.invAmount||0),0),
      grnTotal:    rows.reduce((s,r)=>s+(r.grnTotal||0),0)
    };
  }

  function needsAction(r) {
    if (['ACCEPTED','EXCLUDED'].includes(r.resolution)) return false;
    return ['DISCREPANCY','PARTIAL','UNMATCHED'].includes(r.status);
  }

  // ── Excel export (CA-grade, 7 sheets) ────────────────────────
  function exportExcel(cycle) {
    const rows    = cycle.reconRows    || [];
    const grnOnly = cycle.grnOnlyRows  || [];
    const cns     = cycle.creditNotes  || [];
    const carried = cycle.carriedForward || [];
    const wb      = XLSX.utils.book_new();
    const fmt     = r => {
      const grnNos  = (r.grnEntries||[]).map(g=>g.grnNo).filter(Boolean).join(', ');
      const grnAmts = (r.grnEntries||[]).map(g=>`${g.grnNo||'?'}=₹${g.amount}`).join(' | ');
      return {
        'Status':          r.resolution ? `${r.status} [${r.resolution}]` : r.status,
        'Page':            r.page||'',
        'Source PDF':      r.sourcePdf||'',
        'Inv — Vendor':    r.invVendor,
        'Inv — Invoice':   r.invInvoice,
        'Inv — GSTIN':     r.invGstin,
        'Inv — Amount(₹)': r.invAmount||'',
        'Inv — Date':      r.invDate||'',
        'GRN Count':       (r.grnEntries||[]).length,
        'GRN Nos':         grnNos,
        'GRN Amounts':     grnAmts,
        'GRN Total(₹)':    r.grnTotal||'',
        'Diff(₹)':         r.amountDiff||0,
        'Match by':        r.matchBy||'',
        'Resolution':      r.resolution||'',
        'Notes':           r.resolutionNote||'',
        'Resolved at':     r.resolvedAt||'',
        'Prev Status':     r.previousStatus||'',
        'Carried from':    r.carriedFrom||''
      };
    };

    // Sheet 1: Summary
    const st = getStats(rows, grnOnly, carried);
    const ws1 = XLSX.utils.aoa_to_sheet([
      [`RECONCILIATION SUMMARY — ${cycle.cycleLabel||''}`],[`Generated: ${new Date().toLocaleString('en-IN')}`],[''],
      ['STATUS','COUNT','AMOUNT (₹)'],
      ['✅ Matched',        st.matched,     rows.filter(r=>r.status==='MATCHED'&&!r.resolution).reduce((s,r)=>s+(r.invAmount||0),0)],
      ['⚠ Discrepancy',    st.discrepancy, rows.filter(r=>r.status==='DISCREPANCY'&&!['ACCEPTED','EXCLUDED','DISPUTED','CREDIT_NOTE'].includes(r.resolution)).reduce((s,r)=>s+(r.invAmount||0),0)],
      ['🔶 Partial',       st.partial,     rows.filter(r=>r.status==='PARTIAL'&&!r.resolution).reduce((s,r)=>s+(r.invAmount||0),0)],
      ['❌ Unmatched',     st.unmatched,   rows.filter(r=>r.status==='UNMATCHED'&&r.resolution!=='EXCLUDED').reduce((s,r)=>s+(r.invAmount||0),0)],
      ['🔵 Accepted',      st.accepted,    rows.filter(r=>r.resolution==='ACCEPTED').reduce((s,r)=>s+(r.invAmount||0),0)],
      ['🚩 Disputed',      st.disputed,    rows.filter(r=>r.resolution==='DISPUTED').reduce((s,r)=>s+(r.invAmount||0),0)],
      ['📝 Credit Note',   st.creditNote,  rows.filter(r=>r.resolution==='CREDIT_NOTE').reduce((s,r)=>s+(r.invAmount||0),0)],
      ['⊘ Excluded',       st.excluded,    rows.filter(r=>r.resolution==='EXCLUDED').reduce((s,r)=>s+(r.invAmount||0),0)],
      ['📋 GRN Only',      st.grnOnly,     grnOnly.reduce((s,r)=>s+(r.amount||0),0)],
      ['📦 Carried Fwd',   st.carried,     ''],
      [''],
      ['Invoice Total (₹)', st.invTotal],
      ['GRN Total (₹)',      st.grnTotal],
      ['Net Difference (₹)', parseFloat((st.invTotal-st.grnTotal).toFixed(2))],
    ]);
    ws1['!cols']=[{wch:24},{wch:10},{wch:18}];
    XLSX.utils.book_append_sheet(wb,ws1,'Summary');

    // Sheet 2: Needs Action
    const needsActionRows = rows.filter(r=>needsAction(r));
    const ws2 = XLSX.utils.json_to_sheet(needsActionRows.map(fmt));
    ws2['!cols']=[14,6,20,28,16,18,14,12,8,24,30,14,12,16,12,30,16,14,14].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb,ws2,'Needs Action');

    // Sheet 3: All Transactions
    const ws3 = XLSX.utils.json_to_sheet(rows.map(fmt));
    ws3['!cols']=[14,6,20,28,16,18,14,12,8,24,30,14,12,16,12,30,16,14,14].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb,ws3,'All Transactions');

    // Sheet 4: GRN Only
    const ws4 = XLSX.utils.json_to_sheet(grnOnly.map(g=>({
      'GRN No':g.grnNo,'GRN Date':g.grnDate,'Supplier':g.supplier,
      'Invoice No':g.invoiceNo,'GSTIN':g.supplierGstin,
      'Amount(₹)':g.amount,'Location':g.location,'Type':g.grnType,
      'Resolution':g.resolution||'','Notes':g.resolutionNote||''
    })));
    ws4['!cols']=[16,12,28,16,18,14,20,12,12,30].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb,ws4,'GRN Only');

    // Sheet 5: Resolved
    const resolved = rows.filter(r=>['ACCEPTED','EXCLUDED','DISPUTED','CREDIT_NOTE'].includes(r.resolution));
    if(resolved.length){
      const ws5=XLSX.utils.json_to_sheet(resolved.map(fmt));
      ws5['!cols']=[14,6,20,28,16,18,14,12,8,24,30,14,12,16,12,30,16,14,14].map(w=>({wch:w}));
      XLSX.utils.book_append_sheet(wb,ws5,'Resolved');
    }

    // Sheet 6: Credit Notes
    if(cns.length){
      const ws6=XLSX.utils.json_to_sheet(cns.map(c=>({
        'CN Number':c.cnNumber,'Vendor':c.vendor,'Amount(₹)':c.amount,
        'Date':c.date,'Against Invoice':c.againstInvoice||'','Notes':c.note||''
      })));
      ws6['!cols']=[16,28,14,12,16,30].map(w=>({wch:w}));
      XLSX.utils.book_append_sheet(wb,ws6,'Credit Notes');
    }

    // Sheet 7: Carry Forward
    if(carried.length){
      const ws7=XLSX.utils.json_to_sheet(carried.map(c=>({
        'From Cycle':c.fromCycle, 'Invoice':c.originalRow?.invInvoice||'',
        'Vendor':c.originalRow?.invVendor||'', 'Amount(₹)':c.originalRow?.invAmount||'',
        'Status':c.originalRow?.status||'', 'Notes':c.carryNote||''
      })));
      ws7['!cols']=[14,16,28,14,14,30].map(w=>({wch:w}));
      XLSX.utils.book_append_sheet(wb,ws7,'Carry Forward');
    }

    const label = (cycle.cycleLabel||'recon').replace(/[^a-z0-9]/gi,'_');
    XLSX.writeFile(wb,`reconciliation_${label}_${new Date().toISOString().slice(0,10)}.xlsx`);
  }


  // ── supplier-wise audit stats ─────────────────────────────────
  function getSupplierStats(reconRows, grnOnlyRows) {
    const map = new Map(); // canonical vendor name → stats

    const getOrCreate = name => {
      const key = name || 'Unknown';
      if (!map.has(key)) map.set(key, {
        vendor: key, invoiceCount: 0, invoiceTotal: 0,
        grnTotal: 0, matchedCount: 0, discrepancyCount: 0,
        partialCount: 0, unmatchedCount: 0, resolvedCount: 0,
        totalDiff: 0, maxDiff: 0, rows: []
      });
      return map.get(key);
    };

    for (const r of (reconRows || [])) {
      const s = getOrCreate(r.invVendor);
      s.invoiceCount++;
      s.invoiceTotal  += (r.invAmount  || 0);
      s.grnTotal      += (r.grnTotal   || 0);
      const diff = Math.abs(r.amountDiff || 0);
      s.totalDiff += diff;
      if (diff > s.maxDiff) s.maxDiff = diff;
      if (['ACCEPTED','EXCLUDED','DISPUTED','CREDIT_NOTE'].includes(r.resolution)) s.resolvedCount++;
      else if (r.status === 'MATCHED')      s.matchedCount++;
      else if (r.status === 'DISCREPANCY')  s.discrepancyCount++;
      else if (r.status === 'PARTIAL')      s.partialCount++;
      else if (r.status === 'UNMATCHED')    s.unmatchedCount++;
      s.rows.push(r);
    }

    // GRN-only rows (grouped by supplier name from GRN)
    for (const g of (grnOnlyRows || [])) {
      const s = getOrCreate(g.supplier || 'Unknown');
      s.grnOnlyCount = (s.grnOnlyCount || 0) + 1;
      s.grnTotal += (g.amount || 0);
    }

    const list = [...map.values()].map(s => ({
      ...s,
      netDiff:    nAmt(s.invoiceTotal - s.grnTotal),
      actionCount: s.discrepancyCount + s.partialCount + s.unmatchedCount,
      matchRate:  s.invoiceCount > 0 ? Math.round(s.matchedCount / s.invoiceCount * 100) : 0
    }));

    // Sort: highest actionCount first, then by invoiceTotal desc
    list.sort((a,b) => b.actionCount - a.actionCount || b.invoiceTotal - a.invoiceTotal);
    return list;
  }

  return { parseGRNFile, run, getStats, needsAction, getSupplierStats, exportExcel, norm, nAmt, parseDate };
})();
