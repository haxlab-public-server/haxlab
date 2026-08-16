/*
 * Press Relief — % of a player's possession touches (TouchChain, not a
 * turnover-losing touch) taken with no opponent within PRESSURE_RADIUS px at
 * that moment (telemetry sample nearest the touch's time). The radius is a
 * named, tunable threshold choice, not a measured fact about the game.
 */
const PRESSURE_RADIUS = 80;

class PressureAnalyzer {
    constructor({ pointDistance, Team }) {
        this.pointDistance = pointDistance;
        this.Team = Team;
    }

    analyze(ctx) {
        const { touchChain, telemetry, reports, authOf } = ctx;
        const counts = new Map(); // auth -> { clear, total }

        for (let i = 0; i < touchChain.length; i++) {
            if (touchChain.isTurnoverAt(i)) continue;
            const touch = touchChain.at(i);
            const auth = authOf(touch.player);
            if (!reports.has(auth)) continue;
            const sample = telemetry.sampleNear(touch.time);
            if (sample == null) continue;

            const nearbyOpponent = sample.players.some((p) =>
                p.team !== touch.player.team &&
                p.team !== this.Team.SPECTATORS &&
                this.pointDistance({ x: p.x, y: p.y }, touch.position) < PRESSURE_RADIUS
            );

            const c = counts.get(auth) ?? { clear: 0, total: 0 };
            c.total++;
            if (!nearbyOpponent) c.clear++;
            counts.set(auth, c);
        }

        for (const [auth, c] of counts) {
            const report = reports.get(auth);
            if (report != null) report.pressRelief = c.total > 0 ? Math.round((c.clear / c.total) * 100) : 0;
        }
    }
}

module.exports = { PressureAnalyzer, PRESSURE_RADIUS };
