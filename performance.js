/**
 * performance.js
 *
 * Provides a PerformanceTracker class for strategy validation.
 * It tracks the performance of the betting strategy, focusing on profit and win/loss rates.
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
        this.bet_history = []; // Stores a detailed log of each bet

        // Metrics for the betting strategy
        this.relaxed_metrics = {
            bets_made: 0,
            units_staked: 0,
            wins: 0,
            losses: 0,
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
        const { decision } = log;

        // 1. Update Net Profit based on the actual bet made
        if (decision.stake > 0) {
            this.net_profit_units += (decision.betOn === actualOutcome) ? (decision.stake * 0.95) : -decision.stake;
        }

        // 2. Log performance for the betting strategy
        if (decision.stake > 0) {
            this.relaxed_metrics.bets_made++;
            this.relaxed_metrics.units_staked += decision.stake;
            if (decision.betOn === actualOutcome) {
                this.relaxed_metrics.wins++;
            } else {
                this.relaxed_metrics.losses++;
            }

            // Add detailed record to bet_history
            this.bet_history.push({
                round: log.round,
                betOn: decision.betOn,
                stake: decision.stake,
                outcome: actualOutcome,
                result: (decision.betOn === actualOutcome) ? 'WIN' : 'LOSE',
            });
        }
    }
}