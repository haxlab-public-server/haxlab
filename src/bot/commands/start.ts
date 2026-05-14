import type { BotCommand } from '../types';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const command: BotCommand = {
  name: 'start',
  trigger: '!start',
  description: 'Начать игру',
  handle(ctx, player, _args) {
    try {
      ctx.room.startGame();
      ctx.room.sendAnnouncement('Игра запущена игроком ' + player.name);
    } catch (e: unknown) {
      ctx.room.sendAnnouncement('Не удалось запустить игру: ' + getErrorMessage(e));
    }
    return false;
  }
};

export default command;
