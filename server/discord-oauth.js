// ================================
// DISCORD OAUTH — account linking only (not the bot). Confirms a Peak-Abu
// account really controls a given Discord account before we ever trust
// discordId for role-sync or account recovery. Bot/role-sync logic lives
// in discord-bot.js, built separately once linking is proven out.
//
// Flow: client hits GET /auth/discord/link-url (behind requireAuth) ->
// gets Discord's consent URL with a short-lived `state` tied to their
// Peak-Abu username -> opens it in the system browser -> user approves on
// Discord -> Discord redirects to GET /auth/discord/callback?code&state ->
// we exchange the code for a token, fetch the Discord user, and write
// discordId/discordUsername/discordLinkedAt onto that Peak-Abu account.
// ================================
const crypto = require('crypto');
const { log } = require('./logger');
const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, DISCORD_RECOVERY_REDIRECT_URI } = require('./config');
const { users, saveUsersToDisk } = require('./stores');

// state -> { username, expiresAt }. In-memory + short-lived on purpose —
// a link attempt that isn't completed within 10 minutes should just be
// started over, not resumed from a stale, possibly-replayed state. Same
// volatile-on-purpose reasoning as the abuse limiters in auth.js — a
// restart forgiving an in-progress link attempt is an acceptable tradeoff.
const pendingLinks = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pendingLinks) {
    if (now > entry.expiresAt) pendingLinks.delete(state);
  }
}, 5 * 60 * 1000);

function buildAuthorizeUrl(username) {
  const state = crypto.randomBytes(24).toString('hex');
  pendingLinks.set(state, { username, expiresAt: Date.now() + STATE_TTL_MS });

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

async function exchangeCodeForUser(code) {
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: DISCORD_REDIRECT_URI
    })
  });
  if (!tokenRes.ok) {
    throw new Error(`Discord token exchange failed: ${tokenRes.status}`);
  }
  const tokenData = await tokenRes.json();

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  if (!userRes.ok) {
    throw new Error(`Discord user fetch failed: ${userRes.status}`);
  }
  return userRes.json();
}

function consumeState(state) {
  const entry = pendingLinks.get(state);
  if (!entry) return null;
  pendingLinks.delete(state);
  if (Date.now() > entry.expiresAt) return null;
  return entry.username;
}

// ================================
// RECOVERY STATE — separate map from pendingLinks on purpose. Linking
// carries a username (an already-authenticated user proving their Discord
// identity); recovery carries no username at all (an unauthenticated
// person trying to find OUT which account, if any, their Discord maps to).
// Keeping these separate means a recovery state can never accidentally be
// replayed as a link state or vice versa — no username field to confuse.
// ================================
const pendingRecoveries = new Map(); // state -> { expiresAt }

setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pendingRecoveries) {
    if (now > entry.expiresAt) pendingRecoveries.delete(state);
  }
}, 5 * 60 * 1000);

function buildRecoveryUrl() {
  const state = crypto.randomBytes(24).toString('hex');
  pendingRecoveries.set(state, { expiresAt: Date.now() + STATE_TTL_MS });

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_RECOVERY_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

function consumeRecoveryState(state) {
  const entry = pendingRecoveries.get(state);
  if (!entry) return false;
  pendingRecoveries.delete(state);
  return Date.now() <= entry.expiresAt;
}

function linkDiscordAccount(peakAbuUsername, discordUser) {
  for (const [uname, u] of users) {
    if (u.discordId === discordUser.id && uname !== peakAbuUsername.toLowerCase()) {
      return { ok: false, error: 'already_linked_elsewhere' };
    }
  }
  const user = users.get(peakAbuUsername.toLowerCase());
  if (!user) return { ok: false, error: 'user_not_found' };

  user.discordId = discordUser.id;
  user.discordUsername = discordUser.username;
  user.discordLinkedAt = Date.now();
  saveUsersToDisk();
  log('info', 'discord_account_linked', {
    username: peakAbuUsername, discordId: discordUser.id, discordUsername: discordUser.username
  });
  return { ok: true };
}

module.exports = { buildAuthorizeUrl, exchangeCodeForUser, consumeState, linkDiscordAccount, buildRecoveryUrl, consumeRecoveryState };
