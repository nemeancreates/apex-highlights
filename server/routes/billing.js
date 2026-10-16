// ================================
// BILLING — Stripe Checkout for Peakabu Mobile, sold on the website so
// app stores take no cut. No accounts needed to buy: the buyer gets a
// redemption code (redemption.js) and redeems it in the PC client or the
// mobile host page, both of which go through POST /auth/redeem.
//
//   mobile1  $5  -> 30 days of Mobile
//   mobile3  $12 -> 90 days of Mobile
//   event    $3  -> one event pass: a date + window of up to 16h
//
// Email is optional. If the buyer types one in (before checkout, or on the
// success page) we send the code there once and never store the address.
// Stripe's own checkout page always asks for an email for its receipt;
// that copy lives with Stripe, not here (see privacy.html, section 3).
//
// Fulfilment is idempotent: one code per Stripe checkout session, found
// again by the note "stripe:<checkout id>". The webhook and the success
// page both call fulfil(), whichever gets there first wins.
// ================================
const express = require('express');
const db = require('../db');
const { log } = require('../logger');
const { safeError } = require('../utils');
const { createRateLimiter } = require('../ratelimit');
const { generateRedemptionCodes, findCodeByNote } = require('../redemption');
const { EVENT_MAX_HOURS } = require('../mobile');

const PLANS = {
  mobile1: { cents: 500,  days: 30, label: 'Peakabu Mobile, 1 month' },
  mobile3: { cents: 1200, days: 90, label: 'Peakabu Mobile, 3 months' }
};
const EVENT_CENTS = 300;
const MAX_EMAILS_PER_PURCHASE = 3;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const BILLING_BASE_URL = (process.env.BILLING_BASE_URL || 'https://peakabu.app').replace(/\/$/, '');

let stripe = null;
if (STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(STRIPE_SECRET_KEY); } catch (e) { console.warn('Billing disabled: run npm install (stripe package missing)'); }
} else {
  console.warn('Billing disabled: STRIPE_SECRET_KEY not set in .env');
}

// --- Optional email over SMTP (Zoho). Nothing is configured = no email box.
let mailer = null;
if (process.env.SMTP_HOST) {
  try {
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT || 465);
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;
    mailer = { send: ({ to, subject, text }) => t.sendMail({ from, to, subject, text }) };
  } catch (e) { console.warn('Billing email disabled: nodemailer package missing'); }
}

// Send counts per purchase only. The address itself is never written down.
db.exec(`
  CREATE TABLE IF NOT EXISTS billing_email_sends (
    checkoutId TEXT PRIMARY KEY,
    sends      INTEGER NOT NULL DEFAULT 0,
    autoSent   INTEGER NOT NULL DEFAULT 0
  );
`);
const stmt = {
  get:    db.prepare(`SELECT * FROM billing_email_sends WHERE checkoutId = ?`),
  bump:   db.prepare(`INSERT INTO billing_email_sends (checkoutId, sends) VALUES (?, 1)
                      ON CONFLICT(checkoutId) DO UPDATE SET sends = sends + 1`),
  auto:   db.prepare(`INSERT INTO billing_email_sends (checkoutId, autoSent) VALUES (?, 1)
                      ON CONFLICT(checkoutId) DO UPDATE SET autoSent = 1`)
};

const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[a-z]{2,}$/i;
function cleanEmail(e) {
  const s = String(e ?? '').trim();
  if (!s) return '';
  return EMAIL_RE.test(s) && s.length <= 254 ? s : null; // null = invalid
}

// One code per paid checkout. Returns { code, product, days?, startsAt?, hours? } or null.
function fulfil(session) {
  if (!session || session.payment_status !== 'paid') return null;
  const md = session.metadata || {};
  const note = 'stripe:' + session.id;
  let code = findCodeByNote(note);
  if (md.product === 'mobile') {
    const plan = PLANS[md.plan];
    if (!plan) return null;
    if (!code) {
      [code] = generateRedemptionCodes({ tier: 'mobile', note, maxUses: 1, quantity: 1, durationDays: plan.days });
      log('info', 'billing_code_issued', { checkout: session.id, product: 'mobile', days: plan.days });
    }
    return { code, product: 'mobile', days: plan.days };
  }
  if (md.product === 'event') {
    const startsAt = Number(md.startsAt), hours = Number(md.hours);
    if (!Number.isFinite(startsAt) || !Number.isFinite(hours)) return null;
    if (!code) {
      [code] = generateRedemptionCodes({ tier: 'event', note, maxUses: 1, quantity: 1, meta: { startsAt, hours } });
      log('info', 'billing_code_issued', { checkout: session.id, product: 'event', startsAt, hours });
    }
    return { code, product: 'event', startsAt, hours };
  }
  return null;
}

function messageFor(out) {
  const tail = '\n\nRedeem it while signed in to Peak-Abu: in the PC client under Redeem, or on the Peakabu Mobile host page.\n' +
    'Codes are single use. Keep this email until you have redeemed it.\n\n' +
    'We do not keep your email address. It was used only to send this message.';
  if (out.product === 'mobile') {
    return { subject: 'Your Peakabu Mobile code', text: `Your Peakabu Mobile code (${out.days} days):\n\n    ${out.code}${tail}` };
  }
  return {
    subject: 'Your Peakabu event pass',
    text: `Your Peakabu event pass (${out.hours}h starting ${new Date(out.startsAt).toUTCString()}):\n\n    ${out.code}` +
      `${tail}\n\nOnce redeemed, pick the pass when you start a Mobile session to unlock Peak Spots QR codes for the event.`
  };
}

async function sendCode(checkoutId, out, to) {
  const row = stmt.get.get(checkoutId);
  if (row && row.sends >= MAX_EMAILS_PER_PURCHASE) throw Object.assign(new Error('email_limit'), { status: 429 });
  stmt.bump.run(checkoutId);
  await mailer.send({ to, ...messageFor(out) });
}

const checkoutLimiter = createRateLimiter({ windowMs: 60000, max: 10 });
const lookupLimiter   = createRateLimiter({ windowMs: 60000, max: 40 });
const emailLimiter    = createRateLimiter({ windowMs: 60000, max: 6 });

// Must be mounted BEFORE app.use(express.json()) — Stripe signs the raw body.
function initBillingWebhook(app) {
  app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).end();
    let evt;
    try {
      evt = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      log('warn', 'billing_webhook_bad_signature', { error: err.message });
      return res.status(400).send('Bad signature');
    }
    if (evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded') {
      const session = evt.data.object;
      const out = fulfil(session);
      const to = session.customer_details && session.customer_details.email;
      const row = stmt.get.get(session.id);
      // Email only when the buyer asked for it on OUR page (sendEmail=1).
      if (out && mailer && to && session.metadata?.sendEmail === '1' && !(row && row.autoSent)) {
        stmt.auto.run(session.id);
        sendCode(session.id, out, to).catch(err => log('warn', 'billing_email_failed', { error: err.message }));
      }
    }
    res.json({ received: true });
  });
}

function initBillingRoutes(app) {
  app.get('/billing', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(require('path').join(__dirname, '..', '..', 'public', 'billing.html'));
  });

  app.get('/api/billing/config', (req, res) => {
    res.json({
      enabled: !!stripe,
      emailEnabled: !!mailer,
      plans: Object.entries(PLANS).map(([id, p]) => ({ id, cents: p.cents, days: p.days, label: p.label })),
      event: { cents: EVENT_CENTS, maxHours: EVENT_MAX_HOURS }
    });
  });

  app.post('/api/billing/checkout', checkoutLimiter, async (req, res) => {
    if (!stripe) return safeError(res, 503, 'Payments aren\'t set up yet.');
    const { product, plan, startsAt, hours } = req.body || {};
    const email = cleanEmail(req.body?.email);
    if (email === null) return safeError(res, 400, 'That email doesn\'t look right. Fix it or leave it blank.');

    let item, metadata;
    if (product === 'mobile') {
      const p = PLANS[plan];
      if (!p) return safeError(res, 400, 'Unknown plan');
      item = { name: p.label, cents: p.cents };
      metadata = { product: 'mobile', plan };
    } else if (product === 'event') {
      const start = Number(startsAt);
      const h = Number(hours);
      if (!Number.isFinite(start) || start < Date.now() - 10 * 60000 || start > Date.now() + 365 * 86400000) {
        return safeError(res, 400, 'Pick a start time in the future (within a year).');
      }
      if (!Number.isFinite(h) || h < 0.5 || h > EVENT_MAX_HOURS) return safeError(res, 400, `Events run up to ${EVENT_MAX_HOURS} hours.`);
      item = { name: `Peakabu event pass (${h}h)`, cents: EVENT_CENTS };
      metadata = { product: 'event', startsAt: String(Math.round(start)), hours: String(h) };
    } else {
      return safeError(res, 400, 'Unknown product');
    }
    metadata.sendEmail = email ? '1' : '0';

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: item.cents, product_data: { name: item.name } } }],
        metadata,
        ...(email ? { customer_email: email } : {}),
        success_url: `${BILLING_BASE_URL}/billing-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${BILLING_BASE_URL}/billing`
      });
      res.json({ url: session.url });
    } catch (err) {
      log('error', 'billing_checkout_failed', { error: err.message });
      safeError(res, 502, 'Couldn\'t start checkout. Try again.');
    }
  });

  // The success page polls this. Checks with Stripe directly, so it works
  // even if the webhook is slow or misconfigured.
  app.get('/api/billing/session/:id', lookupLimiter, async (req, res) => {
    if (!stripe) return safeError(res, 503, 'Payments aren\'t set up yet.');
    const id = String(req.params.id || '');
    if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) return safeError(res, 400, 'Bad session');
    try {
      const session = await stripe.checkout.sessions.retrieve(id);
      const out = fulfil(session);
      if (!out) return res.json({ status: 'pending' });
      res.json({ status: 'ready', ...out });
    } catch (err) {
      safeError(res, 404, 'Not found');
    }
  });

  app.post('/api/billing/session/:id/email', emailLimiter, async (req, res) => {
    if (!stripe) return safeError(res, 503, 'Payments aren\'t set up yet.');
    if (!mailer) return safeError(res, 503, 'Email isn\'t set up.');
    const id = String(req.params.id || '');
    if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) return safeError(res, 400, 'Bad session');
    const to = cleanEmail(req.body?.email);
    if (!to) return safeError(res, 400, 'Check the email address.');
    let session;
    try { session = await stripe.checkout.sessions.retrieve(id); } catch (e) { return safeError(res, 404, 'Not found'); }
    const out = fulfil(session);
    if (!out) return safeError(res, 409, 'Payment not confirmed yet.');
    try {
      await sendCode(id, out, to);
      res.json({ sent: true });
    } catch (err) {
      if (err.status === 429) return safeError(res, 429, 'Send limit reached for this purchase.');
      log('warn', 'billing_email_failed', { error: err.message });
      safeError(res, 502, 'Couldn\'t send. Copy the code instead.');
    }
  });
}

module.exports = { initBillingWebhook, initBillingRoutes, fulfil, PLANS, EVENT_CENTS, _setStripeForTest: (s) => { stripe = s; }, _setMailerForTest: (m) => { mailer = m; } };
