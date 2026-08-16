/*
 * Thin, read-only wrapper around state.game.touchArray (models.js's
 * BallTouch[]) — the ONLY place "what counts as a pass vs. a turnover"
 * is defined, so every detector in this folder agrees on it by construction.
 *
 * A key data-shape fact this whole folder is built around: touchArray only
 * gets a NEW entry when the TOUCHING PLAYER CHANGES (see stats/global.js's
 * getLastTouchOfTheBall — consecutive touches by the same player never push
 * a second entry). So there is no direct signal for "where did this player
 * release the ball after dribbling" — only "where did the next different
 * toucher receive it". Every metric here that talks about a pass's or
 * carry's distance/progression is measured as that same segment (touch i's
 * position -> touch i+1's position), which is honest about what the data
 * can support: it measures ball advancement attributable to touch i's
 * player, whether that came from a pure pass or a dribble-then-pass.
 */
class TouchChain {
    constructor(touches, { pointDistance }) {
        this.touches = touches;
        this._pointDistance = pointDistance;
    }

    get length() {
        return this.touches.length;
    }

    at(i) {
        return this.touches[i] ?? null;
    }

    sameTeamAs(i, j) {
        const a = this.at(i);
        const b = this.at(j);
        if (a == null || b == null) return false;
        return a.player.team === b.player.team;
    }

    samePlayer(i, j) {
        const a = this.at(i);
        const b = this.at(j);
        if (a == null || b == null) return false;
        return a.player.id === b.player.id;
    }

    // Every entry is already "a new toucher" by construction (see the file
    // doc comment) except possibly index 0, which has no predecessor to
    // compare against.
    isNewEvent(i) {
        if (i === 0) return true;
        return !this.samePlayer(i, i - 1);
    }

    // A pass INTO touch i: different player than i-1, same team.
    isPass(i) {
        if (i === 0) return false;
        return this.isNewEvent(i) && this.sameTeamAs(i, i - 1);
    }

    // Touch i is possession changing hands TO the other team (a takeaway
    // for i's player, a turnover for i-1's player).
    isTurnoverAt(i) {
        if (i === 0) return false;
        return this.isNewEvent(i) && !this.sameTeamAs(i, i - 1);
    }

    distanceBetween(i, j) {
        const a = this.at(i);
        const b = this.at(j);
        if (a == null || b == null) return 0;
        return this._pointDistance(a.position, b.position);
    }
}

module.exports = { TouchChain };
