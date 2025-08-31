/**
 * strategy.js
 *
 * Implements an advanced Baccarat betting strategy.
 * - Uses a Confidence Index (CI) derived from a Bayesian posterior for staking.
 * - Implements dual-mode logging (Strict vs. Relaxed) for validation.
 * - Features adaptive stop-loss and inter-shoe learning.
 */

// Assumes statistics.js is loaded, providing betaCdfInv() and gammaln().

class BaccaratStrategy {
    /**
     * @param {object} [options={}] - Configuration options for the strategy.
     * @param {object} [options.initial_prior={B:1, P:1, T:1}] - Bayesian priors, allowing for inter-shoe learning.
     * @param {number} [options.warm_up_rounds=10] - Rounds to observe before making any decisions.
     * @param {number} [options.max_exposure=10] - Maximum total units to risk in a single shoe.
     * @param {number} [options.confidence_stop_loss_threshold=0.60] - Stop if confidence is below this for 5 consecutive rounds.
     * @param {number} [options.net_profit_stop_loss_units=-3] - Stop if net profit drops below this many units.
     */
    constructor(options = {}) {
        this.config = {
            initial_prior: options.initial_prior || { B: 1, P: 1, T: 1 },
            warm_up_rounds: options.warm_up_rounds || 10,
            max_exposure: options.max_exposure || 10,
            confidence_stop_loss_threshold: options.confidence_stop_loss_threshold || 0.60,
            net_profit_stop_loss_units: options.net_profit_stop_loss_units || -3,
            // Strict mode (legacy) parameters, used for logging comparison
            sprt: options.sprt || { alpha: 0.05, beta: 0.10, epsilon: 0.01 },
            cusum: options.cusum || { drift: 0.05, threshold: 4 },
        };
        this.resetShoe(this.config.initial_prior);
    }

    /**
     * Resets the strategy's state for a new shoe, potentially carrying over knowledge.
     * @param {object} prior - The initial counts to start the shoe with.
     */
    resetShoe(prior) {
        this.counts = { ...prior };
        this.round = 0;
        this.net_profit = 0;
        this.total_staked = 0;
        this.consecutive_low_confidence_rounds = 0;
        this.consecutive_high_confidence_rounds = 0; // For adaptive stop-loss
        this.betting_disabled = false; // General flag for adaptive stops
        this.stop_reason = null;

        // Adaptive parameters for the current shoe
        this.current_max_exposure = this.config.max_exposure; // For tiered exposure
        this.current_stop_loss = this.config.net_profit_stop_loss_units; // For adaptive stop-loss

        // Legacy system states for logging/comparison
        this.betting_disabled_cusum = false;
        this.betting_disabled_sprt = false;
        this.sprt_state = {
            log_lr: 0,
            upper_boundary: Math.log((1 - this.config.sprt.beta) / this.config.sprt.alpha),
            lower_boundary: Math.log(this.config.sprt.beta / (1 - this.config.sprt.alpha)),
            decision: 'inconclusive',
        };
        this.cusum_sum = 0;
    }

    /**
     * Determines the stake in units based on a confidence level.
     * @param {number} confidence - The confidence index (0.0 to 1.0).
     * @returns {number} The number of units to bet.
     */
    getStakeUnit(confidence) {
        if (confidence >= 0.95) return 4; // Strong bet (4-5 units)
        if (confidence >= 0.90) return 2; // Medium bet (2-3 units)
        if (confidence >= 0.80) return 1; // Small bet (1 unit)
        return 0; // No bet
    }

    /**
     * Processes a single outcome, updates all models, and returns a comprehensive log.
     * @param {string} outcome - The result of the round ('B', 'P', or 'T').
     * @returns {object} A detailed log object for the round.
     */
    addOutcome(outcome) {
        if (!['B', 'P', 'T'].includes(outcome)) return;

        // Update counts and trackers
        this.round++;
        const last_decision = this.current_decision;
        if (last_decision && last_decision.stake > 0) {
            if (last_decision.betOn === outcome) {
                this.net_profit += last_decision.stake * 0.95; // Banker win pays 0.95
            } else {
                this.net_profit -= last_decision.stake;
            }
        }
        this.counts[outcome]++;

        // --- Bayesian Analysis & Confidence Index ---
        const posterior_alpha = { B: this.counts.B, P: this.counts.P, T: this.counts.T };
        const total_alpha = posterior_alpha.B + posterior_alpha.P + posterior_alpha.T;
        const posterior_mean = { B: posterior_alpha.B / total_alpha, P: posterior_alpha.P / total_alpha, T: posterior_alpha.T / total_alpha };
        const p_b_star = (1 - posterior_mean.T) / 1.95;
        let confidence = 1 - regularizedIncompleteBeta(p_b_star, posterior_alpha.B, posterior_alpha.P + posterior_alpha.T);

        if (isNaN(confidence)) {
            confidence = 0;
        }
        confidence = Math.max(0, Math.min(1, confidence));

        // --- Adaptive Strategy Logic ---
        // 1. Adaptive Stop-Loss
        if (confidence >= 0.85) {
            this.consecutive_high_confidence_rounds++;
        } else {
            this.consecutive_high_confidence_rounds = 0;
        }
        if (this.consecutive_high_confidence_rounds >= 3) {
            this.current_stop_loss = -5;
        }

        // 2. Tiered Max Exposure
        if (this.net_profit >= 8) {
            this.current_max_exposure = 15;
        } else if (this.net_profit >= 5) {
            this.current_max_exposure = 12;
        }

        // --- Stop-Loss Checks ---
        if (this.consecutive_low_confidence_rounds >= 5) {
            this.betting_disabled = true;
            this.stop_reason = `Confidence < ${this.config.confidence_stop_loss_threshold*100}% for 5 rounds`;
        }
        if (this.net_profit <= this.current_stop_loss) { // Use adaptive value
            this.betting_disabled = true;
            this.stop_reason = `Net profit reached ${this.current_stop_loss} units`;
        }

        // --- Decision Making ---
        let relaxed_decision = { betOn: null, stake: 0, reason: 'Confidence too low' };
        const stake_unit = this.getStakeUnit(confidence);

        if (this.round < this.config.warm_up_rounds) {
            relaxed_decision.reason = 'Warm-up period';
        } else if (this.betting_disabled) {
            relaxed_decision.reason = `ADAPTIVE STOP: ${this.stop_reason}`;
        } else if (this.total_staked >= this.current_max_exposure) { // Use adaptive value
            relaxed_decision.reason = `Max exposure of ${this.current_max_exposure} units reached`;
        } else if (stake_unit > 0) {
            relaxed_decision = {
                betOn: 'B',
                stake: stake_unit,
                reason: `Confidence ${ (confidence * 100).toFixed(2) }%`
            };
            this.total_staked += stake_unit;
        }
        this.current_decision = relaxed_decision;

        // --- Legacy Analysis ---
        this.updateLegacySystems(outcome, p_b_star);
        const p_b_ci_lower = betaCdfInv(0.025, posterior_alpha.B, posterior_alpha.P + posterior_alpha.T);
        const strict_signal = !this.betting_disabled_cusum &&
                              !this.betting_disabled_sprt &&
                              posterior_mean.B > p_b_star &&
                              p_b_ci_lower > p_b_star &&
                              this.sprt_state.decision === 'accept_h1';

        // --- Log Generation ---
        return {
            round: this.round,
            outcome: outcome,
            counts: { ...this.counts },
            posterior_mean: posterior_mean,
            p_b_star: p_b_star,
            confidence: confidence,
            net_profit: this.net_profit,
            decision: relaxed_decision,
            analysis: {
                strict_signal: strict_signal,
                sprt_state: { ...this.sprt_state },
                cusum_sum: this.cusum_sum,
                total_staked: this.total_staked,
                p_b_credible_interval: [p_b_ci_lower, betaCdfInv(0.975, posterior_alpha.B, posterior_alpha.P + posterior_alpha.T)],
                betting_disabled_reasons: this.stop_reason ? [this.stop_reason] : [],
            }
        };
    }

    /**
     * Updates the legacy SPRT and CUSUM systems for logging purposes.
     * @param {string} outcome The round outcome.
     * @param {number} p_b_star The calculated break-even probability.
     */
    updateLegacySystems(outcome, p_b_star) {
        const x_t = (outcome === 'B') ? 1 : 0;

        // Update CUSUM
        if (!this.betting_disabled_cusum) {
            this.cusum_sum = Math.max(0, this.cusum_sum + (x_t - (p_b_star + this.config.cusum.drift)));
            if (this.cusum_sum > this.config.cusum.threshold) {
                this.betting_disabled_cusum = true;
            }
        }

        // Update SPRT
        if (this.sprt_state.decision === 'inconclusive') {
            const p0 = p_b_star;
            const p1 = p_b_star + this.config.sprt.epsilon;
            if (p1 < 1) {
                const log_p1_p0 = Math.log(p1 / p0);
                const log_1p1_1p0 = Math.log((1 - p1) / (1 - p0));
                this.sprt_state.log_lr += (x_t * log_p1_p0) + ((1 - x_t) * log_1p1_1p0);

                if (this.sprt_state.log_lr >= this.sprt_state.upper_boundary) {
                    this.sprt_state.decision = 'accept_h1';
                } else if (this.sprt_state.log_lr <= this.sprt_state.lower_boundary) {
                    this.sprt_state.decision = 'accept_h0';
                    this.betting_disabled_sprt = true;
                }
            } else {
                this.betting_disabled_sprt = true;
            }
        }
    }
}