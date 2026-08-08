/*
 * "Fireworks" goal celebration — a recursive cascade: one small circle
 * grows, then pops into 5 pieces flying outward, then ALL 5 of those
 * pieces pop into their own 4-spark sub-burst AT THE SAME TIME, each spark
 * traveling further out from wherever its parent popped while shrinking,
 * over a ~1.8-second show (FRAME_DELAY_MS x FRAME_COUNT below).
 *
 * Unlike the previous version, the exact shape is regenerated FRESH on
 * every single call (buildFireworksFrames(), not a module-level constant)
 * — piece angles, how far each one flies, and each spark's own fan angle
 * and distance are all randomized within a range every time, so no two
 * goals produce the identical too-geometric "ruler-straight" burst. Only
 * the STRUCTURE (piece count, frame timing, disc budget) stays fixed.
 *
 * 5 pieces x 4 sparks + the 5 pieces themselves = 25 simultaneous discs at
 * the busiest moment — more than smokeAnimation.js's original 7 (and more
 * than this file's own earlier 16-disc version), so stadiums.js's
 * classicMap/bigMap were each given 9 MORE helper discs on top of the
 * previous expansion (still radius-0/no-collision, same as the rest),
 * bringing the pool reused from smokeAnimation.js's own helper-disc range
 * up to 25 total (see HELPER_DISC_COUNT/resolveDiscStart there).
 *
 * goalAnimation is a single equip slot, so a player only ever has ONE of
 * smoke/fireworks active at a time, meaning the two animations never touch
 * these discs simultaneously and can safely share the same pool.
 *
 * Slot roles (0-24, relative to resolveDiscStart's own result):
 *   - slots 0-4: the 5 main pieces (slot 0 also plays the build-phase core).
 *   - slots 5-24: 5 groups of 4 sub-sparks, one group per main piece, all
 *     active on the same frames once the sub-burst starts.
 * Coordinates are computed, not hand-typed — ORIGIN is the goal mouth
 * center (REFERENCE_GOAL_X=372, same match smokeAnimation.js already
 * established for classic), so the same "no rescaling for classic, scale
 * by stadium-goal-x/372 for big" reasoning applies unchanged here too.
 */
const { isStadiumSupported, resolveDiscStart, STADIUM_GOAL_X, clearGoalpost } = require('./smokeAnimation');

const REFERENCE_GOAL_X = 372;
const ORIGIN = { x: REFERENCE_GOAL_X, y: 0 };

// One shared color family, brightest to darkest — same 4-shade shape as
// smokeAnimation.js's SMOKE_COLORS. Gets darker with every generation: the
// build/main pop are bright (tier 0/1), the sub-sparks are the darkest
// (tier 2), like they're the last, faintest embers of the show.
const FIREWORKS_COLORS = [0xfff2b8, 0xffd23b, 0xff9d1f, 0xcc6600];

const MAIN_PIECE_COUNT = 5;
const SUB_SPARK_COUNT = 4;
const DISCS_NEEDED = MAIN_PIECE_COUNT + MAIN_PIECE_COUNT * SUB_SPARK_COUNT; // 25

const BUILD_FRAME_COUNT = 3;
const MAIN_FRAME_COUNT = 4;
const SUB_FRAME_COUNT = 13;
const SUB_PHASE_START = BUILD_FRAME_COUNT + MAIN_FRAME_COUNT;
const FRAME_COUNT = SUB_PHASE_START + SUB_FRAME_COUNT; // 20
const FRAME_DELAY_MS = 90; // 20 * 90 = 1800ms, the full show

const BUILD_RADII = [5, 10, 15]; // the lone circle's own grow arc

const MAIN_NEAR_DISTANCE = 8;
const MAIN_PEAK_DISTANCE_BASE = 28;
const MAIN_PEAK_DISTANCE_JITTER = 10; // each piece's own peak varies +-this
const MAIN_ANGLE_JITTER_DEG = 20; // each piece wobbles off its even slot
const MAIN_RADII = [7, 8, 9, 10]; // grows gently across its own flight

const SUB_ANGLE_SPREAD_DEG = 50; // total fan width of one piece's sparks
const SUB_ANGLE_JITTER_DEG = 12; // extra per-spark wobble on top of that fan
const SUB_DISTANCE_BASE = 34;
const SUB_DISTANCE_JITTER = 16; // each spark's own final distance varies
const SUB_START_RADIUS_BASE = 7;
const SUB_START_RADIUS_JITTER = 2;

function deg(d) {
    return (d * Math.PI) / 180;
}
function randRange(min, max) {
    return min + Math.random() * (max - min);
}
function project(origin, angle, distance) {
    // Rounded, not left as raw cos/sin output — Math.cos(-Math.PI/2) isn't
    // exactly 0 in floating point, so a disc meant to stay perfectly still
    // on one axis would otherwise drift by a few 1e-16 fractions.
    return {
        x: Math.round(origin.x + Math.cos(angle) * distance),
        y: Math.round(origin.y + Math.sin(angle) * distance),
    };
}
function frame(pos, radius, tier) {
    return { x: pos.x, y: pos.y, radius, color: FIREWORKS_COLORS[tier] };
}
const HIDDEN_FRAME = { x: 0, y: 0, radius: 0, color: FIREWORKS_COLORS[0] };

// Regenerated fresh on every call — see the file-level comment above for
// why. Returns [slot][frameIndex] -> {x, y, radius, color}, unscaled and
// unmirrored (playFireworksAnimation applies both).
function buildFireworksFrames() {
    const mainAngleStep = (2 * Math.PI) / MAIN_PIECE_COUNT;
    const mainAngles = Array.from(
        { length: MAIN_PIECE_COUNT },
        (_, i) => -Math.PI / 2 + i * mainAngleStep + randRange(-1, 1) * deg(MAIN_ANGLE_JITTER_DEG)
    );
    const mainPeakDistances = mainAngles.map(
        () => MAIN_PEAK_DISTANCE_BASE + randRange(-1, 1) * MAIN_PEAK_DISTANCE_JITTER
    );
    const piecesPeak = mainAngles.map((angle, i) => project(ORIGIN, angle, mainPeakDistances[i]));

    const framesBySlot = [];

    for (let piece = 0; piece < MAIN_PIECE_COUNT; piece++) {
        const frames = [];
        for (let f = 0; f < BUILD_FRAME_COUNT; f++) {
            frames.push(piece === 0 ? frame(ORIGIN, BUILD_RADII[f], 0) : HIDDEN_FRAME);
        }
        for (let f = 0; f < MAIN_FRAME_COUNT; f++) {
            const t = f / (MAIN_FRAME_COUNT - 1);
            const dist = MAIN_NEAR_DISTANCE + t * (mainPeakDistances[piece] - MAIN_NEAR_DISTANCE);
            frames.push(frame(project(ORIGIN, mainAngles[piece], dist), MAIN_RADII[f], 1));
        }
        // Consumed the instant the sub-burst starts — replaced by its own
        // sparks below, all 5 pieces at once.
        for (let f = 0; f < SUB_FRAME_COUNT; f++) frames.push(HIDDEN_FRAME);
        framesBySlot.push(frames);
    }

    for (let piece = 0; piece < MAIN_PIECE_COUNT; piece++) {
        for (let spark = 0; spark < SUB_SPARK_COUNT; spark++) {
            const evenOffsetDeg = -SUB_ANGLE_SPREAD_DEG / 2 + (SUB_ANGLE_SPREAD_DEG / (SUB_SPARK_COUNT - 1)) * spark;
            const angle = mainAngles[piece] + deg(evenOffsetDeg + randRange(-1, 1) * SUB_ANGLE_JITTER_DEG);
            const finalDistance = SUB_DISTANCE_BASE + randRange(-1, 1) * SUB_DISTANCE_JITTER;
            const startRadius = SUB_START_RADIUS_BASE + randRange(-1, 1) * SUB_START_RADIUS_JITTER;

            const frames = [];
            for (let f = 0; f < SUB_PHASE_START; f++) frames.push(HIDDEN_FRAME);
            for (let f = 0; f < SUB_FRAME_COUNT; f++) {
                const t = (f + 1) / SUB_FRAME_COUNT; // (0, 1], hits exactly 1 on the last frame
                frames.push(frame(project(piecesPeak[piece], angle, finalDistance * t), startRadius * (1 - t), 2));
            }
            framesBySlot.push(frames);
        }
    }

    return framesBySlot;
}

// Same shape/reasoning as smokeAnimation.js's own HIDDEN_DISC — numeric 0
// cMask/cGroup (the live setDiscProperties API), not the JSON stadium
// format's array-of-trait-names.
const HIDDEN_DISC = {
    xspeed: 0, yspeed: 0, xgravity: 0, ygravity: 0, bCoeff: 0,
    invMass: 0, damping: 0, cMask: 0, cGroup: 0,
    x: 0, y: 0, radius: 0, color: 0xffffff,
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// `team` is whichever side just scored (see gameManagement.js's onTeamGoal
// — the scorer's own team, own goals excluded) — the burst appears at the
// goal that was just scored INTO, same mirroring rule as smokeAnimation.js.
async function playFireworksAnimation({ room, Team, stadium, team }) {
    if (!isStadiumSupported(stadium)) return;
    const discStart = resolveDiscStart(room, stadium);
    if (discStart == null) {
        console.error(`[fireworksAnimation] disc for stadium=${stadium} does not look like our own helper disc (radius !== 0) — skipping to avoid corrupting a real disc.`);
        return;
    }
    const scale = (STADIUM_GOAL_X[stadium] ?? REFERENCE_GOAL_X) / REFERENCE_GOAL_X;
    const mirror = team === Team.RED ? 1 : -1;
    const framesBySlot = buildFireworksFrames();

    // Bugs (reported live, both stadiums, every play):
    //   1. discStart used to be a hardcoded per-stadium constant that
    //      didn't account for the ball (disc 0, always) sitting before the
    //      stadium's own custom discs — see DISC_START in smokeAnimation.js
    //      for the full story, including two dynamic-resolution attempts
    //      that made this WORSE before landing on the simple +1 fix. This
    //      was the actual "штанга пропадает" cause, not overlap.
    //   2. The randomized burst can ALSO fly a disc close enough to
    //      visually overlap a real goalpost even with a correct discStart
    //      (see smokeAnimation.js's clearGoalpost, which this reuses).
    //      Clamped below, per frame, as defense in depth alongside #1's
    //      fix, not a replacement for it.
    //   3. Separately, if the stadium switches (or the room restarts)
    //      while this ~1.8s async loop is still mid-flight,
    //      setDiscProperties on a now-stale/out-of-range index throws —
    //      which used to abort the function entirely, skipping the
    //      cleanup loop below and leaving whatever frame was last drawn
    //      stuck visible forever. try/finally guarantees cleanup runs
    //      regardless.
    try {
        for (let frameIndex = 0; frameIndex < FRAME_COUNT; frameIndex++) {
            for (let slot = 0; slot < DISCS_NEEDED; slot++) {
                const f = framesBySlot[slot][frameIndex];
                let props = HIDDEN_DISC;
                if (f.radius > 0) {
                    const x = f.x * scale * mirror;
                    const y = f.y * scale;
                    const radius = clearGoalpost(stadium, x, y, f.radius * scale);
                    props = radius > 0 ? { x, y, radius, color: f.color } : HIDDEN_DISC;
                }
                room.setDiscProperties(discStart + slot, props);
            }
            await sleep(FRAME_DELAY_MS);
        }
    } finally {
        for (let slot = 0; slot < DISCS_NEEDED; slot++) {
            try {
                room.setDiscProperties(discStart + slot, HIDDEN_DISC);
            } catch {
                // The stadium itself changed out from under this animation
                // (see above) — that stadium's own fresh disc set already
                // has these helper discs correctly hidden by definition, so
                // a failed cleanup write here is a no-op, not a leak.
            }
        }
    }
}

module.exports = {
    ORIGIN,
    MAIN_PIECE_COUNT,
    SUB_SPARK_COUNT,
    SUB_PHASE_START,
    DISCS_NEEDED,
    FRAME_COUNT,
    FRAME_DELAY_MS,
    FIREWORKS_COLORS,
    buildFireworksFrames,
    playFireworksAnimation,
};
