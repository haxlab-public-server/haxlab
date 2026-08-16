/*
 * Raw per-tick sampling — Single Responsibility: capture only, zero
 * interpretation (every detector in this folder that needs positions/
 * velocity reads it back out, nothing here decides what anything MEANS).
 *
 * Not captured by value from room/state: recordTick() is fed already-resolved
 * plain data by the caller (see analytics/index.js), so this class itself
 * never touches `room`/`state` directly and is trivially unit-testable.
 */
class MatchTelemetry {
    constructor() {
        this.samples = [];
    }

    reset() {
        this.samples = [];
    }

    // `players`: [{ id, team, position: {x,y} }]. Samples are appended in
    // increasing `time` order (the tick clock only moves forward within one
    // match), which sampleNear() relies on for its binary search.
    recordTick({ time, ballPosition, ballVelocity, players }) {
        this.samples.push({
            time,
            ball: { x: ballPosition.x, y: ballPosition.y, vx: ballVelocity.vx, vy: ballVelocity.vy },
            players: players.map((p) => ({ id: p.id, team: p.team, x: p.position.x, y: p.position.y })),
        });
    }

    // Closest recorded sample to `time` (a BallTouch's own .time field) —
    // touches and ticks aren't the same clock granularity, so this is always
    // a nearest-neighbor lookup, never an exact match.
    sampleNear(time) {
        if (this.samples.length === 0) return null;
        let lo = 0;
        let hi = this.samples.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.samples[mid].time < time) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0 && Math.abs(this.samples[lo - 1].time - time) <= Math.abs(this.samples[lo].time - time)) {
            return this.samples[lo - 1];
        }
        return this.samples[lo];
    }

    // Furthest the ball was actually seen from center this match — feeds
    // ZoneClassifier.calibrate() (see its own doc comment for why).
    get observedHalfWidth() {
        let max = 0;
        for (const s of this.samples) {
            if (Math.abs(s.ball.x) > max) max = Math.abs(s.ball.x);
        }
        return max;
    }
}

module.exports = { MatchTelemetry };
