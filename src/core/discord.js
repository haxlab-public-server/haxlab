/*
 * Discord bot replacing the old fire-and-forget webhooks: posts the room's
 * activity log and match reports, and answers a stats lookup command. Every
 * command works both as a !prefix message and as a global "/" slash command
 * — global rather than per-guild so the bot doesn't need re-registering in
 * every server it joins, at the cost of up to ~1h for Discord to propagate a
 * newly added/changed command.
 */
const { Client, GatewayIntentBits, Events, EmbedBuilder, AttachmentBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Agent: UndiciAgent, buildConnector } = require('undici');
const { SocksClient } = require('socks');
const { formatBanRemaining } = require('./utils');
const { buildRankingString, buildAllRankingsText, buildClubRankingString } = require('./stats/print');

const SAY_PREFIX = '!say';
const STATS_COMMAND_PREFIX = '!stats';
const TOPS_COMMAND_PREFIX = '!tops';
const PLAYERS_PREFIX = '!players';
const BANAUTH_PREFIX = '!banauth';
const UNBANAUTH_PREFIX = '!unbanauth';
const AUTHBANS_PREFIX = '!authbans';
const MUTEAUTH_PREFIX = '!muteauth';
const UNMUTEAUTH_PREFIX = '!unmuteauth';
const STATUS_MESSAGE_SETTING_KEY = 'statusMessageId';

// Same key list/aliases/quorum behavior as the room's own !tops (see
// commands/player.js's topsCommand and stats/roomStats.js) — just producing
// a reply string here instead of a room.sendAnnouncement call.
const TOPS_STAT_KEYS = ['games', 'wins', 'goals', 'assists', 'cs', 'playtime', 'pt', 'clubs'];
const TOPS_USAGE_REPLY = 'Использование: !tops [games|wins|goals|assists|cs|playtime|clubs] (или /tops). Без аргумента показывает все таблицы лидеров сразу.';
const NOT_ENOUGH_GAMES_REPLY = 'Недостаточно игр сыграно !';
const NO_CLUB_SCORES_REPLY = 'Ни один клуб еще не заработал очков !';

async function buildTopsReply(key, { db, getTimeStats }) {
    if (!key) {
        const text = await buildAllRankingsText(db, getTimeStats);
        return text ?? NOT_ENOUGH_GAMES_REPLY;
    }
    if (key === 'clubs') {
        const text = await buildClubRankingString(db);
        return text ?? NO_CLUB_SCORES_REPLY;
    }
    if (!TOPS_STAT_KEYS.includes(key)) return TOPS_USAGE_REPLY;
    const text = await buildRankingString(db, getTimeStats, key === 'pt' ? 'playtime' : key);
    return text ?? NOT_ENOUGH_GAMES_REPLY;
}

// say/banauth/unbanauth/authbans/muteauth/unmuteauth are usable by the owner
// OR anyone with the configured admin role — every other command here
// (players, etc.) stays owner-only. A role check is enough (no need to hit
// the DB/adminList) since it's just gating who's allowed to moderate the
// room from Discord.
function isOwnerOrAdmin(userId, member, discordOwnerId, discordAdminRoleId) {
    if (userId === discordOwnerId) return true;
    if (discordAdminRoleId && member && member.roles.cache.has(discordAdminRoleId)) return true;
    return false;
}

const slashCommandData = [
    new SlashCommandBuilder()
        .setName('say')
        .setDescription('Отправить сообщение в чат комнаты HaxBall (владелец и админы)')
        .addStringOption((option) =>
            option.setName('message').setDescription('Текст для отправки в комнату').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Показать статистику игрока')
        .addStringOption((option) =>
            option.setName('name').setDescription('Имя игрока (по умолчанию — ваша статистика, если аккаунт привязан)').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('tops')
        .setDescription('Показать таблицы лидеров (как !tops в комнате) — видно только вам')
        .addStringOption((option) =>
            option.setName('stat').setDescription('Категория (по умолчанию — все сразу)').setRequired(false)
                .addChoices(
                    { name: 'games', value: 'games' },
                    { name: 'wins', value: 'wins' },
                    { name: 'goals', value: 'goals' },
                    { name: 'assists', value: 'assists' },
                    { name: 'cs', value: 'cs' },
                    { name: 'playtime', value: 'playtime' },
                    { name: 'clubs', value: 'clubs' }
                )
        ),
    new SlashCommandBuilder()
        .setName('players')
        .setDescription('Показать список игроков в комнате вместе с их auth (только для владельца)'),
    new SlashCommandBuilder()
        .setName('banauth')
        .setDescription('Забанить игрока по auth — работает даже если он не в комнате (владелец и админы)')
        .addStringOption((option) => option.setName('auth').setDescription('Auth игрока').setRequired(true))
        .addIntegerOption((option) => option.setName('minutes').setDescription('Длительность бана в минутах').setRequired(true).setMinValue(1))
        .addStringOption((option) => option.setName('reason').setDescription('Причина бана').setRequired(false)),
    new SlashCommandBuilder()
        .setName('unbanauth')
        .setDescription('Снять бан по auth (владелец и админы)')
        .addStringOption((option) => option.setName('auth').setDescription('Auth забаненного игрока').setRequired(true)),
    new SlashCommandBuilder()
        .setName('authbans')
        .setDescription('Показать список банов по auth (владелец и админы)'),
    new SlashCommandBuilder()
        .setName('muteauth')
        .setDescription('Заглушить игрока по auth — только если он сейчас в комнате (владелец и админы)')
        .addStringOption((option) => option.setName('auth').setDescription('Auth игрока').setRequired(true))
        .addIntegerOption((option) => option.setName('minutes').setDescription('Длительность заглушения в минутах').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder()
        .setName('unmuteauth')
        .setDescription('Снять заглушение по auth (владелец и админы)')
        .addStringOption((option) => option.setName('auth').setDescription('Auth заглушенного игрока').setRequired(true)),
];

// Resolves a typed name to stats. A currently-connected player's live auth
// (via the room's own authArray, captured once at room.onPlayerJoin) is the
// source of truth for "who currently goes by this name" — the DB's stored
// player_name is just a label that only changes on an explicit !rename, so it
// can drift from a player's actual current in-room nickname. Live lookup is
// tried first for exactly that reason; the DB name search is a fallback for
// players who aren't in the room right now.
function resolveStatsByName(name, { db, state, getAuthArray }) {
    const livePlayer = state.playersAll.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (livePlayer) {
        const auth = getAuthArray()[livePlayer.id]?.[0];
        if (auth) {
            const stats = db.getPlayerStats(auth);
            if (stats) return stats;
        }
    }
    return db.getPlayerStatsByName(name);
}

function listCurrentPlayers(state, getAuthArray) {
    if (state.playersAll.length === 0) return 'В комнате никого нет.';
    const authArray = getAuthArray();
    const lines = state.playersAll.map((p) => `${p.name} [${authArray[p.id]?.[0] ?? '?'}]`);
    return `Игроки в комнате:\n${lines.join('\n')}`;
}

// Pure and independently testable: decides what (if anything) to do with an
// incoming Discord message, without touching the discord.js Client itself.
// Async because kickPlayerByAuth crosses to the game process over IPC (see
// core/discordProcess.js) — it's no longer a same-process function call.
async function handleIncomingMessage(message, { discordOwnerId, discordAdminRoleId, db, state, getAuthArray, getPrintPlayerStats, relayToRoom, kickPlayerByAuth, muteByAuth, unmuteByAuth, getTimeStats }) {
    if (message.author.bot) return null;

    if (message.content.toLowerCase().startsWith(SAY_PREFIX)) {
        if (!isOwnerOrAdmin(message.author.id, message.member, discordOwnerId, discordAdminRoleId)) return null;
        const text = message.content.slice(SAY_PREFIX.length).trim();
        if (text === '') return 'Использование: !say <message>';
        relayToRoom(message.author.displayName, text);
        return null;
    }

    if (message.content.toLowerCase().startsWith(PLAYERS_PREFIX)) {
        if (message.author.id !== discordOwnerId) return null;
        return listCurrentPlayers(state, getAuthArray);
    }

    if (message.content.toLowerCase().startsWith(UNBANAUTH_PREFIX)) {
        if (!isOwnerOrAdmin(message.author.id, message.member, discordOwnerId, discordAdminRoleId)) return null;
        const auth = message.content.slice(UNBANAUTH_PREFIX.length).trim();
        if (auth === '') return 'Использование: !unbanauth <auth>';
        const existing = db.getAuthBan(auth);
        if (!existing) return 'Этот auth не забанен.';
        db.unbanAuth(auth);
        return `${existing.playerName} разбанен по auth.`;
    }

    if (message.content.toLowerCase().startsWith(AUTHBANS_PREFIX)) {
        if (!isOwnerOrAdmin(message.author.id, message.member, discordOwnerId, discordAdminRoleId)) return null;
        const bans = db.getAuthBans();
        if (bans.length === 0) return 'В списке банов по auth никого нет.';
        return bans.map((ban) => `${ban.playerName} [${ban.auth}] — осталось ${formatBanRemaining(ban.expiresAt)}${ban.reason ? ' (' + ban.reason + ')' : ''}`).join('\n');
    }

    // Checked before !muteauth so "!unmuteauth" doesn't get shadowed by it.
    if (message.content.toLowerCase().startsWith(UNMUTEAUTH_PREFIX)) {
        if (!isOwnerOrAdmin(message.author.id, message.member, discordOwnerId, discordAdminRoleId)) return null;
        const auth = message.content.slice(UNMUTEAUTH_PREFIX.length).trim();
        if (auth === '') return 'Использование: !unmuteauth <auth>';
        const result = await unmuteByAuth(auth);
        return result.ok ? `${result.name} размучен.` : 'Этот игрок сейчас не заглушен.';
    }

    if (message.content.toLowerCase().startsWith(MUTEAUTH_PREFIX)) {
        if (!isOwnerOrAdmin(message.author.id, message.member, discordOwnerId, discordAdminRoleId)) return null;
        const rest = message.content.slice(MUTEAUTH_PREFIX.length).trim().split(/ +/);
        const auth = rest[0];
        const minutes = parseInt(rest[1]);
        if (!auth || !(minutes > 0)) return 'Использование: !muteauth <auth> <минуты>';
        const result = await muteByAuth(auth, minutes);
        if (result.ok) return `${result.name} заглушен на ${minutes} мин.`;
        return result.reason === 'admin' ? 'Нельзя заглушить администратора.' : 'Этого игрока сейчас нет в комнате.';
    }

    // Checked after !unbanauth/!authbans/!players so "!banauth" doesn't
    // shadow them — none of these prefixes are substrings of each other, but
    // keeping the more specific commands first is the safer habit.
    if (message.content.toLowerCase().startsWith(BANAUTH_PREFIX)) {
        if (!isOwnerOrAdmin(message.author.id, message.member, discordOwnerId, discordAdminRoleId)) return null;
        const rest = message.content.slice(BANAUTH_PREFIX.length).trim().split(/ +/);
        const auth = rest[0];
        const minutes = parseInt(rest[1]);
        if (!auth || !(minutes > 0)) return 'Использование: !banauth <auth> <минуты> [причина]';
        const reason = rest.slice(2).join(' ');
        const kicked = await kickPlayerByAuth(auth, reason);
        db.banAuth(auth, kicked ? kicked.name : auth, reason, minutes);
        return kicked
            ? `${kicked.name} забанен по auth на ${minutes} мин. и выгнан из комнаты.`
            : `${auth} забанен по auth на ${minutes} мин. (сейчас не в комнате).`;
    }

    if (message.content.toLowerCase().startsWith(STATS_COMMAND_PREFIX)) {
        const name = message.content.slice(STATS_COMMAND_PREFIX.length).trim();

        if (name === '') {
            const auth = db.getAuthByDiscordId(message.author.id);
            if (!auth) return 'Ваш аккаунт Discord не привязан. Используйте "!discord <ваш ID Discord>" в комнате, или "!stats <имя игрока>" здесь.';
            const stats = db.getPlayerStats(auth);
            if (!stats) return "Вы еще не играли в квалификационные игры.";
            return await getPrintPlayerStats()(stats);
        }

        const stats = resolveStatsByName(name, { db, state, getAuthArray });
        if (!stats) return `Статистика для "${name}" не найдена.`;
        return await getPrintPlayerStats()(stats);
    }

    if (message.content.toLowerCase().startsWith(TOPS_COMMAND_PREFIX)) {
        const key = message.content.slice(TOPS_COMMAND_PREFIX.length).trim().toLowerCase() || null;
        return await buildTopsReply(key, { db, getTimeStats });
    }

    return null;
}

// Pure and independently testable: assigns the configured auto-role to every
// new Discord member, regardless of whether they've ever linked a HaxBall
// account. If no role is configured, this is a no-op.
function handleGuildMemberAdd(member, { discordAutoRoleId }) {
    if (!discordAutoRoleId) return;
    member.roles.add(discordAutoRoleId).catch((err) => console.error('Discord auto-role assignment failed:', err));
}

// Pure and independently testable, same shape as handleGuildMemberAdd: a
// member gaining the configured VIP role on Discord grants room VIP to
// whichever HaxBall auth they've linked via !discord (see
// commands/player.js's linkDiscordCommand) — a no-op if no role is
// configured, if the role wasn't the one that just got added (only the
// false -> true edge counts, not already having it or losing it), or if
// this Discord account was never linked to a HaxBall auth. grantVipByAuth
// crosses to the room process over IPC (see discordProcess.js), same as
// kickPlayerByAuth.
function handleGuildMemberUpdate(oldMember, newMember, { discordVipRoleId, db, grantVipByAuth }) {
    if (!discordVipRoleId) return;
    const hadRole = oldMember.roles.cache.has(discordVipRoleId);
    const hasRole = newMember.roles.cache.has(discordVipRoleId);
    if (hadRole || !hasRole) return;
    const auth = db.getAuthByDiscordId(newMember.id);
    if (!auth) return;
    grantVipByAuth(auth, newMember.displayName);
}

// The gap handleGuildMemberUpdate's own false->true edge can never cover:
// a player who ALREADY had the VIP role on Discord (a giveaway, a boost,
// an admin manually granting it — anything) from BEFORE they ever ran
// !discord in the room. That edge already fired, at a moment
// db.getAuthByDiscordId returned nothing, and got silently dropped — there
// was never anything left to retroactively catch it, until now. Triggered
// once, from commands/player.js's linkDiscordCommand, every time a player
// links (harmless no-op via grantVipByAuth's own de-dupe if they don't
// actually have the role, or already have room VIP). Single-guild
// assumption, same as the rest of this bot — `guild` is passed in rather
// than looked up here so this stays independently testable without a real
// discord.js Client.
async function checkVipRoleOnLink(guild, discordId, auth, targetName, { discordVipRoleId, grantVipByAuth }) {
    if (!discordVipRoleId || !guild) return;
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member || !member.roles.cache.has(discordVipRoleId)) return;
    grantVipByAuth(auth, targetName);
}

// The missing room->Discord half: a player granted VIP in the room (!setvip,
// or the 4v4-win lottery) gets the configured Discord role too, once their
// account is linked (see commands/player.js's linkDiscordCommand) — a no-op
// if no role is configured, the account isn't linked, or they already have
// it (checked explicitly rather than relying on Discord to no-op a redundant
// .add(), so this never fires a pointless API call). Idempotent by design:
// applyVipGrant (commands/master.js) calls this on every grant path,
// including the Discord role -> room VIP direction itself (grantVipByAuth)
// — that's safe, not a loop, since a member who already has the role just
// gets skipped here, and handleGuildMemberUpdate below only reacts to the
// false->true edge, which granting a role they already hold never crosses.
async function grantVipRoleOnGuild(guild, discordId, { discordVipRoleId }) {
    if (!discordVipRoleId || !guild) return;
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member || member.roles.cache.has(discordVipRoleId)) return;
    await member.roles.add(discordVipRoleId).catch((err) => console.error('Discord VIP role grant failed:', err));
}

// Symmetric to grantVipRoleOnGuild — called on !removevip and on the live
// expiry sweep (commands/master.js's purgeExpiredVips). Same idempotence
// reasoning: skips a member who doesn't have the role, and removing a role
// they DO have only crosses handleGuildMemberUpdate's hadRole(true)->false
// edge, which that handler explicitly ignores (only the grant edge matters
// there) — so this can never loop back into re-granting room VIP.
async function revokeVipRoleOnGuild(guild, discordId, { discordVipRoleId }) {
    if (!discordVipRoleId || !guild) return;
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member || !member.roles.cache.has(discordVipRoleId)) return;
    await member.roles.remove(discordVipRoleId).catch((err) => console.error('Discord VIP role revoke failed:', err));
}

// Startup/reconnect reconciliation — the self-healing sweep that catches
// everything the live, event-driven paths above can miss: a room VIP whose
// account was linked to Discord AFTER the grant already happened (so
// applyVipGrant's own grantVipRoleOnGuild call had nothing to resolve yet),
// or an expiry that happened while this process was offline (so
// purgeExpiredVips never got to fire its own revoke). Runs once per
// ClientReady, not on a timer — cheap enough (one members.fetch(), one pass
// over the vips table) that "every reconnect" is already frequent enough for
// a background-drift fix like this.
async function reconcileVipRoles(guild, { discordVipRoleId, db }) {
    if (!discordVipRoleId || !guild) return;
    const vips = db.getVips();
    const vipAuths = new Set(vips.map((v) => v.auth));
    for (const vip of vips) {
        const discordId = db.getDiscordIdByAuth(vip.auth);
        if (!discordId) continue;
        await grantVipRoleOnGuild(guild, discordId, { discordVipRoleId });
    }
    // The reverse direction needs every current role-holder, not just known
    // VIPs — that's the whole point (catching an expiry that happened
    // without this process around to notice). Only ever revokes from a
    // member we can trace back to a specific, no-longer-VIP auth; a role
    // held for any other reason (a manual admin grant unrelated to room VIP,
    // an unlinked account) is deliberately left alone.
    const members = await guild.members.fetch().catch(() => null);
    if (!members) return;
    for (const member of members.values()) {
        if (!member.roles.cache.has(discordVipRoleId)) continue;
        const auth = db.getAuthByDiscordId(member.id);
        if (!auth || vipAuths.has(auth)) continue;
        await revokeVipRoleOnGuild(guild, member.id, { discordVipRoleId });
    }
}

const OWNER_ONLY_REPLY = { content: 'Только владелец может использовать эту команду.', ephemeral: true };
const OWNER_OR_ADMIN_ONLY_REPLY = { content: 'Только владелец или админ может использовать эту команду.', ephemeral: true };

// Same separation as handleIncomingMessage: pure decision logic, independently
// testable without a real discord.js Interaction. Mirrors handleIncomingMessage's
// behavior command-for-command, just reading typed slash-command options instead
// of parsing message text — /stats replies publicly (like !stats) since it's an
// open lookup, the rest stay ephemeral (owner-only moderation/utility actions).
async function handleSlashCommand(interaction, { discordOwnerId, discordAdminRoleId, db, state, getAuthArray, getPrintPlayerStats, relayToRoom, kickPlayerByAuth, muteByAuth, unmuteByAuth, getTimeStats }) {
    const { commandName } = interaction;

    if (commandName === 'say') {
        if (!isOwnerOrAdmin(interaction.user.id, interaction.member, discordOwnerId, discordAdminRoleId)) return OWNER_OR_ADMIN_ONLY_REPLY;
        const text = interaction.options.getString('message');
        relayToRoom(interaction.user.displayName, text);
        return { content: `Отправлено: ${text}`, ephemeral: true };
    }

    if (commandName === 'tops') {
        const key = interaction.options.getString('stat');
        const content = await buildTopsReply(key, { db, getTimeStats });
        return { content, ephemeral: true };
    }

    if (commandName === 'players') {
        if (interaction.user.id !== discordOwnerId) return OWNER_ONLY_REPLY;
        return { content: listCurrentPlayers(state, getAuthArray), ephemeral: true };
    }

    if (commandName === 'banauth') {
        if (!isOwnerOrAdmin(interaction.user.id, interaction.member, discordOwnerId, discordAdminRoleId)) return OWNER_OR_ADMIN_ONLY_REPLY;
        const auth = interaction.options.getString('auth');
        const minutes = interaction.options.getInteger('minutes');
        const reason = interaction.options.getString('reason') ?? '';
        const kicked = await kickPlayerByAuth(auth, reason);
        db.banAuth(auth, kicked ? kicked.name : auth, reason, minutes);
        const content = kicked
            ? `${kicked.name} забанен по auth на ${minutes} мин. и выгнан из комнаты.`
            : `${auth} забанен по auth на ${minutes} мин. (сейчас не в комнате).`;
        return { content, ephemeral: true };
    }

    if (commandName === 'unbanauth') {
        if (!isOwnerOrAdmin(interaction.user.id, interaction.member, discordOwnerId, discordAdminRoleId)) return OWNER_OR_ADMIN_ONLY_REPLY;
        const auth = interaction.options.getString('auth');
        const existing = db.getAuthBan(auth);
        if (!existing) return { content: 'Этот auth не забанен.', ephemeral: true };
        db.unbanAuth(auth);
        return { content: `${existing.playerName} разбанен по auth.`, ephemeral: true };
    }

    if (commandName === 'authbans') {
        if (!isOwnerOrAdmin(interaction.user.id, interaction.member, discordOwnerId, discordAdminRoleId)) return OWNER_OR_ADMIN_ONLY_REPLY;
        const bans = db.getAuthBans();
        if (bans.length === 0) return { content: 'В списке банов по auth никого нет.', ephemeral: true };
        const content = bans.map((ban) => `${ban.playerName} [${ban.auth}] — осталось ${formatBanRemaining(ban.expiresAt)}${ban.reason ? ' (' + ban.reason + ')' : ''}`).join('\n');
        return { content, ephemeral: true };
    }

    if (commandName === 'muteauth') {
        if (!isOwnerOrAdmin(interaction.user.id, interaction.member, discordOwnerId, discordAdminRoleId)) return OWNER_OR_ADMIN_ONLY_REPLY;
        const auth = interaction.options.getString('auth');
        const minutes = interaction.options.getInteger('minutes');
        const result = await muteByAuth(auth, minutes);
        const content = result.ok
            ? `${result.name} заглушен на ${minutes} мин.`
            : result.reason === 'admin' ? 'Нельзя заглушить администратора.' : 'Этого игрока сейчас нет в комнате.';
        return { content, ephemeral: true };
    }

    if (commandName === 'unmuteauth') {
        if (!isOwnerOrAdmin(interaction.user.id, interaction.member, discordOwnerId, discordAdminRoleId)) return OWNER_OR_ADMIN_ONLY_REPLY;
        const auth = interaction.options.getString('auth');
        const result = await unmuteByAuth(auth);
        const content = result.ok ? `${result.name} размучен.` : 'Этот игрок сейчас не заглушен.';
        return { content, ephemeral: true };
    }

    if (commandName === 'stats') {
        const name = interaction.options.getString('name');

        if (!name) {
            const auth = db.getAuthByDiscordId(interaction.user.id);
            if (!auth) return { content: 'Ваш аккаунт Discord не привязан. Используйте "!discord <ваш ID Discord>" в комнате, или укажите имя игрока.' };
            const stats = db.getPlayerStats(auth);
            if (!stats) return { content: 'Вы еще не играли в квалификационные игры.' };
            return { content: await getPrintPlayerStats()(stats) };
        }

        const stats = resolveStatsByName(name, { db, state, getAuthArray });
        if (!stats) return { content: `Статистика для "${name}" не найдена.` };
        return { content: await getPrintPlayerStats()(stats) };
    }

    return null;
}

// Builds an undici Dispatcher that tunnels every request through a SOCKS5
// proxy — same recipe as the (unmaintained-for-our-undici-version) fetch-socks
// package, reimplemented directly against *this* project's own `undici`
// (the exact instance @discordjs/rest uses) so the Agent/Dispatcher classes
// match. Passing a dispatcher built against a different undici copy fails
// with "opts.dispatcher is not supported by instance methods", since undici
// checks the object's class identity, not just its shape.
function buildSocksDispatcher(proxyUrl) {
    const parsed = new URL(proxyUrl);
    const proxy = {
        host: parsed.hostname,
        port: Number(parsed.port),
        type: 5,
        userId: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    };
    const tlsConnect = buildConnector({});
    const connect = async (options, callback) => {
        try {
            const { socket } = await SocksClient.createConnection({
                command: 'connect',
                proxy,
                destination: { host: options.hostname, port: Number(options.port) || (options.protocol === 'https:' ? 443 : 80) },
            });
            if (options.protocol === 'https:') {
                tlsConnect({ ...options, httpSocket: socket }, callback);
            } else {
                callback(null, socket.setNoDelay());
            }
        } catch (err) {
            callback(err, null);
        }
    };
    return new UndiciAgent({ connect });
}

module.exports = function createDiscordBot({
    discordToken,
    discordLogChannelId,
    discordReportChannelId,
    discordOwnerId,
    discordAdminRoleId,
    discordAutoRoleId,
    discordVipRoleId,
    discordStatusChannelId,
    discordPasswordChannelId,
    discordAdminCallChannelId,
    discordVotebanChannelId,
    discordMentionAlertChannelId,
    discordProxyUrl,
    maxPlayers,
    // BFF room (see haxchill-second-room-plan project memory): own log/
    // report channels, but folded into the SAME status message as the main
    // room rather than a separate one — see updateBffRoomStatus below.
    discordBffLogChannelId,
    discordBffReportChannelId,
    bffMaxPlayers,
    db,
    state,
    getAuthArray,
    getPrintPlayerStats,
    relayToRoom,
    kickPlayerByAuth,
    grantVipByAuth,
    muteByAuth,
    unmuteByAuth,
    getTimeStats,
}) {
    const clientOptions = {
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            // Needed to receive GuildMemberAdd/GuildMemberUpdate at all
            // (the latter is what notices someone getting the VIP role) —
            // like MessageContent, this is a privileged intent that must
            // also be enabled in the Discord Developer Portal (Bot >
            // Privileged Gateway Intents > Server Members Intent), or
            // client.login() will reject.
            GatewayIntentBits.GuildMembers,
        ],
    };
    // Routes only this REST client's traffic through the SOCKS5 proxy — the
    // gateway (WebSocket) side is proxied separately in discordProcess.js,
    // since @discordjs/ws doesn't expose an agent option here. Never touches
    // the room/Puppeteer connection, which lives in a different process.
    if (discordProxyUrl) {
        clientOptions.rest = { agent: buildSocksDispatcher(discordProxyUrl) };
    }
    const client = new Client(clientOptions);

    let logChannel = null;
    let reportChannel = null;
    let statusChannel = null;
    let statusMessage = null;
    let passwordChannel = null;
    let adminCallChannel = null;
    let votebanChannel = null;
    let mentionAlertChannel = null;
    let roomLink = null;
    let bffLogChannel = null;
    let bffReportChannel = null;
    // { playerCount, roomLink } | null — set via updateBffRoomStatus(),
    // called from the BFF orchestrator side (see discordProcess.js's IPC
    // bridge). null until BFF has reported in at least once, so the status
    // message shows only the main room until then — same output as before
    // this feature existed.
    let bffStatus = null;

    // Bug (reported live): a transient Discord API hiccup (503 Service
    // Unavailable, a proxy connect timeout — both seen in production) left
    // the status message showing a DEAD room link — !edit failing just
    // logged an error and gave up, with nothing to naturally retry it
    // until the next player join/leave happened to call updateRoomStatus()
    // again. In a freshly-restarted, still-empty room (nobody around yet
    // to trigger that), the stale link could sit there indefinitely.
    // Retried with backoff instead of a single silent failure.
    const STATUS_UPDATE_RETRY_DELAYS_MS = [3000, 10000, 30000];

    // Keeps a single message live in discordStatusChannelId, with a real
    // "Присоединиться" link button — edited in place rather than reposted so
    // it doesn't get buried, and so a bot restart never leaves a stale message
    // with a dead room link sitting in the channel. Nothing pushes this on its
    // own, so the room has to poke it whenever the player count or room link
    // changes. The message ID is persisted (db.setSetting) since `statusMessage`
    // itself is only an in-memory reference — without that, every restart would
    // forget the old message and post a brand new one instead of editing it.
    // Shared by updateRoomStatus (main room) and updateBffRoomStatus (BFF) —
    // both rooms' info lives in ONE message (see haxchill-second-room-plan:
    // "combined exception" to the otherwise-separate-channels rule), so
    // either side changing has to rebuild the same payload. BFF's block is
    // only included once it has reported in at least once (bffStatus !=
    // null) — before that, or if BFF is never running at all, this is
    // byte-for-byte the same payload as before this feature existed.
    function buildStatusPayload() {
        const embeds = [];
        const buttons = [];
        if (roomLink) {
            embeds.push(
                new EmbedBuilder()
                    .setTitle('HaxLab')
                    .setDescription(`Игроков в комнате: **${state.playersAll.length}/${maxPlayers}**`)
                    .setColor(0x62cbff)
            );
            buttons.push(new ButtonBuilder().setLabel('Присоединиться').setStyle(ButtonStyle.Link).setURL(roomLink));
        }
        if (bffStatus) {
            embeds.push(
                new EmbedBuilder()
                    .setTitle('HaxLab BFF')
                    .setDescription(`Игроков в комнате: **${bffStatus.playerCount}/${bffMaxPlayers}**`)
                    .setColor(0xffa500)
            );
            buttons.push(new ButtonBuilder().setLabel('Присоединиться (BFF)').setStyle(ButtonStyle.Link).setURL(bffStatus.roomLink));
        }
        return { embeds, components: [new ActionRowBuilder().addComponents(...buttons)] };
    }

    // Guard relaxed to "either room has something to show" — before BFF
    // existed this was equivalent to the original `!roomLink` check (bffStatus
    // is always null then), so the main room's behavior is unchanged.
    function updateRoomStatus(attempt = 0) {
        if (!statusChannel || (!roomLink && !bffStatus)) return;
        const payload = buildStatusPayload();
        const retry = (err) => {
            console.error('Discord room status update failed:', err);
            if (attempt < STATUS_UPDATE_RETRY_DELAYS_MS.length) {
                setTimeout(() => updateRoomStatus(attempt + 1), STATUS_UPDATE_RETRY_DELAYS_MS[attempt]);
            }
        };
        if (statusMessage) {
            statusMessage.edit(payload).catch(retry);
        } else {
            statusChannel.send(payload)
                .then((msg) => {
                    statusMessage = msg;
                    db.setSetting(STATUS_MESSAGE_SETTING_KEY, msg.id);
                })
                .catch(retry);
        }
    }

    client.once(Events.ClientReady, async () => {
        if (discordLogChannelId) logChannel = await client.channels.fetch(discordLogChannelId).catch(() => null);
        if (discordReportChannelId) reportChannel = await client.channels.fetch(discordReportChannelId).catch(() => null);
        if (discordStatusChannelId) statusChannel = await client.channels.fetch(discordStatusChannelId).catch(() => null);
        if (discordPasswordChannelId) passwordChannel = await client.channels.fetch(discordPasswordChannelId).catch(() => null);
        if (discordAdminCallChannelId) adminCallChannel = await client.channels.fetch(discordAdminCallChannelId).catch(() => null);
        if (discordVotebanChannelId) votebanChannel = await client.channels.fetch(discordVotebanChannelId).catch(() => null);
        if (discordMentionAlertChannelId) mentionAlertChannel = await client.channels.fetch(discordMentionAlertChannelId).catch(() => null);
        if (discordBffLogChannelId) bffLogChannel = await client.channels.fetch(discordBffLogChannelId).catch(() => null);
        if (discordBffReportChannelId) bffReportChannel = await client.channels.fetch(discordBffReportChannelId).catch(() => null);
        if (statusChannel) {
            const savedMessageId = db.getSetting(STATUS_MESSAGE_SETTING_KEY);
            if (savedMessageId) statusMessage = await statusChannel.messages.fetch(savedMessageId).catch(() => null);
        }
        // Global, not per-guild: works in every server the bot is invited to
        // (and in DMs) without re-registering anywhere. The trade-off is a
        // newly added/changed command can take up to ~1h to show up.
        await client.application.commands.set(slashCommandData).catch((err) => console.error('Discord slash command registration failed:', err));
        updateRoomStatus();
        await reconcileVipRoles(client.guilds.cache.first(), { discordVipRoleId, db }).catch((err) => console.error('Discord VIP role reconciliation failed:', err));
    });

    client.on(Events.MessageCreate, async (message) => {
        const reply = await handleIncomingMessage(message, { discordOwnerId, discordAdminRoleId, db, state, getAuthArray, getPrintPlayerStats, relayToRoom, kickPlayerByAuth, muteByAuth, unmuteByAuth, getTimeStats });
        if (reply) message.channel.send(reply).catch((err) => console.error('Discord reply failed:', err));
    });

    client.on(Events.GuildMemberAdd, (member) => {
        handleGuildMemberAdd(member, { discordAutoRoleId });
    });

    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
        handleGuildMemberUpdate(oldMember, newMember, { discordVipRoleId, db, grantVipByAuth });
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        const reply = await handleSlashCommand(interaction, { discordOwnerId, discordAdminRoleId, db, state, getAuthArray, getPrintPlayerStats, relayToRoom, kickPlayerByAuth, muteByAuth, unmuteByAuth, getTimeStats });
        if (reply) interaction.reply(reply).catch((err) => console.error('Discord interaction reply failed:', err));
    });

    function init() {
        if (!discordToken) return Promise.resolve();
        return client.login(discordToken).catch((err) => console.error('Discord login failed:', err));
    }

    function sendLog(content) {
        if (!logChannel) return;
        logChannel.send(content).catch((err) => console.error('Discord sendLog failed:', err));
    }

    function sendReport(embedData) {
        if (!reportChannel) return;
        const embed = new EmbedBuilder()
            .setTitle(embedData.title)
            .setDescription(embedData.description)
            .setColor(embedData.color)
            .addFields(embedData.fields)
            .setFooter({ text: embedData.footer.text })
            .setTimestamp(new Date(embedData.timestamp));
        reportChannel.send({ embeds: [embed] }).catch((err) => console.error('Discord sendReport failed:', err));
    }

    function sendRecording(buffer, filename) {
        if (!reportChannel) return;
        const attachment = new AttachmentBuilder(Buffer.from(buffer), { name: filename });
        reportChannel.send({ files: [attachment] }).catch((err) => console.error('Discord sendRecording failed:', err));
    }

    function setRoomLink(url) {
        roomLink = url;
        updateRoomStatus();
    }

    /* BFF — see haxchill-second-room-plan project memory: own log/report
     * channels, folded into the ONE shared status message above. */
    function sendBffLog(content) {
        if (!bffLogChannel) return;
        bffLogChannel.send(content).catch((err) => console.error('Discord sendBffLog failed:', err));
    }

    function sendBffReport(embedData) {
        if (!bffReportChannel) return;
        const embed = new EmbedBuilder()
            .setTitle(embedData.title)
            .setDescription(embedData.description)
            .setColor(embedData.color)
            .addFields(embedData.fields)
            .setFooter({ text: embedData.footer.text })
            .setTimestamp(new Date(embedData.timestamp));
        bffReportChannel.send({ embeds: [embed] }).catch((err) => console.error('Discord sendBffReport failed:', err));
    }

    function sendBffRecording(buffer, filename) {
        if (!bffReportChannel) return;
        const attachment = new AttachmentBuilder(Buffer.from(buffer), { name: filename });
        bffReportChannel.send({ files: [attachment] }).catch((err) => console.error('Discord sendBffRecording failed:', err));
    }

    function updateBffRoomStatus(playerCount, url) {
        bffStatus = { playerCount, roomLink: url };
        updateRoomStatus();
    }

    function sendPassword(password) {
        if (!passwordChannel) return;
        passwordChannel.send(`🔒 Комната заполнена! Пароль на оставшиеся места: **${password}** (обновляется каждый час)`)
            .catch((err) => console.error('Discord sendPassword failed:', err));
    }

    // !report (player.js, and BFF's core/bff/adminCall.js) — pings admins
    // in ONE shared dedicated channel for BOTH rooms (confirmed 2026-08-14
    // — not a separate BFF channel), distinguished only by roomTag. The
    // `parse: ['everyone']` allowedMentions flag covers @here too (Discord
    // treats @everyone/@here as the same mention category), and is needed
    // to actually trigger a ping — without it, discord.js still renders the
    // text but suppresses the notification.
    function sendAdminCall(playerName, roomTag = 'FUTSAL') {
        if (!adminCallChannel) return;
        adminCallChannel.send({
            content: `@here [${roomTag}] **${playerName}** позвал админа!`,
            allowedMentions: { parse: ['everyone'] },
        }).catch((err) => console.error('Discord sendAdminCall failed:', err));
    }

    // !voteban (voteBan.js) — posted only once a vote actually passes and
    // the target gets banned, not on every vote.
    function sendVoteBanNotification({ targetName, durationMinutes, votesFor, votesAgainst, abstained }) {
        if (!votebanChannel) return;
        const embed = new EmbedBuilder()
            .setTitle('🔨 Бан по голосованию')
            .setDescription(`**${targetName}** забанен(а) голосованием игроков на ${durationMinutes} мин.`)
            .addFields(
                { name: 'За', value: String(votesFor), inline: true },
                { name: 'Против', value: String(votesAgainst), inline: true },
                { name: 'Воздержались', value: String(abstained), inline: true },
            )
            .setColor(0xe74c3c)
            .setTimestamp();
        votebanChannel.send({ embeds: [embed] }).catch((err) => console.error('Discord sendVoteBanNotification failed:', err));
    }

    // events/activity.js's onPlayerChat — fires whenever a chat message
    // contains "@<MENTION_WATCH_NAME>". allowedMentions.users is scoped to
    // JUST discordOwnerId: `text` is raw, untrusted room chat, and without
    // this restriction a player typing "@everyone" would get relayed as a
    // real @everyone ping (discord.js parses all mentions in content by
    // default unless allowedMentions explicitly narrows them).
    function sendMentionAlert(speakerName, text) {
        if (!mentionAlertChannel || !discordOwnerId) return;
        mentionAlertChannel.send({
            content: `<@${discordOwnerId}> **${speakerName}** упомянул(а) вас в чате: ${text}`,
            allowedMentions: { users: [discordOwnerId] },
        }).catch((err) => console.error('Discord sendMentionAlert failed:', err));
    }

    // commands/player.js's linkDiscordCommand, via the discordId/auth/
    // targetName bridged over IPC (see discordProcess.js's 'checkVipRoleOnLink'
    // handling) — see checkVipRoleOnLink above for why this exists.
    function checkVipRoleOnLinkForGuild(discordId, auth, targetName) {
        checkVipRoleOnLink(client.guilds.cache.first(), discordId, auth, targetName, { discordVipRoleId, grantVipByAuth })
            .catch((err) => console.error('Discord checkVipRoleOnLink failed:', err));
    }

    // discordProcess.js's 'grantVipRole'/'revokeVipRole' IPC handling —
    // called with a discordId already resolved from the room-supplied auth
    // (see there for why the resolution happens on that side, not this one).
    function grantVipRoleForGuild(discordId) {
        grantVipRoleOnGuild(client.guilds.cache.first(), discordId, { discordVipRoleId })
            .catch((err) => console.error('Discord VIP role grant failed:', err));
    }
    function revokeVipRoleForGuild(discordId) {
        revokeVipRoleOnGuild(client.guilds.cache.first(), discordId, { discordVipRoleId })
            .catch((err) => console.error('Discord VIP role revoke failed:', err));
    }

    return {
        init,
        sendLog,
        sendReport,
        sendRecording,
        setRoomLink,
        updateRoomStatus,
        sendPassword,
        sendAdminCall,
        sendVoteBanNotification,
        sendMentionAlert,
        checkVipRoleOnLink: checkVipRoleOnLinkForGuild,
        grantVipRole: grantVipRoleForGuild,
        revokeVipRole: revokeVipRoleForGuild,
        sendBffLog,
        sendBffReport,
        sendBffRecording,
        updateBffRoomStatus,
    };
};

// Exposed statically so tests can exercise the message/interaction-handling
// logic without spinning up a real discord.js Client.
module.exports.handleIncomingMessage = handleIncomingMessage;
module.exports.handleSlashCommand = handleSlashCommand;
module.exports.handleGuildMemberAdd = handleGuildMemberAdd;
module.exports.handleGuildMemberUpdate = handleGuildMemberUpdate;
module.exports.checkVipRoleOnLink = checkVipRoleOnLink;
module.exports.grantVipRoleOnGuild = grantVipRoleOnGuild;
module.exports.revokeVipRoleOnGuild = revokeVipRoleOnGuild;
module.exports.reconcileVipRoles = reconcileVipRoles;
module.exports.resolveStatsByName = resolveStatsByName;
module.exports.listCurrentPlayers = listCurrentPlayers;
