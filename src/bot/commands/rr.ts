import type { BotCommand } from '../types';

const command: BotCommand = {
  name: 'restart',
  trigger: '!rr',
  description: 'Перезапуск матча',
  handle(ctx, player, _args) {
    try { ctx.room.stopGame(); } catch {}
    ctx.room.startGame();
    ctx.room.sendAnnouncement('Перезапуск матча инициирован ' + player.name + '.');
    return false; // cancel echo
  }
};

export default command;
