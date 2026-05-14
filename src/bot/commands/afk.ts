import type { BotCommand } from '../types';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const command: BotCommand = {
  name: 'afk',
  trigger: '!afk',
  description: 'Отметиться AFK: кик через 30 минут, если не вернулся',
  handle(ctx, player, _args) {
    if (ctx.afkTimers[player.id]) {
      clearTimeout(ctx.afkTimers[player.id]);
      delete ctx.afkTimers[player.id];
      ctx.gameState.setAFK(player.id, false);
      if (ctx.captainDraft.isDraftActive()) {
        const state = ctx.gameState.getState();
        const playerMapEntry = state.players ? state.players[player.id] : null;
        ctx.captainDraft.addToAvailable(playerMapEntry || { id: player.id, name: player.name, team: player.team, afk: false });
      }
      ctx.room.setPlayerTeam(player.id, 0);
      ctx.room.sendAnnouncement(player.name + ' вернулся из AFK');
      ctx.logger.info('AFK cleared for ' + player.name + ' (id=' + player.id + ')');
      return false;
    }

    const timeoutMs = 30 * 60 * 1000;
    ctx.afkTimers[player.id] = setTimeout(() => {
      if (ctx.afkTimers[player.id]) {
        delete ctx.afkTimers[player.id];
        try {
          ctx.room.kickPlayer(player.id, 'AFK 30 минут', false);
          ctx.room.sendAnnouncement(player.name + ' кикнут за AFK 30 минут', null, 0xFF6600, 'bold', 1);
          ctx.logger.info('AFK kick: ' + player.name + ' (id=' + player.id + ')');
        } catch (e: unknown) {
          ctx.logger.warn('AFK kick failed: ' + getErrorMessage(e));
        }
      }
    }, timeoutMs);
    ctx.gameState.setAFK(player.id, true);
    if (ctx.captainDraft.isDraftActive()) {
      ctx.captainDraft.removeFromAvailable(player.id);
    }
    ctx.room.setPlayerTeam(player.id, 0);
    ctx.room.sendAnnouncement(player.name + ' ушел в AFK. Автокик через 30 минут. Повтори !afk чтобы вернуться.');
    ctx.logger.info('AFK set for ' + player.name + ' (id=' + player.id + ')');
    return false;
  }
};

export default command;
