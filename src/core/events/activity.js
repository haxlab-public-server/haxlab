/*
 * room.onPlayerChat/BallKick/Activity — chat commands and per-tick activity tracking.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createActivityEvents({
    room,
    state,
    authArray,
    BallTouch,
    HaxNotification,
    Role,
    Situation,
    State,
    Team,
    Trophies,
    adminChatColor,
    commands,
    discordBot,
    errorColor,
    hiddenAdminsSet,
    hiddenVipSet,
    masterChatColor,
    mentionWatchName,
    MutePlayer,
    muteArray,
    silencedAuths,
    vipChatColor,
    checkGoalKickTouch,
    chooseModeFunction,
    swapModeFunction,
    formatTrophyLabel,
    resolveTrophyRank,
    getCommand,
    getDate,
    getGoalGame,
    getPlayerComp,
    getRole,
    handleVoteMessage,
    handleVoteBanMessage,
    jjCommand,
    playerChat,
    slowModeFunction,
    teamChat,
    // Auto-mute a flooding player once they hit spamMessageThreshold
    // messages inside any spamWindowMs window. Tracked per auth (not
    // player id), so reconnecting mid-flood doesn't reset the count, and
    // counts EVERY message attempt — commands included, not just plain
    // chat — since either can be used to spam. Exempts admins (same as
    // muteCommand's own !playerMute.admin check — nothing here should ever
    // be able to silence room staff) and anyone already muted (nothing
    // left to escalate). The resulting mute only ever suppresses their
    // future plain chat, same as any other mute — this doesn't block
    // commands, matching the existing muteArray check further down in
    // onPlayerChat. Injected with defaults (not hardcoded module
    // constants), same tunable-knob pattern as swapTime/chooseTime/
    // muteDuration elsewhere in this codebase — lets tests that don't care
    // about flood detection opt out with a permissive threshold instead of
    // fighting the production default.
    spamWindowMs = 4000,
    spamMessageThreshold = 5,
    spamMuteMinutes = 5,
}) {
    const recentMessageTimestamps = new Map(); // auth -> timestamps[]

    function checkSpamFlood(player) {
        if (player.admin) return;
        const auth = authArray[player.id][0];
        if (muteArray.getByAuth(auth) != null) return;
        const now = Date.now();
        const timestamps = (recentMessageTimestamps.get(auth) ?? []).filter((t) => now - t < spamWindowMs);
        timestamps.push(now);
        if (timestamps.length < spamMessageThreshold) {
            recentMessageTimestamps.set(auth, timestamps);
            return;
        }
        recentMessageTimestamps.delete(auth);
        const muteObj = new MutePlayer(player.name, player.id, auth);
        muteObj.setDuration(spamMuteMinutes);
        room.sendAnnouncement(
            `🔇 ${player.name} автоматически замучен(а) на ${spamMuteMinutes} минут за спам в чате.`,
            null,
            errorColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    function isMuted(player) {
        return !player.admin && muteArray.getByAuth(authArray[player.id][0]) != null;
    }
    function announceMuted(player) {
        room.sendAnnouncement(`Вы замучены !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
    }

    function onPlayerChat(player, message) {
        checkSpamFlood(player);
        if (state.gameState !== State.STOP && player.team != Team.SPECTATORS) {
            let pComp = getPlayerComp(player);
            if (pComp != null) pComp.inactivityTicks = 0;
        }
        let msgArray = message.split(/ +/);
        discordBot.sendLog(`[${getDate()}] 💬 CHAT\n**${player.name}** : ${message.replace('@', '@ ')}`);
        if (mentionWatchName && message.toLowerCase().includes('@' + mentionWatchName.toLowerCase())) {
            discordBot.sendMentionAlert(player.name, message);
        }
        if (msgArray[0][0] == '!') {
            let command = getCommand(msgArray[0].slice(1).toLowerCase());
            if (command != false && commands[command].roles <= getRole(player)) {
                // Fire-and-forget, same as every call site here always was —
                // some command functions are now async (they touch the DB
                // through a bridge), so this catches a rejection that would
                // otherwise have nothing else awaiting it and become an
                // unhandled rejection instead of a logged, per-command error.
                const result = commands[command].function(player, message);
                if (result instanceof Promise) result.catch((err) => console.error(`Error in command !${command}:`, err));
            }
            else
                room.sendAnnouncement(
                    `Команда, которую вы пытались ввести, не существует для вас. Введите "!help" для получения доступных команд.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            return false;
        }
        // Checked BEFORE either vote system, specifically for a bare "1"/"2":
        // a !voteban session runs on its own 60s clock with nothing tied to
        // match transitions (unlike pauseVote's own state, reset on every
        // game start/stop — see gameManagement.js's resetPauseVotes calls),
        // so it can still be mid-vote when a match ends and choose-mode
        // picking begins right after. Since a voteban's eligible-voter pool
        // is "everyone currently in the room", the picking captain is
        // almost always one of them — their "1"/"2" pick was being silently
        // swallowed as a stale vote response instead of a pick (reported
        // live: "после голосования, кэп не может пикать цифрами 1 и 2").
        // chooseModeFunction only ever reacts to the CURRENT captain's own
        // message on their OWN turn (falsy for anyone/anything else — see
        // its own fallthrough), so checking it first here can only ever
        // steal a "1"/"2" from the one player it's actually meant for, at
        // the exact moment it's their turn to pick — never from an
        // ordinary voter, and never outside that captain's own turn.
        if (state.chooseMode && state.teamRed.length * state.teamBlue.length != 0) {
            const choosingMessageCheck = chooseModeFunction(player, message);
            if (choosingMessageCheck) return false;
        }
        if (handleVoteMessage(player, message)) {
            return false;
        }
        // Checked second (pause-vote gets first claim on a bare "1"/"2") —
        // the two systems use separate state namespaces (state.pauseVotes
        // vs state.votebanSession) specifically so they never collide, but
        // a player could theoretically be eligible for both at once.
        if (handleVoteBanMessage(player, message)) {
            return false;
        }
        // 'т'/'ч' — same physical/muscle-memory slip as typing "t" for team
        // chat with the client's own text input still set to a Cyrillic
        // layout instead of Latin.
        //
        // Bug (reported live): a muted player could still be heard by
        // routing through team chat (or the "@@<name>" private-chat
        // trigger right below) — both dispatch here, before the mute check
        // further down ever runs, and neither teamChat nor playerChat
        // (chat.js) checks mute themselves. Each is now gated individually
        // rather than moving the mute check earlier wholesale — jj/
        // swapMode/slowMode below still fall outside it on purpose (mute is
        // about SPEECH, not game-mechanic responses like a swap pick).
        if (['t', 'т', 'ч'].includes(msgArray[0].toLowerCase())) {
            if (isMuted(player)) {
                announceMuted(player);
                return false;
            }
            teamChat(player, message);
            return false;
        }
        if (msgArray[0].substring(0, 2) === '@@') {
            if (isMuted(player)) {
                announceMuted(player);
                return false;
            }
            playerChat(player, message);
            return false;
        }
        // "jj" — no ! prefix, same bare-word shape as "t"/"@@" above. A
        // one-directional AFK shortcut: only ever EXITS AFK (see
        // commands/player.js's exitAfk/jjCommand). jjCommand itself decides
        // whether there was anything to do — a non-AFK player typing "jj"
        // (a common gaming interjection on its own) falls through to
        // ordinary chat instead of being silently swallowed.
        if (msgArray[0].toLowerCase() == 'jj' && jjCommand(player, message)) {
            return false;
        }
        if (state.swapMode) {
            const swapMessageCheck = swapModeFunction(player, message);
            if (swapMessageCheck) return false;
        }
        if (state.slowMode > 0) {
            const filter = slowModeFunction(player, message);
            if (filter) return false;
        }
        if (isMuted(player)) {
            announceMuted(player);
            return false;
        }

        // Every chat message is sent through room.sendAnnouncement, never
        // left to HaxBall's native chat bubble — same trick teamChat/
        // playerChat already use above. MASTER/ADMIN/VIP get a role prefix
        // and keep the bold style; everyone else (including plain players
        // and club/trophy-only prefixes) renders in the normal style.
        // !hide (commands/admin.js) suppresses just the MASTER/ADMIN prefix
        // — role/permissions are untouched, so a hidden VIP-flagged admin
        // would still fall through to the VIP prefix rather than none at all.
        // !viphide (commands/player.js) is the same idea for VIP specifically.
        const role = getRole(player);
        const showAdminPrefix = !hiddenAdminsSet.has(player.id);
        const showVipPrefix = !hiddenVipSet.has(player.id);
        const auth = authArray[player.id][0];
        let rolePrefix = null;
        let prefixColor = null;
        if (showAdminPrefix && role == Role.MASTER) {
            rolePrefix = '[👑СЗД]';
            prefixColor = masterChatColor;
        } else if (showAdminPrefix && role >= Role.ADMIN_TEMP) {
            rolePrefix = '[🛡️АДМ]';
            prefixColor = adminChatColor;
        } else if (showVipPrefix && role == Role.VIP) {
            rolePrefix = '[⭐ВИП]';
            // !vipcolor (see commands/player.js) — a VIP's own override for
            // this, falling back to the shared default when they haven't
            // set one. Same color for everyone who sees it, unlike
            // !customcolors' per-viewer club-color opt-out.
            prefixColor = state.vipColors[auth] ?? vipChatColor;
        }
        // Full prefix order is [клуб] [трофей] [роль] — club tag first, then
        // the equipped trophy (!trophy, see commands/trophies.js), then the
        // role prefix last. They stack rather than one replacing another
        // (e.g. an admin who's also in a club shows both) — the role's own
        // color always wins over the club's custom one, since a role is
        // never "hidden" here whereas a club member with no custom color set
        // just falls back to the default chat color (see constants.js's
        // defaultColor/null semantics in room.sendAnnouncement).
        const membership = state.clubMembers.find((m) => m.auth == auth);
        const club = membership && state.clubs.find((c) => c.id == membership.clubId);
        const clubPrefix = club ? `[${club.emoji ?? ''}${club.prefix}]` : null;
        // Tracked separately from prefixColor itself: only a color that
        // actually came from the club is a per-viewer preference
        // (!customcolors, see commands/player.js) — a role's color never is.
        let usesClubColor = false;
        if (club && prefixColor == null) {
            prefixColor = club.color;
            usesClubColor = club.color != null;
        }
        // A LIVE trophy pick only actually shows while state.topPlayers still
        // agrees the player holds a top-3 spot this season — an
        // equipped-but-since-lost one silently stops appearing rather than
        // lying (see commands/trophies.js). A LEGACY pick (a past, already
        // CLOSED season — see db.closeSeason) is frozen forever in
        // state.seasonTrophies instead, so it always shows once earned. The
        // medal (🥇/🥈/🥉) and season tag always reflect resolveTrophyRank's
        // current answer, never whatever it was when !trophy was last run.
        const equippedTrophyKey = state.equippedTrophies[auth];
        const resolvedTrophy = equippedTrophyKey
            ? resolveTrophyRank(equippedTrophyKey, auth, state.currentSeason, state.topPlayers, state.seasonTrophies)
            : null;
        const trophyPrefix = resolvedTrophy
            ? `[${formatTrophyLabel(Trophies, resolvedTrophy.category, resolvedTrophy.rank, resolvedTrophy.season)}]`
            : null;
        const prefix = [clubPrefix, trophyPrefix, rolePrefix].filter((p) => p != null).join(' ');
        const displayName = prefix ? `${prefix} ${player.name}` : player.name;
        // Only a role (MASTER/ADMIN/VIP) earns the bold style — club/trophy
        // prefixes alone don't, same as a plain player with no prefix at all.
        const style = rolePrefix != null ? 'bold' : 'normal';
        const text = `${displayName}: ${message}`;
        // "@<name>" mentions of any currently-connected player — gives just
        // THEM the native HaxBall "mention" notification sound (a more
        // attention-grabbing alert than the ordinary chat pop everyone else
        // gets), same simple case-insensitive substring match
        // MENTION_WATCH_NAME's own Discord-relay check already uses, not
        // just the one hardcoded name. Self-mentions excluded — pinging
        // your own message back at yourself isn't useful. Confirmed
        // 2026-08-14: this never actually worked in production before (the
        // sound argument to sendAnnouncement was always null/CHAT
        // regardless of the message text).
        const lowerMessage = message.toLowerCase();
        const mentionedIds = new Set(
            state.playersAll
                .filter((p) => p.id !== player.id && lowerMessage.includes('@' + p.name.toLowerCase()))
                .map((p) => p.id)
        );
        // !silence (commands/player.js) is a per-VIEWER filter: whoever
        // silenced this speaker's auth just never gets the message sent to
        // them, while everyone else still sees it normally — same
        // per-viewer-loop trick !customcolors uses below for color, except
        // here a silenced viewer is skipped entirely instead of recolored.
        // silencedAuths starts empty and most rooms never touch it, so the
        // cheap single-broadcast path below stays untouched until someone
        // actually uses the command (now also taken whenever a message
        // contains a mention, so the per-viewer sound can differ).
        if (usesClubColor || silencedAuths.size > 0 || mentionedIds.size > 0) {
            for (const viewer of state.playersAll) {
                const viewerAuth = authArray[viewer.id][0];
                if (silencedAuths.get(viewerAuth)?.has(auth)) continue;
                const viewerColor = usesClubColor && state.hiddenCustomColorsSet.has(viewerAuth) ? null : prefixColor;
                const sound = mentionedIds.has(viewer.id) ? HaxNotification.MENTION : null;
                room.sendAnnouncement(text, viewer.id, viewerColor, style, sound);
            }
        } else {
            room.sendAnnouncement(text, null, prefixColor, style, null);
        }
        return false;
    }

    function onPlayerActivity(player) {
        if (state.gameState !== State.STOP) {
            let pComp = getPlayerComp(player);
            if (pComp != null) pComp.inactivityTicks = 0;
        }
    }

    function onPlayerBallKick(player) {
        if (state.playSituation != Situation.GOAL) {
            const ballPosition = room.getBallPosition();
            if (state.game.touchArray.length == 0 || player.id != state.game.touchArray[state.game.touchArray.length - 1].player.id) {
                if (state.playSituation == Situation.KICKOFF) state.playSituation = Situation.PLAY;
                state.lastTeamTouched = player.team;
                state.game.touchArray.push(
                    new BallTouch(
                        player,
                        state.game.scores.time,
                        getGoalGame(),
                        ballPosition
                    )
                );
                state.lastTouches[0] = checkGoalKickTouch(
                    state.game.touchArray,
                    state.game.touchArray.length - 1,
                    getGoalGame()
                );
                state.lastTouches[1] = checkGoalKickTouch(
                    state.game.touchArray,
                    state.game.touchArray.length - 2,
                    getGoalGame()
                );
            }
        }
    }

    return {
        onPlayerChat,
        onPlayerActivity,
        onPlayerBallKick,
    };
};
