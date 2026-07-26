/*
 * Discord bot replacing the old fire-and-forget webhooks: posts the room's
 * activity log and match reports, and answers a stats lookup command. Every
 * command works both as a !prefix message and as a global "/" slash command
 * — global rather than per-guild so the bot doesn't need re-registering in
 * every server it joins, at the cost of up to ~1h for Discord to propagate a
 * newly added/changed command.
 */
const { Client, GatewayIntentBits, Events, EmbedBuilder, AttachmentBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const SAY_PREFIX = '!say';
const STATS_COMMAND_PREFIX = '!stats';
const PLAYERS_PREFIX = '!players';
const BANAUTH_PREFIX = '!banauth';
const UNBANAUTH_PREFIX = '!unbanauth';
const STATUS_MESSAGE_SETTING_KEY = 'statusMessageId';

const slashCommandData = [
    new SlashCommandBuilder()
        .setName('say')
        .setDescription('Отправить сообщение в чат комнаты HaxBall (только для владельца)')
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
        .setName('players')
        .setDescription('Показать список игроков в комнате вместе с их auth (только для владельца)'),
    new SlashCommandBuilder()
        .setName('banauth')
        .setDescription('Забанить игрока по auth — работает даже если он не в комнате (только для владельца)')
        .addStringOption((option) => option.setName('auth').setDescription('Auth игрока').setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('Причина бана').setRequired(false)),
    new SlashCommandBuilder()
        .setName('unbanauth')
        .setDescription('Снять бан по auth (только для владельца)')
        .addStringOption((option) => option.setName('auth').setDescription('Auth забаненного игрока').setRequired(true)),
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
function handleIncomingMessage(message, { discordOwnerId, db, state, getAuthArray, getPrintPlayerStats, relayToRoom, kickPlayerByAuth }) {
    if (message.author.bot) return null;

    if (message.content.toLowerCase().startsWith(SAY_PREFIX)) {
        if (message.author.id !== discordOwnerId) return null;
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
        if (message.author.id !== discordOwnerId) return null;
        const auth = message.content.slice(UNBANAUTH_PREFIX.length).trim();
        if (auth === '') return 'Использование: !unbanauth <auth>';
        const existing = db.getAuthBan(auth);
        if (!existing) return 'Этот auth не забанен.';
        db.unbanAuth(auth);
        return `${existing.playerName} разбанен по auth.`;
    }

    // Checked after !unbanauth/!players so "!banauth" doesn't shadow them —
    // none of these prefixes are substrings of each other, but keeping the
    // more specific commands first is the safer habit.
    if (message.content.toLowerCase().startsWith(BANAUTH_PREFIX)) {
        if (message.author.id !== discordOwnerId) return null;
        const rest = message.content.slice(BANAUTH_PREFIX.length).trim().split(/ +/);
        const auth = rest[0];
        if (!auth) return 'Использование: !banauth <auth> [причина]';
        const reason = rest.slice(1).join(' ');
        const kicked = kickPlayerByAuth(auth, reason);
        db.banAuth(auth, kicked ? kicked.name : auth, reason);
        return kicked
            ? `${kicked.name} забанен по auth и выгнан из комнаты.`
            : `${auth} забанен по auth (сейчас не в комнате).`;
    }

    if (message.content.toLowerCase().startsWith(STATS_COMMAND_PREFIX)) {
        const name = message.content.slice(STATS_COMMAND_PREFIX.length).trim();

        if (name === '') {
            const auth = db.getAuthByDiscordId(message.author.id);
            if (!auth) return 'Ваш аккаунт Discord не привязан. Используйте "!discord <ваш ID Discord>" в комнате, или "!stats <имя игрока>" здесь.';
            const stats = db.getPlayerStats(auth);
            if (!stats) return "Вы еще не играли в квалификационные игры.";
            return getPrintPlayerStats()(stats);
        }

        const stats = resolveStatsByName(name, { db, state, getAuthArray });
        if (!stats) return `Статистика для "${name}" не найдена.`;
        return getPrintPlayerStats()(stats);
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

const OWNER_ONLY_REPLY = { content: 'Только владелец может использовать эту команду.', ephemeral: true };

// Same separation as handleIncomingMessage: pure decision logic, independently
// testable without a real discord.js Interaction. Mirrors handleIncomingMessage's
// behavior command-for-command, just reading typed slash-command options instead
// of parsing message text — /stats replies publicly (like !stats) since it's an
// open lookup, the rest stay ephemeral (owner-only moderation/utility actions).
function handleSlashCommand(interaction, { discordOwnerId, db, state, getAuthArray, getPrintPlayerStats, relayToRoom, kickPlayerByAuth }) {
    const { commandName } = interaction;

    if (commandName === 'say') {
        if (interaction.user.id !== discordOwnerId) return OWNER_ONLY_REPLY;
        const text = interaction.options.getString('message');
        relayToRoom(interaction.user.displayName, text);
        return { content: `Отправлено: ${text}`, ephemeral: true };
    }

    if (commandName === 'players') {
        if (interaction.user.id !== discordOwnerId) return OWNER_ONLY_REPLY;
        return { content: listCurrentPlayers(state, getAuthArray), ephemeral: true };
    }

    if (commandName === 'banauth') {
        if (interaction.user.id !== discordOwnerId) return OWNER_ONLY_REPLY;
        const auth = interaction.options.getString('auth');
        const reason = interaction.options.getString('reason') ?? '';
        const kicked = kickPlayerByAuth(auth, reason);
        db.banAuth(auth, kicked ? kicked.name : auth, reason);
        const content = kicked
            ? `${kicked.name} забанен по auth и выгнан из комнаты.`
            : `${auth} забанен по auth (сейчас не в комнате).`;
        return { content, ephemeral: true };
    }

    if (commandName === 'unbanauth') {
        if (interaction.user.id !== discordOwnerId) return OWNER_ONLY_REPLY;
        const auth = interaction.options.getString('auth');
        const existing = db.getAuthBan(auth);
        if (!existing) return { content: 'Этот auth не забанен.', ephemeral: true };
        db.unbanAuth(auth);
        return { content: `${existing.playerName} разбанен по auth.`, ephemeral: true };
    }

    if (commandName === 'stats') {
        const name = interaction.options.getString('name');

        if (!name) {
            const auth = db.getAuthByDiscordId(interaction.user.id);
            if (!auth) return { content: 'Ваш аккаунт Discord не привязан. Используйте "!discord <ваш ID Discord>" в комнате, или укажите имя игрока.' };
            const stats = db.getPlayerStats(auth);
            if (!stats) return { content: 'Вы еще не играли в квалификационные игры.' };
            return { content: getPrintPlayerStats()(stats) };
        }

        const stats = resolveStatsByName(name, { db, state, getAuthArray });
        if (!stats) return { content: `Статистика для "${name}" не найдена.` };
        return { content: getPrintPlayerStats()(stats) };
    }

    return null;
}

module.exports = function createDiscordBot({
    discordToken,
    discordLogChannelId,
    discordReportChannelId,
    discordOwnerId,
    discordAutoRoleId,
    discordStatusChannelId,
    discordPasswordChannelId,
    maxPlayers,
    db,
    state,
    getAuthArray,
    getPrintPlayerStats,
    relayToRoom,
    kickPlayerByAuth,
}) {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            // Needed to receive GuildMemberAdd at all — like MessageContent,
            // this is a privileged intent that must also be enabled in the
            // Discord Developer Portal (Bot > Privileged Gateway Intents >
            // Server Members Intent), or client.login() will reject.
            GatewayIntentBits.GuildMembers,
        ],
    });

    let logChannel = null;
    let reportChannel = null;
    let statusChannel = null;
    let statusMessage = null;
    let passwordChannel = null;
    let roomLink = null;

    // Keeps a single message live in discordStatusChannelId, with a real
    // "Присоединиться" link button — edited in place rather than reposted so
    // it doesn't get buried, and so a bot restart never leaves a stale message
    // with a dead room link sitting in the channel. Nothing pushes this on its
    // own, so the room has to poke it whenever the player count or room link
    // changes. The message ID is persisted (db.setSetting) since `statusMessage`
    // itself is only an in-memory reference — without that, every restart would
    // forget the old message and post a brand new one instead of editing it.
    function updateRoomStatus() {
        if (!statusChannel || !roomLink) return;
        const playerCount = state.playersAll.length;
        const payload = {
            embeds: [
                new EmbedBuilder()
                    .setTitle('HaxChill')
                    .setDescription(`Игроков в комнате: **${playerCount}/${maxPlayers}**`)
                    .setColor(0x62cbff),
            ],
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setLabel('Присоединиться').setStyle(ButtonStyle.Link).setURL(roomLink)
                ),
            ],
        };
        if (statusMessage) {
            statusMessage.edit(payload).catch((err) => console.error('Discord room status edit failed:', err));
        } else {
            statusChannel.send(payload)
                .then((msg) => {
                    statusMessage = msg;
                    db.setSetting(STATUS_MESSAGE_SETTING_KEY, msg.id);
                })
                .catch((err) => console.error('Discord room status send failed:', err));
        }
    }

    client.once(Events.ClientReady, async () => {
        if (discordLogChannelId) logChannel = await client.channels.fetch(discordLogChannelId).catch(() => null);
        if (discordReportChannelId) reportChannel = await client.channels.fetch(discordReportChannelId).catch(() => null);
        if (discordStatusChannelId) statusChannel = await client.channels.fetch(discordStatusChannelId).catch(() => null);
        if (discordPasswordChannelId) passwordChannel = await client.channels.fetch(discordPasswordChannelId).catch(() => null);
        if (statusChannel) {
            const savedMessageId = db.getSetting(STATUS_MESSAGE_SETTING_KEY);
            if (savedMessageId) statusMessage = await statusChannel.messages.fetch(savedMessageId).catch(() => null);
        }
        // Global, not per-guild: works in every server the bot is invited to
        // (and in DMs) without re-registering anywhere. The trade-off is a
        // newly added/changed command can take up to ~1h to show up.
        await client.application.commands.set(slashCommandData).catch((err) => console.error('Discord slash command registration failed:', err));
        updateRoomStatus();
    });

    client.on(Events.MessageCreate, (message) => {
        const reply = handleIncomingMessage(message, { discordOwnerId, db, state, getAuthArray, getPrintPlayerStats, relayToRoom, kickPlayerByAuth });
        if (reply) message.channel.send(reply).catch((err) => console.error('Discord reply failed:', err));
    });

    client.on(Events.GuildMemberAdd, (member) => {
        handleGuildMemberAdd(member, { discordAutoRoleId });
    });

    client.on(Events.InteractionCreate, (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        const reply = handleSlashCommand(interaction, { discordOwnerId, db, state, getAuthArray, getPrintPlayerStats, relayToRoom, kickPlayerByAuth });
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

    function sendPassword(password) {
        if (!passwordChannel) return;
        passwordChannel.send(`🔒 Комната заполнена! Пароль на оставшиеся места: **${password}** (обновляется каждый час)`)
            .catch((err) => console.error('Discord sendPassword failed:', err));
    }

    return {
        init,
        sendLog,
        sendReport,
        sendRecording,
        setRoomLink,
        updateRoomStatus,
        sendPassword,
    };
};

// Exposed statically so tests can exercise the message/interaction-handling
// logic without spinning up a real discord.js Client.
module.exports.handleIncomingMessage = handleIncomingMessage;
module.exports.handleSlashCommand = handleSlashCommand;
module.exports.handleGuildMemberAdd = handleGuildMemberAdd;
module.exports.resolveStatsByName = resolveStatsByName;
module.exports.listCurrentPlayers = listCurrentPlayers;
