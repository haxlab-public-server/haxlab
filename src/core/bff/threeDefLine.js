/*
 * "3 defenders" rule for BFF's big map (3v3/4v4) — requested 2026-08-14
 * ("во время большой карты, сделай правило 3 дефа... защищаться могут
 * только трое"). Ported from a known community headless-host technique
 * (github.com/thenorthstar/HaxBall-Example-Scripts, Intermediate/
 * 3DefLines.js) onto BFF's own Big map JSON (core/bff/stadiums.js), whose
 * planes already carry the invisible defensive-zone walls this needs
 * (`{"cMask":["c0"],...}` at x=-360 for red, `{"cMask":["c1"],...}` at
 * x=360 for blue) — supplied by the room owner alongside the rest of that
 * map, just never wired to any collision-group logic until now.
 *
 * Mechanic: every tick, the single most advanced (furthest forward) player
 * on each team is tagged with the collision group (c0/c1) that collides
 * with their own team's defensive-zone plane, physically blocking that ONE
 * player from dropping back into their own third. Every other teammate
 * keeps the plain team collision group and can enter/exit the zone freely.
 * Net effect: at most teamSize-1 players can occupy the defensive zone at
 * once — exactly 3 for a genuine 4v4.
 */
module.exports = function createBffThreeDefLine({ room, state, Team, HaxNotification, warningColor, successColor }) {
    const cf = room.CollisionFlags;

    function mostForward(players, team) {
        return players.reduce((best, p) => {
            if (best == null) return p;
            const moreAdvanced = team === Team.RED ? p.position.x > best.position.x : p.position.x < best.position.x;
            return moreAdvanced ? p : best;
        }, null);
    }

    // Chat announcement on the cGroup transition edge was removed 2026-08-17
    // — "most forward player" is inherently noisy in real play (two
    // defenders jostling for position can flip which one of them is
    // "furthest back" many times a second), so the transition edge itself
    // fires far more often than the doc comment here used to assume,
    // spamming the same two messages. The actual rule enforcement
    // (setPlayerDiscProperties toggling cGroup) is unaffected — only the
    // per-transition chat line is gone, pending a replacement (still TBD).
    function restrictTeam(players, mfpId, plainGroup, restrictedGroup) {
        for (const p of players) {
            const props = room.getPlayerDiscProperties(p.id);
            if (props == null) continue;
            const shouldBeRestricted = p.id === mfpId;
            if (shouldBeRestricted && props.cGroup === plainGroup) {
                room.setPlayerDiscProperties(p.id, { cGroup: restrictedGroup });
            } else if (!shouldBeRestricted && props.cGroup !== plainGroup) {
                room.setPlayerDiscProperties(p.id, { cGroup: plainGroup });
            }
        }
    }

    function adjustDefenseLine() {
        if (state.currentStadium !== 'big') return;
        const red = state.teamRed;
        const blue = state.teamBlue;
        if (red.length === 0 || blue.length === 0) return;

        restrictTeam(red, mostForward(red, Team.RED).id, cf.red, cf.red | cf.c0);
        restrictTeam(blue, mostForward(blue, Team.BLUE).id, cf.blue, cf.blue | cf.c1);
    }

    return { adjustDefenseLine };
};
