/*
 * The !shop catalog — edit this array directly to add/remove/reprice items,
 * no logic changes needed (see core/economy.js for how it's used).
 *
 * Each item needs:
 *   id    — short, unique across ALL types (typed in chat: "!shop fire").
 *   type  — 'form' (a whole SIDE's disc color, not per-player — see below),
 *           'size' (a brief disc radius bump on the SCORER only, the moment
 *           they score, via room.setPlayerDiscProperties — never a standing
 *           effect, see economy.js's playGoalSizeEffect), or 'goalAnimation'
 *           (a brief avatar flash on scoring a goal, via
 *           room.setPlayerAvatar). Both 'size' and 'goalAnimation' revert a
 *           few seconds later.
 *   name  — shown in !shop/!inventory.
 *   price — in coins.
 *   homeColor/awayColor — required for type: 'form'. 0xRRGGBB disc colors.
 *            A side's form is whichever item ITS captain (state.teamRed[0]/
 *            state.teamBlue[0]) has equipped — or, if the captain has none,
 *            a random pick among teammates who do (see economy.js's
 *            determineSideForm). Normally a side wears its form's homeColor;
 *            if red and blue land on the SAME form, red keeps homeColor and
 *            blue switches to awayColor so they're never wearing an
 *            identical color.
 *   radius — required for type: 'size'. Only ever applied for the few-second
 *            goal celebration window, never during actual play, precisely so
 *            this can't become a paid gameplay advantage — it's fine for
 *            these to be dramatic (small/huge) since it's purely a flex.
 *   avatar — required for type: 'goalAnimation'. A short string/emoji.
 */
module.exports = [
    { id: 'crimson', type: 'form', name: 'Багровый', price: 150, homeColor: 0xdc143c, awayColor: 0xffffff },
    { id: 'gold', type: 'form', name: 'Золотой', price: 300, homeColor: 0xffd700, awayColor: 0x1a1a1a },
    { id: 'emerald', type: 'form', name: 'Изумрудный', price: 300, homeColor: 0x50c878, awayColor: 0xffffff },
    { id: 'violet', type: 'form', name: 'Фиолетовый', price: 450, homeColor: 0x8a2be2, awayColor: 0xffd700 },

    { id: 'small', type: 'size', name: 'Малыш', price: 200, radius: 8 },
    { id: 'big', type: 'size', name: 'Здоровяк', price: 200, radius: 20 },

    { id: 'fire', type: 'goalAnimation', name: 'Огонь', price: 150, avatar: '🔥' },
    { id: 'star', type: 'goalAnimation', name: 'Звезда', price: 150, avatar: '⭐' },
    { id: 'skull', type: 'goalAnimation', name: 'Череп', price: 250, avatar: '💀' },
    { id: 'crown', type: 'goalAnimation', name: 'Корона', price: 400, avatar: '👑' },
];
