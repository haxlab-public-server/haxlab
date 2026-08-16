/*
 * Clear + Cl Rec — a touch taken in the player's own defensive third that
 * sends the ball a significant distance into a less dangerous third (not a
 * short risky pass still inside the defensive third). Cl Rec is whether the
 * clearing team also won the very next touch (they "kept" what they cleared).
 *
 * Produces ctx.clearanceEvents ({ index, auth }[]) for SweeperDetector.
 */
const MIN_CLEAR_DISTANCE = 150;

class ClearanceDetector {
    constructor({ zones, pointDistance }) {
        this.zones = zones;
        this.pointDistance = pointDistance;
    }

    analyze(ctx) {
        const { touchChain, reports, authOf } = ctx;
        const clearanceEvents = [];

        for (let i = 0; i < touchChain.length - 1; i++) {
            const touch = touchChain.at(i);
            const next = touchChain.at(i + 1);
            const team = touch.player.team;
            if (!this.zones.isDefensiveThird(touch.position.x, team)) continue;
            const nextThird = this.zones.thirdOf(next.position.x, team);
            if (nextThird === 'defensive') continue;
            const distance = this.pointDistance(touch.position, next.position);
            if (distance < MIN_CLEAR_DISTANCE) continue;

            const auth = authOf(touch.player);
            const report = reports.get(auth);
            if (report == null) continue;
            report.clearances++;
            if (touchChain.sameTeamAs(i + 1, i)) report.clearancesRecovered++;
            clearanceEvents.push({ index: i, auth });
        }

        ctx.clearanceEvents = clearanceEvents;
    }
}

module.exports = { ClearanceDetector, MIN_CLEAR_DISTANCE };
