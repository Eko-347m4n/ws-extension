importScripts('statistics.js', 'performance.js', 'strategy.js');

// --- Global State ---
let ws;
let config;
let reconnectTimeout;
let isCapturing = false;
let autoConnectMode = false;
let discoveredUrls = [];
let nativePort = null;

// --- State Management ---
let shoeStates = {};
let globalPriors = {};
const SHRINKAGE_FACTOR = 0.2;
const COMMON_COOKIE_NAMES = ['session', 'sess', 'sid', 'token', 'auth', 'jwt', 'id'];

// --- Core Functions ---

function connectNative() {
    const hostName = "org.gemini.web_socket_client";
    console.log(`Attempting to connect to native host: ${hostName}`);
    nativePort = chrome.runtime.connectNative(hostName);

    if (chrome.runtime.lastError) {
        console.error("Failed to connect to native host:", chrome.runtime.lastError.message);
        nativePort = null;
        return;
    }

    nativePort.onMessage.addListener((message) => {
        console.log("Received from native host:", message);
    });

    nativePort.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError) {
            console.error("Native host disconnected with error:", chrome.runtime.lastError.message);
        } else {
            console.log("Native host disconnected gracefully.");
        }
        nativePort = null; // Essential for reconnection logic
    });
    console.log("Successfully connected to native host.");
}

function sendMessageToPopup(message) {
    chrome.runtime.sendMessage(message).catch(e => {
        if (!e.message.includes("Receiving end does not exist")) console.error(e);
    });
}

function sendToNativeHost(message) {
    // If port is not connected, try to reconnect it first.
    if (!nativePort) {
        console.log("Native port is not connected. Attempting to reconnect...");
        connectNative();
    }

    // If the connection attempt was successful (or already was connected), send the message.
    if (nativePort) {
        try {
            nativePort.postMessage(message);
        } catch (e) {
            console.error("Failed to send message to native host:", e);
            // The port might have broken between the check and the postMessage call.
            // Disconnect it fully to ensure the next call triggers a reconnect.
            nativePort.disconnect();
            nativePort = null;
        }
    } else {
        console.error("Cannot send message: Native host connection is not available.");
    }
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
  if (nativePort) nativePort.disconnect();
  updateStatus("Disconnected", "#db4437");
}

function connect() {
  if (ws) return;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (!config) { updateStatus("Config?", "#f4b400"); return; }

  connectNative();
  updateStatus("Connecting...", "#4285f4");

  chrome.cookies.get({ url: config.targetUrl, name: config.cookieName }, (cookie) => {
    if (cookie) {
      ws = new WebSocket(config.wsUrl);

      ws.onopen = () => {
          updateStatus("Connected", "#0f9d58");
      };

      ws.onmessage = (event) => {
        console.log(`[${new Date().toISOString()}] Received raw WebSocket message.`);
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
            console.log(`[${new Date().toISOString()}] Message contains 'args' object. Processing tables.`);
            for (const tableId in data.args) {
                const tableData = data.args[tableId];
                if (tableId.toLowerCase().includes('bac') && tableData && Array.isArray(tableData.results)) {
                    console.log(`[${new Date().toISOString()}] Found Baccarat data for table: ${tableId}`);
                    processBaccaratData(tableId, tableData);
                }
            }
        }
      };

      ws.onclose = () => {
        ws = null;
        if (nativePort) nativePort.disconnect();
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
    const startTime = performance.now();
    console.log(`[${new Date().toISOString()}] [${tableId}] Starting processing.`);

    const results = tableData.results;
    if (!results || !Array.isArray(results) || results.length === 0) {
        console.log(`[${new Date().toISOString()}] [${tableId}] No results to process.`);
        return; // Nothing to process
    }

    // To prevent getting stuck, this function treats each message as the current source of truth.
    // It re-processes the entire list of results provided in the message each time.
    // This is more robust against non-cumulative updates from the server.

    const prior = globalPriors[tableId] || { B: 1, P: 1, T: 1 };
    const tempStrategy = new BaccaratStrategy({ initial_prior: prior });
    const tempTracker = new PerformanceTracker();
    let lastDecisionLog = null;

    // Process every outcome in the received list to rebuild the current state from scratch.
    for (const resultObject of results) {
        const outcome = translateOutcome(resultObject);
        if (outcome) {
            lastDecisionLog = tempStrategy.addOutcome(outcome);
            tempTracker.recordDecision(lastDecisionLog, outcome);
        }
    }

    // Detect a new shoe by checking if the new round count is less than our stored one.
    if (shoeStates[tableId] && tempStrategy.round < shoeStates[tableId].strategy.round) {
        console.log(`[${new Date().toISOString()}] [${tableId}] New shoe detected.`);
        const summary = shoeStates[tableId].performanceTracker.getSummary();
        sendToNativeHost({ type: 'shoe_summary', payload: summary });
        const final_counts = shoeStates[tableId].strategy.counts;
        // Update the global prior for the *next* shoe.
        globalPriors[tableId] = { B: 1 + (final_counts.B * SHRINKAGE_FACTOR), P: 1 + (final_counts.P * SHRINKAGE_FACTOR), T: 1 + (final_counts.T * SHRINKAGE_FACTOR) };
    }

    // Persist the newly calculated state for this table.
    shoeStates[tableId] = {
        strategy: tempStrategy,
        performanceTracker: tempTracker
    };

    // Send the latest state to the UI, if any processing occurred.
    if (lastDecisionLog) {
        const payload = { ...lastDecisionLog, tableId };
        console.log(`[${new Date().toISOString()}] [${tableId}] Sending strategy update to native host.`);
        sendToNativeHost({ type: 'strategy_update', payload });
    }
    const endTime = performance.now();
    console.log(`[${new Date().toISOString()}] [${tableId}] Finished processing in ${endTime - startTime}ms.`);
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