/*
 * Builds the room-setup callbacks core/bff/matchFlow.js expects —
 * kept as a separate factory (not inlined into matchFlow.js) specifically
 * so matchFlow.js never needs to know the actual map JSON or naming; this
 * is where that decision actually lives. Confirmed with the room owner
 * (2026-08-14): BFF mirrors the main room's three-tier map structure
 * (training/classic/big — see core/bff/stadiums.js), not a flat two-map
 * split.
 */
module.exports = function createRoomSetup({
    room,
    state,
    bffTrainingMap,
    bffClassicMap,
    bffBigMap,
    classicScoreLimit,
    classicTimeLimit,
    bigScoreLimit,
    bigTimeLimit,
}) {
    // maxSide is the larger of the two teams' sizes (see matchFlow.js's
    // assignBalancedTeams — an odd headcount can leave one team one
    // player bigger). <=2 covers 1v1 and 2v2, matching the main room's
    // own classic-map cutoff (see team/balance.js's desiredStadiumFor).
    function applyLimitsForSize(maxSide) {
        const desired = maxSide <= 2 ? 'classic' : 'big';
        if (state.currentStadium !== desired) {
            room.setCustomStadium(desired === 'classic' ? bffClassicMap : bffBigMap);
            state.currentStadium = desired;
        }
        room.setScoreLimit(desired === 'classic' ? classicScoreLimit : bigScoreLimit);
        room.setTimeLimit(desired === 'classic' ? classicTimeLimit : bigTimeLimit);
    }

    // A lone player has no opponent to balance against — same bootstrap
    // case the main room handles (see team/balance.js's `players.length ==
    // 1` branch), just without needing instantRestart()/resetButton(),
    // since matchFlow.js's assembleMatch() places this player directly.
    // No score/time limit is set here, matching the main room's own
    // !training convention (nothing meaningful to limit while playing
    // solo).
    function applyTrainingMap() {
        if (state.currentStadium !== 'training') {
            room.setCustomStadium(bffTrainingMap);
            state.currentStadium = 'training';
        }
    }

    return {
        applyLimitsForSize,
        applyTrainingMap,
    };
};
