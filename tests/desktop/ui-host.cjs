// Isolated component harness: no preload, application bridge or runtime.
const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.UAH_DATA_DIR);
app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1280, height: 1100, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(process.env.UAH_UI_PREVIEW_URL);
});
app.on('window-all-closed', () => app.quit());
