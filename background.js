/**
 * Background service worker for the WebSocket Client Extension.
 * Handles network requests, WebSocket connections, and communication with the native desktop app.
 */

let ws; // Holds the WebSocket object
let config; // Stores connection configuration (URLs, cookie name)
let reconnectTimeout; // Timeout ID for reconnection logic
let isCapturing = false; // Flag for whether the extension is capturing network requests
let autoConnectMode = false; // Flag for auto-connection feature
let discoveredUrls = []; // Stores discovered WebSocket URLs for the session
let nativePort = null; // Holds the connection port to the native desktop app

const COMMON_COOKIE_NAMES = ['session', 'sess', 'sid', 'token', 'auth', 'jwt', 'id'];

/**
 * Establishes a connection to the native messaging host (desktop app).
 */
function connectNative() {
    const hostName = "org.gemini.web_socket_client";
    console.log(`Connecting to native host: ${hostName}`);
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
            console.log("Native host disconnected.");
        }
        nativePort = null;
    });
}

/**
 * Sends a message to the popup. Fails silently if the popup is not open.
 * @param {object} message The message to send.
 */
function sendMessageToPopup(message) {
    chrome.runtime.sendMessage(message).catch(e => {
        // Ignore "Receiving end does not exist" error, which is expected if popup is closed.
        if (!e.message.includes("Receiving end does not exist")) console.error(e);
    });
}

/**
 * Updates the status in the popup and the badge text.
 * @param {string} status The status text to display.
 * @param {string} color The color for the badge background.
 */
function updateStatus(status, color) {
  sendMessageToPopup({ type: "STATUS_UPDATE", status, color });
  chrome.action.setBadgeText({ text: status.substring(0, 4) }).catch(e => {});
  chrome.action.setBadgeBackgroundColor({ color: color || '#777777' }).catch(e => {});
}

/**
 * Disconnects the WebSocket and the native messaging port.
 */
function disconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = null;
  if (ws) ws.close();
  else updateStatus("Disconnected", "#db4437");
  if (nativePort) {
      nativePort.disconnect();
  }
}

/**
 * Main function to connect to the WebSocket server using the stored config.
 */
function connect() {
  if (ws) return;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (!config) { updateStatus("Config?", "#f4b400"); return; }

  // Establish connection to the desktop app when a WebSocket connection is initiated.
  connectNative();

  console.log("Attempting to connect with config:", config);
  updateStatus("Connecting...", "#4285f4");

  chrome.cookies.get({ url: config.targetUrl, name: config.cookieName }, (cookie) => {
    if (cookie) {
      console.log("Cookie found. Connecting to WebSocket...");
      ws = new WebSocket(config.wsUrl);

      ws.onopen = () => {
          updateStatus("Connected", "#0f9d58");
      };

      ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return; // Ignore non-JSON messages
        }

        // Filter messages: only process if args contains a key with 'bac'.
        if (data && typeof data.args === 'object' && data.args !== null) {
            const keys = Object.keys(data.args);
            const hasBacKey = keys.some(key => key.toLowerCase().includes('bac'));
            if (hasBacKey) {
                // Relay message to both the popup and the native desktop app.
                sendMessageToPopup({ type: "WS_MSG", data: data });
                if (nativePort) {
                    nativePort.postMessage(data);
                } else {
                    console.error("Cannot send message, native port is not connected.");
                }
            }
        }
      };

      ws.onclose = () => {
        ws = null;
        if (nativePort) nativePort.disconnect();
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

/**
 * Attempts to automatically connect to a discovered WebSocket.
 * It intelligently searches for a common session cookie on the target domain.
 * @param {object} urlData Contains wsUrl and origin of the discovered WebSocket.
 */
function initiateAutoConnection(urlData) {
    const httpOrigin = urlData.origin.replace(/^ws/, 'http');
    let hostname = new URL(httpOrigin).hostname;

    // Cookies are often set on the root domain, not a 'ws' subdomain.
    if (hostname.startsWith('ws.') || hostname.startsWith('wss.')) {
        hostname = hostname.substring(hostname.indexOf('.') + 1);
    }

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
        config = { wsUrl: urlData.wsUrl, targetUrl: httpOrigin, cookieName: foundCookie.name };
        connect();
    });
}

/**
 * Listens for network headers and discovers WebSocket upgrade requests.
 * @param {object} details Details of the web request.
 */
function onHeadersReceived(details) {
  // 101 is the status code for "Switching Protocols" (a WebSocket upgrade).
  if (details.statusCode === 101) {
    const urlData = { wsUrl: details.url.replace(/^http/, 'ws'), origin: new URL(details.url).origin };
    if (!discoveredUrls.some(item => item.wsUrl === urlData.wsUrl)) {
        console.log('WebSocket upgrade discovered:', urlData);
        discoveredUrls.push(urlData);
        sendMessageToPopup({ type: "WEBSOCKET_DISCOVERED", data: urlData });
        if (autoConnectMode && !ws) {
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

// --- Event Listeners ---

// Listen for messages from the popup.
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
});

// Initialize the extension state on startup or installation.
function initialize() {
  chrome.storage.local.get(['captureMode', 'autoConnectMode'], (result) => {
    autoConnectMode = !!result.autoConnectMode;
    if (result.captureMode) startCapture();
  });
}

chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);