/*
 * The single 0-10 "how did I play" rating (requested after seeing a replay-
 * analyzer screenshot with per-player match ratings) — MUST run last in the
 * pipeline (see index.js's own ordering doc comment): every other detector
 * has to have already finished writing its fields before this can read them.
 *
 * Explicitly designed to be FAIR ACROSS ROLES (a real gap in the first
 * version, flagged directly by the user: a single POINT_WEIGHTS sum favored
 * attacking output so heavily that even a flawless goalkeeping or
 * destroyer/opornik performance couldn't reach the same heights as one
 * decent goal). There's no formal position tracking in this room (roles are
 * fluid — small teams, no assigned positions in `state`), so this can't
 * normalize by DECLARED role. Instead it takes the best of two INDEPENDENTLY
 * re-centered category scores per player:
 *
 *   1. ATTACK_WEIGHTS and DEFENSE_WEIGHTS each turn a slice of the report
 *      into one raw number (invented, hand-tuned so a genuinely excellent
 *      game in EITHER category lands in a comparable raw range — not
 *      calibrated against real data, same honesty as ShotQualityModel).
 *   2. Each category is z-scored SEPARATELY against the match's own
 *      participants (the "re-centered per-match" design this session's
 *      earlier ELO conversation converged on — plain win/loss ELO with no
 *      matchmaking degenerates into "winrate in a different wrapper";
 *      per-match relative scoring sidesteps that by never touching win/loss
 *      or opponent strength at all).
 *   3. A player's core score is the BETTER of their two category z-scores,
 *      plus a smaller credit for the other one — so a goalkeeper or a
 *      destroyer who tops the match in defensiveZ rates just as highly as a
 *      striker who tops it in attackZ, instead of being structurally capped
 *      below them. A genuinely two-way performance (strong in both) still
 *      earns a bit extra on top of either alone.
 *
 * A clean-sheet bonus is added explicitly for whoever this match's
 * goalkeeper was (via getGK, the same deepest-defender proxy gk.js already
 * uses) if their team conceded nothing — the single most legible "did the
 * keeper do their job" signal, and one this codebase already treats as a
 * first-class stat elsewhere (HaxStatistics.CS).
 *
 * A narrower caveat than it might first seem: on HaxBall's small, dense
 * pitch (3-4 a side, no offside, nobody holds a zone far from the ball),
 * genuinely disruptive positioning almost always DOES eventually surface as
 * a real touch over a full match — a recovery, a duel, an interception —
 * simply because everyone ends up near the ball constantly. This isn't
 * 11-a-side football, where a purely positional defender can go a whole
 * game without a tackle. The one real, accepted difference this can't
 * separate: a disciplined player who quietly wins 3 clean recoveries and an
 * aggressive one who wins 3 scrappy duels (getting beaten in between) can
 * land at a similar score — and that's treated as fine here, not a flaw:
 * both genuinely contributed, `duelsLost` already docks the aggressive
 * approach for the times it didn't come off.
 *
 * goals/assists aren't tracked anywhere else in this module (playerStats.js
 * owns the CAREER totals) — computed fresh here from ctx.goals, purely as a
 * rating input, and stashed on the report too since showing "⚽ 2, 🅰️ 1"
 * next to the rating is the obvious context for it.
 */
const ATTACK_WEIGHTS = {
    goals: 10,
    assists: 6,
    secondAssists: 2,
    thirdAssists: 1,
    keyPasses: 1.5,
    // scoringPct/pressRelief (below) are percentages that can swing hard off
    // a single touch for a low-volume player (0% or 100%, nothing between) —
    // kept deliberately modest relative to the count-based metrics around
    // them so one lucky/unlucky touch can't outweigh an actual goal or an
    // actual tackle won.
    scoringPct: 0.02, // per percentage point (0-100) -> up to +2
    progPasses: 0.3,
    progDistance: 0.005,
    final3rdEntries: 0.5,
    rebounds: 0.3,
    reboundsRecovered: 0.2,
    counters: 0.5,
};
const DEFENSE_WEIGHTS = {
    forcedTakeaways: 2,
    intercDuels: 1.5,
    duelsWon: 1,
    recoveries: 1.5,
    f3Recoveries: 0.5,
    clearances: 1.5,
    clearancesRecovered: 0.5,
    sweeperActions: 2,
    xgPrevented: 3,
    pressRelief: 0.015, // per percentage point -> up to +1.5, same small-sample caveat as scoringPct above
};

const SECONDARY_CATEGORY_WEIGHT = 0.15; // credit for the WEAKER of the two categories, on top of the better one
const DECISION_SPEED_BASELINE = 50;
const DECISION_SPEED_POINTS = 0.01; // +-0.5 rating points max, decisionSpeed is already 0-100
const DISCIPLINE_PENALTY = { turnoverTouches: 0.05, dangerousTurnovers: 0.15, duelsLost: 0.03 }; // small, direct rating-point deductions
const CLEAN_SHEET_BONUS = 0.6;

const RATING_BASELINE = 6.5; // "a solid, unremarkable game" — matches how real match-rating sites center their scale
const RATING_SPREAD = 1.3; // rating points per 1 standard deviation of a category's raw score, this match
const MIN_RATING = 0;
const MAX_RATING = 10;

function mean(values) {
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values, avg) {
    const variance = mean(values.map((v) => (v - avg) ** 2));
    return Math.sqrt(variance);
}

// Raw weighted sum -> z-score against everyone in `reports`, keyed by auth.
// A category with zero spread (nobody did anything in it) scores everyone
// as exactly average (z=0) rather than dividing by zero.
function zScoresFor(reports, weights) {
    const raw = new Map();
    for (const report of reports.values()) {
        let sum = 0;
        for (const [field, weight] of Object.entries(weights)) {
            sum += (report[field] ?? 0) * weight;
        }
        raw.set(report.auth, sum);
    }
    const values = [...raw.values()];
    const avg = mean(values);
    const sd = stddev(values, avg);
    const z = new Map();
    for (const [auth, sum] of raw) {
        z.set(auth, sd > 0 ? (sum - avg) / sd : 0);
    }
    return z;
}

class MatchRatingDetector {
    constructor({ getGK, Team }) {
        this.getGK = getGK;
        this.Team = Team;
    }

    analyze(ctx) {
        const { reports, goals, authOf } = ctx;

        const concededBy = { [this.Team.RED]: 0, [this.Team.BLUE]: 0 };
        for (const goal of goals) {
            if (goal.striker == null || goal.striker.team !== goal.team) continue; // own goal, not a credit
            const scorerReport = reports.get(authOf(goal.striker));
            if (scorerReport != null) scorerReport.goals++;
            if (goal.assist != null) {
                const assistReport = reports.get(authOf(goal.assist));
                if (assistReport != null) assistReport.assists++;
            }
            const concedingTeam = goal.team === this.Team.RED ? this.Team.BLUE : this.Team.RED;
            concededBy[concedingTeam]++;
        }

        const cleanSheetAuths = new Set();
        for (const team of [this.Team.RED, this.Team.BLUE]) {
            if (concededBy[team] === 0) {
                const gk = this.getGK(team);
                if (gk != null) cleanSheetAuths.add(gk.auth);
            }
        }

        const attackZ = zScoresFor(reports, ATTACK_WEIGHTS);
        const defenseZ = zScoresFor(reports, DEFENSE_WEIGHTS);

        for (const report of reports.values()) {
            const a = attackZ.get(report.auth) ?? 0;
            const d = defenseZ.get(report.auth) ?? 0;
            const combinedZ = Math.max(a, d) + SECONDARY_CATEGORY_WEIGHT * Math.min(a, d);

            let rating = RATING_BASELINE + combinedZ * RATING_SPREAD;
            rating += (report.decisionSpeed - DECISION_SPEED_BASELINE) * DECISION_SPEED_POINTS;
            rating -= report.turnoverTouches * DISCIPLINE_PENALTY.turnoverTouches;
            rating -= report.dangerousTurnovers * DISCIPLINE_PENALTY.dangerousTurnovers;
            rating -= report.duelsLost * DISCIPLINE_PENALTY.duelsLost;
            if (cleanSheetAuths.has(report.auth)) rating += CLEAN_SHEET_BONUS;

            report.rating = Math.round(Math.min(MAX_RATING, Math.max(MIN_RATING, rating)) * 10) / 10;
        }
    }
}

module.exports = { MatchRatingDetector, ATTACK_WEIGHTS, DEFENSE_WEIGHTS, RATING_BASELINE, RATING_SPREAD };
