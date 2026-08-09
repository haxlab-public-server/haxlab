/*
 * Pre-match swap window: once captains finish a post-match draft (see
 * balance.js's handlePlayersStop WinStay refill), each captain gets a
 * short turn — blue first, then red — to trade ONE of their own picks for
 * someone left over in state.teamSpec before the match actually kicks off.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event. `completionCallback`
 * is deliberately a plain closure variable, not part of `state` — only one
 * swap session can ever be running at a time, same as state.timeOutCap
 * elsewhere in this file family, but this one doesn't need to survive
 * being read from outside this module.
 */
module.exports = function createSwapHelpers({
    room,
    state,
    Team,
    HaxNotification,
    announcementColor,
    errorColor,
    infoColor,
    swapTime,
    announceOdds,
}) {
    let completionCallback = null;

    function teamName(team) {
        return team == Team.BLUE ? 'синих' : 'красных';
    }

    function getRoster(team) {
        return team == Team.BLUE ? state.teamBlue : state.teamRed;
    }

    function sendList(player, label, list) {
        let msg = `${label} : `;
        for (let i = 0; i < list.length; i++) {
            msg += list[i].name + `[${i + 1}], `;
        }
        msg = msg.substring(0, msg.length - 2) + '.';
        room.sendAnnouncement(msg, player.id, infoColor, 'bold', HaxNotification.CHAT);
    }

    function endSwapPhase() {
        clearTimeout(state.swapTimeout);
        state.swapMode = false;
        state.swapTurnTeam = null;
        state.swapStep = null;
        state.swapPendingPlayerId = null;
        const callback = completionCallback;
        completionCallback = null;
        if (callback) callback();
    }

    function advanceTurn(team) {
        clearTimeout(state.swapTimeout);
        if (team == Team.BLUE) {
            beginCaptainTurn(Team.RED);
        } else {
            endSwapPhase();
        }
    }

    function beginCaptainTurn(team) {
        state.swapTurnTeam = team;
        state.swapStep = 'pickPlayer';
        state.swapPendingPlayerId = null;
        const roster = getRoster(team);
        const captain = roster[0];
        // Nothing this captain could actually do (no captain seated, or
        // nobody waiting to swap in) — skip straight to the next turn
        // instead of burning the whole window on a prompt with no possible
        // answer.
        if (captain == null || state.teamSpec.length == 0) {
            advanceTurn(team);
            return;
        }
        // Room-wide heads-up, separate from the captain's own private
        // prompt below — everyone else just knows whose turn it is (and
        // that the captain might not use it at all), not the full
        // instructions/roster list, which stay private to the captain.
        room.sendAnnouncement(
            `🔄 Время капитана ${teamName(team)} сделать замену (или пропустить).`,
            null,
            infoColor,
            'bold',
            HaxNotification.CHAT
        );
        // Temporarily disabled along with !bet itself (see commands.js) —
        // no point announcing odds nobody can act on. announceOdds is
        // still passed in and still safe to call; just not called for now.
        // Fire-and-forget: reflects whatever the roster looks like RIGHT
        // NOW (including any swap the previous captain's turn just made),
        // same non-blocking reasoning as economy.js's applyTeamForms calls
        // elsewhere in this file family. Fires once per captain turn
        // (blue, then red) — see core/betting.js for the actual odds math.
        // announceOdds().catch((err) => console.error('[betting] announceOdds failed:', err));
        room.sendAnnouncement(
            `🔄 Капитан ${teamName(team)} (${captain.name}), у вас есть ${swapTime}s, чтобы поменять одного игрока своей команды. Если хотите поменять игрока, напишите его номер:`,
            captain.id,
            infoColor,
            'bold',
            HaxNotification.MENTION
        );
        sendList(captain, 'Игроки', roster);
        state.swapTimeout = setTimeout(() => {
            advanceTurn(team);
        }, swapTime * 1000);
    }

    function startSwapPhase(onComplete) {
        completionCallback = onComplete;
        state.swapMode = true;
        beginCaptainTurn(Team.BLUE);
    }

    // Called from handlePlayersLeave whenever a leave lands mid-swap-window
    // — the roster/teamSpec indices a captain was just shown can no longer
    // be trusted, so this bails out entirely (no swap performed) rather
    // than trying to carry on with stale numbers, same "abort, don't limp
    // on" policy chooseMode's own leave-triggered aborts use.
    function cancelSwapPhase() {
        if (!state.swapMode) return;
        endSwapPhase();
    }

    function swapModeFunction(player, message) {
        if (state.swapTurnTeam == null) return false;
        const roster = getRoster(state.swapTurnTeam);
        const captain = roster[0];
        if (captain == null || player.id != captain.id) return false;
        const msgArray = message.split(/ +/);
        const num = Number.parseInt(msgArray[0]);
        if (Number.isNaN(num)) return false;
        if (state.swapStep == 'pickPlayer') {
            if (num < 1 || num > roster.length) {
                room.sendAnnouncement(`Ваш номер недействителен !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                return true;
            }
            state.swapPendingPlayerId = roster[num - 1].id;
            state.swapStep = 'pickReplacement';
            room.sendAnnouncement(
                `Выберите игрока, на которого хотите заменить "${roster[num - 1].name}":`,
                player.id,
                infoColor,
                'bold',
                HaxNotification.MENTION
            );
            sendList(captain, 'Игроки', state.teamSpec);
            return true;
        }
        if (state.swapStep == 'pickReplacement') {
            if (num < 1 || num > state.teamSpec.length) {
                room.sendAnnouncement(`Ваш номер недействителен !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                return true;
            }
            const team = state.swapTurnTeam;
            const outgoing = room.getPlayer(state.swapPendingPlayerId);
            const incoming = state.teamSpec[num - 1];
            // The player picked in step one, or the spectator picked just
            // now, left the room while this prompt was open — nothing sane
            // left to swap, move on rather than acting on a stale id.
            if (outgoing == null || incoming == null) {
                advanceTurn(team);
                return true;
            }
            room.setPlayerTeam(outgoing.id, Team.SPECTATORS);
            room.setPlayerTeam(incoming.id, team);
            room.sendAnnouncement(
                `🔄 Капитан ${teamName(team)} поменял ${outgoing.name} на ${incoming.name} !`,
                null,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
            advanceTurn(team);
            return true;
        }
        return false;
    }

    return {
        startSwapPhase,
        cancelSwapPhase,
        swapModeFunction,
    };
};
