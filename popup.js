// UI Elements
const captureToggle = document.getElementById('capture-toggle');
const autoConnectToggle = document.getElementById('auto-connect-toggle');
const cookieNameInput = document.getElementById('cookie-name');
const configDiv = document.getElementById('config');
const discoveredListDiv = document.getElementById('discovered-list');
const disconnectButton = document.getElementById('disconnect-button');
const statusSpan = document.getElementById('status');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');

const discoveredUrls = new Set();

// Load saved state on startup
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['cookieName', 'captureMode', 'autoConnectMode'], (result) => {
    if (result.cookieName) cookieNameInput.value = result.cookieName;
    captureToggle.checked = !!result.captureMode;
    autoConnectToggle.checked = !!result.autoConnectMode;
    if (result.autoConnectMode) {
        configDiv.classList.add('disabled');
    }
  });
  chrome.runtime.sendMessage({ type: "GET_STATUS" });
  chrome.runtime.sendMessage({ type: "GET_DISCOVERED_LIST" });
});

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "WS_MSG":
      const content = typeof message.data === 'object' ? JSON.stringify(message.data, null, 2) : message.data;
      addMessageToLog(content, 'received');
      break;
    case "STATUS_UPDATE":
      statusSpan.textContent = message.status;
      statusSpan.style.color = message.color || 'black';
      break;
    case "WEBSOCKET_DISCOVERED":
      addDiscoveredUrl(message.data);
      break;
    case "ALL_DISCOVERED_URLS":
      message.data.forEach(urlData => addDiscoveredUrl(urlData));
      break;
    case "AUTO_CONNECT_UPDATE":
        cookieNameInput.value = message.data.cookieName;
        break;
  }
});

function addDiscoveredUrl(data) {
    if (discoveredUrls.has(data.wsUrl)) return;
    discoveredUrls.add(data.wsUrl);
    const item = document.createElement('div');
    item.className = 'discovered-item';
    const urlSpan = document.createElement('span');
    urlSpan.className = 'url';
    urlSpan.textContent = data.wsUrl;
    item.appendChild(urlSpan);
    const connectBtn = document.createElement('button');
    connectBtn.textContent = 'Connect';
    connectBtn.addEventListener('click', () => {
        const cookieName = cookieNameInput.value;
        if (!cookieName) {
            alert('Please enter a Cookie Name first!');
            return;
        }
        chrome.storage.local.set({ cookieName: cookieName });
        chrome.runtime.sendMessage({ type: "CONNECT", data: { wsUrl: data.wsUrl, targetUrl: data.origin, cookieName: cookieName } });
    });
    item.appendChild(connectBtn);
    discoveredListDiv.appendChild(item);
}

// Handle Toggles
captureToggle.addEventListener('change', () => {
  const isEnabled = captureToggle.checked;
  chrome.storage.local.set({ captureMode: isEnabled });
  chrome.runtime.sendMessage({ type: isEnabled ? "START_CAPTURE" : "STOP_CAPTURE" });
});

autoConnectToggle.addEventListener('change', () => {
    const isEnabled = autoConnectToggle.checked;
    chrome.storage.local.set({ autoConnectMode: isEnabled });
    configDiv.classList.toggle('disabled', isEnabled);
    chrome.runtime.sendMessage({ type: "SET_AUTO_CONNECT", data: { enabled: isEnabled } });
});

// Handle Disconnect button click
disconnectButton.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: "DISCONNECT" });
});

// Send message logic
function sendMessage() {
  const message = messageInput.value;
  if (message) {
    chrome.runtime.sendMessage({ type: "WS_SEND", data: message });
    addMessageToLog(`${message}`, 'sent');
    messageInput.value = '';
  }
}
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keyup', (event) => { if (event.key === 'Enter') sendMessage(); });

// Helper to add messages to the log
function addMessageToLog(text, type) {
  const p = document.createElement('p');
  p.textContent = text;
  p.className = type;
  messagesDiv.appendChild(p);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}