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
 *     and bigMap's own `discs` arrays for exactly this purpose.
 *     trainingMap has no goals at all (empty `goals` array — it's a
 *     shooting-practice map, not scored), so it was never given any.
 *     Both maps were later given 18 MORE of the same discs in two rounds
 *     (25 total) for fireworksAnimation.js's own, busier cascade — smoke
 *     itself still only ever touches the first 7 of them, it just no
 *     longer marks the true end of the helper-disc pool (see
 *     HELPER_DISC_COUNT below).
 *
 *     The actual room.setDiscProperties index these land at is NOT simply
 *     "position within the stadium's own discs array" — disc 0 is always
 *     the ball (confirmed elsewhere in this codebase — browser/entry.js's
 *     and stats/global.js's own room.getDiscProperties(0) calls both read
 *     it), and the stadium's own custom discs start right after it, at
 *     index 1. A hardcoded per-stadium constant that skipped this +1 (the
 *     original code here) was the "штанга пропадает" bug: every symptom
 *     ever reported traces back to exactly this one missing offset — see
 *     DISC_START below for the full reasoning, including why two earlier
 *     attempts at finding this dynamically at runtime (via the unverified
 *     room.getDiscCount(), then a full live disc-array scan) both made
 *     things WORSE than the original bug rather than better, and were
 *     abandoned in favor of this single static correction instead.
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
const STADIUM_GOAL_X = { classic: 372, big: 674 };

// Where our own helper-disc pool starts: 1 (the ball, disc 0) + however far
// into the stadium's own `discs` array (see stadiums.js) our first helper
// disc sits — 8 for classic (past its 4 goalposts + 4 corner-line discs),
// 4 for big (past its 4 goalposts only). Written as `N + 1` rather than the
// summed value so the ball offset stays visible in the source, not buried
// in a number.
//
// This +1 is the WHOLE fix for "штанга пропадает" — every reported symptom
// traces back to exactly this one missing offset, no more and no less:
//   - The original code used the raw stadium-relative position (no +1) AS
//     the real index. On big, that means it wrote to real index 4, which —
//     under the correct +1 accounting — is actually stadium-relative
//     position 3: blue's own y=-80 goalpost (see stadiums.js's bigMap
//     discs[3]). Always that ONE disc, regardless of team or which goal
//     the animation rendered at, because this was a pure index bug with
//     zero dependence on scoring geometry — exactly what was reported
//     live ("всегда одно и то же место, независимо от того, кто забил").
//     (On classic the same off-by-one lands on stadium-relative position 7
//     — a corner decoration, not a goalpost, which is presumably why that
//     map was never specifically singled out in the reports.)
//   - Two later attempts at finding this at runtime instead of as a static
//     constant both made things WORSE, live, rather than better:
//     room.getDiscCount() (never verified against a real room — nothing
//     else in this codebase had ever called it) produced a number that
//     happened to work for smoke's short burst once, by what looks in
//     hindsight like coincidence (an empty-ish room at that exact test
//     moment), but was wrong the moment real players were actually
//     present — HaxBall appears to append player discs to the END of the
//     whole array as they join, not insert them before the stadium's own
//     discs, so counting backward from a getDiscCount()-style live total
//     drifts further wrong the more players are in the room, landing on
//     player discs instead (confirmed live: players became firework
//     particles). A follow-up attempt at fully scanning the live disc
//     array for a run of 25 radius-0 discs made this total, not partial:
//     with players' discs appended at the end, "the last 25 discs" is
//     essentially never purely our own pool anymore the moment anyone is
//     in the room at all, so the animation stopped running altogether
//     (confirmed live: no animation played on any goal). A plain static
//     constant, corrected by the one offset that was actually missing,
//     doesn't have either failure mode — nothing about it depends on how
//     many players happen to be in the room.
const DISC_START = { classic: 8 + 1, big: 4 + 1 };

// Total helper discs available from DISC_START onward (see stadiums.js) —
// smoke only ever touches the first 7 of them, fireworks needs all 25.
const HELPER_DISC_COUNT = { classic: 25, big: 25 };

// Fast pre-loop check, no room needed — lets both animation functions bail
// out before ever touching `room` for a stadium that was never given the
// helper discs this needs (e.g. trainingMap, which has no goals at all).
function isStadiumSupported(stadium) {
    return HELPER_DISC_COUNT[stadium] != null;
}

// Cheap, one-time sanity check — NOT a search, just a confirmation that
// DISC_START's own static math still points at one of our own placeholder
// discs (radius 0, per stadiums.js) rather than something real, in case a
// future stadium edit ever moves these without updating DISC_START to
// match. Checks only the first disc of the range (not the whole 25) — see
// the DISC_START comment above for why a full-range version of this
// specific check was tried and made things worse, not better.
function resolveDiscStart(room, stadium) {
    const discStart = DISC_START[stadium];
    if (discStart == null) return null;
    const first = room.getDiscProperties(discStart);
    if (!first || first.radius !== 0) return null;
    return discStart;
}

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
    if (!isStadiumSupported(stadium)) return;
    const discStart = resolveDiscStart(room, stadium);
    if (discStart == null) {
        console.error(`[smokeAnimation] disc ${DISC_START[stadium]} for stadium=${stadium} does not look like our own helper disc (radius !== 0) — skipping to avoid corrupting a real disc.`);
        return;
    }
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
    STADIUM_GOAL_X,
    HELPER_DISC_COUNT,
    isStadiumSupported,
    resolveDiscStart,
    clearGoalpost,
    playSmokeAnimation,
};
