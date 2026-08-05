/*
 * !votepause — a per-team vote (players on the field only) to force a
 * temporary pause mid-match. Needs 3/4 of the team's current roster voting
 * "1" (за); available once per team per match. Only startable right at
 * kickoff (state.playSituation == Situation.KICKOFF, before the ball's been
 * touched) — never mid-play, so it can't be used as a tactical timeout while
 * a team is under pressure or mid-attack.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createPauseVote({
    room,
    state,
    Team,
    State,
    Situation,
    HaxNotification,
    errorColor,
    warningColor,
    successColor,
    redColor,
    blueColor,
    teamSize,
}) {
    const VOTE_DURATION = 7000;
    const PAUSE_DURATION = 20000;

    function teamName(team) {
        return team == Team.RED ? 'Красная' : 'Синяя';
    }

    function teamColor(team) {
        return team == Team.RED ? redColor : blueColor;
    }

    function getTeamArray(team) {
        return team == Team.RED ? state.teamRed : state.teamBlue;
    }

    function announceToTeam(team, message, color, mention) {
        for (const p of getTeamArray(team)) {
            room.sendAnnouncement(message, p.id, color, 'bold', mention);
        }
    }

    function endVote(team, passed) {
        const vote = state.pauseVotes[team];
        if (vote == null) return;
        clearTimeout(vote.timeout);
        state.pauseVotes[team] = null;
        if (passed) {
            state.pauseVoteUsed[team] = true;
            room.sendAnnouncement(
                `⏸️ ${teamName(team)} команда проголосовала за паузу ! Игра будет остановлена на ${PAUSE_DURATION / 1000} секунд.`,
                null,
                teamColor(team),
                'bold',
                HaxNotification.CHAT
            );
            room.pauseGame(true);
            state.pauseVoteUnpauseTimeout = setTimeout(() => {
                if (state.gameState == State.PAUSE) room.pauseGame(false);
            }, PAUSE_DURATION);
        } else {
            announceToTeam(
                team,
                `❌ Голосование за паузу не набрало 3/4 голосов "за" и было отменено.`,
                errorColor,
                HaxNotification.CHAT
            );
        }
    }

    function checkVote(team) {
        const vote = state.pauseVotes[team];
        if (vote == null) return;
        let votesFor = 0;
        for (const v of vote.votes.values()) {
            if (v == 1) votesFor++;
        }
        if (votesFor >= vote.threshold) {
            endVote(team, true);
            return;
        }
        const remaining = vote.voterIds.size - vote.votes.size;
        if (votesFor + remaining < vote.threshold) {
            endVote(team, false);
        }
    }

    function votepauseCommand(player, message) {
        const team = player.team;
        if (team == Team.SPECTATORS) {
            room.sendAnnouncement(
                `Голосование за паузу доступно только игрокам на поле !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        // Only a full house (both teams at teamSize) reaches captain-mode
        // team selection (see team/balance.js's activateChooseMode) — that's
        // the match format this vote is meant for, not an informal
        // auto-balanced 1v1/2v2/3v3.
        if (state.teamRed.length != teamSize || state.teamBlue.length != teamSize) {
            room.sendAnnouncement(
                `Голосование за паузу доступно только в матчах ${teamSize}х${teamSize} с капитан-модом !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (state.gameState != State.PLAY) {
            room.sendAnnouncement(
                `Голосование за паузу доступно только во время игры !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        // Kickoff-only: the ball hasn't been touched yet since the last
        // goal/match start (see events/gameManagement.js/activity.js, which
        // flip state.playSituation to PLAY the instant it's touched) — this
        // is what stops the vote from being used as a mid-play tactical
        // timeout. Only checked here, at the moment the vote STARTS, same
        // as the teamSize/gameState checks above — not re-verified when the
        // vote actually resolves a few seconds later.
        if (state.playSituation != Situation.KICKOFF) {
            room.sendAnnouncement(
                `Голосование за паузу доступно только на кикоффе !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (state.pauseVoteUsed[team]) {
            room.sendAnnouncement(
                `Ваша команда уже использовала голосование за паузу в этом матче !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (state.pauseVotes[team] != null) {
            room.sendAnnouncement(
                `Голосование за паузу вашей команды уже идет !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const teamArray = getTeamArray(team);
        const threshold = Math.ceil(teamArray.length * 3 / 4);
        const votes = new Map();
        votes.set(player.id, 1);
        state.pauseVotes[team] = {
            votes,
            voterIds: new Set(teamArray.map((p) => p.id)),
            threshold,
            timeout: setTimeout(() => endVote(team, false), VOTE_DURATION),
        };
        announceToTeam(
            team,
            `🗳️ ${player.name} начал(а) голосование за паузу ! Напишите "1" — за, "2" — против. Нужно ${threshold} голос(ов) "за" из ${teamArray.length} (у вас ${VOTE_DURATION / 1000} секунд).`,
            warningColor,
            HaxNotification.MENTION
        );
        checkVote(team);
    }

    function handleVoteMessage(player, message) {
        const team = player.team;
        if (team == Team.SPECTATORS) return false;
        const vote = state.pauseVotes[team];
        if (vote == null) return false;
        if (!vote.voterIds.has(player.id)) return false;
        const trimmed = message.trim();
        if (trimmed != '1' && trimmed != '2') return false;
        if (vote.votes.has(player.id)) {
            room.sendAnnouncement(
                `Вы уже проголосовали !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return true;
        }
        vote.votes.set(player.id, trimmed == '1' ? 1 : 2);
        room.sendAnnouncement(
            trimmed == '1' ? `✔️ Ваш голос "за" учтен !` : `✔️ Ваш голос "против" учтен !`,
            player.id,
            successColor,
            'bold',
            HaxNotification.CHAT
        );
        checkVote(team);
        return true;
    }

    // Called on both onGameStart (fresh match — also resets pauseVoteUsed
    // separately) and onGameStop (nothing left to pause/unpause for).
    function resetPauseVotes() {
        for (const team of [Team.RED, Team.BLUE]) {
            const vote = state.pauseVotes[team];
            if (vote != null) clearTimeout(vote.timeout);
            state.pauseVotes[team] = null;
        }
        clearTimeout(state.pauseVoteUnpauseTimeout);
    }

    return {
        votepauseCommand,
        handleVoteMessage,
        resetPauseVotes,
    };
};
