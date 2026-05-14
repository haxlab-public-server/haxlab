import type { BotContext, BotJoinPlayer } from '../types';
import type { PlayerRole } from '../../db/Database';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (ctx: BotContext, player: BotJoinPlayer) {
  ctx.logger.info('onPlayerJoin: ' + player.name + ' (id=' + player.id + ', auth=' + player.auth + ')');
  
  let playerRole: PlayerRole = 'player';
  let match = null;
  if (player.auth) {
    match = ctx.adminList.find((admin) => admin.auth === player.auth);
  }
  if (!match) {
    match = ctx.adminList.find((admin) => (admin.name || '').toLowerCase() === (player.name || '').toLowerCase());
  }
  if (match) {
    playerRole = match.role || 'player';
    const roleLabel = match.role === 'host' ? 'Хост' : 'Админ';
    ctx.room.setPlayerAdmin(player.id, true);
    ctx.room.sendAnnouncement(roleLabel + ' ' + player.name + ' вошел в комнату', null, 0xFF0000, 'bold', 1);
    ctx.logger.info(roleLabel + ' rights granted to ' + player.name + ' (auth=' + (player.auth || 'none') + ')');
  }
  
  ctx.gameState.addPlayer(player.id, player.name);
  const state = ctx.gameState.getState();
  const size = state.gameSize;
  const totalPlayers = ctx.gameState.getTotalPlayers();

  if (player.auth) {
    ctx.db.registerPlayer(player.auth, player.name, playerRole).catch((err: unknown) => {
      ctx.logger.warn('registerPlayer failed: ' + getErrorMessage(err));
    });
  }
  
  const scores = ctx.room.getScores();
  if (scores) {
    ctx.room.sendAnnouncement('Привет, ' + player.name + '! Игра уже идет. Ждите следующего раунда.');
    try {
      ctx.auto.balanceTeams(ctx);
    } catch {}
    return;
  }
  
  ctx.room.sendAnnouncement('Привет, ' + player.name + '! Текущий размер матча: ' + size + 'x' + size + '. Игроков: ' + totalPlayers);
  ctx.logger.info('Player ' + player.name + ' assigned to game size ' + size + 'x' + size);

  if (player.auth) {
    ctx.db.getAlias(player.auth)
      .then((row) => {
        if (row && row.alias) {
          ctx.room.sendAnnouncement('Деанон: ' + player.name + ' => ' + row.alias);
        }
      })
      .catch((err: unknown) => {
        ctx.logger.warn('getAlias on join failed: ' + getErrorMessage(err));
      });
  }
  
  const requiredPlayers = size * 2;
  if (totalPlayers >= requiredPlayers && totalPlayers >= 2) {
    ctx.room.sendAnnouncement('Достаточно игроков (' + totalPlayers + '/' + requiredPlayers + '). Игра начинается через 3 секунды...');
    setTimeout(() => {
      try {
        const currentScores = ctx.room.getScores();
        if (!currentScores) {
          ctx.room.startGame();
          ctx.logger.info('Game auto-started with ' + totalPlayers + ' players');
        }
      } catch (e: unknown) {
        ctx.room.sendAnnouncement('Ошибка запуска: ' + getErrorMessage(e) + '. Используйте !start');
      }
    }, 3000);
  } else {
    ctx.room.sendAnnouncement('Ожидаем еще ' + (requiredPlayers - totalPlayers) + ' игрока(ов). Или используйте !start для старта.');
  }

  try {
    ctx.auto.balanceTeams(ctx);
  } catch {}
};
