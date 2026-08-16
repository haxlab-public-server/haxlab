/*
 * Key Pass — for every shot (ctx.shots, from ShotDetector), the immediately
 * preceding touch, if it's a different player on the same team (i.e. an
 * actual pass, not the shooter's own build-up touch).
 */
class KeyPassDetector {
    analyze(ctx) {
        const { touchChain, reports, authOf, shots } = ctx;
        if (shots == null) return;

        for (const shot of shots) {
            const i = shot.touchIndex;
            if (i === 0) continue;
            if (!touchChain.sameTeamAs(i, i - 1) || touchChain.samePlayer(i, i - 1)) continue;
            const passer = touchChain.at(i - 1).player;
            const report = reports.get(authOf(passer));
            if (report != null) report.keyPasses++;
        }
    }
}

module.exports = { KeyPassDetector };
