import type { BotCommand, BotContext, BotPlayer } from '../types';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (ctx: BotContext, player: BotPlayer, message: string, commands: BotCommand[]) {
  const m = (message || '').trim();

  try {
    if (ctx.gameState.isChooseMode()) {
      const consumed = ctx.auto.handleChooseModeMessage(ctx, player, m);
      if (consumed) return false;
    }
  } catch {}

  if (m.startsWith('!')) {
    // Simple per-player rate limiting: 1 command per 2s, max 5 per minute
    const now = Date.now();
    if (!ctx.rateLimit) ctx.rateLimit = {};
    const rl = ctx.rateLimit[player.id] || { last: 0, windowStart: now, count: 0 };
    // minute window handling
    if (now - rl.windowStart > 60000) {
      rl.windowStart = now;
      rl.count = 0;
    }
    // frequency check
    if (now - rl.last < 2000) {
      ctx.room.sendAnnouncement('Слишком часто. Подожди пару секунд.', player.id, 0xFFFF00, 'normal', 0);
      ctx.rateLimit[player.id] = rl;
      return false;
    }
    if (rl.count >= 5) {
      ctx.room.sendAnnouncement('Слишком много команд. Подождите минуту.', player.id, 0xFF6600, 'normal', 0);
      ctx.rateLimit[player.id] = rl;
      return false;
    }
    rl.last = now;
    rl.count++;
    ctx.rateLimit[player.id] = rl;

    const parts = m.split(/\s+/);
    const name = parts[0];
    const args = parts.slice(1);

    const cmd = commands.find((c) => c.trigger === name);
    if (!cmd) {
      const list = commands.map((c) => c.trigger).join(', ');
      ctx.room.sendAnnouncement('Неизвестная команда. Доступно: ' + list, player.id, 0xFFFF00, 'normal', 0);
      return false; // do not echo unknown command
    }

    try {
      const result = cmd.handle(ctx, player, args);
      // If handler explicitly returns true, allow; otherwise swallow
      return result === true ? true : false;
    } catch (e: unknown) {
      const list = commands.map((c) => c.trigger).join(', ');
      ctx.room.sendAnnouncement('Ошибка или неверные аргументы. Команды: ' + list, player.id, 0xFF6600, 'bold', 0);
      ctx.logger.warn('Command error ' + name + ': ' + getErrorMessage(e));
      return false;
    }
  }

  if (ctx.captainDraft.isDraftActive()) {
    const currentCaptain = ctx.captainDraft.getCurrentCaptain();
    if (player.id === currentCaptain.id) {
      // Try to parse as player number
      const playerNum = parseInt(m, 10);
      if (!isNaN(playerNum)) {
        const result = ctx.captainDraft.pickPlayer(playerNum);
        ctx.room.sendAnnouncement(result.message);
        
        if (result.complete) {
          const rosters = ctx.captainDraft.getTeamRosters();
          // Assign teams from draft result
          const team1 = rosters.team1;
          const team2 = rosters.team2;
          
          // Set team for each player using room API
          team1.forEach((p) => {
            if (p.id !== undefined) {
              ctx.room.setPlayerTeam(p.id, 1);
            }
          });
          team2.forEach((p) => {
            if (p.id !== undefined) {
              ctx.room.setPlayerTeam(p.id, 2);
            }
          });
          
          ctx.room.sendAnnouncement('Драфт завершен! Команды готовы.');
          ctx.room.startGame();
        } else {
          const nextCaptain = ctx.captainDraft.getCurrentCaptain();
          const availableList = ctx.captainDraft.getRosteredList();
          if (availableList) {
            ctx.room.sendAnnouncement('Капитан ' + nextCaptain.name + ', твой ход:\n' + availableList);
          }
        }
        return false; // don't echo
      }
    }
  }

  return true; // let chat pass through
};
