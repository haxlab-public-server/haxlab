/*
 * Factory boundary for this folder (src/core/stats/analytics/) — the ONE
 * place in the codebase built with real OOP classes rather than this
 * project's usual factory-closure convention (SOLID mapping + rationale in
 * the plan this was built from). Nothing outside this folder needs to know
 * that: entry.js consumes it exactly like any other core/ module, via
 * createMatchAnalytics({...}) -> { reset, recordTick, analyzeMatch }.
 *
 * Wiring (see entry.js): reset() from onGameStart (fresh telemetry per
 * match, matching state.tipUsedThisMatch's own per-match reset convention),
 * recordTick() from onGameTick right after getGameStats() (misc.js),
 * analyzeMatch() from endGame() alongside updateStats()/awardMatchCoins().
 *
 * Detector order matters — several depend on an earlier one's intermediate
 * ctx output (see MatchAnalyzer's own doc comment): Turnover before
 * Recovery/Duel (both split its ctx.turnovers); Shot before KeyPass/
 * Rebound/ShotQuality (all three read ctx.shots); Clearance/Recovery before
 * Sweeper/Counter (read their ctx.*Events); MatchRatingDetector last of all,
 * since it reads every report field every other detector writes.
 */
const { TouchChain } = require('./TouchChain');
const { ZoneClassifier } = require('./ZoneClassifier');
const { MatchTelemetry } = require('./MatchTelemetry');
const { MatchAnalyzer } = require('./MatchAnalyzer');

const { PossessionDetector } = require('./detectors/PossessionDetector');
const { TurnoverDetector } = require('./detectors/TurnoverDetector');
const { RecoveryDetector } = require('./detectors/RecoveryDetector');
const { DuelDetector } = require('./detectors/DuelDetector');
const { ShotDetector } = require('./detectors/ShotDetector');
const { KeyPassDetector } = require('./detectors/KeyPassDetector');
const { ReboundDetector } = require('./detectors/ReboundDetector');
const { ShotQualityModel } = require('./detectors/ShotQualityModel');
const { ClearanceDetector } = require('./detectors/ClearanceDetector');
const { SweeperDetector } = require('./detectors/SweeperDetector');
const { CounterDetector } = require('./detectors/CounterDetector');
const { ProgressionDetector } = require('./detectors/ProgressionDetector');
const { AssistChainAnalyzer } = require('./detectors/AssistChainAnalyzer');
const { PressureAnalyzer } = require('./detectors/PressureAnalyzer');
const { DecisionSpeedScorer } = require('./detectors/DecisionSpeedScorer');
const { MatchRatingDetector } = require('./detectors/MatchRatingDetector');

module.exports = function createMatchAnalytics({
    room,
    state,
    Team,
    State,
    Situation,
    db,
    authArray,
    pointDistance,
    getGK,
}) {
    const telemetry = new MatchTelemetry();
    const zones = new ZoneClassifier({ Team });

    const detectors = [
        new PossessionDetector(),
        new TurnoverDetector({ zones }),
        new ShotDetector({ zones, Team }),
        new KeyPassDetector(),
        new ReboundDetector(),
        new ShotQualityModel({ getGK, Team, zones }),
        new RecoveryDetector({ zones }),
        new DuelDetector({ telemetry, pointDistance }),
        new ClearanceDetector({ zones, pointDistance }),
        new SweeperDetector({ zones, getGK, Team }),
        new CounterDetector({ zones }),
        new ProgressionDetector({ zones, Team }),
        new AssistChainAnalyzer(),
        new PressureAnalyzer({ pointDistance, Team }),
        new DecisionSpeedScorer(),
        // Must run LAST — reads every field every other detector above writes.
        new MatchRatingDetector({ getGK, Team }),
    ];

    const matchAnalyzer = new MatchAnalyzer({ detectors });

    function reset() {
        telemetry.reset();
    }

    function recordTick() {
        if (!(state.playSituation === Situation.PLAY && state.gameState === State.PLAY)) return;
        const ballProp = room.getDiscProperties(0);
        telemetry.recordTick({
            time: state.game.scores.time,
            ballPosition: room.getBallPosition(),
            ballVelocity: { vx: ballProp.xspeed, vy: ballProp.yspeed },
            players: room.getPlayerList().filter((p) => p.team !== Team.SPECTATORS && p.position != null),
        });
    }

    function buildParticipants() {
        const red = state.game.playerComp[0].map((pc) => ({ auth: pc.auth, playerName: pc.player.name, team: Team.RED }));
        const blue = state.game.playerComp[1].map((pc) => ({ auth: pc.auth, playerName: pc.player.name, team: Team.BLUE }));
        return [...red, ...blue];
    }

    async function analyzeMatch() {
        zones.calibrate(telemetry.observedHalfWidth);
        const touchChain = new TouchChain(state.game.touchArray, { pointDistance });
        const authOf = (player) => authArray[player.id]?.[0];

        const reports = matchAnalyzer.analyze({
            touchChain,
            telemetry,
            goals: state.game.goals,
            participants: buildParticipants(),
            authOf,
            zones,
        });

        for (const report of reports) {
            await db.saveMatchAnalyticsReport(report);
        }
        return reports;
    }

    return { reset, recordTick, analyzeMatch };
};
