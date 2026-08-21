/*
 * "Wallkick"/double-shot detector (requested 2026-08-21): a player standing
 * right next to a wall kicks the ball into it, then immediately kicks the
 * rebound — announced with the resulting ball speed and shot angle, styled
 * after a similar feature seen on another server.
 *
 * The headless API exposes no "ball hit a wall" event at all (a standing
 * feature request upstream — github.com/haxball/haxball-issues/issues/314),
 * so this is a heuristic built entirely from per-tick ball velocity: a
 * genuine elastic wall bounce shows up as an abrupt SIGN FLIP on the ball's
 * xspeed or yspeed with nobody touching it, distinct from ordinary
 * per-tick damping decay (which always shrinks a component toward zero,
 * never flips its sign). A touch landing within a short window after that
 * flip counts as the wallkick — but ONLY from the SAME player who sent the
 * ball into the wall in the first place (requested 2026-08-21: someone
 * else happening to intercept the rebound isn't a double-shot).
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createWallkickDetector({
    room,
    state,
    HaxNotification,
    getBallSpeed,
    pointDistance,
    achievementColor,
}) {
    // How many ticks after a detected bounce a touch still counts as the
    // "second click" of the double-shot, rather than an unrelated later
    // touch. At 60 ticks/sec this is well under a tenth of a second —
    // generous for a player standing right against the wall (the ball
    // barely has to travel), tight enough not to credit an ordinary touch
    // minutes later just because the ball once bounced off a wall nearby.
    const WALLKICK_WINDOW_TICKS = 5;
    // Below this, a "flip" is just numerical noise around zero (the ball
    // sitting nearly still), not a real bounce.
    const VELOCITY_EPSILON = 0.5;
    // Below this speed, don't bother announcing — a weak, incidental
    // wall-then-player contact isn't the highlight-worthy double-shot this
    // is meant to celebrate.
    const MIN_WALLKICK_SPEED_KMH = 50;

    function checkWallkick() {
        const ballProp = room.getDiscProperties(0);
        if (ballProp == null) return;
        const prev = state.wallkickPrevVelocity;

        if (state.wallkickBounceTicksAgo != null) {
            state.wallkickBounceTicksAgo++;
            if (state.wallkickBounceTicksAgo > WALLKICK_WINDOW_TICKS) {
                state.wallkickBounceTicksAgo = null;
                state.wallkickBounceByPlayerId = null;
            }
        }

        // Own proximity check rather than reusing stats/global.js's
        // lastTouches[0] — that only updates when the TOUCHING PLAYER
        // CHANGES, so the exact double-shot case (the same player kicks,
        // then gets hit by their own rebound) would never re-fire it.
        // Ball position read once, not per player in the loop.
        const ballPosition = room.getBallPosition();
        let touchedBy = null;
        if (ballPosition != null) {
            for (const player of state.players) {
                if (player.position == null) continue;
                if (pointDistance(player.position, ballPosition) < state.triggerDistance) {
                    touchedBy = player;
                    break;
                }
            }
        }

        if (touchedBy != null) {
            if (state.wallkickBounceTicksAgo != null && touchedBy.id === state.wallkickBounceByPlayerId) {
                announceWallkick(ballProp);
            }
            state.wallkickBounceTicksAgo = null;
            state.wallkickBounceByPlayerId = null;
        } else if (prev != null) {
            const flippedX = Math.abs(ballProp.xspeed) > VELOCITY_EPSILON && Math.abs(prev.x) > VELOCITY_EPSILON && Math.sign(ballProp.xspeed) !== Math.sign(prev.x);
            const flippedY = Math.abs(ballProp.yspeed) > VELOCITY_EPSILON && Math.abs(prev.y) > VELOCITY_EPSILON && Math.sign(ballProp.yspeed) !== Math.sign(prev.y);
            if (flippedX || flippedY) {
                state.wallkickBounceTicksAgo = 0;
                // Whoever most recently touched the ball is who sent it
                // into the wall — nobody else could have, the ball was in
                // flight. lastTouches[0] (stats/global.js) is exactly that:
                // updated on the first tick of a new touch, unchanged
                // through the ball's flight since.
                state.wallkickBounceByPlayerId = state.lastTouches?.[0]?.player.id ?? null;
            }
        }

        state.wallkickPrevVelocity = { x: ballProp.xspeed, y: ballProp.yspeed };
    }

    function announceWallkick(ballProp) {
        const speed = getBallSpeed();
        if (speed < MIN_WALLKICK_SPEED_KMH) return;
        const angle = Math.abs(Math.atan2(ballProp.yspeed, ballProp.xspeed) * (180 / Math.PI));
        room.sendAnnouncement(
            `[ ᴡᴀʟʟᴋɪᴄᴋ ┊⚡${speed.toFixed(2)} ᴋᴍ/ʜ - 📐${angle.toFixed(2)}° ]`,
            null,
            achievementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    return {
        checkWallkick,
    };
};
