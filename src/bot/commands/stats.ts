import type { BotCommand } from '../types';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const command: BotCommand = {
  name: 'stats',
  trigger: '!stats',
  description: 'Показать вашу статистику (игры/победы/ничьи/поражения)',
  handle(ctx, player, _args) {
    void (async () => {
      try {
        const resolvedAuth = player.auth ?? await ctx.db.resolveAuthForName(player.name);
        if (!resolvedAuth) {
          ctx.room.sendAnnouncement('Стата недоступна: требуется вход через Haxball (auth) или запись по имени в БД.');
          return;
        }
        const stat = await ctx.db.loadStats(resolvedAuth);
        if (!stat) {
          ctx.room.sendAnnouncement('Нет записей. Сыграй матч, чтобы появилась статистика.');
          return;
        }
        const games = stat.games || 0;
        const wins = stat.wins || 0;
        const draws = stat.draws || 0;
        const losses = stat.losses || 0;
        const winrate = games > 0 ? ((wins / games) * 100).toFixed(1) + '%' : '0%';
        ctx.room.sendAnnouncement(
          player.name + ': ' +
          'Игры ' + games + ', ' +
          'Победы ' + wins + ', ' +
          'Ничьи ' + draws + ', ' +
          'Поражения ' + losses + ', ' +
          'Winrate ' + winrate
        );
      } catch (err: unknown) {
        ctx.logger.warn('loadStats error: ' + getErrorMessage(err));
        ctx.room.sendAnnouncement('Ошибка загрузки статистики.');
      }
    })();

    return false; // prevent echo
  }
};

export default command;
