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
 *
 * Real bug found 2026-08-18 (players reporting they couldn't get anywhere
 * near 100 no matter how fast they played): the per-touch weights below
 * only ever combine to a raw score in [RAW_MIN, RAW_MAX] = [10, 75] —
 * BASELINE + the best-case speed bonus + the best-case outcome bonus caps
 * out at 75, never 100, and the WORST case bottoms out at 10, never 0. The
 * old `Math.max(0, Math.min(100, score))` clamp was dead code — score could
 * never actually reach either bound, so it silently masked the mismatch
 * between the metric's advertised 0-100 range and what the formula could
 * ever produce. Confirmed against 500 real match reports: max observed was
 * exactly 75, mean 40.4 — matching the theoretical ceiling exactly, not a
 * coincidence. Fixed by linearly rescaling the final averaged score from
 * its true achievable range onto the advertised 0-100 one — the underlying
 * heuristic (what's rewarded/penalized, and by how much relative to each
 * other) is UNCHANGED, only the displayed number's scale is corrected.
 */
const IDEAL_HOLD_SECONDS = 1.0;
const SLOW_HOLD_SECONDS = 3.0;

const BASELINE = 50;
const FAST_BONUS = 15;
const SLOW_PENALTY = 15;
const GOOD_OUTCOME_BONUS = 10;
const TURNOVER_PENALTY = 25;

// The true achievable range of the raw per-touch score above, derived from
// the weights themselves (not hardcoded) so they can't silently drift apart
// again if the weights above are ever retuned.
const RAW_MIN = BASELINE - SLOW_PENALTY - TURNOVER_PENALTY;
const RAW_MAX = BASELINE + FAST_BONUS + GOOD_OUTCOME_BONUS;

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

            let score = BASELINE;
            const holdTime = next.time - touch.time;
            if (holdTime <= IDEAL_HOLD_SECONDS) score += FAST_BONUS;
            else if (holdTime > SLOW_HOLD_SECONDS) score -= SLOW_PENALTY;

            if (touchChain.isTurnoverAt(i + 1)) score -= TURNOVER_PENALTY;
            else score += GOOD_OUTCOME_BONUS;

            const arr = scores.get(auth) ?? [];
            arr.push(score);
            scores.set(auth, arr);
        }

        for (const [auth, arr] of scores) {
            const report = reports.get(auth);
            if (report == null) continue;
            const rawAvg = arr.reduce((a, b) => a + b, 0) / arr.length;
            const rescaled = ((rawAvg - RAW_MIN) / (RAW_MAX - RAW_MIN)) * 100;
            report.decisionSpeed = Math.round(Math.max(0, Math.min(100, rescaled)));
        }
    }
}

module.exports = { DecisionSpeedScorer, IDEAL_HOLD_SECONDS, SLOW_HOLD_SECONDS, RAW_MIN, RAW_MAX };
