import type { BotContext, PlayingTeam, TouchPlayer } from '../types';

export default function (ctx: BotContext, team: PlayingTeam) {
  if (!ctx.gameState) return;
  ctx.gameState.setWinnerTeam(team);

  let scorer: TouchPlayer | null = null;
  let assist: TouchPlayer | null = null;
  var ownGoal = false;
  const t: [typeof ctx.touches.lastTouches[0], typeof ctx.touches.lastTouches[1]] = ctx.touches?.lastTouches ?? [null, null];

  if (t[0]) {
    if (t[0].player.team === team) {
      scorer = t[0].player;
      if (t[1] && t[1].player.team === team && t[1].player.id !== scorer.id) {
        assist = t[1].player;
      }
    } else {
      scorer = t[0].player;
      ownGoal = true;
    }
  }

  const teamName = team === 1 ? 'Красные' : 'Синие';
  var msg;
  if (scorer && !ownGoal) {
    if (assist) {
      msg = '⚽ Гол за ' + teamName + '! Забил ' + scorer.name + ', ассист ' + assist.name + '.';
    } else {
      msg = '⚽ Гол за ' + teamName + '! Забил ' + scorer.name + '.';
    }
  } else if (ownGoal) {
    msg = '😂 Автогол! ' + scorer.name + ' отправил мяч в свои ворота.';
  } else {
    msg = '⚽ Гол за ' + teamName + '!';
  }

  ctx.room.sendAnnouncement(msg);
};
