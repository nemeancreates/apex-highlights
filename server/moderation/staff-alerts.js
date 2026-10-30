// ================================
// STAFF ALERTS — posts moderation events to the private staff Discord
// channel through a channel webhook (Channel Settings > Integrations >
// Webhooks > New Webhook > Copy URL), set as DISCORD_STAFF_WEBHOOK_URL.
//
// A webhook rather than the role-sync bot: it needs no extra bot
// permissions, can attach the case PDF, and can only ever post to the one
// channel it was made for.
//
// Never throws and never blocks the request that triggered it — a Discord
// outage must not stop a report from being saved or a listing being hidden.
// ================================
const { log } = require('../logger');

const WEBHOOK = process.env.DISCORD_STAFF_WEBHOOK_URL || null;
// Optional: a role to @mention on urgent alerts (CSAM flags), e.g. "123456".
const URGENT_ROLE_ID = process.env.DISCORD_STAFF_ROLE_ID || null;

const COLORS = { info: 0x39d3a0, warn: 0xd8a838, urgent: 0xd8405a };

function enabled() { return !!WEBHOOK; }

// fields: [{ name, value, inline? }] — values are trimmed to Discord's limits.
// buttons: { kind: 'pc' | 'm', id, caseId, csam } for alerts staff decide on.
// With the Discord bot set up (discord-actions.js) those go out from the bot
// with Approve / Remove / Report buttons; everything else, and any bot
// failure, goes through the webhook.
async function postStaffAlert({ title, description, level = 'info', fields = [], pdf = null, pdfName = 'case.pdf', buttons = null }) {
  const urgent = level === 'urgent' && URGENT_ROLE_ID;
  const payload = {
    username: 'Peakabu Moderation',
    content: urgent ? `<@&${URGENT_ROLE_ID}>` : undefined,
    allowed_mentions: urgent ? { roles: [URGENT_ROLE_ID] } : { parse: [] },
    embeds: [{
      title: String(title).slice(0, 256),
      description: description ? String(description).slice(0, 4000) : undefined,
      color: COLORS[level] || COLORS.info,
      fields: fields.slice(0, 25).map(f => ({
        name: String(f.name).slice(0, 256),
        value: String(f.value == null || f.value === '' ? '-' : f.value).slice(0, 1024),
        inline: !!f.inline
      })),
      timestamp: new Date().toISOString()
    }]
  };

  if (buttons) {
    const actions = require('./discord-actions');
    if (actions.enabled() && await actions.postAlert(payload, { pdf, pdfName, buttons })) return true;
  }
  if (!WEBHOOK) {
    log('warn', 'staff_alert_skipped', { reason: 'DISCORD_STAFF_WEBHOOK_URL not set', title });
    return false;
  }

  try {
    let res;
    if (pdf) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      form.append('files[0]', new Blob([pdf], { type: 'application/pdf' }), pdfName);
      res = await fetch(WEBHOOK + '?wait=true', { method: 'POST', body: form });
    } else {
      res = await fetch(WEBHOOK + '?wait=true', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
    }
    if (!res.ok) {
      log('warn', 'staff_alert_failed', { status: res.status, title });
      return false;
    }
    return true;
  } catch (err) {
    log('warn', 'staff_alert_failed', { error: err.message, title });
    return false;
  }
}

module.exports = { postStaffAlert, staffAlertsEnabled: enabled };
