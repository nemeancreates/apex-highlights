// ================================
// NCMEC CYBERTIPLINE REPORTING API CLIENT
//
// Files one report: submit the report XML, upload each file, send its file
// details, finish. A report that is never finished is deleted by NCMEC after
// about an hour, so any failure after "submit" retracts it. Docs:
// https://report.cybertip.org/ispws/documentation/
//
// Settings (read when used, so a pm2 restart applies a change):
//   NCMEC_API_BASE        https://exttest.cybertip.org/ispws  (test) or
//                         https://report.cybertip.org/ispws   (live)
//   NCMEC_USER / NCMEC_PASS   credentials NCMEC issued for that base
//   NCMEC_REPORTER_EMAIL  required by NCMEC on every report
//   NCMEC_REPORTER_FIRST / NCMEC_REPORTER_LAST   optional
// Nothing here decides WHEN to file; moderation/index.js does (NCMEC_FILE_MODE).
// ================================
const { log } = require('../logger');

const INCIDENT_TYPE = 'Child Pornography (possession, manufacture, and distribution)';

function settings() {
  const e = process.env;
  return {
    base: (e.NCMEC_API_BASE || '').replace(/\/+$/, ''),
    user: e.NCMEC_USER || '', pass: e.NCMEC_PASS || '',
    email: e.NCMEC_REPORTER_EMAIL || '',
    first: e.NCMEC_REPORTER_FIRST || '', last: e.NCMEC_REPORTER_LAST || ''
  };
}
function configured() {
  const s = settings();
  return !!(/^https:\/\//.test(s.base) && s.user && s.pass && s.email);
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (name, value) => (value == null || value === '' ? '' : `<${name}>${esc(value)}</${name}>`);

// The report document. Element order follows the page's example and field
// list; the live XSD is checked in the test environment (ncmec-check.js).
function reportXml({ incidentAt, url, screenName, espIdentifier, espService, info }) {
  const s = settings();
  const when = new Date(incidentAt || Date.now() - 5000).toISOString();
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<report xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://report.cybertip.org/ispws/xsd">' +
    '<incidentSummary>' + tag('incidentType', INCIDENT_TYPE) + tag('incidentDateTime', when) + '</incidentSummary>' +
    (url ? '<internetDetails><webPageIncident>' + tag('url', url) + '</webPageIncident></internetDetails>' : '') +
    '<reporter><reportingPerson>' + tag('firstName', s.first) + tag('lastName', s.last) + tag('email', s.email) + '</reportingPerson></reporter>' +
    '<personOrUserReported>' + tag('espIdentifier', espIdentifier) + tag('espService', espService) + tag('screenName', screenName) + '</personOrUserReported>' +
    tag('additionalInfo', String(info || '').slice(0, 2900)) +
    '</report>';
}

function fileDetailsXml({ reportId, fileId, name, info }) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<fileDetails>' +
    tag('reportId', reportId) + tag('fileId', fileId) + tag('originalFileName', name) +
    '<fileViewedByEsp>false</fileViewedByEsp>' +
    tag('additionalInfo', String(info || '').slice(0, 2900)) + '</fileDetails>';
}

// One response: HTTP status plus the fields the API returns. ok means HTTP 2xx
// and responseCode 0.
function parse(status, text) {
  const pick = (name) => { const m = text.match(new RegExp(`<${name}>([^<]*)</${name}>`)); return m ? m[1] : null; };
  const code = pick('responseCode');
  return {
    ok: status >= 200 && status < 300 && code === '0',
    status, code, description: pick('responseDescription'),
    reportId: pick('reportId'), fileId: pick('fileId'), hash: pick('hash')
  };
}

async function call(path, init, requestId) {
  const s = settings();
  const headers = { Authorization: 'Basic ' + Buffer.from(`${s.user}:${s.pass}`).toString('base64'), ...(init.headers || {}) };
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(s.base + path, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs || 60000) });
      const text = await res.text();
      const out = parse(res.status, text);
      out.requestId = res.headers.get('request-id') || null;
      if (res.status < 500) return out;          // a refusal is final; only server trouble is retried
      last = out;
    } catch (err) {
      last = { ok: false, status: 0, code: null, description: err.message, requestId: null };
    }
    await new Promise(r => setTimeout(r, 1000 * attempt));
  }
  log('warn', 'ncmec_call_failed', { path, status: last.status, code: last.code, description: last.description, requestId: last.requestId });
  return last;
}

const xmlInit = (xml) => ({ method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml });
function formInit(fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (file) form.append('file', new Blob([file.buffer], { type: file.type || 'application/octet-stream' }), file.name);
  return { method: 'POST', body: form, timeoutMs: 5 * 60000 };
}
const why = (r) => `HTTP ${r.status}${r.code ? ` code ${r.code}` : ''}${r.description ? ` (${r.description})` : ''}${r.requestId ? ` Request-ID ${r.requestId}` : ''}`;

// report: the reportXml fields. files: [{ name, buffer, type?, info? }].
// Resolves { ok:true, reportId, files:n } or { ok:false, error, reportId? }.
// Never throws, and never leaves an unfinished report open.
async function fileReport(report, files = []) {
  if (!configured()) return { ok: false, error: 'NCMEC settings are incomplete' };
  const sub = await call('/submit', xmlInit(reportXml(report)));
  if (!sub.ok || !sub.reportId) return { ok: false, error: `submit failed: ${why(sub)}` };
  const reportId = sub.reportId;
  const abandon = async (error) => {
    const r = await call('/retract', formInit({ id: reportId }));
    log('warn', 'ncmec_report_retracted', { reportId, error, retracted: r.ok });
    return { ok: false, error, reportId };
  };
  let sent = 0;
  for (const f of files) {
    const up = await call('/upload', formInit({ id: reportId }, f));
    if (!up.ok || !up.fileId) return abandon(`upload failed for ${f.name}: ${why(up)}`);
    const det = await call('/fileinfo', xmlInit(fileDetailsXml({ reportId, fileId: up.fileId, name: f.name, info: f.info })));
    if (!det.ok) return abandon(`file details failed for ${f.name}: ${why(det)}`);
    sent++;
  }
  const fin = await call('/finish', formInit({ id: reportId }));
  if (!fin.ok) return abandon(`finish failed: ${why(fin)}`);
  log('warn', 'ncmec_report_filed', { reportId, files: sent, requestId: fin.requestId });
  return { ok: true, reportId: fin.reportId || reportId, files: sent };
}

// GET /status (or /xsd) with the configured credentials: a quick access check.
async function get(path) {
  const s = settings();
  const res = await fetch(s.base + path, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${s.user}:${s.pass}`).toString('base64') },
    signal: AbortSignal.timeout(30000)
  });
  return { status: res.status, text: await res.text() };
}

module.exports = { configured, settings, reportXml, fileDetailsXml, fileReport, get };
