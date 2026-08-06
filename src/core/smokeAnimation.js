/*
 * "Smoke burst" goal celebration — ported from the sibling reference repo
 * ../../../haxball-goal-animation (animation.js's `smoke` entry), adapted
 * to THIS room's own classic/big stadiums (see stadiums.js) instead of the
 * original library's own custom map:
 *
 *   - The reference library works by animating extra, otherwise-invisible
 *     discs that must already exist in the loaded stadium's own `discs`
 *     array — room.setDiscProperties(index, ...) can only ever move a disc
 *     that's already there, it can't create one. 7 such discs (radius 0,
 *     cMask/cGroup empty so they never collide with anything, at any point,
 *     visible frames included — the reference library never re-enables
 *     collision on them either) were appended to the END of classicMap's
 *     and bigMap's own `discs` arrays for exactly this purpose. If either
 *     map's discs array is ever restructured, SMOKE_DISC_START_INDEX below
 *     (that array's length at the time these were added) must move with it.
 *     trainingMap has no goals at all (empty `goals` array — it's a
 *     shooting-practice map, not scored), so it was never given any.
 *     Both maps were later given 18 MORE of the same discs in two rounds
 *     (25 total) for fireworksAnimation.js's own, busier cascade — smoke
 *     itself still only ever touches the first 7 (SMOKE_DISC_START_INDEX
 *     unchanged), it just no longer marks the true end of the helper-disc
 *     pool.
 *
 *   - Frame coordinates were tuned against the reference library's own
 *     420-wide stadium, whose goal sits at x=~372 — close enough to
 *     classic's own 420-wide layout (goal at x=372) that it needed no
 *     rescaling at all. big is a genuinely bigger pitch (755 wide, goal at
 *     x=674), so every coordinate and radius gets scaled by
 *     (that stadium's own goal-x / 372) to keep the burst proportional.
 *
 *   - The reference library computed color per-frame via a shared mutable
 *     `currentColor` closure — replaced here with a plain `tier` index
 *     (0-3) into whichever 4-shade SMOKE_COLORS ramp the equipped item
 *     picked, resolved fresh on every call instead of through shared state.
 */
const SMOKE_COLORS = {
    blue: [0x7a86bf, 0x515c94, 0x3a4166, 0x2b2e40],
    red: [0xd64b4b, 0xcf1f1f, 0x5c1717, 0x381111],
    purple: [0x67438c, 0x562487, 0x32194a, 0x261636],
    white: [0xffffff, 0xede8e4, 0x94918f, 0x7d7975],
};

const REFERENCE_GOAL_X = 372;
const SMOKE_DISC_START_INDEX = { classic: 8, big: 4 };
const STADIUM_GOAL_X = { classic: 372, big: 674 };

// Real, physical goalpost positions (see stadiums.js's own discs 0-3 —
// trait: 'goalPost') — duplicated here rather than read live, since these
// animation files only ever get a bare scale factor from playGoalAnimation,
// never the actual stadium data. Needed by clearGoalpost below: this
// file's own hand-tuned SMOKE_FRAMES (and fireworksAnimation.js's
// randomized burst, which imports this) were tuned against a reference
// celebration library's own map, never checked against THIS room's actual
// goalpost coordinates — confirmed live to fly discs (up to a 25-radius
// one) almost exactly on top of a post, on both stadiums, every single
// time. "штанга пропадает после анимации" was that post, still physically
// there, just visually buried under a stuck-in-place decoration.
const GOALPOSTS = {
    classic: { x: 368, ys: [50, -50] },
    big: { x: 665, ys: [80, -80] },
};
const GOALPOST_RADIUS = 5;
const GOALPOST_CLEARANCE = 3; // extra breathing room beyond a bare edge-touch

// Shrinks (never repositions) a disc's radius just enough to clear
// whichever real goalpost it would otherwise overlap, on the side it's
// already drawn on (`x`'s own sign — call this AFTER scaling/mirroring, so
// sign already matches the scored-into side). Clamps to 0 if even a
// razor-thin disc still wouldn't clear — same as this file's own
// null/HIDDEN_DISC frames, just for one specific frame instead of a whole
// slot.
function clearGoalpost(stadium, x, y, radius) {
    const post = GOALPOSTS[stadium];
    if (!post || radius <= 0) return radius;
    const postX = x < 0 ? -post.x : post.x;
    let clamped = radius;
    for (const postY of post.ys) {
        const maxRadius = Math.hypot(x - postX, y - postY) - GOALPOST_RADIUS - GOALPOST_CLEARANCE;
        if (maxRadius < clamped) clamped = maxRadius;
    }
    return Math.max(0, clamped);
}

// 7 slots (one per helper disc) x 5 frames each. null = that disc goes
// invisible (radius 0) for that frame, same as the reference library's
// `{ ...defaultDiscProperties }` frames — most slots only "exist" for part
// of the burst. tier indexes into SMOKE_COLORS[variant].
const SMOKE_FRAMES = [
    [
        { x: 381, y: -2, tier: 0, radius: 10 },
        { x: 381, y: -2, tier: 0, radius: 20 },
        { x: 394, y: -7, tier: 3, radius: 25 },
        { x: 393, y: -47, tier: 1, radius: 15 },
        { x: 371, y: -83, tier: 0, radius: 8 },
    ],
    [
        { x: 378, y: -18, tier: 1, radius: 10 },
        { x: 371, y: 20, tier: 1, radius: 20 },
        { x: 378, y: 29, tier: 1, radius: 25 },
        { x: 373, y: -56, tier: 0, radius: 15 },
        { x: 408, y: -50, tier: 0, radius: 5 },
    ],
    [
        { x: 374, y: -11, tier: 1, radius: 10 },
        { x: 371, y: -24, tier: 1, radius: 15 },
        { x: 356, y: -10, tier: 0, radius: 25 },
        { x: 324, y: -46, tier: 0, radius: 5 },
        { x: 325, y: -6, tier: 0, radius: 10 },
    ],
    [
        null,
        { x: 404, y: -11, tier: 1, radius: 15 },
        { x: 373, y: -43, tier: 1, radius: 25 },
        { x: 340, y: -7, tier: 0, radius: 20 },
        { x: 379, y: 59, tier: 0, radius: 5 },
    ],
    [
        null,
        null,
        { x: 403, y: 18, tier: 3, radius: 5 },
        // Reference library indexed its color ramp out of bounds here
        // (currentColor[4] on a 4-entry array, i.e. undefined) — clamped
        // to the last real tier instead of reproducing that as a bug.
        { x: 333, y: 44, tier: 3, radius: 10 },
        null,
    ],
    [
        null,
        null,
        { x: 344, y: 23, tier: 3, radius: 15 },
        { x: 373, y: 35, tier: 1, radius: 15 },
        null,
    ],
    [
        null,
        null,
        { x: 337, y: -37, tier: 0, radius: 15 },
        { x: 414, y: 26, tier: 3, radius: 5 },
        null,
    ],
];
const FRAME_COUNT = 5;
const FRAME_DELAY_MS = 130;

// Numeric 0 cMask/cGroup (rather than the JSON stadium format's array-of-
// trait-names) matches HaxBall's live setDiscProperties API, same as the
// reference library's own defaultDiscProperties — this is what both the
// "invisible" frames and the final cleanup use.
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
// goal that was just scored INTO, i.e. the opposing side's goal mouth:
// RED scoring mirrors every x positive (blue's goal is on the positive
// side of both these stadiums), BLUE scoring keeps them negative.
async function playSmokeAnimation({ room, Team, stadium, team, colorName }) {
    const discStart = SMOKE_DISC_START_INDEX[stadium];
    if (discStart == null) return;
    const colors = SMOKE_COLORS[colorName] ?? SMOKE_COLORS.purple;
    const scale = (STADIUM_GOAL_X[stadium] ?? REFERENCE_GOAL_X) / REFERENCE_GOAL_X;
    const mirror = team === Team.RED ? 1 : -1;

    // Same "stadium switched mid-animation -> setDiscProperties throws ->
    // cleanup skipped -> a bright disc stays stuck visible near the goal"
    // failure mode as fireworksAnimation.js's own playFireworksAnimation —
    // see its comment. try/finally guarantees cleanup runs regardless.
    try {
        for (let frame = 0; frame < FRAME_COUNT; frame++) {
            for (let slot = 0; slot < SMOKE_FRAMES.length; slot++) {
                const f = SMOKE_FRAMES[slot][frame];
                let props = HIDDEN_DISC;
                if (f) {
                    const x = f.x * scale * mirror;
                    const y = f.y * scale;
                    const radius = clearGoalpost(stadium, x, y, f.radius * scale);
                    props = radius > 0 ? { x, y, radius, color: colors[f.tier] } : HIDDEN_DISC;
                }
                room.setDiscProperties(discStart + slot, props);
            }
            await sleep(FRAME_DELAY_MS);
        }
    } finally {
        for (let slot = 0; slot < SMOKE_FRAMES.length; slot++) {
            try {
                room.setDiscProperties(discStart + slot, HIDDEN_DISC);
            } catch {
                // The stadium itself already changed — its own fresh disc
                // set has these helper discs hidden by definition.
            }
        }
    }
}

module.exports = {
    SMOKE_COLORS,
    SMOKE_DISC_START_INDEX,
    STADIUM_GOAL_X,
    clearGoalpost,
    playSmokeAnimation,
};
