// CaptainDraft: Manages captain-mode team selection
// Captains take turns picking players by number from available pool

export type DraftPlayer = { id: number; name: string; afk?: boolean | null; team?: 0 | 1 | 2 | null };

type DraftState = {
  draftMode: boolean;
  currentTeam: 1 | 2;
  currentCaptain: DraftPlayer | null;
  availablePlayers: DraftPlayer[];
  team1Captain: DraftPlayer | null;
  team2Captain: DraftPlayer | null;
  team1Roster: DraftPlayer[];
  team2Roster: DraftPlayer[];
};

export default class CaptainDraft {
  private state: DraftState = {
    draftMode: false,
    currentTeam: 1,
    currentCaptain: null,
    availablePlayers: [],
    team1Captain: null,
    team2Captain: null,
    team1Roster: [],
    team2Roster: [],
  };

  startDraft(
    availablePlayers: DraftPlayer[],
    team1CaptainId: number,
    team2CaptainId: number,
    playerMap: Record<number, DraftPlayer>
  ) {
    this.state.draftMode = true;
    this.state.currentTeam = 1;
    this.state.availablePlayers = availablePlayers.filter((p) => {
      const entry = playerMap[p.id];
      return p.id !== team1CaptainId && p.id !== team2CaptainId && !!entry && entry.afk !== true;
    });
    this.state.team1Captain = playerMap[team1CaptainId];
    this.state.team2Captain = playerMap[team2CaptainId];
    this.state.team1Roster = [this.state.team1Captain];
    this.state.team2Roster = [this.state.team2Captain];
    this.state.currentCaptain = this.state.team1Captain;
  }

  getRosteredList() {
    return this.state.availablePlayers.map((p, idx) => idx + 1 + '. ' + p.name).join('\n');
  }

  getRosterSummary() {
    const t1 = this.state.team1Roster.map((p) => p.name).join(', ');
    const t2 = this.state.team2Roster.map((p) => p.name).join(', ');
    return 'Красные: ' + t1 + '\nСиние: ' + t2;
  }

  pickPlayer(playerIndex: number) {
    const idx = playerIndex - 1;
    if (idx < 0 || idx >= this.state.availablePlayers.length) {
      return { success: false, message: 'Неверный номер игрока.' };
    }

    const player = this.state.availablePlayers[idx];
    this.state.availablePlayers.splice(idx, 1);

    if (this.state.currentTeam === 1) {
      this.state.team1Roster.push(player);
      this.state.currentTeam = 2;
    } else {
      this.state.team2Roster.push(player);
      this.state.currentTeam = 1;
    }

    this.state.currentCaptain = this.state.currentTeam === 1 ? this.state.team1Captain : this.state.team2Captain;

    const maxSize = Math.ceil(this.state.availablePlayers.length / 2) + 1;
    if (
      this.state.team1Roster.length >= maxSize ||
      this.state.team2Roster.length >= maxSize ||
      this.state.availablePlayers.length === 0
    ) {
      while (this.state.availablePlayers.length > 0) {
        const p = this.state.availablePlayers.shift();
        if (!p) break;
        if (this.state.team1Roster.length <= this.state.team2Roster.length) {
          this.state.team1Roster.push(p);
        } else {
          this.state.team2Roster.push(p);
        }
      }
      this.state.draftMode = false;
      return { success: true, message: 'Драфт завершен!', complete: true };
    }

    return {
      success: true,
      message: 'Игрок ' + player.name + ' добавлен в команду ' + (this.state.currentTeam === 1 ? 'красные' : 'синие') + '.',
      complete: false,
    };
  }

  getCurrentCaptain() {
    return this.state.currentCaptain;
  }

  getTeamRosters() {
    return { team1: this.state.team1Roster, team2: this.state.team2Roster };
  }

  isDraftActive() {
    return this.state.draftMode;
  }

  resetDraft() {
    this.state.draftMode = false;
    this.state.currentTeam = 1;
    this.state.currentCaptain = null;
    this.state.availablePlayers = [];
    this.state.team1Captain = null;
    this.state.team2Captain = null;
    this.state.team1Roster = [];
    this.state.team2Roster = [];
  }

  removeFromAvailable(playerId: number) {
    this.state.availablePlayers = this.state.availablePlayers.filter((p) => p.id !== playerId);
  }

  addToAvailable(playerObj: DraftPlayer | null | undefined) {
    if (!playerObj || playerObj.afk === true) return;
    const exists = this.state.availablePlayers.some((p) => p.id === playerObj.id);
    if (!exists) {
      this.state.availablePlayers.push(playerObj);
    }
  }
}
