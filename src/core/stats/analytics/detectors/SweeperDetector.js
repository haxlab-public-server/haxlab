/*
 * Sweeper actions — a defensive action (clearance or loose-ball recovery,
 * see ClearanceDetector/RecoveryDetector's ctx.clearanceEvents/
 * ctx.recoveryEvents) by whoever getGK() has flagged as that team's
 * goalkeeper (the same deepest-defender-by-tick-count proxy gk.js already
 * uses for clean sheets), taken OUTSIDE their own defensive third — i.e.
 * stepping up well past their line to defend, the sweeper-keeper role.
 */
class SweeperDetector {
    constructor({ zones, getGK, Team }) {
        this.zones = zones;
        this.getGK = getGK;
        this.Team = Team;
    }

    analyze(ctx) {
        const { touchChain, reports, clearanceEvents = [], recoveryEvents = [] } = ctx;
        const gkAuths = new Map();
        for (const team of [this.Team.RED, this.Team.BLUE]) {
            const gk = this.getGK(team);
            if (gk != null) gkAuths.set(gk.auth, team);
        }
        if (gkAuths.size === 0) return;

        for (const event of [...clearanceEvents, ...recoveryEvents]) {
            const team = gkAuths.get(event.auth);
            if (team == null) continue;
            const touch = touchChain.at(event.index);
            if (this.zones.isDefensiveThird(touch.position.x, team)) continue;
            const report = reports.get(event.auth);
            if (report != null) report.sweeperActions++;
        }
    }
}

module.exports = { SweeperDetector };
