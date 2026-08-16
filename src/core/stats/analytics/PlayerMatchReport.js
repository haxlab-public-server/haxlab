/*
 * One instance per player per match — plain data, no behavior. Field names
 * map 1:1 onto the 28-metric spec (Pos Touches, Scoring %, Decision Speed,
 * Turnov Touch, Forced TO, Dang. TO, Prog Pass, Prog Dist, Final 3rd, Key
 * Pass, Recoveries, F3 Recoveries, Press Relief, Duels, Duel W, Duel L,
 * Interc Duels, Rebounds, Reb Rec, Clear, Cl Rec, XG Faced, XG Prev, Sweeper
 * actions, 2nd Ast, 3rd Ast, Counters) — see the individual detector classes
 * for how each one is actually computed and how confident that computation is.
 *
 * goals/assists/rating are a later addition (see MatchRatingDetector, which
 * runs last and is the only detector that writes them): goals/assists are a
 * MATCH-scoped tally, independent of player_stats' own CAREER totals
 * (roomStats.js) — same underlying source data (state.game.goals), separate
 * bookkeeping, purely for this report. rating is the single 0-10 composite.
 */
class PlayerMatchReport {
    constructor(auth, playerName, team) {
        this.auth = auth;
        this.playerName = playerName;
        this.team = team;

        this.posTouches = 0;
        this.scoringPct = 0;
        this.decisionSpeed = 0;
        this.turnoverTouches = 0;
        this.forcedTakeaways = 0;
        this.dangerousTurnovers = 0;
        this.progPasses = 0;
        this.progDistance = 0;
        this.final3rdEntries = 0;
        this.keyPasses = 0;
        this.recoveries = 0;
        this.f3Recoveries = 0;
        this.pressRelief = 0;
        this.duels = 0;
        this.duelsWon = 0;
        this.duelsLost = 0;
        this.intercDuels = 0;
        this.rebounds = 0;
        this.reboundsRecovered = 0;
        this.clearances = 0;
        this.clearancesRecovered = 0;
        this.xgFaced = 0;
        this.xgPrevented = 0;
        this.sweeperActions = 0;
        this.secondAssists = 0;
        this.thirdAssists = 0;
        this.counters = 0;

        this.goals = 0;
        this.assists = 0;
        this.rating = 0;
    }
}

module.exports = { PlayerMatchReport };
