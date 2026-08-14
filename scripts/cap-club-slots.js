/*
 * One-off migration: clubs are now capped at CLUB_MAX_SLOTS (10, see
 * commands/club.js). Two independent things to fix per club, since a club
 * could be over on either without being over on the other:
 *
 * 1. slots > 10 — refunds whatever the owner paid for any slots bought
 *    PAST the cap (same cost formula clubSlotsCommand's own nextSlotCost
 *    uses: 500 for the first slot bought past the 5 base ones, +100 per
 *    slot since), then clamps slots down to 10.
 * 2. actual membership > 10 — confirmed 2026-08-14 ("может выгоним
 *    последних кто зашел?"): trims the roster itself, not just the slot
 *    count. Keeps the owner (always — a club can't lose its owner without
 *    being disbanded) plus the OLDEST 9 other members by join date
 *    (club_members.joined_at), removes everyone newer than that. A removed
 *    assistant is cleared too, so club.assistantAuth never dangles.
 *    Removed members are NOT refunded anything — joining a club has never
 *    cost the joining player coins (only slot purchases, paid by the
 *    owner, do), so there's nothing to give back here.
 *
 * Safe to re-run: a club already within both limits is skipped entirely on
 * both counts, so running this twice never double-refunds or removes
 * anyone twice.
 *
 * Usage: node scripts/cap-club-slots.js
 */
const { createDatabaseApi } = require('../api/database');

const CLUB_BASE_SLOTS = 5;
const CLUB_SLOT_BASE_COST = 500;
const CLUB_SLOT_COST_STEP = 100;
const CLUB_MAX_SLOTS = 10;

function refundForExcessSlots(currentSlots) {
    let refund = 0;
    for (let slotsBefore = CLUB_MAX_SLOTS; slotsBefore < currentSlots; slotsBefore++) {
        refund += CLUB_SLOT_BASE_COST + CLUB_SLOT_COST_STEP * (slotsBefore - CLUB_BASE_SLOTS);
    }
    return refund;
}

const db = createDatabaseApi();
db.init();

const clubs = db.getAllClubs();
let slotsFixed = 0;
let membersRemoved = 0;

for (const club of clubs) {
    if (club.slots > CLUB_MAX_SLOTS) {
        const refund = refundForExcessSlots(club.slots);
        db.addCoins(club.ownerAuth, '', refund);
        db.setClubSlots(club.id, CLUB_MAX_SLOTS);
        console.log(`"${club.name}" (id ${club.id}): ${club.slots} -> ${CLUB_MAX_SLOTS} slots, refunded ${refund} coins to owner ${club.ownerAuth}.`);
        slotsFixed++;
    }

    const members = db.getClubMembers(club.id); // oldest-first (joined_at ASC)
    if (members.length > CLUB_MAX_SLOTS) {
        const nonOwnerOldestFirst = members.filter((m) => m.auth !== club.ownerAuth);
        const keep = new Set([club.ownerAuth, ...nonOwnerOldestFirst.slice(0, CLUB_MAX_SLOTS - 1).map((m) => m.auth)]);
        const toRemove = members.filter((m) => !keep.has(m.auth));
        for (const m of toRemove) {
            db.removeClubMember(m.auth);
            if (club.assistantAuth === m.auth) db.setClubAssistant(club.id, null);
            console.log(`  removed ${m.playerName} (${m.auth}) from "${club.name}" — joined ${m.joinedAt}, past the new ${CLUB_MAX_SLOTS}-member cap.`);
            membersRemoved++;
        }
    }
}

if (slotsFixed === 0 && membersRemoved === 0) {
    console.log('No clubs over the new cap on slots or membership — nothing to do.');
} else {
    console.log(`Done. ${slotsFixed} club(s) had slots clamped/refunded, ${membersRemoved} member(s) removed for being over the membership cap.`);
}

db.close();
