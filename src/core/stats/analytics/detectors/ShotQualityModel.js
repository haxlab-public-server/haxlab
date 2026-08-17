/*
 * XG Faced / XG Prevented (goalkeeper side) + Shots Taken / XG Created
 * (attacker side, added 2026-08-17 — see PlayerMatchReport's own doc comment
 * for why: a real-replay cross-check against an independent analyzer showed
 * it crediting a player with 4 shots on target and the match's highest xG
 * far above what this module gave him, since goals actually scored was the
 * ONLY attacking-output signal a missed shot ever contributed to before
 * this — a real fairness gap, not present in the original 28-metric spec,
 * which scoped "xG" to goalkeepers only).
 *
 * IMPORTANT CAVEAT: a real xG model is calibrated against thousands of
 * labeled real shots (did it score, given distance/angle/pressure) — this
 * room has no such dataset, and this isn't collecting one. What this
 * actually computes is a pure GEOMETRY heuristic (distance + angle subtended
 * by the goal mouth, scaled to 0-1) — genuinely useful as a RELATIVE
 * ranking of shot difficulty, but not a statistically validated probability.
 * Treat "xG" here as a labeled approximation, not the real analytics-industry
 * metric of the same name — say so wherever this surfaces to players too.
 * Same one quality number is computed once per shot and credited to BOTH
 * sides (shooter's xgCreated, defending GK's xgFaced/xgPrevented) — it's the
 * same shot, just attributed from two different perspectives.
 *
 * Faced/prevented stays scoped to goalkeepers only (via getGK, the same
 * deepest-defender proxy gk.js already uses) — attributing shot quality to a
 * specific outfield defender would need a marking/defender-assignment model
 * this data doesn't support; "shots faced/prevented by whoever was in goal"
 * is the well-defined, real-football version of that half of the stat. The
 * shooter side has no such ambiguity — it's always whoever's own touch the
 * shot was.
 */
const GOAL_HALF_HEIGHT = 60; // px, half the goal mouth's height

class ShotQualityModel {
    constructor({ getGK, Team, zones }) {
        this.getGK = getGK;
        this.Team = Team;
        this.zones = zones;
    }

    analyze(ctx) {
        const { reports, shots, authOf } = ctx;
        if (shots == null) return;

        for (const shot of shots) {
            const defendingTeam = shot.team === this.Team.RED ? this.Team.BLUE : this.Team.RED;

            const goalX = defendingTeam === this.Team.RED ? -this.zones.fieldHalfWidth : this.zones.fieldHalfWidth;
            const distance = Math.hypot(shot.touch.position.x - goalX, shot.touch.position.y);
            const angle = Math.atan2(GOAL_HALF_HEIGHT, Math.max(distance, 1));
            const quality = Math.min(1, angle / (Math.PI / 2));

            const shooterReport = reports.get(authOf(shot.touch.player));
            if (shooterReport != null) {
                shooterReport.shotsTaken++;
                shooterReport.xgCreated = +(shooterReport.xgCreated + quality).toFixed(2);
            }

            const gk = this.getGK(defendingTeam);
            if (gk == null) continue;
            const gkReport = reports.get(gk.auth);
            if (gkReport == null) continue;

            gkReport.xgFaced = +(gkReport.xgFaced + quality).toFixed(2);
            if (!shot.isGoal) {
                gkReport.xgPrevented = +(gkReport.xgPrevented + quality).toFixed(2);
            }
        }
    }
}

module.exports = { ShotQualityModel, GOAL_HALF_HEIGHT };
