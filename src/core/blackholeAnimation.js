/*
 * "Black hole" goal celebration — a small dark sphere appears at the goal
 * mouth of whichever side just conceded (the goal that was actually scored
 * INTO — same mirroring rule as smokeAnimation.js/fireworksAnimation.js:
 * RED scoring mirrors x positive, blue's goal, and vice versa) and grows
 * into a real black hole over the animation, pulling every player
 * currently on a team toward its center as it grows — everyone except
 * whoever just scored, who stays exactly where they are the whole time.
 *
 * Unlike smokeAnimation.js/fireworksAnimation.js, this doesn't just draw
 * decorative discs — it directly overrides affected players' own disc
 * position every frame via room.setPlayerDiscProperties, the same API
 * economy.js's own playGoalSizeEffect already uses (for radius there,
 * position here) and browser/entry.js's own player-reconnect handling
 * already confirms round-trips x/y correctly via getPlayerDiscProperties.
 * This is a deliberate override, not a suggestion — a player can't fight
 * their own way out of the pull by moving, same as nobody can outrun an
 * actual black hole.
 *
 * The ball is left untouched on purpose (only the spec ever asked for
 * players) — after a goal it's normally already reset near the field's
 * own center, waiting for the next kickoff, independent of wherever this
 * file's own hole ends up.
 *
 * Reuses smokeAnimation.js's own helper-disc pool (isStadiumSupported/
 * resolveDiscStart) for its own single visual disc — only ever needs 1,
 * well within the 25 already reserved there, and goalAnimation is a single
 * equip slot, so this can never run at the same time as smoke/fireworks on
 * the same disc.
 */
const { isStadiumSupported, resolveDiscStart, STADIUM_GOAL_X } = require('./smokeAnimation');

const REFERENCE_GOAL_X = 372;

const FRAME_COUNT = 24;
const FRAME_DELAY_MS = 90; // 24 * 90 = 2160ms, the full show

const START_RADIUS = 3;
const END_RADIUS = 90; // scaled per stadium, same reasoning as smokeAnimation.js's own radii

// Near-black with a faint violet tint — reads as "space" rather than a flat
// silhouette against the map's own dark line art.
const BLACKHOLE_COLOR = 0x0d001a;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Quadratic ease-in — starts gentle, accelerates toward the end. Drives
// BOTH the pull and the growth from the same value on purpose: a hole
// that's still small shouldn't already be yanking players in at full
// force.
function easeIn(t) {
    return t * t;
}

// `team` is whichever side just scored (see gameManagement.js's onTeamGoal
// — the scorer's own team, own goals excluded) — the hole opens at the
// goal that was just scored INTO, i.e. the opposing side's goal mouth,
// same convention (and same math) as smokeAnimation.js's own mirroring.
function goalCenter(stadium, team, Team) {
    const scale = (STADIUM_GOAL_X[stadium] ?? REFERENCE_GOAL_X) / REFERENCE_GOAL_X;
    const mirror = team === Team.RED ? 1 : -1;
    return { x: REFERENCE_GOAL_X * scale * mirror, y: 0 };
}

// Same shape/reasoning as smokeAnimation.js's own HIDDEN_DISC — numeric 0
// cMask/cGroup (the live setDiscProperties API), not the JSON stadium
// format's array-of-trait-names.
const HIDDEN_DISC = {
    xspeed: 0, yspeed: 0, xgravity: 0, ygravity: 0, bCoeff: 0,
    invMass: 0, damping: 0, cMask: 0, cGroup: 0,
    x: 0, y: 0, radius: 0, color: 0xffffff,
};

// `players` is the roster to pull — captured once, by the caller, at the
// moment the goal was scored (state.teamRed.concat(state.teamBlue)), same
// "snapshot the moment, don't re-evaluate mid-flight" convention as
// smokeAnimation.js's own `team` parameter. `scorerId` is excluded from
// that list entirely, never touched. `state` is threaded through (not
// captured by value) purely to re-check aliveness every frame — a player
// who leaves mid-animation is just skipped from then on, not an error.
async function playBlackholeAnimation({ room, state, Team, stadium, team, players, scorerId }) {
    if (!isStadiumSupported(stadium)) return;
    const discStart = resolveDiscStart(room, stadium);
    if (discStart == null) {
        console.error(`[blackholeAnimation] disc for stadium=${stadium} does not look like our own helper disc (radius !== 0) — skipping to avoid corrupting a real disc.`);
        return;
    }
    const scale = (STADIUM_GOAL_X[stadium] ?? REFERENCE_GOAL_X) / REFERENCE_GOAL_X;
    const endRadius = END_RADIUS * scale;
    const center = goalCenter(stadium, team, Team);

    const targets = players.filter((p) => p.id !== scorerId);
    const startPositions = new Map();
    for (const p of targets) {
        const props = room.getPlayerDiscProperties(p.id);
        if (props) startPositions.set(p.id, { x: props.x, y: props.y });
    }

    try {
        for (let frame = 0; frame < FRAME_COUNT; frame++) {
            const t = (frame + 1) / FRAME_COUNT;
            const eased = easeIn(t);

            room.setDiscProperties(discStart, {
                x: center.x,
                y: center.y,
                radius: START_RADIUS + (endRadius - START_RADIUS) * eased,
                color: BLACKHOLE_COLOR,
            });

            for (const p of targets) {
                const start = startPositions.get(p.id);
                if (!start) continue;
                if (!state.playersAll.some((live) => live.id === p.id)) continue;
                try {
                    room.setPlayerDiscProperties(p.id, {
                        x: start.x + (center.x - start.x) * eased,
                        y: start.y + (center.y - start.y) * eased,
                    });
                } catch {
                    // Same "left/reconnected out from under this frame"
                    // tolerance as the disc cleanup below — one player's
                    // stale id must never abort the pull for everyone else.
                }
            }
            await sleep(FRAME_DELAY_MS);
        }
    } finally {
        try {
            room.setDiscProperties(discStart, HIDDEN_DISC);
        } catch {
            // The stadium itself changed out from under this animation —
            // its own fresh disc set already has this helper disc hidden
            // by definition, same reasoning as smokeAnimation.js's own
            // cleanup.
        }
    }
}

module.exports = {
    goalCenter,
    FRAME_COUNT,
    FRAME_DELAY_MS,
    START_RADIUS,
    END_RADIUS,
    BLACKHOLE_COLOR,
    easeIn,
    playBlackholeAnimation,
};
