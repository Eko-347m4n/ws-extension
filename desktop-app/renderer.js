/**
 * Renderer process script for the Electron desktop app window.
 * This script builds and manages the dashboard UI.
 */

// --- DOM Elements ---
const logContainer = document.getElementById('log-container');
const connectionStatusSpan = document.getElementById('connection-status');

/**
 * Creates or updates a dashboard card for a specific table.
 * @param {object} logData The comprehensive log data from the strategy.
 */
function createOrUpdateDashboardCard(logData) {
    const { tableId, round, outcome, confidence, net_profit, decision, analysis } = logData;
    if (!tableId) return;

    const cardId = 'table-' + tableId;
    let card = document.getElementById(cardId);

    // If a card for this table doesn't exist, create it at the bottom.
    if (!card) {
        card = document.createElement('div');
        card.id = cardId;
        card.className = 'card';
        logContainer.appendChild(card); // ALWAYS APPEND TO THE BOTTOM
    }

    // --- Determine UI states ---
    const confidenceValue = confidence * 100;
    const isBet = decision.stake > 0;
    const isBlocked = !isBet && (decision.reason !== 'Confidence too low');

    let actionClass, actionText, riskText, riskIcon;
    let betOnSide = decision.betOn === 'B' ? 'BANKER' : 'PLAYER';
    let betOnColorClass = decision.betOn === 'B' ? 'bet-banker' : 'bet-player';

    if (isBet) {
        actionClass = 'bet-yes';
        actionText = `🟢 BET <span class="${betOnColorClass}">${betOnSide}</span> (${decision.stake} units)`;
    } else if (isBlocked) {
        actionClass = 'bet-blocked';
        actionText = `🟡 NO BET – ${decision.reason}`;
    } else {
        actionClass = 'bet-no';
        actionText = `🔴 NO BET – ${decision.reason}`;
    }

    if (decision.reason.includes('exposure') || decision.reason.includes('STOP')) {
        riskIcon = '❌';
        riskText = decision.reason;
    } else {
        riskIcon = '✅';
        riskText = 'Exposure OK';
    }

    let confidenceCategory, confidenceColor;
    if (confidenceValue >= 95) { confidenceCategory = 'Strong'; confidenceColor = '#4caf50'; }
    else if (confidenceValue >= 90) { confidenceCategory = 'High'; confidenceColor = '#ffeb3b'; }
    else if (confidenceValue >= 80) { confidenceCategory = 'Medium'; confidenceColor = '#ff9800'; }
    else { confidenceCategory = 'Low'; confidenceColor = '#f44336'; }

    // --- Build Card HTML from Wireframe ---
    card.innerHTML = `
        <div class="card-header">
            <span>ROUND: ${round}</span>
            <span>TABLE: ${tableId}</span>
        </div>
        <div class="card-body">
            <div class="card-action ${actionClass}">${actionText}</div>
            <div class="metric">
                <span>Confidence</span>
                <div class="progress-bar">
                    <div class="progress-bar-inner" style="width: ${confidenceValue}%; background-color: ${confidenceColor};"></div>
                </div>
                <span style="color: ${confidenceColor}; font-weight: bold;">${confidenceValue.toFixed(1)}%</span>
            </div>
            <div class="metric">
                <span>Risk Status</span>
                <span>${riskIcon} ${riskText}</span>
                <span></span>
            </div>
            <div class="details-toggle" onclick="toggleDetails('${tableId}')">Show Details ▼</div>
            <div class="details-panel" id="details-${tableId}">
                <div class="stat"><strong>Last Outcome:</strong> ${outcome}</div>
                <div class="stat"><strong>Net Profit:</strong> ${net_profit.toFixed(2)} units</div>
                <div class="stat"><strong>Strict Signal:</strong> ${analysis.strict_signal ? 'YES' : 'NO'}</div>
                <div class="stat"><strong>SPRT Decision:</strong> ${analysis.sprt_state.decision}</div>
                <div class="stat"><strong>CUSUM Sum:</strong> ${analysis.cusum_sum.toFixed(2)}</div>
                <div class="stat"><strong>P(B*):</strong> ${logData.p_b_star.toFixed(3)}</div>
                <div class="stat"><strong>Posterior Mean (B):</strong> ${logData.posterior_mean.B.toFixed(3)}</div>
            </div>
        </div>
    `;
}

/**
 * Toggles the visibility of the details panel for a card.
 * @param {string} tableId The ID of the table to toggle.
 */
function toggleDetails(tableId) {
    const panel = document.getElementById(`details-${tableId}`);
    const toggle = panel.previousElementSibling;
    if (panel.classList.toggle('show')) {
        toggle.textContent = 'Hide Details ▲';
    } else {
        toggle.textContent = 'Show Details ▼';
    }
}

/**
 * Creates a standard log entry wrapper for non-dashboard messages.
 * @param {HTMLElement} bodyContent The pre-formatted content.
 * @param {string} headerText The text for the log header.
 * @returns {HTMLElement} A complete log entry element.
 */
function createLogEntry(bodyContent, headerText) {
    const logEntry = document.createElement('div');
    logEntry.className = 'card'; // Use card style for consistency
    logEntry.innerHTML = `
        <div class="card-header">${headerText}</div>
        <div class="card-body"></div>
    `;
    logEntry.querySelector('.card-body').appendChild(bodyContent);
    return logEntry;
}

// --- IPC Listeners ---

/**
 * Creates or updates a card for a table that has been detected but has no processable data yet.
 * @param {object} payload The message payload, containing the tableId and round.
 */
function createOrUpdatePlaceholderCard(payload) {
    const { tableId, round } = payload; // Added round
    if (!tableId) return;

    const cardId = 'table-' + tableId;
    let card = document.getElementById(cardId);

    // If a card for this table already shows full data, don't overwrite it with a placeholder.
    // Only create a new card or update an existing placeholder.
    if (card && card.querySelector('.details-toggle')) {
        return;
    }

    if (!card) {
        card = document.createElement('div');
        card.id = cardId;
        card.className = 'card';
        logContainer.appendChild(card);
    }

    // Update the card's content to show a waiting/no-data state.
    card.innerHTML = `
        <div class="card-header">
            <span>ROUND: ${round || 'N/A'}</span> <!-- Display round -->
            <span>TABLE: ${tableId}</span>
        </div>
        <div class="card-body">
            <div class="card-action bet-blocked">⚪ WAITING FOR DATA...</div>
            <div class="metric">
                <span>Confidence</span>
                <div class="progress-bar">
                    <div class="progress-bar-inner" style="width: 0%;"></div>
                </div>
                <span>N/A</span>
            </div>
        </div>
    `;
}

/**
 * Creates a card to display the shoe summary report.
 * @param {string} summaryText The formatted summary text from PerformanceTracker.getSummary().
 */
function createShoeSummaryCard(summaryText) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
        <div class="card-header">SHOE SUMMARY REPORT (${new Date().toLocaleTimeString()})</div>
        <div class="card-body">
            <pre style="white-space: pre-wrap; word-wrap: break-word; font-size: 12px;">${summaryText}</pre>
        </div>
    `;
    logContainer.appendChild(card);
}

window.electronAPI.onWsMessage((message) => {
    // DEBUG: Add a simple log entry for every message received
    const debugLogEntry = document.createElement('div');
    debugLogEntry.textContent = `Received message: ${JSON.stringify(message)}`;
    logContainer.appendChild(debugLogEntry);

    if (message && message.type === 'strategy_update') {
        createOrUpdateDashboardCard(message.payload);
    } else if (message && message.type === 'strategy_no_data') {
        createOrUpdatePlaceholderCard(message.payload);
    } else if (message && message.type === 'shoe_summary') {
        createShoeSummaryCard(message.payload); // payload is the summary string
    } else if (message && message.type === 'WS_MSG') {
        const bodyContent = document.createElement('pre');
        if (typeof message.data === 'object') {
            bodyContent.textContent = JSON.stringify(message.data, null, 2);
        } else {
            bodyContent.textContent = message.data; // Raw string
        }
        const logEntryElement = createLogEntry(bodyContent, `Raw WebSocket Message (${new Date().toLocaleTimeString()})`);
        logContainer.appendChild(logEntryElement);
    } else {
        // For other message types, append them as a simple log entry
        const bodyContent = document.createElement('pre');
        bodyContent.textContent = JSON.stringify(message, null, 2);
        const logEntryElement = createLogEntry(bodyContent, `Log Message (${new Date().toLocaleTimeString()})`);
        logContainer.appendChild(logEntryElement);
    }
    
    // ALWAYS scroll to the bottom after any message to ensure the latest content is visible.
    logContainer.scrollTop = logContainer.scrollHeight;
});

window.electronAPI.onConnectionStatusChanged((status) => {
    if (connectionStatusSpan) {
        connectionStatusSpan.textContent = status.toUpperCase();
        connectionStatusSpan.className = `status-${status}`;
    }
});