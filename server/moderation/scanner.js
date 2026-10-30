// ================================
// SCANNER — automated checks run before a session can go public, and again
// on any clip added to a public session afterwards.
//
// Two independent layers, both optional and both off until configured:
//
// 1. CSAM HASH MATCHING — Cloudflare's free CSAM Scanning Tool.
//    Cloudflare fuzzy-hashes images served through your zone against NCMEC's
//    known-CSAM lists and blocks a match with HTTP 451. Turn it on in the
//    Cloudflare dashboard for the domain that serves your R2 media, then set
//    CSAM_SCAN_BASE_URL to that domain (e.g. https://media.peakabu.app).
//    We request each clip thumbnail through that domain; a 451 means the
//    image matched, and the session goes down the CSAM path.
//    Matching runs on images Cloudflare serves, so a first request can be
//    let through before the scan result lands — the 5-minute sweep re-checks.
//
// 2. CONTENT CLASSIFIER — OpenAI's free Moderation API (omni-moderation),
//    set OPENAI_MODERATION_KEY. Catches adult sexual content and graphic
//    violence in thumbnails. A flag hides the listing and asks staff to
//    review; it does NOT ban anyone on its own. It cannot detect CSAM (its
//    child-safety category is text-only), which is why layer 1 exists.
//
// Thumbnails only: one frame per clip. Video frames aren't scanned yet.
// Peakabu Mobile listings get the same two layers on every clip thumbnail
// and every photo, before the listing can show (see mobile.js).
// ================================
const { log } = require('../logger');

const CSAM_BASE = (process.env.CSAM_SCAN_BASE_URL || '').replace(/\/+$/, '') || null;
const MEDIA_BASE = (require('../config').SPACES_CDN_BASE || '').replace(/\/+$/, '') || null;
const OPENAI_KEY = process.env.OPENAI_MODERATION_KEY || null;
const CLASSIFIER_THRESHOLD = Number(process.env.MODERATION_SCORE_THRESHOLD || 0.6);
const FLAG_CATEGORIES = ['sexual', 'violence/graphic', 'self-harm'];

function configured() {
  return { hashMatch: !!CSAM_BASE, classifier: !!OPENAI_KEY };
}
// With no scanner set up, public listings stay "checking" and never show,
// unless ALLOW_UNSCANNED_PUBLIC=1 (only for local testing).
const ALLOW_UNSCANNED = process.env.ALLOW_UNSCANNED_PUBLIC === '1';
function unscannedAllowed() { return ALLOW_UNSCANNED; }

// Thumbnail URL as stored, plus the same object via the scanning domain.
function thumbUrls(code, upload) {
  let url = upload.thumbnailUrl || null;
  if (!url && upload.thumbnailKey && MEDIA_BASE) url = MEDIA_BASE + '/' + upload.thumbnailKey;
  let scanUrl = null;
  if (CSAM_BASE) {
    if (upload.thumbnailKey) scanUrl = CSAM_BASE + '/' + upload.thumbnailKey;
    else if (url && MEDIA_BASE && url.startsWith(MEDIA_BASE)) scanUrl = CSAM_BASE + url.slice(MEDIA_BASE.length);
  }
  return { url, scanUrl };
}

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// --- Layer 1 ---
async function hashMatch(scanUrl) {
  if (!scanUrl) return { checked: false };
  try {
    const res = await fetchWithTimeout(scanUrl, { method: 'GET' });
    try { await res.arrayBuffer(); } catch (e) {}
    if (res.status === 451) return { checked: true, match: true };
    return { checked: res.ok, match: false, status: res.status };
  } catch (err) {
    return { checked: false, error: err.message };
  }
}

// --- Layer 2 ---
async function classify(url) {
  if (!OPENAI_KEY || !url) return { checked: false };
  try {
    const res = await fetchWithTimeout('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({
        model: 'omni-moderation-latest',
        input: [{ type: 'image_url', image_url: { url } }]
      })
    }, 20000);
    if (!res.ok) return { checked: false, error: 'HTTP ' + res.status };
    const data = await res.json();
    const r = data.results && data.results[0];
    if (!r) return { checked: false, error: 'empty result' };
    const hits = FLAG_CATEGORIES
      .filter(c => (r.category_scores && r.category_scores[c] || 0) >= CLASSIFIER_THRESHOLD)
      .map(c => ({ category: c, score: Math.round(r.category_scores[c] * 1000) / 1000 }));
    return { checked: true, flagged: hits.length > 0, hits };
  } catch (err) {
    return { checked: false, error: err.message };
  }
}

// Scans one clip. Result:
//   { verdict: 'clean' | 'csam' | 'review' | 'unscanned', detail }
// 'unscanned' = no layer could check it (not configured, or no thumbnail).
async function scanUpload(code, upload) {
  return scanImage(thumbUrls(code, upload));
}

// Same two layers on any image. url = what the classifier fetches; scanUrl =
// the same image through the Cloudflare zone with CSAM Scanning turned on.
// Peakabu Mobile uses this for its clip thumbnails and photos (mobile.js).
async function scanImage({ url, scanUrl }) {
  const hm = await hashMatch(scanUrl);
  if (hm.match) return { verdict: 'csam', detail: 'Cloudflare CSAM Scanning Tool hash match (HTTP 451)' };
  // Never send a hash-matched image anywhere else; only unmatched ones
  // reach the classifier.
  const cl = await classify(url);
  if (cl.flagged) {
    return { verdict: 'review', detail: 'Classifier: ' + cl.hits.map(h => `${h.category} ${h.score}`).join(', ') };
  }
  if (!hm.checked && !cl.checked) {
    return { verdict: 'unscanned', detail: [hm.error, cl.error].filter(Boolean).join('; ') || (url ? 'no scanner configured' : 'no thumbnail') };
  }
  return { verdict: 'clean', detail: [hm.checked ? 'hash: no match' : null, cl.checked ? 'classifier: ok' : null].filter(Boolean).join(', ') };
}

function logStartup() {
  const c = configured();
  log('info', 'moderation_scanner_ready', {
    csamHashMatch: c.hashMatch, classifier: c.classifier,
    note: (!c.hashMatch && !c.classifier)
      ? (ALLOW_UNSCANNED ? 'No scanners configured and ALLOW_UNSCANNED_PUBLIC=1: public listings go live WITHOUT automated checks'
                         : 'No scanners configured: public listings stay hidden ("checking") until OPENAI_MODERATION_KEY and/or CSAM_SCAN_BASE_URL is set')
      : undefined
  });
}

module.exports = { scanUpload, scanImage, thumbUrls, scannerConfigured: configured, unscannedAllowed, logScannerStartup: logStartup };
