importScripts('statistics.js', 'performance.js', 'strategy.js');

// --- Global State ---
let ws;
let config;
let reconnectTimeout;
let heartbeatTimeout;
let isCapturing = false;
let autoConnectMode = false;
let discoveredUrls = [];
let latestMessage = null;
let isProcessing = false;

// --- State Management ---
let globalPriors = {};
let tableStates = {}; // Holds the state (strategy, tracker, etc.) for each table
const COMMON_COOKIE_NAMES = ['session', 'sess', 'sid', 'token', 'auth', 'jwt', 'id'];

// --- Core Functions ---

function sendMessageToPopup(message) {
    chrome.runtime.sendMessage(message).catch(e => {
        if (!e.message.includes("Receiving end does not exist")) console.error(e);
    });
}

function updateStatus(status, color) {
  sendMessageToPopup({ type: "STATUS_UPDATE", status, color });
  chrome.action.setBadgeText({ text: status.substring(0, 4) }).catch(e => {});
  chrome.action.setBadgeBackgroundColor({ color: color || '#777777' }).catch(e => {});
}

function disconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
  reconnectTimeout = null;
  heartbeatTimeout = null;
  if (ws) {
      ws.onclose = null; // Prevent reconnect logic from firing on manual disconnect
      ws.close();
      ws = null;
  }
  updateStatus("Disconnected", "#db4437");
}

function resetHeartbeat() {
  if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
  heartbeatTimeout = setTimeout(() => {
    console.log("WebSocket heartbeat timeout after 30s. Reconnecting...");
    if (ws) {
      ws.close(); // This will trigger the onclose handler which contains the reconnect logic
    }
  }, 30000);
}

function connect() {
  if (ws) return;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (!config) { updateStatus("Config?", "#f4b400"); return; }

  updateStatus("Connecting...", "#4285f4");

  chrome.cookies.get({ url: config.targetUrl, name: config.cookieName }, (cookie) => {
    if (cookie) {
      ws = new WebSocket(config.wsUrl);

      ws.onopen = () => {
          updateStatus("Connected", "#0f9d58");
          resetHeartbeat();
      };

      ws.onmessage = (event) => {
        resetHeartbeat();
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            console.error(`[${new Date().toISOString()}] Failed to parse WebSocket message:`, e);
            sendMessageToPopup({ type: "WS_MSG", data: event.data });
            return;
        }
        
        latestMessage = data; // Always store the latest message

        if (!isProcessing) {
            processLatestMessage();
        }
      };

      ws.onclose = () => {
        if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
        ws = null;
        if (config) { 
            updateStatus("Reconnecting", "#f4b400"); 
            reconnectTimeout = setTimeout(connect, 1500); 
        }
      };

      ws.onerror = (error) => { 
          console.error("WebSocket error:", error); 
          updateStatus("Error", "#db4437"); 
      };
    } else {
      console.error(`Cookie '${config.cookieName}' not found for domain '${config.targetUrl}'.`);
      updateStatus("No Cookie", "#f4b400");
      reconnectTimeout = setTimeout(connect, 10000);
    }
  });
}

function processLatestMessage() {
    if (isProcessing || !latestMessage) {
        return;
    }

    isProcessing = true;
    
    const messageToProcess = latestMessage;
    latestMessage = null; 

    try {
        sendMessageToPopup({ type: "WS_MSG", data: messageToProcess });

        if (messageToProcess && typeof messageToProcess.args === 'object') {
            for (const tableId in messageToProcess.args) {
                const tableData = messageToProcess.args[tableId];
                if (tableId.toLowerCase().includes('bac') && tableData && Array.isArray(tableData.results)) {
                    processBaccaratData(tableId, tableData);
                }
            }
        }
    } finally {
        isProcessing = false;
        if (latestMessage) {
            setTimeout(processLatestMessage, 0); 
        }
    }
}

function logCalibrationData(logEntry) {
    chrome.storage.local.get(['calibrationData'], (result) => {
        let data = result.calibrationData || [];
        data.push(logEntry);
        // Keep only the last 1000 entries to prevent storage bloat
        if (data.length > 1000) {
            data = data.slice(data.length - 1000);
        }
        chrome.storage.local.set({ calibrationData: data });
    });
}

function processBaccaratData(tableId, tableData) {
    const results = tableData.results;
    if (!results || !Array.isArray(results)) return;

    let state = tableStates[tableId];
    const currentRoundTotal = results.length;

    // Initialize or Reset state if it's a new shoe
    if (!state || (currentRoundTotal < state.lastRound && currentRoundTotal < 5)) {
        if (state) { // A new shoe is starting for a table we were already tracking
            // --- Log previous shoe's performance summary ---
            if (state.tracker.relaxed_metrics.bets_made > 0) {
                const { wins, losses, bets_made } = state.tracker.relaxed_metrics;
                const winRate = (wins / bets_made * 100).toFixed(2);
                const profit = state.tracker.net_profit_units;
                const profitText = profit.toFixed(2);
                const profitCss = 'font-weight: bold; color: ' + (profit >= 0 ? '#0f9d58' : '#db4437');

                console.groupCollapsed(`%cShoe Performance Summary for ${tableId}`, 'color: #1a73e8; font-weight: bold;');
                console.log(`Result: %c${wins}W - ${losses}L (${winRate}%)`);
                console.log(`Total Bets: ${bets_made}`);
                console.log(`Final Net Profit: %c${profitText} units`, profitCss);
                if (state.tracker.bet_history && state.tracker.bet_history.length > 0) {
                    console.log('--- Bet History ---');
                    console.table(state.tracker.bet_history);
                }
                console.groupEnd();
            }

            console.log(`%cNew shoe detected for ${tableId}. Resetting strategy and saving learned priors.`, 'color: blue; font-weight: bold;');
            const finalCounts = state.strategy.counts;
            globalPriors[tableId] = finalCounts;
            chrome.storage.local.set({ globalPriors: globalPriors });
        }
        
        state = {
            strategy: new BaccaratStrategy({ initial_prior: globalPriors[tableId] || { B: 1, P: 1, T: 1 } }),
            tracker: new PerformanceTracker(),
            lastRound: 0,
            hasStopped: false, // Track if the strategy has issued a permanent stop
        };
        tableStates[tableId] = state;
    }

    const newOutcomes = results.slice(state.lastRound);
    if (newOutcomes.length === 0) return;

    let lastDecisionLog = state.strategy.current_decision_log;
    let lastBetResult = null; // To hold the result of the last bet processed

    for (const resultObject of newOutcomes) {
        const outcome = translateOutcome(resultObject);
        if (outcome) {
            if (lastDecisionLog) { // Use the decision from *before* the outcome was known
                state.tracker.recordDecision(lastDecisionLog, outcome);
                
                // If a bet was made, store its result to be logged later
                if (lastDecisionLog.decision.stake > 0) {
                    const isWin = lastDecisionLog.decision.betOn === outcome;
                    lastBetResult = {
                        round: lastDecisionLog.round,
                        resultText: isWin ? 'WIN' : 'LOSE',
                        color: isWin ? '#0f9d58' : '#db4437'
                    };

                    logCalibrationData({
                        timestamp: Date.now(),
                        tableId: tableId,
                        confidence: lastDecisionLog.analysis.raw_confidence, // Use raw confidence
                        win: isWin
                    });
                }
            }
            // Process the outcome and get the log for the *next* decision
            lastDecisionLog = state.strategy.addOutcome(outcome);
        }
    }
    
    state.lastRound = currentRoundTotal;

    if (lastDecisionLog) {
        try {
            const { decision, confidence, round, analysis } = lastDecisionLog;

            // Manage logging state for the table
            let hasStopped = state.hasStopped || false;
            if (hasStopped) return; // Don't log if already permanently stopped

            const isPermanentStop = decision.reason && decision.reason.startsWith('STOP:');
            if (isPermanentStop) {
                state.hasStopped = true; // Mark for future rounds, the current stop log will be the last.
            }

            // Only log from round 10 onwards
            if (round < 10) return;

            if (decision) {
                const isBet = decision.stake > 0;
                const profit = state.tracker.net_profit_units;

                // --- Build Log Message ---
                const time = new Date().toLocaleTimeString('en-GB');
                const title = `%c[${time}] ${tableId} | R${round}`;
                const actionText = isBet ? `BET ${decision.betOn} ${decision.stake}u` : 'NO BET';
                const action = isBet ? `%c${actionText} 🟢` : `%c${actionText} 🔴`;
                const profitText = `| Profit: %c${profit.toFixed(2)}u`;

                // Add the result of the previous bet if it exists
                let lastBetLine = '';
                let lastBetCss = [];
                if (lastBetResult) {
                    lastBetLine = `\nLast Bet (R${lastBetResult.round}): %c${lastBetResult.resultText}`;
                    lastBetCss.push(`color: ${lastBetResult.color}; font-weight: bold;`);
                }

                const evText = `EV: ${analysis.ev_per_unit.toFixed(3)}`;
                const confText = `Conf: ${(confidence * 100).toFixed(1)}%`;
                const ensembleText = `Ensemble: ${analysis.ensemble_agrees ? '✅' : '❌'}`;
                const secondaryLine = `%c${evText} | ${confText} | ${ensembleText}`;
                
                const reasonLine = `%c> ${decision.reason || 'N/A'}`;

                // --- Define CSS Styles ---
                const titleCss = 'color: #9e9e9e;'; // Grey
                const betCss = 'color: #2e7d32; font-weight: bold;'; // Dark Green
                const noBetCss = 'color: #c62828;'; // Dark Red
                const profitCss = 'font-weight: bold; color: ' + (profit >= 0 ? '#0f9d58' : '#db4437');
                const secondaryCss = 'color: #6c757d;'; // Muted Grey
                const reasonCss = 'color: #4285f4; font-style: italic;'; // Blue

                // --- Log to Console ---
                console.log(
                    `${title} ${action} ${profitText}${lastBetLine}\n${secondaryLine}\n${reasonLine}`,
                    titleCss,
                    isBet ? betCss : noBetCss,
                    profitCss,
                    ...lastBetCss, // Spread the array for the result color
                    secondaryCss,
                    reasonCss
                );
            }
        } catch (e) {
            console.error("Error logging strategy decision:", e, lastDecisionLog);
        }
    } 
}

function translateOutcome(resultObject) {
    if (!resultObject) return null;
    if (resultObject.ties) return 'T';
    if (resultObject.c === 'R') return 'B';
    if (resultObject.c === 'B') return 'P';
    return null;
}

function initiateAutoConnection(urlData) {
    const httpOrigin = urlData.origin.replace(/^ws/, 'http');
    let hostname = new URL(httpOrigin).hostname;
    if (hostname.startsWith('ws.') || hostname.startsWith('wss.')) {
        hostname = hostname.substring(hostname.indexOf('.') + 1);
    }
    chrome.cookies.getAll({ domain: hostname }, (cookies) => {
        if (!cookies || cookies.length === 0) {
            updateStatus("No Cookies", "#f4b400");
            return;
        }
        let foundCookie = COMMON_COOKIE_NAMES.map(name => cookies.find(c => c.name.toLowerCase().includes(name))).find(c => c);
        if (!foundCookie) {
            updateStatus("No Cookie?", "#f4b400");
            return;
        }
        sendMessageToPopup({ type: "AUTO_CONNECT_UPDATE", data: { cookieName: foundCookie.name } });
        config = { wsUrl: urlData.wsUrl, targetUrl: httpOrigin, cookieName: foundCookie.name };
        connect();
    });
}

function onHeadersReceived(details) {
  if (details.statusCode === 101) {
    const urlData = { wsUrl: details.url.replace(/^http/, 'ws'), origin: new URL(details.url).origin };
    if (!discoveredUrls.some(item => item.wsUrl === urlData.wsUrl)) {
        discoveredUrls.push(urlData);
        sendMessageToPopup({ type: "WEBSOCKET_DISCOVERED", data: urlData });
        if (autoConnectMode && !ws) initiateAutoConnection(urlData);
    }
  }
}

function startCapture() {
  if (isCapturing) return;
  isCapturing = true;
  discoveredUrls = [];
  updateStatus("Capturing...", "#ff6d00");
  chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, { urls: ["<all_urls>"], types: ["main_frame", "sub_frame", "xmlhttprequest", "websocket", "other"] });
}

function stopCapture() {
  if (!isCapturing) return;
  isCapturing = false;
  chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  if (!ws) updateStatus("Disconnected", "#db4437");
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "CONNECT": if (ws) disconnect(); config = message.data; connect(); break;
    case "DISCONNECT": config = null; disconnect(); tableStates = {}; break; // Clear states on manual disconnect
    case "WS_SEND": if (ws && ws.readyState === WebSocket.OPEN) ws.send(message.data); else console.error("WS not connected."); break;
    case "GET_STATUS":
      if (isCapturing) updateStatus("Capturing...", "#ff6d00");
      else if (ws && ws.readyState === WebSocket.OPEN) updateStatus("Connected", "#0f9d58");
      else if (config) updateStatus("Connecting...", "#f4b400");
      else updateStatus("Disconnected", "#db4437");
      break;
    case "START_CAPTURE": startCapture(); break;
    case "STOP_CAPTURE": stopCapture(); break;
    case "GET_DISCOVERED_LIST": sendMessageToPopup({ type: "ALL_DISCOVERED_URLS", data: discoveredUrls }); break;
    case "SET_AUTO_CONNECT": autoConnectMode = message.data.enabled; chrome.storage.local.set({ autoConnectMode: autoConnectMode }); break;
  }
});

function initialize() {
  chrome.storage.local.get(['captureMode', 'autoConnectMode', 'globalPriors', 'calibrationData'], (result) => {
    autoConnectMode = !!result.autoConnectMode;
    globalPriors = result.globalPriors || {};
    console.log('Loaded global priors:', globalPriors);
    console.log(`Loaded ${result.calibrationData ? result.calibrationData.length : 0} calibration data points.`);
    if (result.captureMode) startCapture();
  });
}

chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);