import type { BotContext, BotPlayer } from '../types';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (ctx: BotContext) {
  const state = ctx.gameState.getState();
  const winnerTeam = state.winnerTeam; // 1, 2 or null
  const players = ctx.room.getPlayerList().map((p: BotPlayer) => {
    return { id: p.id, name: p.name, auth: p.auth, team: p.team };
  });

  // Persist stats via bridge if available
  try {
    ctx.db.saveStats({ winnerTeam: winnerTeam, players: players }).catch((err: unknown) => {
      ctx.logger.warn('saveStats failed: ' + getErrorMessage(err));
    });
  } catch (err: unknown) {
    ctx.logger.warn('saveStats failed: ' + getErrorMessage(err));
  }

  ctx.gameState.resetGame();
  const nextState = ctx.gameState.getState();
  const size = nextState.gameSize;
  ctx.room.sendAnnouncement('Матч завершен! Следующий размер: ' + size + 'x' + size + '.');

  try {
    ctx.auto.applyWinstayAndStart(ctx, winnerTeam);
  } catch (e: unknown) {
    ctx.logger.warn('applyWinstayAndStart failed: ' + getErrorMessage(e));
  }
};
