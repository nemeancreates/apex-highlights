// ================================
// ENTITLEMENTS — how codes and subscriptions turn into plan time.
//
// One place decides what a redeemed code or a Stripe subscription does to
// an account, so the PC client, the website and the mobile host page all
// get the same answer.
//
// TIMED PC CODES (no subscription on the account)
//   - Same tier as the active plan: its days are ADDED to the end.
//   - Higher tier: upgrades now. Leftover days are converted by price
//     (30 Creator days at $10/mo become 15 Squad days at $20/mo) and added.
//   - Lower tier: refused while the higher plan runs (redeem it after).
//   - Lifetime plan (no expiry): refused, nothing to add to.
//   Mobile codes always add days; event passes just land on the account.
//
// SUBSCRIPTIONS (Creator, Squad, Pro, Mobile host — billed monthly by Stripe)
//   - Checkout issues a single-use code (tier "sub"). Redeeming it LINKS the
//     subscription to that username. We never learn the buyer's email;
//     Stripe keeps that for its own receipts.
//   - While linked, the plan runs to the end of the paid period + a short
//     grace. Every paid renewal (invoice.paid) moves that end forward.
//   - Cancel = Stripe's customer portal, reached from the account page.
//     Access runs to the end of the paid period, then the subscription
//     ends (customer.subscription.deleted) and the plan drops back.
//   - Time the account already had when the subscription was linked, and
//     any timed code redeemed WHILE subscribed, is BANKED: it's kept and
//     starts the moment the subscription ends, so nothing paid is lost.
// ================================
const db = require('./db');
const { log } = require('./logger');
const { TIERS, TIER_ORDER, TIER_MONTHLY_CENTS } = require('./config');
const { users, saveUsersToDisk } = require('./stores');
const mobile = require('./mobile');

const DAY_MS = 24 * 60 * 60 * 1000;
// Stripe charges at the period end and may need a moment (or a retry) to
// collect; this keeps the plan on meanwhile. A failed payment that's still
// unpaid after this simply lets the plan lapse until Stripe collects.
const GRACE_MS = 3 * DAY_MS;
// Monthly subscriptions sold on peakabu.app/billing.
const SUB_PLANS = {
  t2:     { kind: 'pc',     tier: 't2',     cents: 1000, label: 'Peakabu Creator, monthly' },
  t3:     { kind: 'pc',     tier: 't3',     cents: 2000, label: 'Peakabu Squad, monthly' },
  t4:     { kind: 'pc',     tier: 't4',     cents: 4000, label: 'Peakabu Pro, monthly' },
  mobile: { kind: 'mobile', tier: 'mobile', cents: 700,  label: 'Peakabu Mobile host, monthly' }
};
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    subId             TEXT PRIMARY KEY,
    customerId        TEXT,
    kind              TEXT NOT NULL,            -- 'pc' | 'mobile'
    tier              TEXT NOT NULL,            -- 't2'..'t4' | 'mobile'
    usernameLower     TEXT,                     -- null until the code is redeemed
    status            TEXT NOT NULL,
    periodEnd         INTEGER NOT NULL DEFAULT 0,
    cancelAtPeriodEnd INTEGER NOT NULL DEFAULT 0,
    checkoutId        TEXT,
    linkedAt          INTEGER,
    createdAt         INTEGER NOT NULL,
    updatedAt         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(usernameLower);
  CREATE TABLE IF NOT EXISTS plan_bank (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    usernameLower TEXT NOT NULL,
    kind          TEXT NOT NULL,                -- 'pc' | 'mobile'
    tier          TEXT NOT NULL,                -- PC tier, or 'mobile'
    ms            INTEGER NOT NULL,
    createdAt     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_plan_bank_user ON plan_bank(usernameLower);
`);
// Who paid, when they bought it signed in: lets them manage (cancel) a
// subscription they gave someone else as a gift.
try { db.exec(`ALTER TABLE subscriptions ADD COLUMN buyerLower TEXT`); } catch (e) { /* already there */ }

const stmt = {
  get:        db.prepare(`SELECT * FROM subscriptions WHERE subId = ?`),
  insert:     db.prepare(`INSERT OR IGNORE INTO subscriptions
                (subId, customerId, kind, tier, status, periodEnd, cancelAtPeriodEnd, checkoutId, createdAt, updatedAt)
                VALUES (@subId, @customerId, @kind, @tier, @status, @periodEnd, @cancelAtPeriodEnd, @checkoutId, @now, @now)`),
  update:     db.prepare(`UPDATE subscriptions SET status = @status, periodEnd = MAX(periodEnd, @periodEnd),
                cancelAtPeriodEnd = @cancelAtPeriodEnd, updatedAt = @now WHERE subId = @subId`),
  // A paid checkout settles an 'incomplete' row an early webhook created.
  fill:       db.prepare(`UPDATE subscriptions SET checkoutId = COALESCE(checkoutId, @checkoutId),
                customerId = COALESCE(customerId, @customerId), buyerLower = COALESCE(buyerLower, @buyerLower),
                status = CASE WHEN status = 'incomplete' AND @status = 'active' THEN 'active' ELSE status END,
                periodEnd = MAX(periodEnd, @periodEnd) WHERE subId = @subId`),
  link:       db.prepare(`UPDATE subscriptions SET usernameLower = ?, linkedAt = ?, updatedAt = ? WHERE subId = ? AND usernameLower IS NULL`),
  forUser:    db.prepare(`SELECT * FROM subscriptions WHERE usernameLower = ? ORDER BY createdAt DESC`),
  liveFor:    db.prepare(`SELECT * FROM subscriptions WHERE usernameLower = ? AND kind = ?
                AND status IN ('active','trialing','past_due') ORDER BY createdAt DESC LIMIT 1`),
  bankAdd:    db.prepare(`INSERT INTO plan_bank (usernameLower, kind, tier, ms, createdAt) VALUES (?, ?, ?, ?, ?)`),
  bankFor:    db.prepare(`SELECT * FROM plan_bank WHERE usernameLower = ? AND kind = ?`),
  bankClear:  db.prepare(`DELETE FROM plan_bank WHERE usernameLower = ? AND kind = ?`),
  forget:     db.prepare(`UPDATE subscriptions SET usernameLower = NULL WHERE usernameLower = ?`),
  forgetBuyer: db.prepare(`UPDATE subscriptions SET buyerLower = NULL WHERE buyerLower = ?`),
  forgetBank: db.prepare(`DELETE FROM plan_bank WHERE usernameLower = ?`)
};

const rank = (t) => TIER_ORDER.indexOf(t);
const label = (t) => (TIERS[t] && TIERS[t].label) || t;
const valueOf = (t) => TIER_MONTHLY_CENTS[t] || 0;
// Leftover time on one tier, re-priced as time on another.
function convertMs(ms, fromTier, toTier) {
  const from = valueOf(fromTier), to = valueOf(toTier);
  return from && to ? Math.floor(ms * from / to) : 0;
}
const daysText = (ms) => { const d = Math.round(ms / DAY_MS); return `${d} day${d === 1 ? '' : 's'}`; };

// The PC plan the account bought and still has (Free when expired/missing).
function currentPc(user) {
  if (!user || !user.tier || !TIERS[user.tier] || user.tier === 't1') return { tier: 't1', expiresAt: null };
  if (user.tierExpiresAt && Date.now() > user.tierExpiresAt) return { tier: 't1', expiresAt: null };
  return { tier: user.tier, expiresAt: user.tierExpiresAt || null }; // null = lifetime
}

function liveSub(usernameLower, kind) {
  return stmt.liveFor.get(usernameLower, kind) || null;
}

function syncDiscord(user, tier) {
  if (!user || !user.discordId) return;
  try { require('./discord-bot').syncRole(user.discordId, tier).catch(() => {}); } catch (e) { /* bot not set up */ }
}

// ---------------------------------------------------------------------------
// Codes

// What redeeming a timed or lifetime PC code WOULD do — no changes made.
// Used by /auth/redeem/check (the "are you sure?" step) and by applyPcCode.
// Returns { ok, action, tier, expiresAt?, carriedMs?, bankedMs?, message } or { ok: false, error }.
function planPcCode(user, codeTier, durationDays) {
  const lower = user.username.toLowerCase();
  const now = Date.now();
  const sub = liveSub(lower, 'pc');

  if (!durationDays) { // lifetime code (hand-issued)
    if (sub) return { ok: false, error: `You have a ${label(sub.tier)} subscription. Cancel it on your account page first, then redeem this lifetime code, so you aren't charged for a plan you no longer need.` };
    return { ok: true, action: 'lifetime', tier: codeTier, expiresAt: null, message: `${label(codeTier)} is now yours for life.` };
  }
  const ms = durationDays * DAY_MS;

  if (sub) {
    return { ok: true, action: 'bank', tier: codeTier, bankedMs: ms,
      message: `Saved for later: ${daysText(ms)} of ${label(codeTier)} will start when your ${label(sub.tier)} subscription ends.` };
  }

  const cur = currentPc(user);
  if (cur.tier !== 't1' && cur.expiresAt === null) {
    return { ok: false, error: `Your ${label(cur.tier)} plan never expires, so this code has nothing to add to.` };
  }
  if (cur.tier === 't1') {
    const expiresAt = now + ms;
    return { ok: true, action: 'start', tier: codeTier, expiresAt, message: `${label(codeTier)} is active until ${new Date(expiresAt).toDateString()}.` };
  }
  if (codeTier === cur.tier) {
    const expiresAt = cur.expiresAt + ms;
    return { ok: true, action: 'extend', tier: codeTier, expiresAt, message: `Added ${daysText(ms)}. ${label(codeTier)} now runs until ${new Date(expiresAt).toDateString()}.` };
  }
  if (rank(codeTier) > rank(cur.tier)) {
    const carriedMs = convertMs(cur.expiresAt - now, cur.tier, codeTier);
    const expiresAt = now + ms + carriedMs;
    return { ok: true, action: 'upgrade', tier: codeTier, expiresAt, carriedMs,
      message: `Upgraded to ${label(codeTier)} until ${new Date(expiresAt).toDateString()}` +
        (carriedMs > 0 ? ` (your leftover ${label(cur.tier)} time became ${daysText(carriedMs)} of ${label(codeTier)}).` : '.') };
  }
  return { ok: false, error: `You have ${label(cur.tier)} until ${new Date(cur.expiresAt).toDateString()}, which is higher than this ${label(codeTier)} code. Redeem it after your plan ends.` };
}

// Apply a plan computed by planPcCode (after the code itself was consumed).
function applyPcCode(user, plan) {
  const lower = user.username.toLowerCase();
  if (plan.action === 'bank') {
    stmt.bankAdd.run(lower, 'pc', plan.tier, plan.bankedMs, Date.now());
    log('info', 'plan_time_banked', { username: user.username, tier: plan.tier, ms: plan.bankedMs });
    return;
  }
  user.tier = plan.tier;
  user.tierSource = 'redeemed';
  user.tierExpiresAt = plan.expiresAt;
  saveUsersToDisk();
  log('info', 'tier_granted', { username: user.username, tier: plan.tier, source: 'redeemed', action: plan.action,
    tierExpiresAt: plan.expiresAt, carriedOverMs: plan.carriedMs || 0 });
  syncDiscord(user, plan.tier);
}

// Mobile codes always add time; while a Mobile subscription runs they're banked.
function planMobileCode(user, durationDays) {
  const lower = user.username.toLowerCase();
  const ms = (durationDays || 30) * DAY_MS;
  if (liveSub(lower, 'mobile')) {
    return { ok: true, action: 'bank', bankedMs: ms, message: `Saved for later: ${daysText(ms)} of Peakabu Mobile will start when your Mobile subscription ends.` };
  }
  return { ok: true, action: 'extend', days: durationDays || 30 };
}

function applyMobileCode(user, plan) {
  const lower = user.username.toLowerCase();
  if (plan.action === 'bank') {
    stmt.bankAdd.run(lower, 'mobile', 'mobile', plan.bankedMs, Date.now());
    log('info', 'plan_time_banked', { username: user.username, tier: 'mobile', ms: plan.bankedMs });
    return { message: plan.message };
  }
  const mobileExpiresAt = mobile.grantMobileDays(lower, plan.days);
  return { mobileExpiresAt, message: `Peakabu Mobile is active until ${new Date(mobileExpiresAt).toDateString()}.` };
}

// ---------------------------------------------------------------------------
// Subscriptions

// The period end Stripe reports, in ms. Older API versions put it on the
// subscription, newer ones on its items.
function periodEndOf(sub) {
  const s = sub && (sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end));
  return s ? s * 1000 : 0;
}

// Checkout finished: remember the subscription so its code can link it.
function recordCheckout({ subId, customerId, plan, checkoutId, status, periodEnd, buyerLower }) {
  const p = SUB_PLANS[plan];
  if (!p || !subId) return null;
  stmt.insert.run({ subId, customerId: customerId || null, kind: p.kind, tier: p.tier, status: status || 'active',
    periodEnd: periodEnd || 0, cancelAtPeriodEnd: 0, checkoutId: checkoutId || null, now: Date.now() });
  stmt.fill.run({ subId, checkoutId: checkoutId || null, customerId: customerId || null, status: status || 'active', periodEnd: periodEnd || 0, buyerLower: buyerLower || null });
  return stmt.get.get(subId);
}

// Can this code's subscription be linked to this account? (No changes made.)
function planLink(user, subId) {
  const lower = user.username.toLowerCase();
  const row = stmt.get.get(subId);
  if (!row) return { ok: false, error: 'This subscription code isn\'t ready yet. Try again in a minute.' };
  if (row.usernameLower && row.usernameLower !== lower) return { ok: false, error: 'This subscription is already linked to another account.' };
  if (row.usernameLower === lower) return { ok: false, error: 'This subscription is already on your account.' };
  if (!LIVE_STATUSES.includes(row.status)) return { ok: false, error: 'This subscription has ended, so there\'s nothing to link.' };
  const other = liveSub(lower, row.kind);
  if (other) return { ok: false, error: `Your account already has a ${other.kind === 'mobile' ? 'Mobile' : label(other.tier)} subscription. Cancel it first, or redeem this code on a different account.` };
  if (row.kind === 'pc') {
    const cur = currentPc(user);
    if (cur.tier !== 't1' && cur.expiresAt === null) {
      return { ok: false, error: `Your ${label(cur.tier)} plan never expires, so you don't need this subscription. Contact support for a refund.` };
    }
  }
  const what = row.kind === 'mobile' ? 'Peakabu Mobile' : label(row.tier);
  return { ok: true, row, label: what,
    message: `${what} subscription linked. It renews monthly until you cancel on your account page.`,
    previewMessage: `This will link your ${what} subscription to your account. It renews monthly until you cancel on your account page.` };
}

// Link the subscription and switch the plan on. Any time the account
// already had is banked so it isn't lost.
function link(user, subId) {
  const plan = planLink(user, subId);
  if (!plan.ok) return plan;
  const lower = user.username.toLowerCase();
  const now = Date.now();
  if (!stmt.link.run(lower, now, now, subId).changes) return { ok: false, error: 'This subscription is already linked to another account.' };
  const row = stmt.get.get(subId);
  if (row.kind === 'pc') {
    const cur = currentPc(user);
    if (cur.tier !== 't1' && cur.expiresAt > now) stmt.bankAdd.run(lower, 'pc', cur.tier, cur.expiresAt - now, now);
  } else {
    const left = mobile.mobilePassRemainingMs(lower);
    if (left > 0) stmt.bankAdd.run(lower, 'mobile', 'mobile', left, now);
  }
  applyAccess(row);
  log('info', 'subscription_linked', { username: user.username, subId, kind: row.kind, tier: row.tier });
  return { ok: true, message: plan.message, kind: row.kind, tier: row.tier };
}

// Keep the account's plan in step with a linked, live subscription.
function applyAccess(row) {
  if (!row || !row.usernameLower || !LIVE_STATUSES.includes(row.status)) return;
  const until = Math.max(row.periodEnd, Date.now()) + GRACE_MS;
  if (row.kind === 'mobile') { mobile.setMobilePassUntil(row.usernameLower, until); return; }
  const user = users.get(row.usernameLower);
  if (!user) return;
  const changedTier = user.tier !== row.tier;
  user.tier = row.tier;
  user.tierSource = 'subscription';
  user.tierExpiresAt = until;
  saveUsersToDisk();
  if (changedTier) syncDiscord(user, row.tier);
}

// The subscription is over (cancelled, refunded, or never paid): drop back,
// then start any banked time.
function endAccess(row) {
  if (!row || !row.usernameLower) return;
  const lower = row.usernameLower;
  const now = Date.now();
  const user = users.get(lower);
  // A PC plan granted some other way since (lifetime/manual) is left alone,
  // and so is the bank, which then waits for that plan's next code.
  if (row.kind === 'pc' && (!user || user.tierSource !== 'subscription')) return;
  const bank = stmt.bankFor.all(lower, row.kind);
  stmt.bankClear.run(lower, row.kind);
  if (row.kind === 'mobile') {
    const banked = bank.reduce((n, b) => n + b.ms, 0);
    mobile.setMobilePassUntil(lower, now + banked);
    log('info', 'subscription_access_ended', { username: lower, kind: 'mobile', bankedMs: banked });
    return;
  }
  if (bank.length) {
    // Banked time from different tiers becomes time on the highest one.
    const top = bank.reduce((t, b) => rank(b.tier) > rank(t) ? b.tier : t, bank[0].tier);
    const ms = bank.reduce((n, b) => n + (b.tier === top ? b.ms : convertMs(b.ms, b.tier, top)), 0);
    user.tier = top;
    user.tierSource = 'redeemed';
    user.tierExpiresAt = now + ms;
  } else {
    user.tier = 't1';
    user.tierSource = 'default';
    user.tierExpiresAt = null;
  }
  saveUsersToDisk();
  syncDiscord(user, user.tier);
  log('info', 'subscription_access_ended', { username: user.username, kind: 'pc', nowTier: user.tier, tierExpiresAt: user.tierExpiresAt });
}

// customer.subscription.created / updated / deleted.
// Webhooks can arrive in any order, so a subscription event that beats
// checkout.session.completed records the row itself from the plan we put
// in the subscription's metadata at checkout.
function rowFor(subId, metadata, customer) {
  const row = stmt.get.get(subId);
  if (row || !metadata || !SUB_PLANS[metadata.plan]) return row || null;
  return recordCheckout({ subId, plan: metadata.plan, customerId: typeof customer === 'string' ? customer : (customer && customer.id), status: 'incomplete' });
}

function onStripeSubscription(sub) {
  const row = rowFor(sub.id, sub.metadata, sub.customer);
  if (!row) return; // not one of ours
  stmt.update.run({ subId: sub.id, status: sub.status, periodEnd: periodEndOf(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end ? 1 : 0, now: Date.now() });
  const fresh = stmt.get.get(sub.id);
  if (LIVE_STATUSES.includes(fresh.status)) applyAccess(fresh);
  else if (['canceled', 'unpaid', 'incomplete_expired'].includes(fresh.status)) endAccess(fresh);
}

// invoice.paid: a renewal (or the first payment) went through.
function onInvoicePaid(invoice) {
  const subId = invoice.subscription ||
    (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
  const details = invoice.subscription_details || (invoice.parent && invoice.parent.subscription_details) || {};
  const row = subId && rowFor(typeof subId === 'string' ? subId : subId.id, details.metadata, invoice.customer);
  if (!row) return;
  const lines = (invoice.lines && invoice.lines.data) || [];
  const end = lines.reduce((m, l) => Math.max(m, ((l.period && l.period.end) || 0) * 1000), 0);
  stmt.update.run({ subId: row.subId, status: 'active', periodEnd: end, cancelAtPeriodEnd: row.cancelAtPeriodEnd, now: Date.now() });
  applyAccess(stmt.get.get(row.subId));
  log('info', 'subscription_renewed', { subId: row.subId, linked: !!row.usernameLower, periodEnd: end });
}

// For the account page.
function subscriptionsFor(usernameLower) {
  const bank = { pc: stmt.bankFor.all(usernameLower, 'pc'), mobile: stmt.bankFor.all(usernameLower, 'mobile') };
  return {
    subscriptions: stmt.forUser.all(usernameLower)
      .filter(r => LIVE_STATUSES.includes(r.status))
      .map(r => ({ id: r.subId, kind: r.kind, tier: r.tier, label: r.kind === 'mobile' ? 'Peakabu Mobile' : label(r.tier),
        cents: (SUB_PLANS[r.tier] || {}).cents || null, status: r.status, renewsAt: r.cancelAtPeriodEnd ? null : r.periodEnd,
        endsAt: r.cancelAtPeriodEnd ? r.periodEnd : null })),
    banked: [...bank.pc, ...bank.mobile].map(b => ({ kind: b.kind, tier: b.tier, label: b.kind === 'mobile' ? 'Peakabu Mobile' : label(b.tier), days: Math.round(b.ms / DAY_MS) }))
  };
}

// The Stripe customer behind one of this account's subscriptions (for the portal).
// The account using it, or the account that paid for it (a gift), may manage it.
function customerFor(usernameLower, subId) {
  const row = stmt.get.get(subId);
  return row && (row.usernameLower === usernameLower || row.buyerLower === usernameLower) ? row.customerId : null;
}

const subscriptionTier = (subId) => (stmt.get.get(subId) || {}).tier || null;

// One subscription's state, for the "My codes" list.
function subscriptionState(subId) {
  const row = stmt.get.get(subId);
  if (!row) return null;
  const live = LIVE_STATUSES.includes(row.status);
  return { live, linked: !!row.usernameLower, status: row.status,
    renewsAt: live && !row.cancelAtPeriodEnd ? row.periodEnd : null,
    endsAt: live ? (row.cancelAtPeriodEnd ? row.periodEnd : null) : (row.periodEnd || row.updatedAt) };
}

// Account deletion: live subscriptions this account uses or pays for.
// gift = someone else uses it (the deleted account only paid).
const stmtPaidFor = db.prepare(`SELECT * FROM subscriptions WHERE buyerLower = ? AND (usernameLower IS NULL OR usernameLower != ?)`);
function liveSubsFor(usernameLower) {
  const mine = stmt.forUser.all(usernameLower).map(r => ({ id: r.subId, gift: false, status: r.status }));
  const gifts = stmtPaidFor.all(usernameLower, usernameLower).map(r => ({ id: r.subId, gift: !!r.usernameLower, status: r.status }));
  return [...mine, ...gifts].filter(r => LIVE_STATUSES.includes(r.status));
}
const liveSubIdsFor = (u) => liveSubsFor(u).map(r => r.id);
function forgetUser(usernameLower) {
  stmt.forget.run(usernameLower);
  stmt.forgetBuyer.run(usernameLower);
  stmt.forgetBank.run(usernameLower);
}

module.exports = {
  SUB_PLANS, GRACE_MS,
  planPcCode, applyPcCode, planMobileCode, applyMobileCode,
  recordCheckout, planLink, link, onStripeSubscription, onInvoicePaid,
  subscriptionsFor, subscriptionState, subscriptionTier, customerFor, liveSubIdsFor, liveSubsFor, forgetUser, periodEndOf
};
