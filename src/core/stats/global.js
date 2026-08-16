/*
 * Tracks ball touches, possession and per-tick game state.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createGlobalStats({
    room,
    state,
    Team,
    State,
    Situation,
    BallTouch,
    checkGoalKickTouch,
    getGoalGame,
    handleGK,
    pointDistance,
    updateTeams,
}) {
    function getLastTouchOfTheBall() {
        const ballPosition = room.getBallPosition();
        updateTeams();
        let playerArray = [];
        for (let player of state.players) {
            if (player.position != null) {
                const distanceToBall = pointDistance(player.position, ballPosition);
                if (distanceToBall < state.triggerDistance) {
                    if (state.playSituation == Situation.KICKOFF) state.playSituation = Situation.PLAY;
                    playerArray.push([player, distanceToBall]);
                }
            }
        }
        if (playerArray.length != 0) {
            let playerTouch = playerArray.sort((a, b) => a[1] - b[1])[0][0];
            // Previously this only recorded a touch once the SAME team had
            // touched twice in a row (or on the first touch after a
            // SPECTATORS reset), to avoid a stray opponent deflection being
            // read as a genuine possession change. That gate had a real
            // cost: a clean interception-and-shoot (one touch, no second
            // confirming touch) never got recorded, leaving lastTouches[0]
            // stale on the PREVIOUS team's toucher — misattributing the
            // goal as an own goal, or leaving it null right after a reset.
            // The team filter isn't needed for correctness anyway:
            // getGoalAttribution() (goalAttribution.js) already requires
            // lastTouches[1].player.team == scoring team before crediting an
            // assist, so a cross-team lastTouches[1] here just naturally
            // yields "no assist" instead of a wrong one.
            if (state.lastTouches[0] == null || state.lastTouches[0].player.id != playerTouch.id) {
                state.game.touchArray.push(
                    new BallTouch(
                        playerTouch,
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
            state.lastTeamTouched = playerTouch.team;
        }
    }

    function getBallSpeed() {
        const ballProp = room.getDiscProperties(0);
        return Math.sqrt(ballProp.xspeed ** 2 + ballProp.yspeed ** 2) * state.speedCoefficient;
    }

    function getGameStats() {
        if (state.playSituation == Situation.PLAY && state.gameState == State.PLAY) {
            state.lastTeamTouched == Team.RED ? state.possession[0]++ : state.possession[1]++;
            const ballPosition = room.getBallPosition();
            ballPosition.x < 0 ? state.actionZoneHalf[0]++ : state.actionZoneHalf[1]++;
            handleGK();
        }
    }

    return {
        getLastTouchOfTheBall,
        getBallSpeed,
        getGameStats,
    };
};
