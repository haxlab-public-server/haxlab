/*
 * !voteban #<id> — a room-wide vote (any current player, not per-team) to
 * temporarily ban a disruptive player. Needs VOTE_THRESHOLD_RATIO (61%) of
 * ALL eligible voters currently in the room — not just those who actually
 * cast a vote — so abstaining effectively counts against the ban.
 *
 * Eligibility:
 *   - Voters (and whoever starts the vote) need MIN_GAMES_TO_VOTE games
 *     played. The eligible-voter pool is frozen at the moment the vote
 *     starts (same "snapshot the roster once, don't grow it mid-vote"
 *     design as pauseVote.js's team roster) — someone who joins mid-vote
 *     doesn't get added, someone who leaves is still counted against the
 *     total (they just can no longer cast a vote).
 *   - A target currently ranked top PROTECTED_TOP_N in ANY of !tops' player
 *     categories (games/wins/goals/assists/CS/playtime — own goals isn't a
 *     !tops category at all, so it was never in scope) can't be targeted.
 *   - The room owner (Role.MASTER) can't be targeted either — allowing a
 *     vote to remove the room's own owner isn't something this feature is
 *     meant to enable, even though nobody asked for it explicitly.
 *
 * Only one vote can run at a time, room-wide (not one per target) — same
 * "no overlapping sessions" simplicity as pauseVote.js.
 *
 * A passing vote bans by auth (db.banAuth, BAN_DURATION_MINUTES — there is
 * no "permanent" option in this codebase, see db.banAuth's own docs) and
 * kicks the target if they're still online — same combo commands/master.js's
 * banAuthCommand already uses for !banauth/!ban.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createVoteBan({
    room,
    state,
    authArray,
    db,
    Role,
    getRole,
    HaxNotification,
    errorColor,
    warningColor,
    successColor,
    announcementColor,
    discordBot,
    formatBanRemaining,
}) {
    const VOTE_DURATION_MS = 60000;
    const BAN_DURATION_MINUTES = 60;
    const MIN_GAMES_TO_VOTE = 10;
    const VOTE_THRESHOLD_RATIO = 0.61;
    const PROTECTED_TOP_N = 10;

    // The same 6 columns !tops itself supports (see db/sqlite.js's
    // LEADERBOARD_COLUMNS) — 'clubs' is deliberately excluded, it ranks
    // clubs, not players, so it has no bearing on a single player's
    // protection here.
    const PROTECTED_CATEGORIES = ['games', 'wins', 'goals', 'assists', 'CS', 'playtime'];

    async function isProtectedByTopStats(auth) {
        const leaderboards = await Promise.all(PROTECTED_CATEGORIES.map((key) => db.getLeaderboard(key, PROTECTED_TOP_N)));
        return leaderboards.some((board) => board.some((row) => row.auth === auth));
    }

    async function getPlayerGames(auth) {
        const stats = await db.getPlayerStats(auth);
        return stats?.games ?? 0;
    }

    // Snapshot of who CAN vote right now (everyone currently in the room,
    // minus the target, with enough games) — frozen the instant the vote
    // starts, per this file's own doc comment above.
    async function getEligibleVoterIds(excludePlayerId) {
        const candidates = state.playersAll.filter((p) => p.id !== excludePlayerId);
        const gamesList = await Promise.all(candidates.map((p) => getPlayerGames(authArray[p.id][0])));
        return candidates.filter((_, i) => gamesList[i] >= MIN_GAMES_TO_VOTE).map((p) => p.id);
    }

    function tally(vote) {
        let votesFor = 0;
        let votesAgainst = 0;
        for (const v of vote.votes.values()) {
            if (v === 1) votesFor++;
            else votesAgainst++;
        }
        return { votesFor, votesAgainst, abstained: vote.voterIds.size - vote.votes.size };
    }

    async function endVoteban(passed) {
        const vote = state.votebanSession;
        if (vote == null) return;
        clearTimeout(vote.timeout);
        state.votebanSession = null;
        const { votesFor, votesAgainst, abstained } = tally(vote);
        const summary = `(${votesFor} за, ${votesAgainst} против, ${abstained} воздержались из ${vote.voterIds.size})`;

        if (passed) {
            await db.banAuth(vote.targetAuth, vote.targetName, 'Голосование игроков', BAN_DURATION_MINUTES);
            const targetIndex = state.playersAll.findIndex((p) => p.id === vote.targetId);
            if (targetIndex !== -1) {
                room.kickPlayer(state.playersAll[targetIndex].id, `Вы забанены голосованием на ${BAN_DURATION_MINUTES} мин.`, false);
            }
            room.sendAnnouncement(
                `✔️ ${vote.targetName} забанен голосованием на ${BAN_DURATION_MINUTES} мин. ! ${summary}`,
                null,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
            discordBot.sendVoteBanNotification({
                targetName: vote.targetName,
                durationMinutes: BAN_DURATION_MINUTES,
                votesFor,
                votesAgainst,
                abstained,
            });
        } else {
            room.sendAnnouncement(
                `❌ Голосование за бан ${vote.targetName} не набрало ${Math.round(VOTE_THRESHOLD_RATIO * 100)}% голосов "за" от всех, кто мог голосовать, и было отменено. ${summary}`,
                null,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    function checkVote() {
        const vote = state.votebanSession;
        if (vote == null) return;
        const { votesFor } = tally(vote);
        if (votesFor >= vote.threshold) {
            endVoteban(true);
            return;
        }
        // Ends early (failed) the moment passing becomes mathematically
        // impossible — even if every remaining non-voter still votes "for",
        // the threshold (against the FULL frozen pool, not just votes cast)
        // couldn't be reached. Same early-exit shape as pauseVote.js.
        const remaining = vote.voterIds.size - vote.votes.size;
        if (votesFor + remaining < vote.threshold) {
            endVoteban(false);
        }
    }

    async function votebanCommand(player, message) {
        const restriction = await db.getCommandRestriction(authArray[player.id][0], 'voteban');
        if (restriction) {
            room.sendAnnouncement(
                `Вам запрещено использовать !voteban (осталось: ${formatBanRemaining(restriction.expiresAt)})${restriction.reason ? ' : ' + restriction.reason : ''}.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const usage = () => room.sendAnnouncement(
            `Использование: !voteban #<id> — начать голосование за временный бан игрока.`,
            player.id,
            errorColor,
            'bold',
            HaxNotification.CHAT
        );
        const targetArg = message.split(/ +/)[1];
        if (!targetArg || targetArg[0] !== '#') {
            usage();
            return;
        }
        const targetId = parseInt(targetArg.substring(1));
        const target = state.playersAll.find((p) => p.id === targetId);
        if (!target) {
            room.sendAnnouncement(`Игрока с таким ID нет в комнате.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        if (target.id === player.id) {
            room.sendAnnouncement(`Нельзя начать голосование против самого себя !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        if (state.votebanSession != null) {
            room.sendAnnouncement(`Голосование за бан уже идет ! Дождитесь его завершения.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        if (getRole(target) === Role.MASTER) {
            room.sendAnnouncement(`Нельзя голосовать за бан владельца комнаты !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }

        const initiatorGames = await getPlayerGames(authArray[player.id][0]);
        if (initiatorGames < MIN_GAMES_TO_VOTE) {
            room.sendAnnouncement(`Голосовать могут только игроки, сыгравшие от ${MIN_GAMES_TO_VOTE} игр !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }

        const targetAuth = authArray[target.id][0];
        if (await isProtectedByTopStats(targetAuth)) {
            room.sendAnnouncement(
                `${target.name} в топ-${PROTECTED_TOP_N} по одной из категорий статистики (!tops) — голосование за бан для них недоступно !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        const eligibleVoterIds = await getEligibleVoterIds(target.id);
        const threshold = Math.ceil(eligibleVoterIds.length * VOTE_THRESHOLD_RATIO);
        const votes = new Map();
        votes.set(player.id, 1);
        state.votebanSession = {
            targetId: target.id,
            targetAuth,
            targetName: target.name,
            votes,
            voterIds: new Set(eligibleVoterIds),
            threshold,
            timeout: setTimeout(() => endVoteban(false), VOTE_DURATION_MS),
        };
        room.sendAnnouncement(
            `🗳️ ${player.name} начал(а) голосование за бан игрока ${target.name} на ${BAN_DURATION_MINUTES} мин. ! ` +
                `Голосовать могут игроки с ${MIN_GAMES_TO_VOTE}+ играми — напишите "1" (за) или "2" (против). ` +
                `Нужно ${threshold} голос(ов) "за" из ${eligibleVoterIds.length} возможных (у вас ${VOTE_DURATION_MS / 1000} секунд).`,
            null,
            warningColor,
            'bold',
            HaxNotification.MENTION
        );
        checkVote();
    }

    function handleVoteBanMessage(player, message) {
        const vote = state.votebanSession;
        if (vote == null) return false;
        if (!vote.voterIds.has(player.id)) return false;
        const trimmed = message.trim();
        if (trimmed != '1' && trimmed != '2') return false;
        if (vote.votes.has(player.id)) {
            room.sendAnnouncement(`Вы уже проголосовали !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
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
        checkVote();
        return true;
    }

    return {
        votebanCommand,
        handleVoteBanMessage,
    };
};
