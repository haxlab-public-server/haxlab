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
}) {
    function getGoalAttribution(team) {
        let goalAttribution = Array(2).fill(null);
        if (state.lastTouches[0] != null) {
            if (state.lastTouches[0].player.team == team) {
                // Direct goal scored by player
                if (state.lastTouches[1] != null && state.lastTouches[1].player.team == team) {
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

    function getGoalString(team) {
        let goalString;
        const scores = state.game.scores;
        const goalAttribution = getGoalAttribution(team);
        if (goalAttribution[0] != null) {
            if (goalAttribution[0].team == team) {
                if (goalAttribution[1] != null && goalAttribution[1].team == team) {
                    goalString = `⚽ ${getTimeGame(scores.time)} Гол забил ${goalAttribution[0].name} ! С ассистом ${goalAttribution[1].name}.`;
                    state.game.goals.push(
                        new Goal(
                            scores.time,
                            team,
                            goalAttribution[0],
                            goalAttribution[1]
                        )
                    );
                } else {
                    goalString = `⚽ ${getTimeGame(scores.time)} Гол забил ${goalAttribution[0].name} !`;
                    state.game.goals.push(
                        new Goal(scores.time, team, goalAttribution[0], null)
                    );
                }
            } else {
                goalString = `😂 ${getTimeGame(scores.time)} Автогол забил ${goalAttribution[0].name} !`;
                state.game.goals.push(
                    new Goal(scores.time, team, goalAttribution[0], null)
                );
            }
        } else {
            goalString = `⚽ ${getTimeGame(scores.time)} Гол для ${team == Team.RED ? 'красной' : 'синей'} команды !`;
            state.game.goals.push(
                new Goal(scores.time, team, null, null)
            );
        }

        return goalString;
    }

    return {
        getGoalAttribution,
        getGoalString,
    };
};
