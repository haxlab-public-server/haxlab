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

    // Explains the invisible wall the very first time it actually applies
    // to someone (item #20) — this runs every tick, but the two branches
    // below only fire on the cGroup transition edge itself (see the
    // `=== plainGroup` / `!== plainGroup` guards), not on every tick the
    // restriction merely continues to hold, so a player sees this once per
    // spell as the most-advanced defender, not spammed every frame.
    function restrictTeam(players, mfpId, plainGroup, restrictedGroup) {
        for (const p of players) {
            const props = room.getPlayerDiscProperties(p.id);
            if (props == null) continue;
            const shouldBeRestricted = p.id === mfpId;
            if (shouldBeRestricted && props.cGroup === plainGroup) {
                room.setPlayerDiscProperties(p.id, { cGroup: restrictedGroup });
                room.sendAnnouncement(
                    `🚧 Вы крайний защитник — дальше своей трети отступать нельзя (правило "3 защитника").`,
                    p.id, warningColor, 'bold', HaxNotification.CHAT
                );
            } else if (!shouldBeRestricted && props.cGroup !== plainGroup) {
                room.setPlayerDiscProperties(p.id, { cGroup: plainGroup });
                room.sendAnnouncement(
                    `✅ Вы больше не крайний защитник — можно снова отступать в свою треть.`,
                    p.id, successColor, 'bold', HaxNotification.CHAT
                );
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
