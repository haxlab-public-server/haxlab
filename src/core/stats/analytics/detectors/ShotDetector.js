/*
 * Not a metric on its own — HaxBall has no discrete "shot" event, so this
 * infers one: a touch struck fast enough, aimed toward the opponent's goal,
 * taken from the middle or attacking third. Produces ctx.shots for
 * KeyPassDetector/ReboundDetector/ShotQualityModel to build on. A heuristic,
 * same caveat as DuelDetector's: will miss soft chip shots and may flag a
 * hard clearance struck the right direction as a "shot".
 */
const MIN_SHOT_SPEED = 6; // px/tick, ballVelocity units as recorded by MatchTelemetry
const GOAL_MATCH_WINDOW_SECONDS = 1;

class ShotDetector {
    constructor({ zones, Team }) {
        this.zones = zones;
        this.Team = Team;
    }

    analyze(ctx) {
        const { touchChain, telemetry, goals } = ctx;
        const shots = [];

        for (let i = 0; i < touchChain.length; i++) {
            const touch = touchChain.at(i);
            const sample = telemetry.sampleNear(touch.time);
            if (sample == null) continue;
            const speed = Math.hypot(sample.ball.vx, sample.ball.vy);
            if (speed < MIN_SHOT_SPEED) continue;
            const attackingSign = touch.player.team === this.Team.RED ? 1 : -1;
            const towardOpponentGoal = (sample.ball.vx * attackingSign) > 0;
            if (!towardOpponentGoal) continue;
            if (this.zones.isDefensiveThird(touch.position.x, touch.player.team)) continue;

            shots.push({ touchIndex: i, touch, team: touch.player.team, speed, isGoal: false });
        }

        for (const goal of goals) {
            if (goal.striker == null || goal.striker.team !== goal.team) continue;
            const matching = shots.find((s) =>
                s.team === goal.team && Math.abs(s.touch.time - goal.time) < GOAL_MATCH_WINDOW_SECONDS
            );
            if (matching != null) matching.isGoal = true;
        }

        ctx.shots = shots;
    }
}

module.exports = { ShotDetector, MIN_SHOT_SPEED };
