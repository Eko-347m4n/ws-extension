/**
 * Renderer process script for the Electron desktop app window.
 * This script runs in the context of the web page (index.html).
 * It listens for messages from the main process and displays them in the log container.
 */
const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const logContainer = document.getElementById('log-container');
  const clearLogBtn = document.getElementById('clear-log-btn');
  const autoscrollToggle = document.getElementById('autoscroll-toggle');

  let messageCount = 0;

  // --- Event Listeners for Controls ---

  clearLogBtn.addEventListener('click', () => {
    logContainer.innerHTML = '';
    messageCount = 0;
  });

  // --- IPC Message Handler ---

  // Listen for the 'ws-message' event from the main process.
  ipcRenderer.on('ws-message', (event, message) => {
    try {
      messageCount++;

      // Create the main container for the log entry
      const logEntry = document.createElement('div');
      logEntry.className = 'log-entry';

      // Create the header with timestamp and copy button
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

      // Create the body with the formatted JSON message
      const logBody = document.createElement('div');
      logBody.className = 'log-body';

      const messageElement = document.createElement('pre');
      messageElement.textContent = JSON.stringify(message, null, 2);
      logBody.appendChild(messageElement);

      // Assemble the log entry
      logEntry.appendChild(logHeader);
      logEntry.appendChild(logBody);

      // Add the new log entry to the container
      logContainer.appendChild(logEntry);

      // Auto-scroll if the checkbox is checked
      if (autoscrollToggle.checked) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }

    } catch (e) {
      // If there's an error rendering the message, display it in the log.
      const errorElement = document.createElement('pre');
      errorElement.style.color = 'red';
      errorElement.textContent = `RENDERER ERROR:
${e.stack}`;
      logContainer.appendChild(errorElement);
    }
  });
});
