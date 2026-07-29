/*
 * The !shop catalog — edit this array directly to add/remove/reprice items,
 * no logic changes needed (see core/economy.js for how it's used).
 *
 * Each item needs:
 *   id    — short, unique across ALL types (typed in chat: "!shop fire").
 *   type  — 'form' (a whole SIDE's kit, not per-player — see below),
 *           'size' (a brief disc radius bump on the SCORER only, the moment
 *           they score, via room.setPlayerDiscProperties — never a standing
 *           effect, see economy.js's playGoalSizeEffect), or 'goalAnimation'
 *           (a brief avatar flash on scoring a goal, via
 *           room.setPlayerAvatar). Both 'size' and 'goalAnimation' revert a
 *           few seconds later.
 *   name  — shown in !shop/!inventory.
 *   price — in coins.
 *   home/away — required for type: 'form'. Each is a full kit, passed
 *            straight through to room.setTeamColors(team, angle, textColor,
 *            colors):
 *              colors    — 1-3 ints, 0xRRGGBB (HaxBall's own stripe limit).
 *              textColor — 0xRRGGBB, the player-number color.
 *              angle     — stripe angle in degrees.
 *            A side's form is whichever item ITS captain (state.teamRed[0]/
 *            state.teamBlue[0]) has equipped — or, if the captain has none,
 *            a random pick among teammates who do (see economy.js's
 *            determineSideForm). Normally a side wears its form's `home`
 *            kit; if red and blue land on the SAME form, red keeps `home`
 *            and blue switches to `away` so they're never wearing identical
 *            colors.
 *   clashesWithDefault — optional, for type: 'form' only. 'red' or 'blue' if
 *            this form's `home` kit is close enough to that side's DEFAULT
 *            kit (see economy.js) to be hard to tell apart when the OTHER
 *            side has no form of its own active. When set, applyTeamForms()
 *            falls back to `away` for exactly that case, the same way it
 *            already does when both sides land on the same form.
 *   radius — required for type: 'size', UNLESS `upgradeable` is set (see
 *            below). Only ever applied for the few-second goal celebration
 *            window, never during actual play, precisely so this can't
 *            become a paid gameplay advantage — it's fine for these to be
 *            dramatic (small/huge) since it's purely a flex.
 *   avatar — required for type: 'goalAnimation'. A short string/emoji.
 *
 *   upgradeable — type: 'size' only. Marks a tiered item bought in place
 *            (!shop <id> again upgrades it, rather than "already owned")
 *            instead of a single flat purchase — see economy.js's
 *            priceForLevel/radiusForLevel and db/sqlite.js's
 *            getItemLevel/upgradeItem. Needs:
 *              baseRadius — the untouched default disc radius (15).
 *              direction  — +1 (bigger) or -1 (smaller) per level.
 *              stepRadius — radius change per level.
 *              maxLevel   — highest level sellable.
 *              basePrice  — cost of level 1.
 *              priceStep  — cost increase per level after that.
 *            Level N's price is basePrice + priceStep*(N-1); its radius is
 *            baseRadius + direction*stepRadius*N.
 */
module.exports = [
    {
        id: 'crimson', type: 'form', name: 'Багровый', price: 150, clashesWithDefault: 'red',
        home: { colors: [0xD60000, 0x8F1410, 0x750000], textColor: 0xffffff, angle: 60 },
        away: { colors: [0x4D4D4D, 0x383838, 0x242424], textColor: 0xD60000, angle: 60 },
    },
    {
        id: 'gold', type: 'form', name: 'Золотой', price: 300,
        home: { colors: [0xFFD700, 0xD9CA05, 0xCCB802], textColor: 0x000000, angle: 60 },
        away: { colors: [0x4D4D4D, 0x383838, 0x242424], textColor: 0xFFD700, angle: 60 },
    },
    {
        id: 'emerald', type: 'form', name: 'Изумрудный', price: 300,
        home: { colors: [0x50c878, 0x45AD68, 0x3D995C], textColor: 0xffffff, angle: 60 },
        away: { colors: [0x4D4D4D, 0x383838, 0x242424], textColor: 0x50c878, angle: 60 },
    },
    {
        id: 'violet', type: 'form', name: 'Фиолетовый', price: 450,
        home: { colors: [0x8a2be2, 0x7524BF, 0x561B8C], textColor: 0xffffff, angle: 60 },
        away: { colors: [0x4D4D4D, 0x383838, 0x242424], textColor: 0x8a2be2, angle: 60 },
    },

    {
        id: 'small', type: 'size', name: 'Малыш', upgradeable: true,
        baseRadius: 15, direction: -1, stepRadius: 2, maxLevel: 5,
        basePrice: 200, priceStep: 100,
    },
    {
        id: 'big', type: 'size', name: 'Здоровяк', upgradeable: true,
        baseRadius: 15, direction: 1, stepRadius: 2, maxLevel: 5,
        basePrice: 200, priceStep: 100,
    },

    { id: 'fire', type: 'goalAnimation', name: 'Огонь', price: 150, avatar: '🔥' },
    { id: 'star', type: 'goalAnimation', name: 'Звезда', price: 150, avatar: '⭐' },
    { id: 'skull', type: 'goalAnimation', name: 'Череп', price: 250, avatar: '💀' },
    { id: 'crown', type: 'goalAnimation', name: 'Корона', price: 400, avatar: '👑' },
];
