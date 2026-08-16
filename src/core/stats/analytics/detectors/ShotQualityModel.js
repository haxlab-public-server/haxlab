/*
 * XG Faced / XG Prevented.
 *
 * IMPORTANT CAVEAT: a real xG model is calibrated against thousands of
 * labeled real shots (did it score, given distance/angle/pressure) — this
 * room has no such dataset, and this isn't collecting one. What this
 * actually computes is a pure GEOMETRY heuristic (distance + angle subtended
 * by the goal mouth, scaled to 0-1) — genuinely useful as a RELATIVE
 * ranking of shot difficulty, but not a statistically validated probability.
 * Treat "xG" here as a labeled approximation, not the real analytics-industry
 * metric of the same name — say so wherever this surfaces to players too.
 *
 * Scoped to goalkeepers only (via getGK, the same deepest-defender proxy
 * gk.js already uses for GK detection/clean sheets) — attributing shot
 * quality to a specific outfield defender would need a marking/defender-
 * assignment model this data doesn't support; "shots faced/prevented by
 * whoever was in goal" is the well-defined, real-football version of this
 * stat anyway.
 */
const GOAL_HALF_HEIGHT = 60; // px, half the goal mouth's height

class ShotQualityModel {
    constructor({ getGK, Team, zones }) {
        this.getGK = getGK;
        this.Team = Team;
        this.zones = zones;
    }

    analyze(ctx) {
        const { reports, shots } = ctx;
        if (shots == null) return;

        for (const shot of shots) {
            const defendingTeam = shot.team === this.Team.RED ? this.Team.BLUE : this.Team.RED;
            const gk = this.getGK(defendingTeam);
            if (gk == null) continue;
            const report = reports.get(gk.auth);
            if (report == null) continue;

            const goalX = defendingTeam === this.Team.RED ? -this.zones.fieldHalfWidth : this.zones.fieldHalfWidth;
            const distance = Math.hypot(shot.touch.position.x - goalX, shot.touch.position.y);
            const angle = Math.atan2(GOAL_HALF_HEIGHT, Math.max(distance, 1));
            const quality = Math.min(1, angle / (Math.PI / 2));

            report.xgFaced = +(report.xgFaced + quality).toFixed(2);
            if (!shot.isGoal) {
                report.xgPrevented = +(report.xgPrevented + quality).toFixed(2);
            }
        }
    }
}

module.exports = { ShotQualityModel, GOAL_HALF_HEIGHT };
