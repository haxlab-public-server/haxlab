import type { BotCommand } from '../types';

const command: BotCommand = {
  name: 'status',
  trigger: '!status',
  description: 'Показать состояние комнаты (админ)',
  handle(ctx, player, _args) {
    // Admin check
    var isAdmin = ctx.room.getPlayerList().some((p) => p.id === player.id && p.admin === true);
    if (!isAdmin) {
      ctx.room.sendAnnouncement('Команда доступна только админам', player.id);
      return false;
    }

    var state = ctx.gameState.getState();
    var players = ctx.room.getPlayerList() || [];
    var totalPlayers = players.length;
    var gameSize = state.gameSize;
    var inProgress = state.gameInProgress ? 'да' : 'нет';
    var draftActive = ctx.captainDraft.isDraftActive() ? 'да' : 'нет';
    var afkCount = 0;
    if (state.players) {
      afkCount = Object.values(state.players).filter((p: { afk?: boolean }) => p.afk === true).length;
    }

    var msg = [
      'Игроков: ' + totalPlayers,
      'Размер: ' + gameSize + 'x' + gameSize,
      'Игра идет: ' + inProgress,
      'Драфт: ' + draftActive,
      'AFK: ' + afkCount,
      'БД: ok'
    ].join(' | ');

    ctx.room.sendAnnouncement(msg, player.id, 0x00FF00, 'normal', 0);
    return false;
  }
};

export default command;
