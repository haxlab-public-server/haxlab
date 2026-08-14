/*
 * BFF's own !afk / "jj" / !afks — forked out of commands/player.js's
 * exitAfk/jjCommand/afkCommand/afkListCommand (identical timers/behavior),
 * not reused as-is: the original calls team/balance.js's
 * handlePlayersJoin/handlePlayersLeave (the main room's captain-pick/
 * random-balance system) and checks state.chooseMode, neither of which
 * exist on BFF — this calls matchFlow.js's own handlePlayersJoin/
 * handlePlayersLeave instead (same "roster just changed, reassemble/wait"
 * role, different implementation) and drops the chooseMode guard entirely
 * (BFF has no captain draft to dodge out of).
 *
 * Voluntary/manual — distinct from bffEntry.js's own handleActivityPlayer
 * (auto-kicks an unresponsive player mid-match). This is a player choosing
 * to step away and hold their spot as a spectator, exempted from being
 * pulled back onto a team, until they toggle it off again.
 *
 * Mutable room state is reached through `state`, never captured by value.
 */
module.exports = function createBffAfk({
    room,
    state,
    Team,
    State,
    Role,
    AFKSet,
    AFKMinSet,
    AFKCooldownSet,
    minAFKDuration,
    maxAFKDuration,
    maxAFKDurationVip,
    maxAFKCount,
    AFKCooldown,
    announcementColor,
    errorColor,
    HaxNotification,
    getRole,
    updateTeams,
    matchFlow,
}) {
    // async, unlike the main room's own exitAfk: this calls matchFlow.js's
    // handlePlayersJoin, which is genuinely async (crosses the DB bridge —
    // see haxchill-second-room-plan memory on matchFlow.js's own async
    // fix) — the main room's team/balance.js equivalent is synchronous, so
    // its bare fire-and-forget call there carries no rejection risk. Here,
    // returning the chained promise lets the existing call-site pattern
    // (bffEntry.js's onPlayerChat: `if (result instanceof Promise)
    // result.catch(...)`) actually catch a DB failure instead of it
    // becoming a genuine unhandled rejection.
    async function exitAfk(player) {
        if (!AFKSet.has(player.id)) return false;
        if (AFKMinSet.has(player.id)) {
            room.sendAnnouncement(`Минимальное время AFK: ${minAFKDuration} минут. Не злоупотребляйте командой !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return true;
        }
        AFKSet.delete(player.id);
        // Fairness-queue fix found alongside this: without a fresh
        // timestamp here, an AFK player kept whatever queue position they
        // had from BEFORE they went AFK (their last real join or bench) —
        // meaning time spent AFK, deliberately opted OUT of playing, would
        // silently count as "waiting" and grant them unfair priority over
        // spectators who were genuinely present and waiting the whole time.
        state.specQueueSince.set(player.id, Date.now());
        room.sendAnnouncement(`🌅 ${player.name} больше не AFK !`, null, announcementColor, 'bold', null);
        updateTeams();
        await matchFlow.handlePlayersJoin();
        return true;
    }

    function jjCommand(player) {
        return exitAfk(player);
    }

    async function afkCommand(player) {
        const betweenRandomRounds = state.gameState == State.STOP;
        if (player.team == Team.SPECTATORS || state.players.length == 1 || betweenRandomRounds) {
            const afkCapForPlayer = getRole(player) >= Role.ADMIN_TEMP
                ? null
                : getRole(player) >= Role.VIP
                    ? maxAFKCount + 1
                    : maxAFKCount;
            if (AFKSet.has(player.id)) {
                await exitAfk(player);
            } else if (afkCapForPlayer != null && AFKSet.size >= afkCapForPlayer) {
                room.sendAnnouncement(`Одновременно AFK может быть не больше ${afkCapForPlayer} игроков. Попробуйте позже.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            } else if (AFKCooldownSet.has(player.id)) {
                room.sendAnnouncement(`Вы можете становиться AFK только каждые ${AFKCooldown} минут. Не злоупотребляйте командой !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            } else {
                AFKSet.set(player.id, Date.now());
                if (!player.admin) {
                    const afkSessionStartedAt = AFKSet.get(player.id);
                    AFKMinSet.add(player.id);
                    AFKCooldownSet.add(player.id);
                    setTimeout((id) => {
                        if (AFKSet.has(id) && AFKSet.get(id) !== afkSessionStartedAt) return;
                        AFKMinSet.delete(id);
                    }, minAFKDuration * 60 * 1000, player.id);
                    const effectiveMaxAFKDuration = getRole(player) >= Role.VIP ? maxAFKDurationVip : maxAFKDuration;
                    setTimeout((id) => {
                        if (!AFKSet.has(id) || AFKSet.get(id) !== afkSessionStartedAt) return;
                        AFKSet.delete(id);
                        const p = room.getPlayer(id);
                        if (p != null) {
                            room.sendAnnouncement(`😴 ${p.name} вышел из AFK !`, null, announcementColor, 'bold', null);
                            room.sendAnnouncement(`Вы слишком долго находились в AFK.`, id, errorColor, 'bold', HaxNotification.CHAT);
                        }
                        updateTeams();
                        // A bare timer callback, not a command dispatch — no
                        // outer promise chain to catch a rejection here, so
                        // it needs its own .catch (unlike the awaited calls
                        // above/below, which ride afkCommand's own returned
                        // promise back to the existing onPlayerChat handler).
                        matchFlow.handlePlayersJoin().catch((err) => console.error('[bff/afk] handlePlayersJoin (AFK auto-return) failed:', err));
                    }, effectiveMaxAFKDuration * 60 * 1000, player.id);
                    setTimeout((id) => {
                        if (AFKSet.has(id) && AFKSet.get(id) !== afkSessionStartedAt) return;
                        AFKCooldownSet.delete(id);
                    }, AFKCooldown * 60 * 1000, player.id);
                }
                if (player.team != Team.SPECTATORS) {
                    room.setPlayerTeam(player.id, Team.SPECTATORS);
                }
                room.sendAnnouncement(`😴 ${player.name} теперь AFK !`, null, announcementColor, 'bold', null);
                updateTeams();
                await matchFlow.handlePlayersLeave();
            }
        } else {
            room.sendAnnouncement(`Вы не можете стать AFK, пока находитесь в команде !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
        }
    }

    function afksCommand(player) {
        if (AFKSet.size == 0) {
            room.sendAnnouncement("😴 В списке AFK никого нет.", player.id, announcementColor, 'bold', null);
            return;
        }
        let cstm = '😴 AFK лист : ';
        AFKSet.forEach((afkSince, id) => {
            const p = room.getPlayer(id);
            if (p != null) {
                const minutesAfk = Math.floor((Date.now() - afkSince) / 60000);
                cstm += `${p.name} (${minutesAfk} мин.), `;
            }
        });
        cstm = cstm.substring(0, cstm.length - 2) + '.';
        room.sendAnnouncement(cstm, player.id, announcementColor, 'bold', null);
    }

    return { exitAfk, jjCommand, afkCommand, afksCommand };
};
