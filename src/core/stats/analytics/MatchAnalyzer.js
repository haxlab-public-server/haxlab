/*
 * Orchestrator/facade — depends only on the Detector contract
 * (`analyze(ctx)`, mutating ctx.reports and optionally stashing intermediate
 * findings on ctx for later detectors), never on any concrete detector class
 * (Dependency Inversion). Detectors run in a fixed order because several
 * genuinely depend on an earlier one's intermediate output (documented in
 * index.js, where that order is assembled) — Open/Closed still holds for
 * adding a new detector: append it, it reads whatever's already on ctx by
 * that point, existing detectors are untouched.
 */
const { PlayerMatchReport } = require('./PlayerMatchReport');

class MatchAnalyzer {
    constructor({ detectors }) {
        this.detectors = detectors;
    }

    // `participants`: [{ auth, playerName, team }]. `touchChain`/`telemetry`/
    // `goals`/`authOf`/`zones` are the shared read models every detector may
    // draw from.
    analyze({ touchChain, telemetry, goals, participants, authOf, zones }) {
        const reports = new Map();
        for (const p of participants) {
            reports.set(p.auth, new PlayerMatchReport(p.auth, p.playerName, p.team));
        }

        const ctx = { touchChain, telemetry, goals, reports, authOf, zones };
        for (const detector of this.detectors) {
            detector.analyze(ctx);
        }

        return [...reports.values()];
    }
}

module.exports = { MatchAnalyzer };
