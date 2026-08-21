/*
 * Post-match analytics: pairwise head-to-head recording and room-wide
 * "best ever" record tracking (currently just win streak — see
 * db/sqlite.js's room_records table). Plain exported functions, not a
 * factory — no closure over `room`/`state`, everything comes in as an
 * argument, so entry.js's own endGame() (not independently testable —
 * it's the composition root, not an extracted core/ module) can call
 * these while the actual logic stays testable in isolation.
 */

// Records this match's outcome for every RED-vs-BLUE pairing — see
// db/sqlite.js's recordHeadToHead for why teammates never get a row
// (this only ever calls it with opposing-team pairs). `winner` is
// Team.RED/Team.BLUE/anything else (a draw) — a draw still records the
// pairing (last_played_at) without moving either side's win count.
async function recordHeadToHead(db, authArray, teamRed, teamBlue, winner, Team) {
    for (const red of teamRed) {
        for (const blue of teamBlue) {
            const authRed = authArray[red.id]?.[0];
            const authBlue = authArray[blue.id]?.[0];
            if (!authRed || !authBlue) continue;
            const winnerAuth = winner == Team.RED ? authRed : winner == Team.BLUE ? authBlue : null;
            await db.recordHeadToHead(authRed, authBlue, winnerAuth);
        }
    }
}

// Checks the current win streak against the persisted room record and,
// if it's a new high, overwrites it and announces — a live, unprompted
// "you just made history" moment (requested 2026-08-17), not a
// once-a-season stat line. Attributed to `captain` (the winning team's
// state.teamRed[0]/teamBlue[0]) rather than every player on the side —
// the streak belongs to a team color across however many different
// rosters carried it, not one individual. A no-op if `captain` is
// falsy (an empty/left-mid-match roster — shouldn't normally happen at
// this call site, kept defensive rather than assumed).
async function checkWinStreakRecord(db, room, HaxNotification, achievementColor, authArray, captain, streak, buildBox) {
    if (!captain) return;
    const record = await db.getRecord('winStreak');
    if (streak <= (record?.value ?? 0)) return;
    await db.setRecord('winStreak', streak, authArray[captain.id][0], captain.name);
    const lines = [`🚨 Новый рекорд комнаты! Серия побед подряд — ${streak} !`];
    if (record) {
        lines.push(`Прошлый рекорд: ${record.value} (держал(а) ${record.holderName})`);
    }
    room.sendAnnouncement(
        buildBox(lines),
        null,
        achievementColor,
        'bold',
        HaxNotification.MENTION
    );
}

module.exports = { recordHeadToHead, checkWinStreakRecord };
