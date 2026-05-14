import type { BotContext } from '../types';

export default function (ctx: BotContext) {
  ctx.logger.info('onGameStart triggered');
  
  ctx.gameState.setGameInProgress(true);
  
  const totalPlayers = ctx.gameState.getTotalPlayers();
  try { ctx.auto.setStadiumForPlayers(ctx, totalPlayers); } catch {}
  
  // Draft mode only for 9+ players
  if (totalPlayers >= 9) {
    const captains = ctx.gameState.getCaptains();
    if (!captains.team1Captain || !captains.team2Captain) {
      ctx.logger.warn('Captains not assigned yet');
      return;
    }

    ctx.logger.info('Starting draft with captains: ' + captains.team1Captain.name + ' vs ' + captains.team2Captain.name);

    ctx.captainDraft.startDraft(
      Object.values(ctx.gameState.getState().playerList),
      captains.team1Captain.id,
      captains.team2Captain.id,
      ctx.gameState.getState().players
    );

    // Assign captains to teams
    ctx.room.setPlayerTeam(captains.team1Captain.id, 1);
    ctx.room.setPlayerTeam(captains.team2Captain.id, 2);

    const availableList = ctx.captainDraft.getRosteredList();
    const currentCaptain = ctx.captainDraft.getCurrentCaptain();

    ctx.room.sendAnnouncement('=== ДРАФТ НАЧАЛАСЬ ===', null, 0xFFFF00, 'bold', 2);
    ctx.room.sendAnnouncement('Капитан ' + currentCaptain.name + ', выбери игроков (1, 2, 3...):\n' + availableList);
    
    ctx.logger.info('Draft started, available players: ' + availableList);
  } else {
    ctx.logger.info('Simple mode - auto-assigning teams for ' + totalPlayers + ' players');
    
    ctx.gameState.simpleAssignTeams();
    const state = ctx.gameState.getState();
    
    // Apply team assignments via room API
    Object.keys(state.players).forEach((playerId) => {
      const player = state.players[playerId];
      if (player.team !== null && player.team !== undefined) {
        ctx.room.setPlayerTeam(parseInt(playerId, 10), player.team);
      }
    });
    
    const size = state.gameSize;
    ctx.room.sendAnnouncement('Игра ' + size + 'x' + size + ' начинается!', null, 0x00FF00, 'bold', 1);
  }
};
