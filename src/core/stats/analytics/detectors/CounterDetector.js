/*
 * Counters — a fast transition: within a short window after their team's
 * own loose-ball Recovery (ctx.recoveryEvents, RecoveryDetector), the first
 * same-team touch that reaches the attacking third, credited to whoever
 * made that touch (not necessarily the recovering player themselves).
 */
const COUNTER_WINDOW_SECONDS = 6;

class CounterDetector {
    constructor({ zones }) {
        this.zones = zones;
    }

    analyze(ctx) {
        const { touchChain, reports, authOf, recoveryEvents = [] } = ctx;

        for (const { index } of recoveryEvents) {
            const recoveryTouch = touchChain.at(index);
            const team = recoveryTouch.player.team;
            if (this.zones.isAttackingThird(recoveryTouch.position.x, team)) continue; // already there, not a counter

            for (let j = index; j < touchChain.length; j++) {
                const touch = touchChain.at(j);
                if (touch.time - recoveryTouch.time > COUNTER_WINDOW_SECONDS) break;
                if (touch.player.team !== team) break; // possession lost again before reaching the final third
                if (!this.zones.isAttackingThird(touch.position.x, team)) continue;
                const report = reports.get(authOf(touch.player));
                if (report != null) report.counters++;
                break;
            }
        }
    }
}

module.exports = { CounterDetector, COUNTER_WINDOW_SECONDS };
