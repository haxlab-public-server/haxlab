import type { BotContext } from '../types';

export default function (ctx: BotContext, player: PlayerObject) {
  ctx.gameState.removePlayer(player.id);
  const totalPlayers = ctx.gameState.getTotalPlayers();

  if (ctx.afkTimers[player.id]) {
    clearTimeout(ctx.afkTimers[player.id]);
    delete ctx.afkTimers[player.id];
  }
  
  ctx.room.sendAnnouncement(player.name + ' покинул комнату. Игроков осталось: ' + totalPlayers);
  
  const scores = ctx.room.getScores();
  if (scores) {
    if (totalPlayers < 2) {
      ctx.room.sendAnnouncement('Недостаточно игроков для продолжения. Игра остановлена.');
      ctx.room.stopGame();
      ctx.gameState.setGameInProgress(false);
      return;
    }
    
    if (player.team !== 0) {
      const playerList = ctx.room.getPlayerList();
      
      let team1Count = 0;
      let team2Count = 0;
      const spectators: PlayerObject[] = [];
      
      for (let i = 0; i < playerList.length; i++) {
        const p = playerList[i];
        if (p.team === 1) team1Count++;
        else if (p.team === 2) team2Count++;
        else if (p.team === 0) spectators.push(p);
      }
      
      ctx.logger.info('Team balance: Team 1=' + team1Count + ', Team 2=' + team2Count + ', Spectators=' + spectators.length);
      
      const diff = Math.abs(team1Count - team2Count);
      if (diff > 0 && spectators.length > 0) {
        const targetTeam = team1Count < team2Count ? 1 : 2;
        const spectatorToMove = spectators[0];
        
        ctx.room.setPlayerTeam(spectatorToMove.id, targetTeam);
        ctx.gameState.updatePlayerTeam(spectatorToMove.id, targetTeam);
        
        ctx.room.sendAnnouncement(
          spectatorToMove.name + ' перемещен в команду ' + targetTeam + ' для баланса',
          null,
          0xFFAA00,
          'normal',
          1
        );
        
        ctx.logger.info('Moved spectator ' + spectatorToMove.name + ' to team ' + targetTeam);
      }
    }
  }

  // Attempt balance after leave
  try {
    ctx.auto.balanceTeams(ctx);
  } catch {}
};
