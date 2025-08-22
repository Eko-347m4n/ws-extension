
/**
 * statistics.js
 *
 * Provides statistical utility functions, focusing on the Beta distribution needed for Bayesian analysis.
 */

// A small constant for machine precision.
const EPSILON = 1e-15;

/**
 * The regularized incomplete beta function, I_x(a, b).
 * This is the CDF of the Beta distribution.
 *
 * The implementation uses the continued fraction method for its robustness.
 * @param {number} x The value to evaluate the CDF at (must be in [0, 1]).
 * @param {number} a The alpha parameter of the Beta distribution.
 * @param {number} b The beta parameter of the Beta distribution.
 * @returns {number} The value of the CDF, P(X <= x) for X ~ Beta(a, b).
 */
function regularizedIncompleteBeta(x, a, b) {
    if (x < 0 || x > 1) return NaN;
    if (x === 0) return 0;
    if (x === 1) return 1;

    // This term is a normalization factor.
    const logBeta = gammaln(a + b) - gammaln(a) - gammaln(b);
    const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta) / a;

    // Continued fraction evaluation (using the Lentz-Thompson-Barnett modified method).
    let f = 1;
    let c = 1;
    let d = 0;

    for (let i = 1; i <= 200; i++) {
        const m = i >> 1; // integer division by 2
        let d_m;

        if (i % 2 === 1) { // Odd terms
            d_m = -((a + m - 1) * (a + b + m - 1) * x) / ((a + 2 * m - 2) * (a + 2 * m - 1));
        } else { // Even terms
            d_m = (m * (b - m) * x) / ((a + 2 * m - 2) * (a + 2 * m - 1));
        }

        d = 1 + d_m * d;
        if (Math.abs(d) < EPSILON) d = EPSILON;
        d = 1 / d;

        c = 1 + d_m / c;
        if (Math.abs(c) < EPSILON) c = EPSILON;

        const delta = c * d;
        f *= delta;

        if (Math.abs(delta - 1) < EPSILON * 100) {
            break; // Converged
        }
    }

    return front * (1 / f);
}

/**
 * The log-gamma function, ln(Γ(x)).
 * Uses the Lanczos approximation, which is a good balance of speed and accuracy.
 * @param {number} x The input value.
 * @returns {number} The natural logarithm of the gamma function of x.
 */
function gammaln(x) {
    const p = [
        0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    if (x < 0.5) {
        return Math.PI / Math.sin(Math.PI * x) - gammaln(1 - x);
    }
    x -= 1;
    let a = p[0];
    for (let i = 1; i < p.length; i++) {
        a += p[i] / (x + i);
    }
    const t = x + p.length - 1.5;
    return Math.log(Math.sqrt(2 * Math.PI) * a) + t * Math.log(t) - t;
}

/**
 * Inverse of the regularized incomplete beta function (quantile function).
 * Finds x such that I_x(a, b) = p.
 *
 * This function uses a combination of Newton-Raphson iteration and bisection
 * to find the root robustly and efficiently.
 *
 * @param {number} p The probability (quantile) to find, must be in [0, 1].
 * @param {number} a The alpha parameter of the Beta distribution.
 * @param {number} b The beta parameter of the Beta distribution.
 * @returns {number} The value x such that P(X <= x) = p for X ~ Beta(a, b).
 */
function betaCdfInv(p, a, b) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;

    // Initial guess using a simple approximation.
    let x = Math.pow(p, 1 / a);
    if (a > 1 && b > 1) {
        const mean = a / (a + b);
        x = mean;
    }

    const logBeta = gammaln(a) + gammaln(b) - gammaln(a + b);

    // Newton-Raphson iterations for refinement.
    for (let i = 0; i < 20; i++) {
        const fx = regularizedIncompleteBeta(x, a, b) - p;
        
        // PDF of the Beta distribution, which is the derivative of the CDF.
        const pdf = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - logBeta);

        const step = fx / pdf;
        const nextX = x - step;

        // Ensure the next guess is within bounds.
        if (nextX <= 0 || nextX >= 1) {
            break; // Switch to bisection if we step out of bounds.
        }
        
        x = nextX;

        if (Math.abs(step) < 1e-8) {
            return x; // Converged
        }
    }

    // Fallback to bisection method if Newton-Raphson fails to converge.
    let low = 0;
    let high = 1;
    for (let i = 0; i < 50; i++) {
        const mid = (low + high) / 2;
        if (regularizedIncompleteBeta(mid, a, b) < p) {
            low = mid;
        } else {
            high = mid;
        }
        if (high - low < 1e-10) break;
    }

    return (low + high) / 2;
}
