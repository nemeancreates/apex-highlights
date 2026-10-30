// ================================
// DISCORD ACTIONS — buttons on staff alerts, so staff decide in Discord.
//
// Alerts staff can act on (scan flags, reports, CSAM cases) are posted by the
// bot instead of the webhook, with buttons. Discord sends each click to
// POST /discord/interactions signed with the app's Ed25519 key; anything
// not signed by Discord is refused. Only members with DISCORD_STAFF_ROLE_ID
// (or server admins) can use them, and only in the staff channel.
//
//   Approve   back on Browse; flags and reports cleared
//   Remove    stays hidden; the host gets a strike (3 = no public posting)
//   Report    asks to confirm, then the CSAM path: legal hold, host banned
//             from public posting, urgent case posted with its PDF
//   Record CyberTip report  (on CSAM cases) staff enter the CyberTipline
//             report number once filed; it's kept with the case
//
// Once decided, the alert shows who did what and loses its buttons.
//
// Setup (.env): DISCORD_BOT_TOKEN (the role-sync bot), DISCORD_PUBLIC_KEY
// (Developer Portal > the app > General Information > Public Key),
// DISCORD_STAFF_CHANNEL_ID and DISCORD_STAFF_ROLE_ID. Then set the app's
// Interactions Endpoint URL to https://peakabu.app/discord/interactions. The
// bot needs View Channel, Send Messages, Embed Links and Attach Files in the
// staff channel. Until all four are set, alerts use the webhook as before.
// ================================
const crypto = require('crypto');
const express = require('express');
const { log } = require('../logger');

const API = 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_BOT_TOKEN || null;
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || null;
const CHANNEL = process.env.DISCORD_STAFF_CHANNEL_ID || null;
const ROLE = process.env.DISCORD_STAFF_ROLE_ID || null;
const GUILD = process.env.DISCORD_GUILD_ID || null;

const EPHEMERAL = 64;   // message flag: only the person who clicked sees it

function enabled() { return !!(TOKEN && PUBLIC_KEY && CHANNEL && ROLE); }

// --- Discord's signature on every interaction (Ed25519 over timestamp + body).
let verifyKey = null;
function signedByDiscord(req) {
  const sig = req.get('x-signature-ed25519');
  const ts = req.get('x-signature-timestamp');
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig) || !Buffer.isBuffer(req.body)) return false;
  if (!(Math.abs(Date.now() / 1000 - Number(ts)) < 300)) return false;   // no replays of old clicks
  try {
    if (!verifyKey) {
      verifyKey = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(PUBLIC_KEY, 'hex')]),
        format: 'der', type: 'spki'
      });
    }
    return crypto.verify(null, Buffer.concat([Buffer.from(ts), req.body]), verifyKey, Buffer.from(sig, 'hex'));
  } catch (e) {
    return false;
  }
}

async function api(method, path, body) {
  const form = body instanceof FormData;
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${TOKEN}`, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: form ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Discord ${method}: HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// --- Buttons. custom_id is pa:<action>:<kind>:<id>[:<extra>]. kind: 'pc' (a
// desktop session code) or 'm' (a Peakabu Mobile listing id). extra: the case
// id (CyberTip) or the alert's message id (CSAM confirm).
const button = (style, emoji, label, customId) =>
  ({ type: 2, style, emoji: { name: emoji }, label, custom_id: customId.slice(0, 100) });

function buttonsFor({ kind, id, caseId, csam }) {
  const t = `${kind}:${id}`;
  if (csam) return [{ type: 1, components: [button(1, '📝', 'Record CyberTip report', `pa:tip:${t}:${caseId || ''}`)] }];
  return [{ type: 1, components: [
    button(3, '✅', 'Approve', `pa:restore:${t}`),
    button(4, '❌', 'Remove', `pa:remove:${t}`),
    button(2, '🚔', 'Report CSAM', `pa:csam:${t}`)
  ] }];
}

// payload: the webhook payload staff-alerts.js built. false if it didn't go.
async function postAlert(payload, { pdf, pdfName, buttons }) {
  const body = { content: payload.content, allowed_mentions: payload.allowed_mentions, embeds: payload.embeds, components: buttonsFor(buttons) };
  try {
    let form = null;
    if (pdf) {
      form = new FormData();
      form.append('payload_json', JSON.stringify(body));
      form.append('files[0]', new Blob([pdf], { type: 'application/pdf' }), pdfName);
    }
    await api('POST', `/channels/${CHANNEL}/messages`, form || body);
    return true;
  } catch (err) {
    log('warn', 'discord_alert_failed', { error: err.message });
    return false;
  }
}

// --- Who clicked.
function isStaff(it) {
  const m = it.member;
  const channel = it.channel_id || (it.channel && it.channel.id);
  if (!m || channel !== CHANNEL || (GUILD && it.guild_id !== GUILD)) return false;
  if ((m.roles || []).includes(ROLE)) return true;
  try { return (BigInt(m.permissions || '0') & 8n) === 8n; } catch (e) { return false; }   // Administrator
}
function clicker(it) {
  const u = (it.member && it.member.user) || it.user || {};
  return { name: u.global_name || u.username || 'unknown', tag: `discord:${u.username || u.id || 'unknown'}` };
}

// A text box's value from a modal submit (rows of components, or labels).
function modalValue(it, customId) {
  const walk = (list) => {
    for (const c of list || []) {
      if (c.custom_id === customId && typeof c.value === 'string') return c.value;
      const inner = walk(c.components || (c.component ? [c.component] : []));
      if (inner != null) return inner;
    }
    return null;
  };
  return walk(it.data && it.data.components) || '';
}

// Fills in the "thinking…" reply. A fast action can finish before Discord has
// registered our acknowledgement, which makes it answer 404, so a refusal is
// retried a few times and logged if it never goes through.
async function answer(it, content) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${API}/webhooks/${it.application_id}/${it.token}/messages/@original`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }), signal: AbortSignal.timeout(15000)
      });
      if (res.ok) return;
      log('warn', 'discord_answer_failed', { status: res.status, attempt });
    } catch (err) {
      log('warn', 'discord_answer_failed', { error: err.message, attempt });
    }
    await new Promise(r => setTimeout(r, 400 * attempt));
  }
}

// --- The decision, after Discord has been answered.
async function finish(it, { action, kind, id, extra, alertId, by }) {
  let reply;
  let decision = null;
  let keepButtons = false;
  const code = (kind === 'm' ? 'm-' : '') + id;
  if (action === 'tipsave') {
    const number = modalValue(it, 'number').trim();
    if (!/^[A-Za-z0-9-]{3,40}$/.test(number)) {
      reply = 'That doesn\'t look like a report number (letters, digits and dashes only). Nothing was saved.';
    } else {
      require('./index').recordTipReport(extra || null, code, number, by.tag);
      reply = `Saved CyberTip report ${number} with case ${extra || code}.`;
      decision = `📝 CyberTip report **${number}** recorded by ${by.name}`;
      keepButtons = true;   // a typo can be corrected by entering it again
    }
  } else {
    const act = action === 'csamok' ? 'csam' : action;
    const pub = require('../routes/public');
    const opts = { by: by.tag, note: act === 'csam' ? `Confirmed by ${by.name} in Discord` : act === 'remove' ? `Removed by ${by.name} in Discord` : null };
    const r = kind === 'pc' ? await pub.pcStaffAction(id, act, opts) : await pub.mobileStaffAction(id, act, opts);
    if (!r.ok) {
      reply = `Couldn't do that: ${r.error}`;
    } else if (act === 'restore') {
      reply = 'Approved. It shows on Browse again.';
      decision = `✅ Approved by ${by.name}`;
    } else if (act === 'remove') {
      reply = r.host ? `Removed. ${r.host} has ${r.strikes} strike${r.strikes === 1 ? '' : 's'}${r.bannedFromPublic ? ' and is banned from public posting' : ''}.` : 'Removed.';
      decision = `❌ Removed by ${by.name}`;
    } else {
      reply = 'Reported. Legal hold placed and the host is banned from public posting. The urgent case with its PDF is posted in this channel: file it with NCMEC, then record the report number on it.';
      decision = `🚔 Reported as apparent CSAM by ${by.name}`;
    }
  }
  log('info', 'discord_staff_action', { action, kind, id, by: by.tag, ok: !!decision });
  await answer(it, reply);
  if (decision && alertId) await markAlert(alertId, decision, keepButtons);
}

// Adds the decision to the alert and (unless keepButtons) takes its buttons
// away, so nobody acts on it twice.
async function markAlert(messageId, decision, keepButtons) {
  try {
    const msg = await api('GET', `/channels/${CHANNEL}/messages/${messageId}`);
    const embeds = (msg.embeds || []).slice(0, 10);
    if (embeds[0]) {
      embeds[0].fields = [...(embeds[0].fields || []),
        { name: 'Decision', value: `${decision} · <t:${Math.floor(Date.now() / 1000)}:f>` }].slice(0, 25);
    }
    await api('PATCH', `/channels/${CHANNEL}/messages/${messageId}`, keepButtons ? { embeds } : { embeds, components: [] });
  } catch (err) {
    log('warn', 'discord_alert_update_failed', { error: err.message });
  }
}

// --- The endpoint. Mounted above express.json: the signature covers the raw body.
function initDiscordInteractions(app) {
  app.post('/discord/interactions', express.raw({ type: '*/*', limit: '64kb' }), (req, res) => {
    if (!enabled() || !signedByDiscord(req)) return res.status(401).end('invalid request signature');
    let it;
    try { it = JSON.parse(req.body.toString('utf8')); } catch (e) { return res.status(400).end(); }
    if (it.type === 1) return res.json({ type: 1 });   // Discord checking the endpoint

    const say = (content) => res.json({ type: 4, data: { content, flags: EPHEMERAL } });
    const [pa, action, kind, id, extra] = String((it.data && it.data.custom_id) || '').split(':');
    if (pa !== 'pa' || (kind !== 'pc' && kind !== 'm') || !id) return say('That button is out of date.');
    if (!isStaff(it)) return say('Only staff can do that.');
    const by = clicker(it);

    if (it.type === 3 && action === 'csam') {
      return res.json({ type: 4, data: {
        flags: EPHEMERAL,
        content: `Report **${id}** as apparent CSAM? This places a legal hold (kept as evidence, hidden from everyone), bans the host from public posting and posts an urgent case with its report PDF. Only confirm if it shows a child being sexually abused or exploited.`,
        components: [{ type: 1, components: [button(4, '🚔', 'Yes, report it', `pa:csamok:${kind}:${id}:${it.message.id}`)] }]
      } });
    }
    if (it.type === 3 && action === 'tip') {
      return res.json({ type: 9, data: {
        custom_id: `pa:tipsave:${kind}:${id}:${extra || ''}`.slice(0, 100),
        title: 'CyberTipline report',
        components: [{ type: 1, components: [{ type: 4, custom_id: 'number', style: 1, label: 'Report number from NCMEC', min_length: 3, max_length: 40, required: true }] }]
      } });
    }
    const known = it.type === 3 ? ['restore', 'remove', 'csamok'] : it.type === 5 ? ['tipsave'] : [];
    if (!known.includes(action)) return say('That button is out of date.');

    // Answer within Discord's 3 seconds ("thinking…", only the clicker sees
    // it), then do the work and fill the answer in.
    res.json({ type: 5, data: { flags: EPHEMERAL } });
    const alertId = action === 'csamok' ? extra : it.message && it.message.id;
    finish(it, { action, kind, id, extra, alertId, by })
      .catch(err => log('warn', 'discord_action_failed', { action, kind, id, error: err.message }));
  });
}

module.exports = { enabled, postAlert, initDiscordInteractions };
