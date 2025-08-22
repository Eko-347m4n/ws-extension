
/**
 * performance.js
 *
 * Provides an advanced PerformanceTracker class for dual-mode strategy validation.
 * - Mode A (Strict): Tracks performance of the legacy, triple-confirmation signal.
 * - Mode B (Relaxed): Tracks performance of the new Confidence Index (CI) based staking.
 * It computes metrics for both to allow for calibration and analysis.
 */

class PerformanceTracker {
    constructor() {
        this.reset();
    }

    /**
     * Resets all performance counters to zero for a new shoe.
     */
    reset() {
        this.outcomes_observed = 0;
        this.net_profit_units = 0;

        // Metrics for the new Confidence-based "Relaxed" mode
        this.relaxed_metrics = {
            bets_made: 0,
            units_staked: 0,
            wins: 0,
            losses: 0, // Represents "False Signals"
        };

        // Metrics for the legacy "Strict" mode
        this.strict_metrics = {
            signals_fired: 0,
            wins: 0, // True Positives
            losses: 0, // False Positives
            missed_wins: 0, // False Negatives: Strict said NO, but B won.
            avoided_losses: 0, // True Negatives: Strict said NO, and B lost.
        };
    }

    /**
     * Records a round's outcome against the decisions made by the strategy.
     *
     * @param {object} log - The comprehensive log object from BaccaratStrategy.addOutcome().
     * @param {string} actualOutcome - The actual outcome that occurred (e.g., 'B', 'P', 'T').
     */
    recordDecision(log, actualOutcome) {
        this.outcomes_observed++;
        const { decision, analysis } = log;

        // 1. Update Net Profit based on the actual bet made (Relaxed Mode)
        if (decision.stake > 0) {
            this.net_profit_units += (decision.betOn === actualOutcome) ? (decision.stake * 0.95) : -decision.stake;
        }

        // 2. Log performance for the Relaxed (Confidence-based) strategy
        if (decision.stake > 0) {
            this.relaxed_metrics.bets_made++;
            this.relaxed_metrics.units_staked += decision.stake;
            if (decision.betOn === actualOutcome) {
                this.relaxed_metrics.wins++;
            } else {
                this.relaxed_metrics.losses++; // This is a "False Signal"
            }
        }

        // 3. Log performance for the Strict (Triple-Confirmation) strategy
        if (analysis.strict_signal) {
            this.strict_metrics.signals_fired++;
            if (actualOutcome === 'B') {
                this.strict_metrics.wins++;
            } else {
                this.strict_metrics.losses++;
            }
        } else {
            // If the strict signal didn't fire, was it a missed opportunity or a good call?
            if (actualOutcome === 'B') {
                this.strict_metrics.missed_wins++;
            } else {
                this.strict_metrics.avoided_losses++;
            }
        }
    }

    /**
     * Generates a string summary comparing the performance of both modes.
     * @returns {string} A formatted string with the performance report.
     */
    getSummary() {
        const { wins: relaxed_wins, losses: relaxed_losses, bets_made: relaxed_bets_made } = this.relaxed_metrics;
        const relaxed_winrate = relaxed_bets_made > 0 ? (relaxed_wins / relaxed_bets_made) : 0;

        const { wins: strict_wins, losses: strict_losses, signals_fired: strict_signals_fired, missed_wins: strict_missed_wins } = this.strict_metrics;
        const strict_winrate = strict_signals_fired > 0 ? (strict_wins / strict_signals_fired) : 0;

        const ev_per_bet = this.relaxed_metrics.bets_made > 0 ? (this.net_profit_units / this.relaxed_metrics.bets_made) : 0;

        return `
===================================
      SHOE PERFORMANCE REPORT
===================================

Total Rounds: ${this.outcomes_observed}
Net Profit: ${this.net_profit_units.toFixed(2)} units
Expected Value/Bet: ${ev_per_bet.toFixed(3)} units

--- Mode B: Relaxed (Confidence-Based Betting) ---
Bets Made: ${relaxed_bets_made}
Total Units Staked: ${this.relaxed_metrics.units_staked}

  - Wins: ${relaxed_wins}
  - False Signals (Losses): ${relaxed_losses}
  - Win Rate: ${(relaxed_winrate * 100).toFixed(2)}%

--- Mode A: Strict (Triple-Confirmation Signal) ---
Signals Fired: ${strict_signals_fired}

  - Correct Signals (Wins): ${strict_wins}
  - Incorrect Signals (Losses): ${strict_losses}
  - Signal Win Rate: ${(strict_winrate * 100).toFixed(2)}%

  - Missed Opportunities: ${strict_missed_wins} (Strict said NO, but should have bet)

-----------------------------------
Analysis:
- The Relaxed model's win rate shows the raw performance of the confidence index.
- The Strict model's win rate shows performance under maximum confirmation.
- Compare 'False Signals' (Relaxed) vs. 'Missed Opportunities' (Strict) to find the optimal confidence cutoff.
        `;
    }
}
