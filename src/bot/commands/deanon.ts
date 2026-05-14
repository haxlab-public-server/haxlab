import type { BotCommand, BotPlayer } from '../types';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const command: BotCommand = {
  name: 'deanon',
  trigger: '!deanon',
  description: 'Показать или задать деанон по auth',
  handle(ctx, player, args) {
    if (!args || args.length === 0) {
      ctx.room.sendAnnouncement('Использование: !deanon <@имя|id> [alias]\nПодсказка: используйте @ и выберите игрока из списка. Alias может задавать только админ.');
      return false;
    }

    // Find target player
    let query = args[0] || '';
    query = query.replace(/^[@#]+/, '').trim(); // поддержка @упоминаний и #ID
    const playerList = ctx.room.getPlayerList() as BotPlayer[];
    const target = playerList.find((p) => p.name.toLowerCase() === query.toLowerCase() || p.id === parseInt(query, 10));

    if (!target) {
      ctx.room.sendAnnouncement('Игрок не найден: ' + query);
      return false;
    }

    // Resolve target auth: use target.auth if present, else try DB by their name
    var targetAuth = target.auth;
    const isAdmin = player.admin === true;

    // Admin can set alias with second argument
    if (args.length >= 2) {
      if (!isAdmin) {
        ctx.room.sendAnnouncement('Только админ может задавать alias.');
        return false;
      }
      const alias = args.slice(1).join(' ');
      if (!alias || alias.length < 2) {
        ctx.room.sendAnnouncement('Alias слишком короткий.');
        return false;
      }

      void (async () => {
        try {
          const resolvedAuth = await ctx.db.resolveAuthForName(target.name);
          const auth = targetAuth || resolvedAuth;
          if (!auth) {
            ctx.room.sendAnnouncement('Невозможно задать alias: нет auth у цели. Войдите через Haxball или добавьте запись в БД.');
            return;
          }
          await ctx.db.setAlias(auth, alias);
          ctx.room.sendAnnouncement('Alias сохранен: ' + target.name + ' -> ' + alias);
        } catch (err: unknown) {
          ctx.logger.warn('setAlias error: ' + getErrorMessage(err));
          ctx.room.sendAnnouncement('Ошибка сохранения alias.');
        }
      })();
      return false;
    }

    // Otherwise just show alias if exists
    void (async () => {
      try {
        const resolvedAuth = targetAuth || target.auth || await ctx.db.resolveAuthForName(target.name);
        if (!resolvedAuth) {
          ctx.room.sendAnnouncement('Деанон недоступен: у игрока нет auth и запись по имени в БД не найдена.');
          return;
        }
        const row = await ctx.db.getAlias(resolvedAuth);
        if (row && row.alias) {
          ctx.room.sendAnnouncement('Деанон: ' + target.name + ' => ' + row.alias);
        } else {
          ctx.room.sendAnnouncement('Деанон не найден для ' + target.name);
        }
      } catch (err: unknown) {
        ctx.logger.warn('getAlias error: ' + getErrorMessage(err));
        ctx.room.sendAnnouncement('Ошибка поиска деанона.');
      }
    })();

    return false;
  }
};

export default command;
