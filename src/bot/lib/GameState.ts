import type { NullableTeam, PlayingTeam } from '../types';

export type PlayerState = { id: number; name: string; team: NullableTeam; afk: boolean; playerId?: number };
export type StateShape = {
  players: Record<string, PlayerState>;
  playerList: Array<{ id: number; name: string }>;
  gameSize: 1 | 2 | 3 | 4;
  gameInProgress: boolean;
  winnerTeam: PlayingTeam | null;
  draftMode: boolean;
  team1Captain: PlayerState | null;
  team2Captain: PlayerState | null;
  chooseMode: boolean;
};

export default class GameState {
  private state: StateShape = {
    players: {},
    playerList: [],
    gameSize: 1,
    gameInProgress: false,
    winnerTeam: null,
    draftMode: false,
    team1Captain: null,
    team2Captain: null,
    chooseMode: false,
  };

  getSize() {
    return this.state.gameSize;
  }

  getActivePlayers() {
    return Object.values(this.state.players).filter((p) => p.team !== null && !p.afk);
  }

  getTotalPlayers() {
    return Object.values(this.state.players).filter((p) => !p.afk).length;
  }

  getPlayersByTeam(team: NullableTeam) {
    return Object.values(this.state.players).filter((p) => p.team === team);
  }

  calcNextSize(totalPlayers: number): 1 | 2 | 3 | 4 {
    if (totalPlayers <= 2) return 1;
    if (totalPlayers <= 4) return 2;
    if (totalPlayers <= 6) return 3;
    return 4;
  }

  assignCaptains() {
    const players = Object.values(this.state.players).filter((p) => !p.afk);

    if (players.length < 9) {
      this.state.team1Captain = null;
      this.state.team2Captain = null;
      this.state.draftMode = false;
      return;
    }

    this.state.team1Captain = players[0];
    this.state.team2Captain = players[1];
    this.state.draftMode = true;
  }

  simpleAssignTeams() {
    const availableIds = Object.keys(this.state.players).filter((id) => !this.state.players[id].afk);
    const nextSize = this.calcNextSize(availableIds.length);

    Object.keys(this.state.players).forEach((id) => {
      this.state.players[id].team = null;
    });

    for (let i = 0; i < availableIds.length && i < nextSize * 2; i++) {
      const playerId = availableIds[i];
      this.state.players[playerId].team = i % 2 === 0 ? 1 : 2;
    }

    this.state.gameSize = nextSize;
  }

  assignTeams() {
    const availableIds = Object.keys(this.state.players).filter((id) => !this.state.players[id].afk);
    const nextSize = this.calcNextSize(availableIds.length);
    let team1Count = 0;
    let team2Count = 0;

    const winners = this.getPlayersByTeam(this.state.winnerTeam)
      .map((p) => p.playerId || Object.keys(this.state.players).find((id) => this.state.players[id] === p))
      .filter((id): id is string => Boolean(id));
    const losers = availableIds.filter((id) => this.state.players[id].team !== this.state.winnerTeam);

    Object.keys(this.state.players).forEach((id) => {
      this.state.players[id].team = null;
    });

    if (this.state.winnerTeam && winners.length > 0) {
      for (let i = 0; i < Math.min(winners.length, nextSize); i++) {
        const id = winners[i];
        if (this.state.players[id]) {
          this.state.players[id].team = this.state.winnerTeam;
          if (this.state.winnerTeam === 1) team1Count++;
          else team2Count++;
        }
      }
    }

    const available = losers.concat(availableIds.filter((id) => this.state.players[id].team === null));
    for (const id of available) {
      if (team1Count < nextSize && this.state.players[id].team === null) {
        this.state.players[id].team = 1;
        team1Count++;
      } else if (team2Count < nextSize && this.state.players[id].team === null) {
        this.state.players[id].team = 2;
        team2Count++;
      }
    }

    this.state.gameSize = nextSize;
    this.state.winnerTeam = null;
    this.state.gameInProgress = false;
  }

  addPlayer(playerId: number, playerName: string) {
    this.state.players[playerId] = { id: playerId, name: playerName, team: null, afk: false };
    this.state.playerList.push({ id: playerId, name: playerName });

    if (!this.state.gameInProgress) {
      this.assignCaptains();
    }
  }

  removePlayer(playerId: number) {
    delete this.state.players[playerId];
    this.state.playerList = this.state.playerList.filter((p) => p.id !== playerId);
  }

  setGameInProgress(flag: boolean) {
    this.state.gameInProgress = flag;
  }

  setAFK(playerId: number, flag: boolean) {
    if (!this.state.players[playerId]) return;
    this.state.players[playerId].afk = !!flag;
    this.state.players[playerId].team = null;
  }

  setWinnerTeam(team: PlayingTeam | null) {
    this.state.winnerTeam = team;
  }

  updatePlayerTeam(playerId: number, team: NullableTeam) {
    if (!this.state.players[playerId]) return;
    this.state.players[playerId].team = team;
  }

  resetGame() {
    this.state.winnerTeam = null;
    this.state.gameInProgress = false;
    this.state.draftMode = false;
    this.state.chooseMode = false;
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state)) as StateShape;
  }

  getCaptains() {
    return { team1Captain: this.state.team1Captain, team2Captain: this.state.team2Captain };
  }

  isDraftMode() {
    return this.state.draftMode;
  }

  setDraftMode(flag: boolean) {
    this.state.draftMode = flag;
  }

  isChooseMode() {
    return this.state.chooseMode;
  }

  setChooseMode(flag: boolean) {
    this.state.chooseMode = !!flag;
  }
}
