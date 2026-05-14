import type { BotContext, BotPlayer } from '../types';

export default function (ctx: BotContext, player: BotPlayer) {
  if (!ctx.touches) ctx.touches = { lastTouches: [null, null], lastTeamTouched: 0 };
  var lt = ctx.touches.lastTouches;

  if (!lt[0] || lt[0].player.id !== player.id) {
    lt[1] = lt[0] || null;
    lt[0] = { player: { id: player.id, name: player.name, team: player.team }, time: Date.now() };
  }
  ctx.touches.lastTeamTouched = player.team;
};
