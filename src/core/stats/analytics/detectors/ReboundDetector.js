/*
 * Rebounds + Reb Rec — the touch immediately following a non-scoring shot
 * (ctx.shots, ShotDetector), if it lands within a short window of the shot
 * (a genuine loose-ball scramble, not the next normal possession sequence
 * minutes later). Reb Rec is the subset where the shooting team itself won
 * that loose ball back.
 */
const REBOUND_WINDOW_SECONDS = 1.5;

class ReboundDetector {
    analyze(ctx) {
        const { touchChain, reports, authOf, shots } = ctx;
        if (shots == null) return;

        for (const shot of shots) {
            if (shot.isGoal) continue;
            const next = touchChain.at(shot.touchIndex + 1);
            if (next == null) continue;
            if (next.time - shot.touch.time > REBOUND_WINDOW_SECONDS) continue;
            const report = reports.get(authOf(next.player));
            if (report == null) continue;
            report.rebounds++;
            if (next.player.team === shot.team) report.reboundsRecovered++;
        }
    }
}

module.exports = { ReboundDetector, REBOUND_WINDOW_SECONDS };
