/*
 * Turnov Touch + Dang. TO, and produces ctx.turnovers for
 * RecoveryDetector/DuelDetector to split further (see their own doc
 * comments for the loose-ball-vs-contested distinction this class tags).
 *
 * Dang. TO is scoped to "turned it over in your own defensive third" only —
 * the fuller definition considered ("...or led to an opponent shot soon
 * after") would need ShotDetector's output, which runs after this class;
 * chasing that would mean either re-ordering the whole pipeline around one
 * secondary clause or a second pass, neither of which is worth it for a
 * refinement, not a correctness fix.
 */
const RECOVERY_GAP_SECONDS = 1.2;

class TurnoverDetector {
    constructor({ zones }) {
        this.zones = zones;
    }

    analyze(ctx) {
        const { touchChain, reports, authOf } = ctx;
        const turnovers = [];

        for (let i = 0; i < touchChain.length - 1; i++) {
            if (!touchChain.isTurnoverAt(i + 1)) continue;
            const losingTouch = touchChain.at(i);
            const gainingTouch = touchChain.at(i + 1);
            const report = reports.get(authOf(losingTouch.player));
            if (report != null) {
                report.turnoverTouches++;
                if (this.zones.isDefensiveThird(losingTouch.position.x, losingTouch.player.team)) {
                    report.dangerousTurnovers++;
                }
            }
            const tag = (gainingTouch.time - losingTouch.time) > RECOVERY_GAP_SECONDS ? 'loose' : 'contested';
            turnovers.push({ loseIndex: i, gainIndex: i + 1, tag });
        }

        ctx.turnovers = turnovers;
    }
}

module.exports = { TurnoverDetector, RECOVERY_GAP_SECONDS };
