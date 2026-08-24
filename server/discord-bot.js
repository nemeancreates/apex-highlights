// ================================
// DISCORD BOT — role sync only, plain REST calls (PUT/DELETE/GET against
// discord.com/api/v10). Deliberately NOT a persistent Gateway connection —
// this never listens for Discord events or slash commands, only pushes
// role changes triggered by server-side tier changes (redemption, Discord
// linking). Runs in-process with the main server; nothing here needs its
// own lifecycle or a separate PM2 entry.
// ================================
const { log } = require('./logger');
const { DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_ROLE_MAP, DISCORD_BOT_ENABLED } = require('./config');

const API_BASE = 'https://discord.com/api/v10';

async function discordRequest(method, path) {
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
  });
}

// Fetches a guild member's current role IDs. Returns null if the member
// isn't in the guild (they linked Discord but never actually joined your
// server) — callers should treat that as "nothing to sync yet", not an
// error worth alarming over.
async function getMemberRoles(discordId) {
  const res = await discordRequest('GET', `/guilds/${DISCORD_GUILD_ID}/members/${discordId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Discord member fetch failed: ${res.status}`);
  const data = await res.json();
  return data.roles; // array of role ID strings
}

async function addRole(discordId, roleId) {
  const res = await discordRequest('PUT', `/guilds/${DISCORD_GUILD_ID}/members/${discordId}/roles/${roleId}`);
  if (!res.ok && res.status !== 204) throw new Error(`Discord add role failed: ${res.status}`);
}

async function removeRole(discordId, roleId) {
  const res = await discordRequest('DELETE', `/guilds/${DISCORD_GUILD_ID}/members/${discordId}/roles/${roleId}`);
  if (!res.ok && res.status !== 204) throw new Error(`Discord remove role failed: ${res.status}`);
}

// Syncs a Discord member's tier role to match their current Peak-Abu tier.
// Removes any OTHER tier role they hold (covers upgrades/downgrades) and
// adds the correct one. Only ever touches the roles listed in
// DISCORD_ROLE_MAP — any other role the member has (mod roles, custom
// self-assigned roles, whatever) is left completely alone. Idempotent and
// safe to call repeatedly; Discord's PUT is a no-op if already assigned.
async function syncRole(discordId, tier) {
  if (!DISCORD_BOT_ENABLED) return { ok: false, error: 'discord_bot_not_configured' };
  if (!discordId) return { ok: false, error: 'no_discord_id' };

  const targetRoleId = DISCORD_ROLE_MAP[tier] || null;

  try {
    const currentRoles = await getMemberRoles(discordId);
    if (currentRoles === null) {
      log('warn', 'discord_sync_member_not_in_guild', { discordId, tier });
      return { ok: false, error: 'member_not_in_guild' };
    }

    const allTierRoleIds = Object.values(DISCORD_ROLE_MAP).filter(Boolean);
    const rolesToRemove = currentRoles.filter(r => allTierRoleIds.includes(r) && r !== targetRoleId);

    for (const roleId of rolesToRemove) {
      await removeRole(discordId, roleId);
    }
    if (targetRoleId && !currentRoles.includes(targetRoleId)) {
      await addRole(discordId, targetRoleId);
    }

    log('info', 'discord_role_synced', { discordId, tier, added: targetRoleId, removed: rolesToRemove });
    return { ok: true };
  } catch (err) {
    log('warn', 'discord_sync_failed', { discordId, tier, error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { syncRole };