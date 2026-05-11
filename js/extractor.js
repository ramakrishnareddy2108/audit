// ═══════════════════════════════════════════════════════════════════
// extractor.js  —  Vision OCR + field parsing + extraction workflow
// ═══════════════════════════════════════════════════════════════════

const Extractor = (() => {

  // ── credentials (shared with Settings) ────────────────────────
  let credMode         = 'vision'; // 'vision' | 'claude'
  let visionApiKey     = '';
  let serviceAccountJson = null;
  let claudeApiKey     = '';
  let _oauthToken      = null;
  let _oauthTokenExp   = 0;

  const COST_VISION = 1.5 / 1000;
  const COST_CLAUDE = (1500 * 0.80 + 50 * 4) / 1e6;

  function setCredentials(mode, vKey, saJson, cKey) {
    credMode           = mode;
    visionApiKey       = vKey       || '';
    serviceAccountJson = saJson     || null;
    claudeApiKey       = cKey       || '';
  }

  function hasCred() {
    if (credMode === 'vision') return !!(visionApiKey || serviceAccountJson);
    return !!claudeApiKey;
  }

  function getCredSummary() {
    if (!hasCred()) return null;
    if (credMode === 'vision') {
      return serviceAccountJson
        ? `✓ Vision SA (${serviceAccountJson.project_id})`
        : '✓ Vision API Key';
    }
    return '✓ Claude Haiku API Key';
  }

  // ── JWT / OAuth2 for service account ──────────────────────────
  function b64u(buf) {
    const b = new Uint8Array(buf); let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  async function getVisionToken() {
    if (_oauthToken && Date.now() < _oauthTokenExp - 60_000) return _oauthToken;
    const sa  = serviceAccountJson;
    const now = Math.floor(Date.now() / 1000);
    const claim = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-vision', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
    const hdr = b64u(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const pay = b64u(new TextEncoder().encode(JSON.stringify(claim)));
    const sig_input = `${hdr}.${pay}`;
    const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
    const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sig_input));
    const jwt = `${sig_input}.${b64u(sigBuf)}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error('Token error: ' + (e.error_description || e.error || res.status)); }
    const d = await res.json();
    _oauthToken = d.access_token; _oauthTokenExp = Date.now() + (d.expires_in || 3600) * 1000;
    return _oauthToken;
  }

  // ── Google Vision OCR ─────────────────────────────────────────
  async function visionOCR(b64img) {
    let url, headers;
    if (serviceAccountJson) {
      const tok = await getVisionToken();
      url     = 'https://vision.googleapis.com/v1/images:annotate';
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}` };
    } else {
      url     = `https://vision.googleapis.com/v1/images:annotate?key=${visionApiKey}`;
      headers = { 'Content-Type': 'application/json' };
    }
    const body = JSON.stringify({ requests: [{ image: { content: b64img }, features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }], imageContext: { languageHints: ['en', 'hi'] } }] });
    for (let a = 0; a <= 3; a++) {
      let res;
      try { res = await fetch(url, { method: 'POST', headers, body }); }
      catch (e) { if (a < 3) { await sleep(Math.pow(2, a) * 1500); continue; } throw new Error('Network: ' + e.message); }
      if (res.status === 429) { if (a < 3) { await sleep((a + 1) * 4000); continue; } throw new Error('Rate limit'); }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        const m = e?.error?.message || `HTTP ${res.status}`;
        if (res.status === 401 && a < 3) { _oauthToken = null; await sleep(1000); continue; }
        throw new Error(m);
      }
      const d = await res.json();
      const r = d.responses?.[0];
      if (r?.error) throw new Error(r.error.message);
      return r?.fullTextAnnotation?.text || '';
    }
  }

  // ── Claude Haiku OCR ──────────────────────────────────────────
  async function claudeOCR(b64img) {
    const prompt = 'You are an OCR engine. Extract ALL text from this scanned invoice image exactly as it appears.\nOutput only the raw extracted text — no commentary, no formatting, no JSON.\nPreserve line breaks. Include every word, number, and symbol you can read.';
    for (let a = 0; a <= 4; a++) {
      let res;
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': claudeApiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64img } }, { type: 'text', text: prompt }] }] })
        });
      } catch (e) { if (a < 4) { await sleep(Math.pow(2, a) * 1000); continue; } throw new Error('Network: ' + e.message); }
      if (res.status === 429) { const w = parseInt(res.headers.get('retry-after') || '0') || (a + 1) * 6; if (a < 4) { await sleep(w * 1000); continue; } throw new Error('Rate limit'); }
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${res.status}`); }
      const d = await res.json();
      return (d.content || []).find(b => b.type === 'text')?.text || '';
    }
    throw new Error('Max retries');
  }

  // ── field parsing ─────────────────────────────────────────────
  function isBadInvoiceNo(v) {
    if (!v || v.trim().length < 2) return true;
    const t = v.trim();
    if (/^(date|gstin|gst\s*no|total|amount|vendor|product|pack|batch|mrp|m\.r\.p|sgst|cgst|igst|qty|rate|discount|no\.|sr\.?\s*no|party\s*code|mode|state|type|s\.?man|sales\s*man|bill\s*time|invoice\s*date)$/i.test(t)) return true;
    if (/^\d{1,2}[\/\-][A-Za-z]{3}[\/\-](19|20)\d{2}$/i.test(t)) return true;
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-](19|20)\d{2}$/.test(t)) return true;
    if (/^\d{1,2}$/.test(t)) return true;
    return false;
  }

  function extractInvoiceNo(lines) {
    const labelRx = /^(bill\s*no\.?|invoice\s*no\.?|inv\.?\s*no\.?|tax\s*invoice\s*no\.?|inv\s*number|bill\s*number)$/i;
    const skipRx  = /^(date|gstin|gst\s*no|order\s*no|vehicle|vehical|mode|terms|delivery|ref|po\s*no|party\s*code|state|type|s\.?man|sales\s*man|bill\s*time|invoice\s*date)$/i;

    for (let i = 0; i < lines.length; i++) {
      const clean = lines[i].replace(/[:\-]/g, '').trim();
      const sameM = lines[i].match(/(?:bill\s*no\.?|invoice\s*no\.?|inv\.?\s*no\.?|tax\s*invoice\s*no\.?)[\s:\-]+(.+)$/i);
      if (sameM) {
        let v = sameM[1].trim().split(/\s{2,}|\t/)[0].trim();
        v = v.replace(/\s+(date|order|vehicle|vehical|ref)\s*[:\-].*$/i, '').trim();
        if (v && !isBadInvoiceNo(v)) return v;
      }
      const ncM = lines[i].match(/(?:invoice\s*no\.?|bill\s*no\b)\.?\s+([A-Z0-9][A-Z0-9\/\-]{0,20})(?:\s|$)/i);
      if (ncM && !isBadInvoiceNo(ncM[1])) return ncM[1].trim();
      if (!labelRx.test(clean)) continue;
      const labels = [clean];
      let j = i + 1;
      while (j < lines.length && j < i + 8) {
        const nxt = lines[j].replace(/[:\-]/g, '').trim();
        if (skipRx.test(nxt) || labelRx.test(nxt)) { labels.push(nxt); j++; }
        else break;
      }
      const values = [];
      while (j < lines.length && j < i + labels.length + 4) {
        const v = lines[j].trim();
        if (v.startsWith(':') || v.startsWith('-')) { values.push(v.replace(/^[:\-]\s*/, '').trim()); j++; }
        else break;
      }
      if (values.length > 0 && !isBadInvoiceNo(values[0])) return values[0];
      for (let k = i + 1; k < Math.min(i + 7, lines.length); k++) {
        const v = lines[k].replace(/^[:\-]\s*/, '').trim();
        if (!v || skipRx.test(v) || labelRx.test(v)) continue;
        if (!isBadInvoiceNo(v)) return v;
      }
    }
    return '';
  }

  function extractAmount(text, lines) {
    const contam = /\b(mrp|m\.r\.p|sgst|cgst|igst|rate|taxable|discount|cess|scheme|freight)\b/i;
    const patterns = [
      /amount\s*payable\s*[:\-]?\s*[₹Rs.]*\s*([0-9,]+\.?[0-9]{0,2})/i,
      /grand\s*total\s*[:\-]?\s*[₹Rs.]*\s*([0-9,]+\.?[0-9]{0,2})/i,
      /net\s*amount\s*[:\-]?\s*[₹Rs.]*\s*([0-9,]+\.?[0-9]{0,2})/i,
      /net\s*amt\s*[:\-]?\s*[₹Rs.]*\s*([0-9,]+\.?[0-9]{0,2})/i,
      /total\s*invoice\s*amount\s*[:\-]?\s*[₹Rs.]*\s*([0-9,]+\.?[0-9]{0,2})/i,
      /total\s*amount\s*[:\-]?\s*[₹Rs.]*\s*([0-9,]+\.?[0-9]{0,2})/i,
      /bill\s*amount\s*[:\-]?\s*[₹Rs.]*\s*([0-9,]+\.?[0-9]{0,2})/i,
      /invoice\s*amount\s*[:\-]?\s*[₹Rs.]*\s*([0-9,]+\.?[0-9]{0,2})/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) {
        const matchLine = (lines || []).find(l => p.test(l)) || '';
        if (!contam.test(matchLine)) return m[1].replace(/,/g, '');
      }
    }
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].replace(/,/g, '');
    }
    for (const line of (lines || [])) {
      if (contam.test(line)) continue;
      const m = line.match(/^\s*total\s*[:\-]?\s*[₹Rs.]*\s*([0-9,]+\.[0-9]{2})\s*$/i);
      if (m) return m[1].replace(/,/g, '');
    }
    return '';
  }

  function extractVendor(lines) {
    const buyerBlockRx = /^(m\/s\b|to\s*:|bill\s*to|buyer|consignee|ship\s*to|sold\s*to|party\s*name)/i;
    const skipLineRx   = /^(tax\s*invoice|retail\s*invoice|original|duplicate|triplicate|gstin|gst\s*no\.?|mode|terms|credit|debit|e\.?way|subject|invoice\s*no|bill\s*no|proforma)$/i;
    const addrRx       = /\d.*(?:road|street|nagar|colony|floor|plot|ward|near|opp|s\.no|survey|block|building|district|mandal|phase|sector)|p\.?o\.?\s*box|pin\s*code|pincode|\b\d{6}\b/i;
    const contactRx    = /phone|mobile|cell|tel[:\s]|fax|email|www\.|@|gstin\s*:/i;

    // Pass 1: collect candidates before buyer block
    const candidates = [];
    for (const l of lines.slice(0, 25)) {
      const t = l.trim();
      if (!t) continue;
      if (buyerBlockRx.test(t)) break;
      if (skipLineRx.test(t))   continue;
      if (addrRx.test(t))       continue;
      if (contactRx.test(t))    break;
      if (t.length >= 4 && !/^\d/.test(t) && !/^[-–—_*#]/.test(t)) candidates.push(t);
    }
    if (candidates.length) return candidates[0];

    // Pass 2: wider fallback, skip M/s lines (buyer)
    for (const l of lines.slice(0, 30)) {
      const t = l.trim();
      if (!t || addrRx.test(t) || contactRx.test(t) || skipLineRx.test(t)) continue;
      if (/^m\/s\b/i.test(t)) continue;
      if (t.length >= 4 && !/^\d/.test(t)) return t;
    }
    return '';
  }

  // ── date parsing helpers ──────────────────────────────────────
  const _MONTHS = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
    january:1,february:2,march:3,april:4,june:6,july:7,august:8,
    september:9,october:10,november:11,december:12
  };

  // Parse any common date string → ISO "YYYY-MM-DD" or null
  function parseToISO(str) {
    if (!str) return null;
    str = String(str).trim().replace(/\s+/g, ' ');
    let m;
    // DD/MM/YYYY  DD-MM-YYYY  DD.MM.YYYY
    m = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31)
      return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    // YYYY-MM-DD  YYYY/MM/DD
    m = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    // DD Mon YYYY  |  DD-Mon-YYYY  |  DD/Mon/YYYY  |  DD Mon, YYYY
    m = str.match(/^(\d{1,2})[\s\/\-]([A-Za-z]{3,9})[\s\/\-,]*(\d{4})$/);
    if (m) { const mo = _MONTHS[m[2].toLowerCase()]; if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
    // Month DD, YYYY  |  Mon DD, YYYY
    m = str.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m) { const mo = _MONTHS[m[1].toLowerCase()]; if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`; }
    // Compact YYYYMMDD
    m = str.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    // Compact DDMMYYYY
    m = str.match(/^(\d{2})(\d{2})(\d{4})$/);
    if (m && +m[1] <= 31 && +m[2] <= 12) return `${m[3]}-${m[2]}-${m[1]}`;
    return null;
  }

  // Normalise any date string → DD/MM/YYYY (matches GRN en-IN output)
  function normaliseDate(str) {
    const iso = parseToISO(str);
    if (!iso) return str || '';
    const [y, mo, d] = iso.split('-');
    return `${d}/${mo}/${y}`;
  }

  // Extract invoice date from OCR text, skipping due/delivery/expiry dates
  function extractInvoiceDate(text, lines) {
    const DATE_RX  = /\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2}|\d{1,2}[\s\/\-][A-Za-z]{3,9}[\s\/\-,]*\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/g;
    const LABEL_RX = /(?:invoice\s*date|inv\.?\s*date|bill\s*date|tax\s*invoice\s*date|date\s*of\s*invoice|dt\.?)\s*[:\-]?\s*/i;
    const SKIP_RX  = /due\s*date|expiry|valid(?:ity)?|delivery|dispatch|ship|challan|po\s*date|order\s*date|e\.?w\.?b|lr\s*date/i;

    // Pass 1: label + date on same line  e.g. "Invoice Date: 01/04/2026"
    for (const line of lines) {
      if (SKIP_RX.test(line)) continue;
      if (LABEL_RX.test(line)) {
        const after = line.replace(LABEL_RX, '');
        const m = [...after.matchAll(DATE_RX)];
        for (const hit of m) { const iso = parseToISO(hit[0]); if (iso) return normaliseDate(hit[0]); }
      }
    }
    // Pass 2: label on one line, date on next line
    for (let i = 0; i < lines.length - 1; i++) {
      if (SKIP_RX.test(lines[i])) continue;
      if (LABEL_RX.test(lines[i])) {
        const m = [...lines[i+1].matchAll(DATE_RX)];
        for (const hit of m) { const iso = parseToISO(hit[0]); if (iso) return normaliseDate(hit[0]); }
      }
    }
    // Pass 3: bare "Date:" prefix
    for (const line of lines) {
      if (SKIP_RX.test(line)) continue;
      if (/^\s*date\s*[:\-]/i.test(line)) {
        const m = [...line.matchAll(DATE_RX)];
        for (const hit of m) { const iso = parseToISO(hit[0]); if (iso) return normaliseDate(hit[0]); }
      }
    }
    // Pass 4: first plausible date in text not near skip words
    for (const line of text.split('\n')) {
      if (SKIP_RX.test(line)) continue;
      const m = [...line.matchAll(DATE_RX)];
      for (const hit of m) {
        const iso = parseToISO(hit[0]);
        if (iso && iso >= '2020-01-01' && iso <= '2035-12-31') return normaliseDate(hit[0]);
      }
    }
    return '';
  }


  // ── supplier master list ──────────────────────────────────────
  const SUPPLIER_MASTER = [
    'THE ALTERNATIVE SOURCE MEDICAL','BIOKRONE LABS','SRI SAI AGENCIES-VSP',
    'SHARP MEDICAL SOLUTIONS PVT LTD','BIONIC MEDITECH LLP','FALCON HEALTH LLP',
    'AA LIFE SCIENCES','PIONEER HEALTH CARE','ALS SURGICALS','ALIGN THERAPEUTICS',
    'NEELKANTH MAHADEV HEALTH CARE','RELISYS MEDICAL DEVICES LIMITED',
    'B&J HEALTHCARE PVT LTD','THAYAR ORTHO AND DIAGNOSTIC','GENUINE HEALTH CARE',
    'HEALTH VISION SURGICALS','GESCO HEALTHCARE PVT LTD','SURYA MARKETING -VJA',
    'R.K.PHARMA DISTRIBUTORS','SRI LAKSHMI SURGICAL AND MEDICALS -TPT',
    'NSJ MEDICAL LIFE SCIENCES','INDIAN ORTHOCARE SURGICALS',
    'BIOKRONE SCIENTIFIC PRIVATE LIMITED','KNOX HEALTHCARE',
    'SUNRISE MEDICAL HEALTH CARE','SRIKAAR RETAIL PRIVATE LIMITED -VJA',
    'ASTROMED HEALTH CARE INDIA PVT LTD-NLR','SCHILLER HEALTHCARE INDIA PVT. LTD.',
    'SRI ANNAPURNA SURGICALS & MEDICALS','KARTHIKEYA MEDICINE HOUSE',
    'SRI VENKATESWARA GALAXY MEDICAL DISTRIBUTORS PVT LTD',
    'SKIN AESTHETICS INTERNATIONAL PVT LTD','RADHAKRISHNA PHARMA','AUROBINDO DRUGS',
    'KALYAN PHARMA','LEO GRENPHARMA PVT LTD','R.K.MEDEQUIPS','NEW AGE BIOLOGICS',
    'SAI SASI VACCINE & SPECIALITIES','STERIMED BIOSCIENCES','SRI RVM SURGICALS',
    'VEERENDHRA SURGICAL&MEDICALS','J&J MEDITECH SURGICALS','SREERAMA MEDICINE HOUSE',
    'NEW SRS MEDICAL AGENCIES','TRUST CHEMISTS AND DRUGGISTS LTD','SR DISTRIBUTORS -VJA',
    'GLOBAL CARE PHARMA DISTRIBUTORS','SREE TRIVENI ENTERPRISES','KALYANI HEALTH PLUS',
    'NEW RITHIKA MEDCIAL& SURGICAL DISTRIBUTORS','AMRUTHA PHARMA HUB -TPT',
    'SAI SRI SURGICALS AND MEDICALS -TPT','ARKA SURGICALS','RR PHARMA DISTRIBUTORS',
    'OM LAKSHMI GANAPATHI MEDICAL & SURGICALS','JAYA SURGICAL AND PHARMA PVT LTD',
    'MOTHER MEDICAL AGENCY','ALEXON HEALTH CARE','7HILLS MEDICAL AGENCIES',
    'MURALI KRISHNA MEDICAL DISTRIBUTORS','MEDOVATION INC',
    'VANDE BHARAT PHARMACEUTIGALS-HYD','JAYHIDA MEDICARE PVT LTD',
    'HANUMAN MEDICAL DISTRIBUTORS','LAKSHMI SREENIVASA MEDICAL AGENCIES',
    'RS PHRAMA -CHENNAI','SREE RAM MEDICAL AGENCIES -VJA','RESPURE HEALTH CARE -CHENNAI',
    'SRI LAKSHMI KISHORE PHARMA DISTRIBUTORS','SV PRIDE MEDICAL AGENCIES -NLR',
    'SHIVAM DRUGS&CHEMICALS','SRI SATYA SAI ENTERPRISES',
    'SRI SAI MURALI MEDICAL AGENCIES -TPT','VISHNU MEDICAL AGENCIES -VJA',
    'PRECIOUS SURGICALS','DHANVANTHARI SURGICALS','PRABAVATHI MEDICAL AGENCIES',
    'AMRUT MEDICALS','SREE ADITYA AGENCIES','SRI VEDADRI MEDICAL AGENCIES',
    'ARJOHUNTLEIGH HEALTH CARE INDIA PVT LTD -VJA','SRI SAI PURNA ENTERPRISES -VJA',
    'VAHINI HEALTHCARE PVT LTD','RIVAAN HEALTHCARE PVT LTD',
    'SRI VENUS SURGICALS AND MEDICALS','WAL MART INDIA PVT LTD',
    'SRI MARUTI AGENCIES - VJA','MEDIHAUXE PHARMACEUTICALS PRIVATE LIMITED-VJA',
    'CARDIO CONSUMABLES PVT LTD','PETA PHARMACEUTICALS','PRAXIA HEALTH PRIVATE LIMITED',
    'MS SPECIALITIES','SRI RAMADOOT ENTERPRISES','STRYKER INDIA PRIVATE LIMITED',
    'RAMYA AGENCIES','COASTAL AGRO FOODS','CIPHER MEDITECH LLP','CARE ASSOCIATES',
    'SS PHARMA-HYD','DHANVANTHARI SURGICALS HYD','SREENIDHI SURGICALS -HYD',
    'SRI KALYANI PHAMACEUTICALS','GOURI MEDICALS-HYD','MEDLINE ENTERPRISES-HYD',
    'NITTE DEEMED TO BE UNIVERSITY','VISHNU SAI MEDICAL AGENCIES',
    'PURUSHOTHAM MEDICAL AGENCIES','ELITE HEALTHCARE SOLUTIONS','SUNIL ENTERPRISES',
    'MANJULA MEDICAL AGENCIES','SRI DATTA SAI ENTERPRISES','ARJUN MEDICAL AGENCY',
    'SAI PAVITRA MEDICAL SERVICES','SAHRUDAYA DEVICES','GANESH MEDICAL AND SURGICALS',
    'MAC ASSOCIATES','PR ENTERPRISES','SRI RAMA NAGA SAI MEDICAL AGENCY',
    'SWAGATH INTENATIONAL','MEDIGO MULTI SPECIALITY HOSPITAL',
    'SURYATEJA MEDICAL AND SURGICALS','M/S.3 VIEW TECHNOLOGIES',
    'SREE SAI VISHNU INDUSTRIAL PRODUCTS','ADROIT ACCESS SYSTEMS PVT LTD',
    'LIFECORE SYSTEMS','MAHINDRA INDUSTRIES','CUBIX MARKETING','M/S GAYATHRI FILING STN',
    'HEALTEC MANUFACTURING COMPANY','TRIVITECH DIAGNOSTIC SOLUTION PRIVATE LIMITED',
    'RAJSHRI BHARATH COMMUNICATION','CHERRYS ENTERPRISES','VIYONA BIO SYSTEMS',
    'AMAZON .IN','S T TRADERS ANNEXE CHEAP JACK','GEMINI COFFEE VENDING SOLUTIONS LLP',
    'DENTCARE DENTAL LAB PVT LTD','SRI ASHAPURA TRADERS','VARDHMAN THREADS',
    'SAI TEJA SURGICALS','SREE PADMAVATHI PAPER ENTERPRISES','MOHIT SCREENS',
    'TELSON TECHNO SOLUTIONS','V N MEDICAL SERVICES',
    'BECK MANN DIAGNOSTICS & MEDICALS SYSTEMS','PROMPT SOLUTIONS PVT .LTD',
    'SRI KRISHNA MEDICAL OXYGEN','BJ ELECTRICALS','HEALTH CARE NEEDS',
    'FBG THE BEST OR NOTHING','KUMAR RUBBER STAMPS','BALAJI ELECTRICALS & HARDWARE',
    'OM HARDWARE AND ELECTRICALS','SREE VINYA TRADERS','MADHU MEDI SYSTEM',
    'KRISHNA ENTERPRISES','HAASINI MANUFACTURING COMPANY','RR DENTAL LABS PVT LTD',
    'KALA ENTERPRISES','D-MART SUPERMARKET','SARAVANA FURNISHING',
    'SARVAM SAFETY EQUIPMENT (P) LTD','HELLO MOBILES','LAVANYA ENTERPRISES TIRUPATI',
    'LUB DUB MEDICAL','SLK SOLUTIONS CO','D MAX DENTAL LAB','SRIDEVI AGENCIES',
    'SRI SAI RAM PLYWOOD & HARDWARE'
  ];

  // strip location suffixes and common legal suffixes for core name comparison
  const LOC_SUFFIX = /[\s\-]+(VSP|VJA|HYD|NLR|TPT|CHENNAI|TIRUPATI|VIJAYAWADA|VIZAG|HYDERABAD)\s*$/i;
  const LEG_SUFFIX = /\s+(PVT\.?\s*LTD\.?|PRIVATE\s+LIMITED|LTD\.?|LLP|PVT|LIMITED|PRIVATE|CO\.|CORP\.?|INDIA)\s*$/i;

  function normMaster(s) {
    return s.toUpperCase()
      .replace(LOC_SUFFIX,'').replace(LEG_SUFFIX,'')
      .replace(/[^A-Z0-9]/g,'').trim();
  }

  // pre-build index for performance
  const _masterIndex = SUPPLIER_MASTER.map(name => ({ name, key: normMaster(name) }));

  // score overlap between two normalised strings (Jaccard on 3-grams)
  function trigramScore(a, b) {
    if (!a || !b) return 0;
    const tg = s => { const t=new Set(); for(let i=0;i<=s.length-3;i++) t.add(s.slice(i,i+3)); return t; };
    const ta=tg(a), tb=tg(b);
    let inter=0; for(const x of ta) if(tb.has(x)) inter++;
    return inter / (ta.size + tb.size - inter + 1e-9);
  }

  // match raw OCR vendor string against master list
  // returns { matched: canonicalName|null, score, isKnown }
  function matchToMaster(raw) {
    if (!raw || raw.length < 3) return { matched: null, score: 0, isKnown: false };
    const normRaw = normMaster(raw);
    if (!normRaw) return { matched: null, score: 0, isKnown: false };

    let best = null, bestScore = 0;
    for (const entry of _masterIndex) {
      // exact normalised match
      if (entry.key === normRaw) return { matched: entry.name, score: 1.0, isKnown: true };
      // prefix match (raw starts with master core or vice versa, min 6 chars)
      const minLen = Math.min(normRaw.length, entry.key.length);
      if (minLen >= 6 && (normRaw.startsWith(entry.key.slice(0,minLen)) || entry.key.startsWith(normRaw.slice(0,minLen)))) {
        const sc = minLen / Math.max(normRaw.length, entry.key.length);
        if (sc > bestScore) { bestScore = sc; best = entry.name; }
      }
      // trigram similarity
      const sc = trigramScore(normRaw, entry.key);
      if (sc > bestScore) { bestScore = sc; best = entry.name; }
    }
    const THRESHOLD = 0.45;
    if (bestScore >= THRESHOLD && best) return { matched: best, score: bestScore, isKnown: true };
    return { matched: null, score: bestScore, isKnown: false };
  }

  function parseInvoiceText(text) {
    if (!text) return { vendor: '', invoice: '', gstin: '', amount: '', invoiceDate: '', confidence: 'low' };
    const lines       = text.split('\n').map(l => l.trim()).filter(Boolean);
    const gstins      = [...text.matchAll(/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/gi)].map(m => m[1].toUpperCase());
    const gstin       = gstins[0] || '';
    const invoice     = extractInvoiceNo(lines);
    const amount      = extractAmount(text, lines);
    const vendorRaw   = extractVendor(lines);
    const masterMatch = matchToMaster(vendorRaw);
    const vendor      = masterMatch.matched || vendorRaw;
    const vendorKnown = masterMatch.isKnown;
    const vendorScore = masterMatch.score;
    const invoiceDate = extractInvoiceDate(text, lines);
    const filled      = [gstin, invoice, amount, vendor, invoiceDate].filter(Boolean).length;
    const invoiceOk   = invoice && !isBadInvoiceNo(invoice);
    const confidence  = (filled >= 4 && invoiceOk) ? 'high' : filled >= 2 ? 'medium' : 'low';
    return { vendor, vendorRaw, vendorKnown, vendorScore, invoice, gstin, amount, invoiceDate, confidence };
  }

  // ── main extract one page ─────────────────────────────────────
  async function extractOnePage(b64img) {
    let ocrText = '';
    if (credMode === 'vision') {
      ocrText = await visionOCR(b64img);
    } else {
      ocrText = await claudeOCR(b64img);
    }
    const fields = parseInvoiceText(ocrText);
    return { ...fields, ocrText, cost: credMode === 'vision' ? COST_VISION : COST_CLAUDE };
  }

  // ── parse flexible page range ─────────────────────────────────
  function parsePageRange(input, total) {
    const str = (input || '').trim().toLowerCase();
    if (!str || str === 'all') return Array.from({ length: total }, (_, i) => i + 1);
    const pages = new Set();
    str.split(',').forEach(part => {
      part = part.trim();
      const range = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (range) {
        const a = parseInt(range[1]), b = parseInt(range[2]);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= total) pages.add(i);
      } else {
        const n = parseInt(part);
        if (!isNaN(n) && n >= 1 && n <= total) pages.add(n);
      }
    });
    return [...pages].sort((a, b) => a - b);
  }

  // ── test connection ───────────────────────────────────────────
  const TEST_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';

  async function testConnection(modeSetting, vKey, saJson, cKey) {
    const steps = [];
    const s = (label, ok, detail = '') => steps.push({ label, ok, detail });

    if (modeSetting === 'vision') {
      if (!vKey && !saJson) { s('Credentials provided', false, 'Enter an API key or upload service account JSON'); return steps; }
      s('Credentials provided', true, saJson ? `Service account: ${saJson.client_email}` : 'Plain API key');
      if (saJson) {
        try {
          const pem = saJson.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
          const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
          await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
          s('Private key valid', true, 'RSA key imported successfully');
        } catch (e) { s('Private key valid', false, e.message); return steps; }
        try {
          // temporarily set sa to test
          const prevSa = serviceAccountJson; serviceAccountJson = saJson;
          await getVisionToken();
          serviceAccountJson = prevSa;
          s('OAuth2 token obtained', true, 'Token exchange successful');
        } catch (e) { s('OAuth2 token obtained', false, e.message); return steps; }
      }
      try {
        const tok = saJson ? _oauthToken : null;
        const url = saJson ? 'https://vision.googleapis.com/v1/images:annotate' : `https://vision.googleapis.com/v1/images:annotate?key=${vKey}`;
        const hdr = saJson ? { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}` } : { 'Content-Type': 'application/json' };
        const res = await fetch(url, { method: 'POST', headers: hdr, body: JSON.stringify({ requests: [{ image: { content: TEST_B64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }] }] }) });
        if (res.status === 403) { const e = await res.json().catch(() => ({})); s('Vision API call', false, '403 Forbidden — enable Cloud Vision API in GCP Console. ' + (e?.error?.message || '')); return steps; }
        if (!res.ok) { const e = await res.json().catch(() => ({})); s('Vision API call', false, `HTTP ${res.status}: ${e?.error?.message || ''}`); return steps; }
        s('Vision API call', true, '✓ API responded successfully');
      } catch (e) { s('Vision API call', false, 'Network error: ' + e.message); }
    } else {
      if (!cKey) { s('API key provided', false, 'Enter your Anthropic API key'); return steps; }
      s('API key provided', true, cKey.slice(0, 12) + '…');
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': cKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 20, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: TEST_B64 } }, { type: 'text', text: 'Extract text.' }] }] })
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); s('Claude API call', false, e?.error?.message || `HTTP ${res.status}`); }
        else s('Claude API call', true, '✓ Claude Haiku responded successfully');
      } catch (e) { s('Claude API call', false, 'Network error: ' + e.message); }
    }
    return steps;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Public wrapper: parse fields from raw OCR text only (no API call)
  function parseFromOCR(ocrText) {
    return parseInvoiceText(ocrText || '');
  }

  return {
    setCredentials, hasCred, getCredSummary,
    extractOnePage, parsePageRange, parseFromOCR, testConnection,
    matchToMaster, get supplierMaster() { return SUPPLIER_MASTER; },
    get costPerPage() { return credMode === 'vision' ? COST_VISION : COST_CLAUDE; }
  };
})();
