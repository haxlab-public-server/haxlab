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
 *   clashesWith — optional, for type: 'form' only. Array of other form ids
 *            this one's `home` kit is close enough to that the two read as
 *            near-identical when they land on OPPOSING sides (unlike
 *            clashesWithDefault, this is form-vs-form, not form-vs-the-
 *            room's-own-default-kit). Only needs to be listed on ONE of the
 *            pair — economy.js's formsClash checks both directions. When
 *            two different forms flagged this way both end up active, the
 *            LOWER-priority one (see economy.js's formPriority: vipOnly >
 *            current-season > retired; an exact-tier tie defaults to red
 *            keeping home) switches to its `away` kit — e.g. 'black' vs
 *            'vip-kvadrat' below (both read as near-black), or a retired
 *            form that happens to resemble a current one. Two different
 *            forms NOT flagged this way both just wear home normally, even
 *            if one is retired and the other current — deferring to away is
 *            only ever about an ACTUAL clash, never automatic.
 *   vipOnly — optional, for type: 'form' only. Only VIP+ can !shop/!equip
 *            it — unlike goalAnimation's access gate, there's no coin-bought
 *            bypass for a non-VIP here, it's permanently VIP-exclusive.
 *            Re-checked live in determineSideForm (economy.js) every time a
 *            side's kit is (re)computed, not just at equip time — a VIP form
 *            stops being worn the moment the wearer's VIP itself lapses,
 *            with no need to re-equip anything. A vipOnly form also outranks
 *            a non-VIP captain's own equipped form for who a side's kit
 *            comes from (see determineSideForm) — if more than one VIP on
 *            the same side has one equipped, one is picked at random among
 *            them, same tie-break as the existing non-VIP "captain has none,
 *            random pick among teammates who do" rule.
 *   radius — required for type: 'size', UNLESS `upgradeable` is set (see
 *            below). Only ever applied for the few-second goal celebration
 *            window, never during actual play, precisely so this can't
 *            become a paid gameplay advantage — it's fine for these to be
 *            dramatic (small/huge) since it's purely a flex.
 *   avatar — required for type: 'goalAnimation', UNLESS `smokeColor` is set
 *            (see below) — the two are mutually exclusive celebration kinds
 *            within the same 'goalAnimation' slot.
 *   smokeColor — type: 'goalAnimation' only, instead of `avatar`. A "smoke
 *            burst" celebration — 7 helper discs animate a puff of color at
 *            the goal that was just scored into (see smokeAnimation.js),
 *            rather than a simple avatar swap. Value is one of
 *            smokeAnimation.js's SMOKE_COLORS keys ('blue'/'red'/'purple'/
 *            'white'). Only actually plays on classic/big (see
 *            smokeAnimation.js's SMOKE_DISC_START_INDEX) — silently does
 *            nothing on any other/future stadium that hasn't been given the
 *            extra helper discs it needs.
 *            The 4 real smoke-color items (ids smoke-blue/red/purple/white)
 *            are `hidden` (see below) — !shop only ever shows the single
 *            `smokeFamily` bundle entry ('smoke'). Buying that bundle grants
 *            every real color at once (economy.js's shopCommand), and
 *            !equip is which now-owned color is actually worn — e.g.
 *            "!equip smoke-red". The bundle id itself is never recorded as
 *            owned/equippable; ownership is always checked via any one real
 *            color (see economy.js's ownsSmokeFamily).
 *   fireworks — type: 'goalAnimation' only, instead of `avatar`/`smokeColor`.
 *            A one-shot explosion burst (see fireworksAnimation.js) reusing
 *            the exact same 7 helper discs as smokeColor — set to `true`,
 *            single fixed palette, no color variants.
 *
 * type: 'goalAnimation' splits into two access tiers (see economy.js's
 * isBigGoalAnimation/hasBigAnimationAccess):
 *   - Plain avatar flashes (`avatar` set — fire/star/skull/crown) are
 *     ordinary coin-shop cosmetics, open to every player — no VIP or
 *     unlock prerequisite at all, same as a 'form'/'size' item.
 *   - The bigger disc-based ones (`smokeColor`/`smokeFamily`/`fireworks`
 *     set) are a VIP perk: free to use for any CURRENT VIP+ without owning
 *     anything, re-checked live every goal (a lapsed VIP simply stops
 *     seeing it fire, no re-equip needed) — or usable by anyone, VIP or
 *     not, who's bought that specific item outright (50000 coins each),
 *     which then never expires.
 *
 *   smokeFamily — type: 'goalAnimation' only, on the single 'smoke' catalog
 *            entry. Marks it as a bundle purchase: buying it charges once
 *            and grants every real smokeColor item (see above) instead of
 *            being equippable itself.
 *   hidden — optional, any type. Excluded from the browsable !shop catalog
 *            listing (still fully ownable/equippable/shown in !inventory by
 *            id) — used for the 4 real smoke colors now that 'smoke' is the
 *            single catalog entry for the whole family.
 *   retired — optional, any type. A past season's item, kept in this array
 *            FOREVER (never delete a retired entry — see below) purely so
 *            existing owners keep it: `hidden`-like (excluded from the
 *            browsable !shop listing) PLUS actively blocked from ever being
 *            bought again by anyone, owner or not (see economy.js's
 *            shopCommand). Fully unaffected everywhere else — still shown in
 *            !inventory, still !equip-able, still worn in matches exactly
 *            like any current item, forever. Only the id has to survive; the
 *            name/price/colors of a retired entry are never read by
 *            anything except display, so they're safe to leave as-is.
 *            type: 'form' only — current-season forms outrank a retired one
 *            WITHIN a side: determineSideForm picks a retired form for a
 *            side ONLY if nobody on it has a current one equipped, even over
 *            that side's own captain's retired pick. Between OPPOSING sides,
 *            a retired form only defers to a current one's away kit if the
 *            two are actually flagged as clashing (see `clashesWith` above)
 *            — otherwise both just wear home normally.
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
    // clashesWith: 'vip-kvadrat' — its near-black home kit reads as the same
    // color as this one from a distance (see below).
    {
        id: 'black', type: 'form', name: 'Черный', price: 1000, clashesWithDefault: 'red', clashesWith: ['vip-kvadrat'],
        home: { colors: [0x000000], textColor: 0xffffff, angle: 0 },
        away: { colors: [0xFFFFFF], textColor: 0x000000, angle: 0 },
    },
    {
        id: 'white', type: 'form', name: 'Белый', price: 1000,
        home: { colors: [0xFFFFFF], textColor: 0x000000, angle: 0 },
        away: { colors: [0x000000], textColor: 0xffffff, angle: 0 },
    },
    {
        id: 'ametist', type: 'form', name: 'Аметистовый', price: 1000,
        home: { colors: [0xFF05EE], textColor: 0x00FFFF, angle: 90 },
        away: { colors: [0x03F7FF], textColor: 0xF700FF, angle: 90 },
    },
    {
        id: 'traffic', type: 'form', name: 'Трафик', price: 1000, clashesWithDefault: 'blue',
        home: { colors: [0x1D0DFF], textColor: 0x00FF11, angle: 60 },
        away: { colors: [0x00FF3C], textColor: 0x0800FF, angle: 60 },
    },

    // price: 0 — vipOnly forms are a perk of being VIP, not a separate coin
    // purchase on top of it (the role gate in economy.js's shopCommand is
    // what actually restricts these, not the price).
    {
        id: 'vip-gucci', type: 'form', name: 'VIP Gucci', price: 0, vipOnly: true,
        home: { colors: [0x0A6A56, 0xA82B11, 0x0A6A56], textColor: 0xBDB104, angle: 0 },
        away: { colors: [0xBFA793, 0x836239, 0xBFA793], textColor: 0xFFFFFF, angle: 0 },
    },
    {
        id: 'vip-kvadrat', type: 'form', name: 'VIP Квадрат', price: 0, vipOnly: true,
        home: { colors: [0x21232B, 0x272A33, 0x2B2E38], textColor: 0xFCA3FF, angle: 60 },
        away: { colors: [0x7209b7, 0xb5179e, 0xf72585], textColor: 0xFFFFFF, angle: 60 },
    },

    // Retired (see `retired` above) — past seasons' forms, kept here forever
    // so existing owners keep wearing them, but nobody can buy them again.
    // Never delete these entries or existing owners lose access outright.
    {
        id: 'crimson', type: 'form', name: 'Багровый', price: 150, clashesWithDefault: 'red', retired: true,
        home: { colors: [0xD60000, 0x8F1410, 0x750000], textColor: 0xffffff, angle: 60 },
        away: { colors: [0x4D4D4D, 0x383838, 0x242424], textColor: 0xD60000, angle: 60 },
    },
    {
        id: 'gold', type: 'form', name: 'Золотой', price: 300, retired: true,
        home: { colors: [0xFFD700, 0xD9CA05, 0xCCB802], textColor: 0x000000, angle: 60 },
        away: { colors: [0x4D4D4D, 0x383838, 0x242424], textColor: 0xFFD700, angle: 60 },
    },
    {
        id: 'emerald', type: 'form', name: 'Изумрудный', price: 300, retired: true,
        home: { colors: [0x50c878, 0x45AD68, 0x3D995C], textColor: 0xffffff, angle: 60 },
        away: { colors: [0x4D4D4D, 0x383838, 0x242424], textColor: 0x50c878, angle: 60 },
    },
    {
        id: 'violet', type: 'form', name: 'Фиолетовый', price: 450, retired: true,
        home: { colors: [0x8a2be2, 0x7524BF, 0x561B8C], textColor: 0xffffff, angle: 60 },
        away: { colors: [0x4D4D4D, 0x383838, 0x242424], textColor: 0x8a2be2, angle: 60 },
    },

    {
        id: 'small', type: 'size', name: 'Малыш', upgradeable: true,
        baseRadius: 15, direction: -1, stepRadius: 1, maxLevel: 10,
        basePrice: 1000, priceStep: 1000,
    },
    {
        id: 'big', type: 'size', name: 'Здоровяк', upgradeable: true,
        baseRadius: 15, direction: 1, stepRadius: 1, maxLevel: 10,
        basePrice: 1000, priceStep: 1000,
    },

    { id: 'fire', type: 'goalAnimation', name: 'Огонь', price: 150, avatar: '🔥' },
    { id: 'star', type: 'goalAnimation', name: 'Звезда', price: 150, avatar: '⭐' },
    { id: 'skull', type: 'goalAnimation', name: 'Череп', price: 250, avatar: '💀' },
    { id: 'crown', type: 'goalAnimation', name: 'Корона', price: 400, avatar: '👑' },

    // 'smoke' is the single catalog entry (!shop smoke) — buying it grants
    // all 4 real colors below at once (see economy.js's shopCommand) and
    // also unlocks goalAnimation access for a non-VIP. The colors themselves
    // are `hidden` (not shown in !shop), picked between via !equip once
    // owned — e.g. "!equip smoke-red".
    { id: 'smoke', type: 'goalAnimation', name: 'Дым', price: 50000, smokeFamily: true },
    { id: 'smoke-blue', type: 'goalAnimation', name: 'Дым (синий)', price: 50000, smokeColor: 'blue', hidden: true },
    { id: 'smoke-red', type: 'goalAnimation', name: 'Дым (красный)', price: 50000, smokeColor: 'red', hidden: true },
    { id: 'smoke-purple', type: 'goalAnimation', name: 'Дым (фиолетовый)', price: 50000, smokeColor: 'purple', hidden: true },
    { id: 'smoke-white', type: 'goalAnimation', name: 'Дым (белый)', price: 50000, smokeColor: 'white', hidden: true },

    { id: 'fireworks', type: 'goalAnimation', name: 'Фейерверк', price: 50000, fireworks: true },
];
