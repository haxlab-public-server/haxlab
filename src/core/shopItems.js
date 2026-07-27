/*
 * The !shop catalog — edit this array directly to add/remove/reprice items,
 * no logic changes needed (see core/economy.js for how it's used).
 *
 * Each item needs:
 *   id    — short, unique across ALL types (typed in chat: "!shop fire").
 *   type  — 'form' (disc color, applied via room.setPlayerDiscProperties),
 *           'size' (disc radius, same API — see the note below), or
 *           'goalAnimation' (a brief avatar flash on scoring a goal, via
 *           room.setPlayerAvatar — reverted a few seconds later).
 *   name  — shown in !shop/!inventory.
 *   price — in coins.
 *   color — required for type: 'form'. A 0xRRGGBB disc color.
 *   radius — required for type: 'size'. HaxBall's default player radius is
 *            15 — keep these within shouting distance of that (this isn't
 *            just cosmetic, it's the real physics collision radius, so a
 *            wildly bigger/smaller disc is a genuine gameplay advantage, not
 *            just a look).
 *   avatar — required for type: 'goalAnimation'. A short string/emoji.
 */
module.exports = [
    { id: 'crimson', type: 'form', name: 'Багровый', price: 150, color: 0xdc143c },
    { id: 'gold', type: 'form', name: 'Золотой', price: 300, color: 0xffd700 },
    { id: 'emerald', type: 'form', name: 'Изумрудный', price: 300, color: 0x50c878 },
    { id: 'violet', type: 'form', name: 'Фиолетовый', price: 450, color: 0x8a2be2 },

    { id: 'small', type: 'size', name: 'Малыш', price: 300, radius: 12 },
    { id: 'big', type: 'size', name: 'Здоровяк', price: 300, radius: 18 },

    { id: 'fire', type: 'goalAnimation', name: 'Огонь', price: 150, avatar: '🔥' },
    { id: 'star', type: 'goalAnimation', name: 'Звезда', price: 150, avatar: '⭐' },
    { id: 'skull', type: 'goalAnimation', name: 'Череп', price: 250, avatar: '💀' },
    { id: 'crown', type: 'goalAnimation', name: 'Корона', price: 400, avatar: '👑' },
];
