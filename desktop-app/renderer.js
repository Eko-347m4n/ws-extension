/**
 * Renderer process script for the Electron desktop app window.
 * This script runs in the context of the web page (index.html).
 * It listens for messages from the main process and displays them in the log container.
 */
const { ipcRenderer } = require('electron');

/**
 * Parses WebSocket responses to extract structured Baccarat game results.
 * @param {string} jsonString The raw JSON string from the WebSocket.
 * @returns {object|null} A structured object with results or null if not applicable.
 */
function processWebSocketResponse(jsonString) {
  try {
    const data = JSON.parse(jsonString);

    if (data.type !== 'lobby.historyUpdated') {
      return null;
    }

    const args = data.args;
    const tableName = Object.keys(args)[0];
    const history = args[tableName];

    if (!tableName || !history || !history.results) {
      return null;
    }

    const rawResults = history.results;
    let processedResults = [];

    if (rawResults.length === 0) {
      processedResults = [];
    } else if (typeof rawResults[0] === 'string') {
      processedResults = rawResults.map(result => {
        if (result === 'Player') return 'Player';
        if (result === 'Banker') return 'Banker';
        return 'Tie';
      });
    } else if (typeof rawResults[0] === 'object' && rawResults[0] !== null) {
      processedResults = rawResults.map(result => {
        if (result.ties) return 'Tie';
        if (result.c === 'R') return 'Banker';
        if (result.c === 'B') return 'Player';
        return 'Unknown';
      });
    } else {
      return null; // Not a format we can process
    }

    return {
      tableName: tableName,
      totalRounds: processedResults.length,
      results: processedResults
    };

  } catch (error) {
    // This isn't a fatal error, just means we can't parse this specific message.
    return null;
  }
}

/**
 * Creates a DOM element for displaying a structured game result.
 * @param {object} structuredData The processed data from processWebSocketResponse.
 * @param {object} rawMessage The original raw message for the collapsible view.
 * @returns {HTMLElement} The log body element.
 */
function createStructuredLogBody(structuredData, rawMessage) {
    const logBody = document.createElement('div');
    logBody.className = 'log-body';

    // Add structured data view
    const structuredView = document.createElement('div');
    structuredView.style.padding = '12px';
    structuredView.style.backgroundColor = '#1a1a1a';

    const title = document.createElement('h4');
    title.textContent = `Table: ${structuredData.tableName}`;
    title.style.margin = '0 0 10px 0';
    title.style.color = '#00aaff';

    const rounds = document.createElement('p');
    rounds.textContent = `Total Rounds: ${structuredData.totalRounds}`;
    rounds.style.margin = '0 0 10px 0';
    rounds.style.fontSize = '12px';

    const resultsContainer = document.createElement('div');
    resultsContainer.style.display = 'flex';
    resultsContainer.style.flexWrap = 'wrap';
    resultsContainer.style.gap = '5px';

    structuredData.results.forEach(result => {
        const resultChip = document.createElement('span');
        resultChip.textContent = result.charAt(0); // B, P, or T
        resultChip.style.display = 'inline-block';
        resultChip.style.width = '20px';
        resultChip.style.height = '20px';
        resultChip.style.textAlign = 'center';
        resultChip.style.lineHeight = '20px';
        resultChip.style.borderRadius = '50%';
        resultChip.style.color = 'white';
        resultChip.style.fontWeight = 'bold';
        resultChip.style.fontSize = '12px';
        
        if (result === 'Banker') {
            resultChip.style.backgroundColor = '#d9534f'; // Red
        } else if (result === 'Player') {
            resultChip.style.backgroundColor = '#428bca'; // Blue
        } else {
            resultChip.style.backgroundColor = '#5cb85c'; // Green
        }
        resultsContainer.appendChild(resultChip);
    });

    structuredView.appendChild(title);
    structuredView.appendChild(rounds);
    structuredView.appendChild(resultsContainer);
    
    // Add collapsible raw data view
    const details = document.createElement('details');
    details.style.marginTop = '10px';

    const summary = document.createElement('summary');
    summary.textContent = 'View Raw JSON';
    summary.style.cursor = 'pointer';
    summary.style.fontSize = '11px';
    summary.style.color = '#aaa';

    const rawJsonPre = document.createElement('pre');
    rawJsonPre.textContent = JSON.stringify(rawMessage, null, 2);
    
    details.appendChild(summary);
    details.appendChild(rawJsonPre);

    logBody.appendChild(structuredView);
    logBody.appendChild(details);

    return logBody;
}

/**
 * Creates a DOM element for displaying a raw JSON message.
 * @param {object} message The raw message.
 * @returns {HTMLElement} The log body element.
 */
function createRawLogBody(message) {
    const logBody = document.createElement('div');
    logBody.className = 'log-body';
    const messageElement = document.createElement('pre');
    messageElement.textContent = JSON.stringify(message, null, 2);
    logBody.appendChild(messageElement);
    return logBody;
}


window.addEventListener('DOMContentLoaded', () => {
  const logContainer = document.getElementById('log-container');
  const clearLogBtn = document.getElementById('clear-log-btn');
  const autoscrollToggle = document.getElementById('autoscroll-toggle');
  const statusIndicator = document.getElementById('connection-status');

  // --- Event Listeners for Controls ---

  clearLogBtn.addEventListener('click', () => {
    logContainer.innerHTML = '';
  });

  // --- IPC Message Handlers ---

  ipcRenderer.on('connection-status-changed', (event, status) => {
    statusIndicator.className = ''; // Clear previous classes
    switch (status) {
      case 'connected':
        statusIndicator.textContent = 'Connected';
        statusIndicator.classList.add('status-connected');
        break;
      case 'disconnected':
        statusIndicator.textContent = 'Disconnected (Waiting for data...)';
        statusIndicator.classList.add('status-disconnected');
        break;
      case 'waiting':
        statusIndicator.textContent = 'Waiting for Connection...';
        statusIndicator.classList.add('status-waiting');
        break;
      case 'terminated':
        statusIndicator.textContent = 'Connection Terminated';
        break;
    }
  });

  ipcRenderer.on('ws-message', (event, message) => {
    try {
      const logEntry = document.createElement('div');
      logEntry.className = 'log-entry';

      const logHeader = document.createElement('div');
      logHeader.className = 'log-header';

      const timestamp = document.createElement('span');
      timestamp.className = 'timestamp';
      timestamp.textContent = new Date().toLocaleTimeString();

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(JSON.stringify(message, null, 2));
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1000);
      });

      logHeader.appendChild(timestamp);
      logHeader.appendChild(copyBtn);
      
      // --- MODIFIED LOGIC ---
      const structuredData = processWebSocketResponse(JSON.stringify(message));
      let logBody;

      if (structuredData) {
        // If parsing is successful, show the structured view
        logBody = createStructuredLogBody(structuredData, message);
      } else {
        // Otherwise, fall back to the raw JSON view
        logBody = createRawLogBody(message);
      }
      // --- END OF MODIFIED LOGIC ---

      logEntry.appendChild(logHeader);
      logEntry.appendChild(logBody);

      logContainer.appendChild(logEntry);

      if (autoscrollToggle.checked) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }

    } catch (e) {
      const errorElement = document.createElement('pre');
      errorElement.style.color = 'red';
      errorElement.textContent = `RENDERER ERROR:
${e.stack}`;
      logContainer.appendChild(errorElement);
    }
  });
});