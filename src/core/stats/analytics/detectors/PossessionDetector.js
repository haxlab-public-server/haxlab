/*
 * Pos Touches + Scoring %.
 *
 * Every touch counts — including the exact touch that wins a turnover (that
 * player genuinely touched the ball while gaining possession for their
 * team) and the touch that loses one (it was a real possession touch right
 * up until it wasn't). TurnoverDetector/DuelDetector already carve those
 * same touches out separately for their own metrics; Pos Touches isn't
 * trying to exclude "contested" touches, just count on-ball involvement.
 * Scoring % is the share of a player's touches that were part of the
 * unbroken same-team run ending in that team's own (non-own-)goal — found
 * by walking backward from each goal through the chain while the team
 * stays constant.
 */
class PossessionDetector {
    analyze(ctx) {
        const { touchChain, reports, authOf, goals } = ctx;
        const scoringTouchIndices = new Set();

        for (const goal of goals) {
            if (goal.striker == null || goal.striker.team !== goal.team) continue; // own goal, or unresolved
            let scoreIdx = -1;
            for (let i = touchChain.length - 1; i >= 0; i--) {
                if (touchChain.at(i).time <= goal.time) {
                    scoreIdx = i;
                    break;
                }
            }
            if (scoreIdx === -1) continue;
            let i = scoreIdx;
            while (i >= 0 && touchChain.sameTeamAs(i, scoreIdx)) {
                scoringTouchIndices.add(i);
                i--;
            }
        }

        const scoringTouchCount = new Map();
        for (let i = 0; i < touchChain.length; i++) {
            const touch = touchChain.at(i);
            const report = reports.get(authOf(touch.player));
            if (report == null) continue;
            report.posTouches++;
            if (scoringTouchIndices.has(i)) {
                scoringTouchCount.set(report.auth, (scoringTouchCount.get(report.auth) ?? 0) + 1);
            }
        }

        for (const report of reports.values()) {
            const scoring = scoringTouchCount.get(report.auth) ?? 0;
            report.scoringPct = report.posTouches > 0 ? Math.round((scoring / report.posTouches) * 100) : 0;
        }
    }
}

module.exports = { PossessionDetector };
