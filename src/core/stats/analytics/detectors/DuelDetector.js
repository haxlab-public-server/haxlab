/*
 * Duels / Duel W / Duel L / Interc Duels / Forced TO — the 'contested'
 * subset of ctx.turnovers (TurnoverDetector): the previous toucher was still
 * actively in control when possession changed hands, as opposed to picking
 * up an already-loose ball (RecoveryDetector).
 *
 * Every contested turnover is a duel by definition here — the losing
 * player gets duelsLost, the gaining player gets duelsWon. It's then split:
 * if the gaining player was the closest opponent to the ball just before
 * the takeaway (telemetry sample at the losing touch's time), it's a direct
 * challenge -> Forced TO. If they weren't closest, they read a passing lane
 * instead of the carrier -> Interc Duels (HaxBall has no real "pass intent"
 * to detect against, so this is a position-based proxy for it, not literal
 * interception detection) — counted as a Forced TO too (a duel won either
 * way), per the metric spec's own "Interc Duels is a subset of Forced TO"
 * framing.
 *
 * This is the fuzziest classification in the whole module: proximity at one
 * sampled tick standing in for "who was actually contesting whom" will
 * misfire on chaotic multi-player pileups. Best-effort, not gospel.
 */
class DuelDetector {
    constructor({ telemetry, pointDistance }) {
        this.telemetry = telemetry;
        this.pointDistance = pointDistance;
    }

    analyze(ctx) {
        const { touchChain, reports, authOf, turnovers, telemetry = this.telemetry } = ctx;
        if (turnovers == null) return;

        for (const { loseIndex, gainIndex, tag } of turnovers) {
            if (tag !== 'contested') continue;
            const losingTouch = touchChain.at(loseIndex);
            const gainingTouch = touchChain.at(gainIndex);
            const losingReport = reports.get(authOf(losingTouch.player));
            const gainingReport = reports.get(authOf(gainingTouch.player));
            if (losingReport != null) {
                losingReport.duels++;
                losingReport.duelsLost++;
            }
            if (gainingReport == null) continue;
            gainingReport.duels++;
            gainingReport.duelsWon++;
            gainingReport.forcedTakeaways++;

            const sample = telemetry.sampleNear(losingTouch.time);
            if (sample == null) continue;
            const opponents = sample.players.filter((p) => p.team === gainingTouch.player.team);
            if (opponents.length === 0) continue;
            const closest = opponents.reduce((best, p) => {
                const d = this.pointDistance({ x: p.x, y: p.y }, losingTouch.position);
                return d < best.d ? { p, d } : best;
            }, { p: null, d: Infinity });
            const gainingWasClosest = closest.p != null && closest.p.id === gainingTouch.player.id;
            if (!gainingWasClosest) {
                gainingReport.intercDuels++;
            }
        }
    }
}

module.exports = { DuelDetector };
