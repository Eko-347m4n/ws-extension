let ws;
let config;
let reconnectTimeout;
let isCapturing = false;
let autoConnectMode = false;
let discoveredUrls = []; // Store for the session

const COMMON_COOKIE_NAMES = ['session', 'sess', 'sid', 'token', 'auth', 'jwt', 'id'];

// Helper to send messages to popup and ignore errors if popup is not open.
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
  if (ws) ws.close();
  else updateStatus("Disconnected", "#db4437");
}

function connect() {
  if (ws) return;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (!config) { updateStatus("Config?", "#f4b400"); return; }

  console.log("Attempting to connect with config:", config);
  updateStatus("Connecting...", "#4285f4");

  chrome.cookies.get({ url: config.targetUrl, name: config.cookieName }, (cookie) => {
    if (cookie) {
      console.log("Cookie found. Connecting to WebSocket...");
      ws = new WebSocket(config.wsUrl);
      ws.onopen = () => { updateStatus("Connected", "#0f9d58"); };
      ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            // Ignore non-JSON messages as they don't fit the filter criteria.
            return;
        }

        // Filter messages based on the presence of 'bac' in the keys of the 'args' object.
        if (data && typeof data.args === 'object' && data.args !== null) {
            const keys = Object.keys(data.args);
            const hasBacKey = keys.some(key => key.toLowerCase().includes('bac'));
            if (hasBacKey) {
                sendMessageToPopup({ type: "WS_MSG", data: data });
            }
        }
      };
      ws.onclose = () => {
        ws = null;
        if (config) { updateStatus("Reconnecting", "#f4b400"); reconnectTimeout = setTimeout(connect, 5000); }
      };
      ws.onerror = (error) => { console.error("WebSocket error:", error); updateStatus("Error", "#db4437"); };
    } else {
      console.error(`Cookie '${config.cookieName}' not found for domain '${config.targetUrl}'.`);
      updateStatus("No Cookie", "#f4b400");
      reconnectTimeout = setTimeout(connect, 10000);
    }
  });
}

function initiateAutoConnection(urlData) {
    // The origin for cookie purposes must be http/https.
    const httpOrigin = urlData.origin.replace(/^ws/, 'http');
    const hostname = new URL(httpOrigin).hostname;

    console.log(`Auto-Connect: Searching for cookies on domain '${hostname}'`);
    chrome.cookies.getAll({ domain: hostname }, (cookies) => {
        if (!cookies || cookies.length === 0) {
            console.error(`Auto-Connect: No cookies found for domain '${hostname}'`);
            updateStatus("No Cookies", "#f4b400");
            return;
        }
        let foundCookie = null;
        for (const name of COMMON_COOKIE_NAMES) {
            foundCookie = cookies.find(c => c.name.toLowerCase().includes(name));
            if (foundCookie) break;
        }
        if (!foundCookie) {
            console.error("Auto-Connect: Could not find a likely session cookie on domain:", hostname, cookies);
            updateStatus("No Cookie?", "#f4b400");
            return;
        }
        console.log("Auto-Connect: Found likely cookie:", foundCookie.name);
        sendMessageToPopup({ type: "AUTO_CONNECT_UPDATE", data: { cookieName: foundCookie.name } });
        // Use the corrected httpOrigin for the config
        config = { wsUrl: urlData.wsUrl, targetUrl: httpOrigin, cookieName: foundCookie.name };
        connect();
    });
}

function onHeadersReceived(details) {
  if (details.statusCode === 101) {
    const urlData = { wsUrl: details.url.replace(/^http/, 'ws'), origin: new URL(details.url).origin };
    if (!discoveredUrls.some(item => item.wsUrl === urlData.wsUrl)) {
        console.log('WebSocket upgrade discovered:', urlData);
        discoveredUrls.push(urlData);
        sendMessageToPopup({ type: "WEBSOCKET_DISCOVERED", data: urlData });
        if (autoConnectMode && !ws) { // If auto-connect is on and we are not already connected
            initiateAutoConnection(urlData);
        }
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "CONNECT": if (ws) disconnect(); config = message.data; connect(); break;
    case "DISCONNECT": config = null; disconnect(); break;
    case "WS_SEND": if (ws && ws.readyState === WebSocket.OPEN) ws.send(message.data); else console.error("WS not connected."); break;
    case "GET_STATUS":
      if (isCapturing) updateStatus("Capturing...", "#ff6d00");
      else if (ws && ws.readyState === WebSocket.OPEN) updateStatus("Connected", "#0f9d58");
      else if (config) updateStatus("Connecting...", "#4285f4");
      else updateStatus("Disconnected", "#db4437");
      break;
    case "START_CAPTURE": startCapture(); break;
    case "STOP_CAPTURE": stopCapture(); break;
    case "GET_DISCOVERED_LIST": sendMessageToPopup({ type: "ALL_DISCOVERED_URLS", data: discoveredUrls }); break;
    case "SET_AUTO_CONNECT": autoConnectMode = message.data.enabled; chrome.storage.local.set({ autoConnectMode: autoConnectMode }); break;
  }
  return true;
});

function initialize() {
  chrome.storage.local.get(['captureMode', 'autoConnectMode'], (result) => {
    autoConnectMode = !!result.autoConnectMode;
    if (result.captureMode) startCapture();
  });
}

chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);