/*
 * Decision Speed (0-100) — explicitly an INVENTED composite index, not a
 * physical measurement (matches the metric's own spec: "estimating how fast
 * a player turns possession into a useful next action"). Per touch, starts
 * at a neutral baseline and adjusts for how long the ball sat before the
 * next touch (too slow is penalized, comfortably quick is rewarded — there's
 * no reward for being unrealistically instant, that's not measured either
 * way here) and for the outcome (a turnover afterward is penalized, a
 * same-team follow-up is rewarded). Averaged across a player's touches this
 * match. Designed, not derived — same spirit as a credit score or ELO
 * itself, reasonable but not objectively "the" right formula.
 */
const IDEAL_HOLD_SECONDS = 1.0;
const SLOW_HOLD_SECONDS = 3.0;

class DecisionSpeedScorer {
    analyze(ctx) {
        const { touchChain, reports, authOf } = ctx;
        const scores = new Map(); // auth -> number[]

        for (let i = 0; i < touchChain.length; i++) {
            const touch = touchChain.at(i);
            const auth = authOf(touch.player);
            if (!reports.has(auth)) continue;
            const next = touchChain.at(i + 1);
            if (next == null) continue;

            let score = 50;
            const holdTime = next.time - touch.time;
            if (holdTime <= IDEAL_HOLD_SECONDS) score += 15;
            else if (holdTime > SLOW_HOLD_SECONDS) score -= 15;

            if (touchChain.isTurnoverAt(i + 1)) score -= 25;
            else score += 10;

            score = Math.max(0, Math.min(100, score));
            const arr = scores.get(auth) ?? [];
            arr.push(score);
            scores.set(auth, arr);
        }

        for (const [auth, arr] of scores) {
            const report = reports.get(auth);
            if (report != null) report.decisionSpeed = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
        }
    }
}

module.exports = { DecisionSpeedScorer, IDEAL_HOLD_SECONDS, SLOW_HOLD_SECONDS };
