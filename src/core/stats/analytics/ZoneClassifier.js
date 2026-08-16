/*
 * Defensive/middle/attacking third classification, relative to a team's own
 * attacking direction (RED attacks toward +x, BLUE toward -x — same
 * convention stats/gk.js's GK-detection already relies on: RED's GK is the
 * min-x player, BLUE's is the max-x player).
 *
 * fieldHalfWidth isn't a hardcoded stadium constant (this room switches
 * between multiple stadium files — classic/big — with different, undocumented
 * pixel dimensions; see team/balance.js's desiredStadiumFor). Instead it's
 * calibrated per match from the actual observed ball-position range (see
 * MatchTelemetry.observedHalfWidth), via calibrate() — self-adjusting to
 * whichever stadium is actually live, no per-map constant to keep in sync.
 */
const THIRD_FRACTION = 1 / 3;
const DEFAULT_HALF_WIDTH = 600;

class ZoneClassifier {
    constructor({ Team, fieldHalfWidth = DEFAULT_HALF_WIDTH }) {
        this.Team = Team;
        this.fieldHalfWidth = fieldHalfWidth > 0 ? fieldHalfWidth : DEFAULT_HALF_WIDTH;
    }

    calibrate(observedHalfWidth) {
        this.fieldHalfWidth = observedHalfWidth > 0 ? observedHalfWidth : DEFAULT_HALF_WIDTH;
    }

    // 0 = own goal line, 1 = opponent's goal line, from `team`'s perspective.
    progressOf(x, team) {
        const progress = team === this.Team.RED
            ? (x + this.fieldHalfWidth) / (2 * this.fieldHalfWidth)
            : (this.fieldHalfWidth - x) / (2 * this.fieldHalfWidth);
        return Math.min(1, Math.max(0, progress));
    }

    thirdOf(x, team) {
        const progress = this.progressOf(x, team);
        if (progress < THIRD_FRACTION) return 'defensive';
        if (progress < 2 * THIRD_FRACTION) return 'middle';
        return 'attacking';
    }

    isDefensiveThird(x, team) {
        return this.thirdOf(x, team) === 'defensive';
    }

    isAttackingThird(x, team) {
        return this.thirdOf(x, team) === 'attacking';
    }

    // True only if `after` is strictly further upfield than `before`
    // (defensive -> middle -> attacking) — used to tell a genuine forward
    // third-crossing apart from a sideways-only zone "change" or a backward one.
    isForwardThirdChange(before, after) {
        const order = { defensive: 0, middle: 1, attacking: 2 };
        return order[after] > order[before];
    }
}

module.exports = { ZoneClassifier, DEFAULT_HALF_WIDTH };
