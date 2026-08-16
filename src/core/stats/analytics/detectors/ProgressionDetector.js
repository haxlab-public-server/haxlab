/*
 * Prog Pass + Prog Dist + Final 3rd — measured on the segment from touch i
 * to touch i+1 (see TouchChain's own doc comment on why that's the unit of
 * measurement this data supports), credited to touch i's player. A segment
 * counts as "progressive" if it gains more than PROGRESS_THRESHOLD px
 * upfield, OR crosses a third boundary forward even on a shorter gain (e.g.
 * a short pass that still breaks a defensive line). Final 3rd counts
 * segments that specifically land in the attacking third.
 */
const PROGRESS_THRESHOLD = 100;

class ProgressionDetector {
    constructor({ zones, Team }) {
        this.zones = zones;
        this.Team = Team;
    }

    analyze(ctx) {
        const { touchChain, reports, authOf } = ctx;

        for (let i = 0; i < touchChain.length - 1; i++) {
            const touch = touchChain.at(i);
            const next = touchChain.at(i + 1);
            const report = reports.get(authOf(touch.player));
            if (report == null) continue;

            const team = touch.player.team;
            const attackingSign = team === this.Team.RED ? 1 : -1;
            const forwardDelta = (next.position.x - touch.position.x) * attackingSign;

            const thirdBefore = this.zones.thirdOf(touch.position.x, team);
            const thirdAfter = this.zones.thirdOf(next.position.x, team);
            const crossedForward = this.zones.isForwardThirdChange(thirdBefore, thirdAfter);

            if (forwardDelta > PROGRESS_THRESHOLD || crossedForward) {
                report.progPasses++;
                report.progDistance += Math.max(0, Math.round(forwardDelta));
            }
            if (thirdAfter === 'attacking' && thirdBefore !== 'attacking') {
                report.final3rdEntries++;
            }
        }
    }
}

module.exports = { ProgressionDetector, PROGRESS_THRESHOLD };
