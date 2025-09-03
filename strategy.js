/**
 * strategy.js
 *
 * Implements an advanced Baccarat betting strategy with realistic modeling.
 * - Uses a Confidence Index (CI) derived from a Bayesian posterior, enhanced with shrinkage.
 * - Calibrates confidence and scales staking by Expected Value (EV).
 * - Implements an ensemble signal and change-point detection for robustness.
 */

// Assumes statistics.js is loaded, providing betaCdfInv() and gammaln().

// Define a global baseline for shrinkage - based on known Baccarat probabilities
const GLOBAL_BANKER_RATE = 0.4585; // (Win rate of Banker on non-tie hands)
const GLOBAL_PLAYER_RATE = 0.4462; // (Win rate of Player on non-tie hands)
const GLOBAL_TIE_RATE = 0.0953;

class BaccaratStrategy {
    /**
     * @param {object} [options={}] - Configuration options for the strategy.
     */
    constructor(options = {}) {
        this.config = {
            initial_prior: options.initial_prior || { B: 1, P: 1, T: 1 },
            warm_up_rounds: options.warm_up_rounds || 12,
            max_exposure: options.max_exposure || 10,
            net_profit_stop_loss_units: options.net_profit_stop_loss_units || -3,
            shrinkage_strength: options.shrinkage_strength || 5.0,
            calibration_map: options.calibration_map || {
                '0.70': 0.68, '0.75': 0.71, '0.80': 0.75, '0.85': 0.80, '0.90': 0.86, '0.95': 0.92
            },
            changepoint_penalty: options.changepoint_penalty || 0.6,
            use_ensemble_signal: options.use_ensemble_signal !== undefined ? options.use_ensemble_signal : true,
            ensemble_mode: options.ensemble_mode || 'require_one', // 'require_one' or 'require_all'
            kelly_fraction: options.kelly_fraction || 0.5, // Bet half of the recommended Kelly stake
            cusum: options.cusum || { drift: 0.05, threshold: 4 },
        };
        this.resetShoe(this.config.initial_prior);
    }

    resetShoe(prior) {
        this.counts = { ...prior };
        this.round = 0;
        this.net_profit = 0;
        this.total_staked = 0;
        this.betting_disabled = false;
        this.stop_reason = null;
        this.recent_outcomes = [];
        this.change_point_detected = false;
        this.current_decision_log = null; // Stores the log of the latest decision

        this.current_max_exposure = this.config.max_exposure;
        this.current_stop_loss = this.config.net_profit_stop_loss_units;

        this.betting_disabled_cusum = false;
        this.cusum_sum = 0;
    }

    getStakeUnitKelly(p_win, p_lose, odds = 0.95) {
        const kelly_fraction = (p_win * odds - p_lose) / odds;
        if (kelly_fraction <= 0) return 0;

        const stake_fraction = this.config.kelly_fraction * kelly_fraction;

        if (stake_fraction > 0.15) return 4; // Very high edge
        if (stake_fraction > 0.10) return 3;
        if (stake_fraction > 0.05) return 2;
        if (stake_fraction > 0.02) return 1; // Small edge
        return 0;
    }

    addOutcome(outcome) {
        if (!['B', 'P', 'T'].includes(outcome)) return;

        this.round++;
        this.recent_outcomes.push(outcome);
        const last_decision = this.current_decision_log ? this.current_decision_log.decision : null;

        if (last_decision && last_decision.stake > 0) {
            if (last_decision.betOn === outcome) {
                this.net_profit += last_decision.stake * 0.95;
            } else {
                this.net_profit -= last_decision.stake;
            }
        }
        this.counts[outcome]++;

        const k = this.config.shrinkage_strength;
        const shrunk_counts = {
            B: this.counts.B + k * GLOBAL_BANKER_RATE,
            P: this.counts.P + k * GLOBAL_PLAYER_RATE,
            T: this.counts.T + k * GLOBAL_TIE_RATE,
        };

        const total_shrunk_alpha = shrunk_counts.B + shrunk_counts.P + shrunk_counts.T;
        const posterior_mean = {
            B: shrunk_counts.B / total_shrunk_alpha,
            P: shrunk_counts.P / total_shrunk_alpha,
            T: shrunk_counts.T / total_shrunk_alpha,
        };
        
        const p_b_star = (1 - posterior_mean.T) / 1.95;
        let raw_confidence = 1 - regularizedIncompleteBeta(p_b_star, shrunk_counts.B, shrunk_counts.P + shrunk_counts.T);
        if (isNaN(raw_confidence)) raw_confidence = 0;

        this.updateLegacySystems(outcome, p_b_star);
        let adjusted_confidence = this.change_point_detected ? raw_confidence * this.config.changepoint_penalty : raw_confidence;
        let calibrated_confidence = this.getCalibratedConfidence(adjusted_confidence);

        const ev_per_unit = (posterior_mean.B * 0.95) - posterior_mean.P;
        const final_confidence = (ev_per_unit > 0) ? calibrated_confidence : 0;
        const ensemble_agrees = this.getEnsembleSignal();

        if (this.net_profit <= this.current_stop_loss) {
            this.betting_disabled = true;
            this.stop_reason = `Net profit reached ${this.current_stop_loss} units`;
        }
        if (this.total_staked >= this.current_max_exposure) {
            this.betting_disabled = true;
            this.stop_reason = `Max exposure of ${this.current_max_exposure} units reached`;
        }

        let decision = { betOn: null, stake: 0, reason: 'Analysis pending' };
        const stake_unit = this.getStakeUnitKelly(posterior_mean.B, posterior_mean.P);

        if (this.round < this.config.warm_up_rounds) {
            decision.reason = 'Warm-up period';
        } else if (this.betting_disabled) {
            decision.reason = `STOP: ${this.stop_reason}`;
        } else if (this.config.use_ensemble_signal && !ensemble_agrees) {
            decision.reason = 'Ensemble models disagree';
        } else if (stake_unit <= 0) {
            decision.reason = `Kelly stake is zero (EV ${(ev_per_unit.toFixed(3))}) `;
        } else {
            decision = {
                betOn: 'B',
                stake: stake_unit,
                reason: `Kelly: ${stake_unit}u | Conf: ${(final_confidence * 100).toFixed(1)}% | EV: ${ev_per_unit.toFixed(3)}`
            };
            this.total_staked += stake_unit;
        }
        
        this.current_decision_log = {
            round: this.round,
            outcome: outcome,
            counts: { ...this.counts },
            posterior_mean: posterior_mean,
            p_b_star: p_b_star,
            confidence: final_confidence,
            net_profit: this.net_profit,
            decision: decision,
            analysis: {
                raw_confidence: raw_confidence,
                calibrated_confidence: calibrated_confidence,
                ev_per_unit: ev_per_unit,
                ensemble_agrees: ensemble_agrees,
                change_point_detected: this.change_point_detected,
                cusum_sum: this.cusum_sum,
                total_staked: this.total_staked,
            }
        };
        return this.current_decision_log;
    }

    updateLegacySystems(outcome, p_b_star) {
        const x_t = (outcome === 'B') ? 1 : 0;
        if (!this.betting_disabled_cusum) {
            this.cusum_sum = Math.max(0, this.cusum_sum + (x_t - (p_b_star + this.config.cusum.drift)));
            if (this.cusum_sum > this.config.cusum.threshold) {
                this.betting_disabled_cusum = true;
                this.change_point_detected = true;
            }
        }
    }

    getCalibratedConfidence(confidence) {
        const buckets = Object.keys(this.config.calibration_map).sort((a, b) => parseFloat(a) - parseFloat(b));
        let calibrated = confidence;
        for (const bucket of buckets) {
            if (confidence >= parseFloat(bucket)) {
                calibrated = this.config.calibration_map[bucket];
            } else {
                break;
            }
        }
        return calibrated;
    }

    getEnsembleSignal() {
        const momentum = this.getMomentumSignal();
        const streak = this.getStreakSignal();
        const chop = this.getChopSignal();
        const signals = [momentum, streak, chop];
        const agreeing_signals = signals.filter(s => s === true).length;
        if (this.config.ensemble_mode === 'require_all') {
            return agreeing_signals === signals.length;
        }
        return agreeing_signals > 0;
    }

    getMomentumSignal() {
        const window = this.recent_outcomes.slice(-15);
        if (window.length < 10) return false;
        const banker_count = window.filter(o => o === 'B').length;
        const player_count = window.filter(o => o === 'P').length;
        return banker_count > player_count;
    }

    getStreakSignal() {
        if (this.recent_outcomes.length < 3) return false;
        return this.recent_outcomes.slice(-3).every(o => o === 'B');
    }

    getChopSignal() {
        if (this.recent_outcomes.length < 4) return false;
        const last_four = this.recent_outcomes.slice(-4);
        return last_four[0] === 'B' && last_four[1] === 'P' && last_four[2] === 'B' && last_four[3] === 'P';
    }
}
