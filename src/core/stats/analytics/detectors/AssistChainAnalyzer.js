/*
 * 2nd Ast + 3rd Ast — extends the existing 2-deep goal-attribution lookback
 * (stats/goalAttribution.js's state.lastTouches[0]/[1], resolved live into
 * Goal.striker/Goal.assist) one and two steps further back through the same
 * touch chain, entirely post-match: find the scorer's touch (the last touch
 * at/before the goal's time — by construction the same touch
 * goalAttribution.js read as lastTouches[0] when the goal fired), confirm
 * the chain agrees with the already-resolved goal.assist one step back, then
 * look one and two touches further still, each requiring same team and a
 * player distinct from everyone already credited on this goal.
 *
 * Only runs for goals that already have a first assist — a goal with no
 * assist has no chain to extend.
 */
class AssistChainAnalyzer {
    analyze(ctx) {
        const { touchChain, reports, authOf, goals } = ctx;

        for (const goal of goals) {
            if (goal.striker == null || goal.striker.team !== goal.team || goal.assist == null) continue;

            let scoreIdx = -1;
            for (let i = touchChain.length - 1; i >= 0; i--) {
                if (touchChain.at(i).time <= goal.time) {
                    scoreIdx = i;
                    break;
                }
            }
            if (scoreIdx < 2) continue;
            if (touchChain.at(scoreIdx - 1).player.id !== goal.assist.id) continue; // chain disagrees with the resolved assist, bail

            const scorerId = touchChain.at(scoreIdx).player.id;
            const assistId = touchChain.at(scoreIdx - 1).player.id;

            const secondTouch = touchChain.at(scoreIdx - 2);
            const secondEligible = secondTouch != null &&
                secondTouch.player.team === goal.team &&
                secondTouch.player.id !== scorerId &&
                secondTouch.player.id !== assistId;
            if (!secondEligible) continue;
            const secondReport = reports.get(authOf(secondTouch.player));
            if (secondReport != null) secondReport.secondAssists++;

            if (scoreIdx < 3) continue;
            const thirdTouch = touchChain.at(scoreIdx - 3);
            const thirdEligible = thirdTouch != null &&
                thirdTouch.player.team === goal.team &&
                ![scorerId, assistId, secondTouch.player.id].includes(thirdTouch.player.id);
            if (!thirdEligible) continue;
            const thirdReport = reports.get(authOf(thirdTouch.player));
            if (thirdReport != null) thirdReport.thirdAssists++;
        }
    }
}

module.exports = { AssistChainAnalyzer };
