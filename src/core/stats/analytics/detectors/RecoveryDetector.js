/*
 * Recoveries + F3 Recoveries — the 'loose' subset of ctx.turnovers
 * (TurnoverDetector): the ball sat uncontested for a while before this
 * player's team collected it, as opposed to winning it directly off an
 * opponent still actively in control (see DuelDetector, which handles the
 * 'contested' subset instead).
 *
 * Scope note: this can only ever fire on a TEAM change (touchArray only
 * records a new entry when the toucher changes — see TouchChain's own doc
 * comment), so a player recovering their OWN team's loose ball (nobody else
 * touched it in between) never appears as a distinct event here. That's a
 * real gap against the informal notion of "recovery", not a bug — there's no
 * signal in this data to detect it.
 *
 * Also records ctx.recoveryEvents ({ index, auth }[]) for SweeperDetector/
 * CounterDetector to build on.
 */
class RecoveryDetector {
    constructor({ zones }) {
        this.zones = zones;
    }

    analyze(ctx) {
        const { touchChain, reports, authOf, turnovers } = ctx;
        const recoveryEvents = [];
        if (turnovers == null) {
            ctx.recoveryEvents = recoveryEvents;
            return;
        }

        for (const { gainIndex, tag } of turnovers) {
            if (tag !== 'loose') continue;
            const gainingTouch = touchChain.at(gainIndex);
            const auth = authOf(gainingTouch.player);
            const report = reports.get(auth);
            if (report == null) continue;
            report.recoveries++;
            if (this.zones.isAttackingThird(gainingTouch.position.x, gainingTouch.player.team)) {
                report.f3Recoveries++;
            }
            recoveryEvents.push({ index: gainIndex, auth });
        }

        ctx.recoveryEvents = recoveryEvents;
    }
}

module.exports = { RecoveryDetector };
