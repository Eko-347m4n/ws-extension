/**
 * Main process for the Electron desktop app.
 * Handles window creation and native messaging communication with the Chrome extension.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const log = require('electron-log');

// Configure logging to a file and disable console output to prevent EPIPE errors.
log.transports.console.level = false;
log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'main.log');
log.info('App starting...');

let mainWindow;

/**
 * Creates and loads the main application window.
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      // The preload script runs in a privileged environment with access to Node.js APIs.
      preload: path.join(__dirname, 'renderer.js')
    }
  });
  mainWindow.loadFile('index.html');
  log.info('Main window created.');
}

/**
 * Sends a message to the Chrome extension via standard output.
 * The message is JSON-encoded and prefixed with a 4-byte length.
 * @param {object} message The message object to send.
 */
function sendToChrome(message) {
    try {
        const json = JSON.stringify(message);
        const buffer = Buffer.from(json);

        const lengthBuffer = Buffer.alloc(4);
        lengthBuffer.writeUInt32LE(buffer.length, 0);

        process.stdout.write(lengthBuffer);
        process.stdout.write(buffer);

        log.info(`Sent message to Chrome: ${json}`);
    } catch (e) {
        log.error('Failed to send message to Chrome:', e.message);
    }
}

// --- App Lifecycle Events ---

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  log.info('App ready. Listening for stdin.');
  // Signal to the extension that the native host is ready.
  sendToChrome({ status: 'ready' });

  // --- Native Messaging Handlers ---

  // Buffer to store incoming data from Chrome.
  let messageBuffer = Buffer.alloc(0);

  process.stdin.on('data', (chunk) => {
    log.info(`Received data chunk of length: ${chunk.length}`);
    messageBuffer = Buffer.concat([messageBuffer, chunk]);

    // Process messages from the buffer as long as a full message exists.
    while (true) {
      // A message needs at least 4 bytes for the length prefix.
      if (messageBuffer.length < 4) {
        break;
      }

      const messageLength = messageBuffer.readUInt32LE(0);
      const totalLength = 4 + messageLength;
      log.info(`Expecting message length: ${messageLength}. Total buffer: ${messageBuffer.length}`);

      // If the full message is not yet in the buffer, wait for more data.
      if (messageBuffer.length < totalLength) {
        log.warn('Buffer not yet full. Waiting for more data.');
        break;
      }

      const messageContent = messageBuffer.slice(4, totalLength);
      // Remove the processed message from the buffer, keeping any remaining data.
      messageBuffer = messageBuffer.slice(totalLength);

      try {
        const message = JSON.parse(messageContent.toString());
        log.info('Successfully parsed message. Sending to renderer.');
        if (mainWindow && !mainWindow.isDestroyed()) {
          // Send the parsed message to the renderer process for display.
          mainWindow.webContents.send('ws-message', message);
        }
      } catch (e) {
        log.error('Failed to parse message:', e.message);
        log.error('Problematic content as string:', messageContent.toString());
      }
    }
  });

  process.stdin.on('end', () => {
    log.info('Stdin stream ended. Quitting app.');
    app.quit();
  });
});

app.on('window-all-closed', () => {
  log.info('All windows closed.');
  // Quit when all windows are closed, except on macOS.
  if (process.platform !== 'darwin') app.quit();
});
