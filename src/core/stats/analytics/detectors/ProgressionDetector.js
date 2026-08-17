/*
 * Prog Pass + Prog Dist + Final 3rd — measured on the segment from touch i
 * to touch i+1 (see TouchChain's own doc comment on why that's the unit of
 * measurement this data supports), credited to touch i's player. A segment
 * counts as "progressive" if it gains more than PROGRESS_THRESHOLD px
 * upfield, OR crosses a third boundary forward even on a shorter gain (e.g.
 * a short pass that still breaks a defensive line). Final 3rd counts
 * segments that specifically land in the attacking third.
 *
 * Real bug fixed 2026-08-17 (found while cross-checking against a real
 * replay run through an independent analyzer): this used to count ANY
 * consecutive touch pair, including a TURNOVER — a player dribbling forward
 * and then getting the ball taken off them still moved the ball upfield in
 * the process, so a failed advance was being credited exactly like a
 * successful pass. Now requires `touchChain.isPass(i + 1)` — possession
 * must have genuinely stayed with the same team — before counting anything.
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
            if (!touchChain.isPass(i + 1)) continue;
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
