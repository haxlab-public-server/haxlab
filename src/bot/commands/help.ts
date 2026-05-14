import type { BotCommand } from '../types';

const command: BotCommand = {
  name: 'help',
  trigger: '!help',
  description: 'Показать список команд',
  handle(ctx, player, _args) {
    ctx.room.sendAnnouncement('Команды: !help, !start, !rr, !afk, !stats, !deanon, !status\nПодсказка: для !deanon используйте @имя или #id (например: !deanon @ник, !deanon #2)', player.id, 0x00FF00, 'normal', 0);
    return false; // cancel echo
  }
};

export default command;
