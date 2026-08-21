/*
 * Attributes a goal to a striker/assist based on recent ball touches.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createGoalAttribution({
    state,
    Team,
    Goal,
    getTimeGame,
    buildBox,
}) {
    function getGoalAttribution(team) {
        let goalAttribution = Array(2).fill(null);
        if (state.lastTouches[0] != null) {
            if (state.lastTouches[0].player.team == team) {
                // Direct goal scored by player. The assist candidate must be a
                // different player than the scorer — without this check, a
                // stale/duplicate touch entry for the same player (touch
                // tracking runs off two separate mechanisms, a kick event and
                // a per-tick proximity check) could otherwise credit someone
                // with assisting their own goal.
                if (
                    state.lastTouches[1] != null &&
                    state.lastTouches[1].player.team == team &&
                    state.lastTouches[1].player.id != state.lastTouches[0].player.id
                ) {
                    goalAttribution = [state.lastTouches[0].player, state.lastTouches[1].player];
                } else {
                    goalAttribution = [state.lastTouches[0].player, null];
                }
            } else {
                // Own goal
                goalAttribution = [state.lastTouches[0].player, null];
            }
        }
        return goalAttribution;
    }

    // Boxed goal announcement (requested 2026-08-21, matching a style seen
    // on another server: a box-drawn frame, a time/emoji/scorer/assist/
    // score line). Small-caps Unicode (the other server's "ɢᴏᴀʟ sᴄᴏʀᴇᴅ ʙʏ"
    // look) only has full letter coverage for Latin — Cyrillic small-caps
    // exist in Unicode but are missing common letters (no small-caps for
    // а/о/е/р/с/т/у and others), so applying it to Russian labels would
    // render as broken/mixed-case garbage for half the alphabet. Skipped
    // for that reason; the box/emoji/separator styling carries the look
    // instead. buildBox (core/utils.js) does the actual width/border math
    // — shared with entry.js's post-match summary box.
    function getGoalString(team) {
        const scores = state.game.scores;
        const time = getTimeGame(scores.time).slice(1, -1);
        const scoreLine = `🟥 ${scores.red} - ${scores.blue} 🟦`;
        const goalAttribution = getGoalAttribution(team);
        let line;
        if (goalAttribution[0] != null) {
            if (goalAttribution[0].team == team) {
                if (goalAttribution[1] != null && goalAttribution[1].team == team) {
                    line = `${time} ┊ ⚽ Гол забил ${goalAttribution[0].name} ┊ Ассист: ${goalAttribution[1].name} ┊ ${scoreLine}`;
                    state.game.goals.push(
                        new Goal(
                            scores.time,
                            team,
                            goalAttribution[0],
                            goalAttribution[1]
                        )
                    );
                } else {
                    line = `${time} ┊ ⚽ Гол забил ${goalAttribution[0].name} ┊ Ассист: - ┊ ${scoreLine}`;
                    state.game.goals.push(
                        new Goal(scores.time, team, goalAttribution[0], null)
                    );
                }
            } else {
                line = `${time} ┊ 😂 Автогол: ${goalAttribution[0].name} ┊ ${scoreLine}`;
                state.game.goals.push(
                    new Goal(scores.time, team, goalAttribution[0], null)
                );
            }
        } else {
            line = `${time} ┊ ⚽ Гол для ${team == Team.RED ? 'красной' : 'синей'} команды ┊ ${scoreLine}`;
            state.game.goals.push(
                new Goal(scores.time, team, null, null)
            );
        }

        return buildBox([line]);
    }

    return {
        getGoalAttribution,
        getGoalString,
    };
};
