importScripts('statistics.js', 'performance.js', 'strategy.js');

// --- Global State ---
let ws;
let config;
let reconnectTimeout;
let isCapturing = false;
let autoConnectMode = false;
let discoveredUrls = [];

// --- State Management ---
let shoeStates = {};
let globalPriors = {};
const SHRINKAGE_FACTOR = 0.2;
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
  reconnectTimeout = null;
  if (ws) {
      ws.onclose = null; // Prevent reconnect logic from firing on manual disconnect
      ws.close();
      ws = null;
  }
  updateStatus("Disconnected", "#db4437");
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
      };

      ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            console.error(`[${new Date().toISOString()}] Failed to parse WebSocket message:`, e);
            sendMessageToPopup({ type: "WS_MSG", data: event.data });
            return;
        }

        sendMessageToPopup({ type: "WS_MSG", data: data });

        if (data && typeof data.args === 'object') {
            for (const tableId in data.args) {
                const tableData = data.args[tableId];
                if (tableId.toLowerCase().includes('bac') && tableData && Array.isArray(tableData.results)) {
                    processBaccaratData(tableId, tableData);
                }
            }
        }
      };

      ws.onclose = () => {
        ws = null;
        if (config) { 
            updateStatus("Reconnecting", "#f4b400"); 
            reconnectTimeout = setTimeout(connect, 5000); 
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

function processBaccaratData(tableId, tableData) {
    const results = tableData.results;
    if (!results || !Array.isArray(results)) {
        return;
    }

    // Create a fresh, stateless strategy for each incoming message.
    const strategy = new BaccaratStrategy({ initial_prior: globalPriors[tableId] || { B: 1, P: 1, T: 1 } });
    let lastDecisionLog = null;

    // Process the entire history provided in the message.
    for (const resultObject of results) {
        const outcome = translateOutcome(resultObject);
        if (outcome) {
            lastDecisionLog = strategy.addOutcome(outcome);
        }
    }

    // If a valid decision log was produced from the results, log it to the console.
    if (lastDecisionLog) {
        try {
            const { decision, confidence, round, net_profit, outcome } = lastDecisionLog;
            if (decision) {
                const isBet = decision.stake > 0;
                const betOnSide = decision.betOn === 'B' ? 'BANKER' : (decision.betOn === 'P' ? 'PLAYER' : 'N/A');
                
                let actionText;
                if (isBet) {
                    actionText = `🟢 BET ${betOnSide} (${decision.stake} units)`;
                } else {
                    actionText = `🔴 NO BET`;
                }

                const confidenceText = (confidence !== null && typeof confidence !== 'undefined') ? `${(confidence * 100).toFixed(1)}%` : 'N/A';
                const profitText = (net_profit !== null && typeof net_profit !== 'undefined') ? `${net_profit.toFixed(2)} units` : 'N/A';

                console.group(`[${new Date().toLocaleTimeString()}] Decision for ${tableId} (Round ${round || 'N/A'})`);
                console.log(`%cAction: ${actionText}`, `font-weight:bold; font-size:13px; color: ${isBet ? '#2e7d32' : '#c62828'};`);
                console.log(`Reason: ${decision.reason || 'N/A'}`);
                console.log(`Confidence: ${confidenceText}`);
                const lastFiveOutcomes = results.slice(-5).map(r => translateOutcome(r)).filter(o => o).join(', ');
                console.log('Last 5 Outcomes:', lastFiveOutcomes || 'N/A');
                console.log(`Net Profit: ${profitText}`);
                console.groupEnd();
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
    case "DISCONNECT": config = null; disconnect(); break;
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
  chrome.storage.local.get(['captureMode', 'autoConnectMode'], (result) => {
    autoConnectMode = !!result.autoConnectMode;
    if (result.captureMode) startCapture();
  });
}

chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);