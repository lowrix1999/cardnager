
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let mainWindow;
let isQuitting = false; // FLAG: Prevents infinite loop during close

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1250, 
        height: 1000,
        autoHideMenuBar: true,
        backgroundColor: '#121212',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');

    // CLOSE HANDSHAKE (Prevents accidental close)
    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault(); // STOP the close
            mainWindow.webContents.send('check-for-unsaved'); // Ask the Renderer
        }
    });

    // Native Right-Click Menu
    mainWindow.webContents.on('context-menu', (event, params) => {
        const menu = Menu.buildFromTemplate([
            { role: 'cut', enabled: params.editFlags.canCut },
            { role: 'copy', enabled: params.editFlags.canCopy },
            { role: 'paste', enabled: params.editFlags.canPaste },
            { type: 'separator' },
            { role: 'selectAll', enabled: params.editFlags.canSelectAll }
        ]);
        menu.popup({ window: mainWindow });
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// 1. Open File Logic (ASYNC FIX)
ipcMain.handle('open-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ 
        properties: ['openFile', 'multiSelections'], 
        filters: [{ name: 'All Files', extensions: ['*'] }] 
    });
    
    if (canceled || filePaths.length === 0) return [];
    
    // Read files in parallel without blocking the UI
    const promises = filePaths.map(filePath => {
        return new Promise((resolve) => {
            fs.readFile(filePath, 'utf-8', (err, data) => {
                if (err) {
                    console.error("Read Error:", err);
                    resolve(null);
                } else {
                    resolve({ path: filePath, name: path.basename(filePath), content: data });
                }
            });
        });
    });

    const results = await Promise.all(promises);
    return results.filter(f => f !== null);
});

// 2. Save File Logic (ASYNC + SMART BACKUPS)
ipcMain.handle('save-file', async (event, { filePath, content, createBackup }) => {
    try {
        // A. CREATE BACKUP (If requested and file exists)
        if (createBackup && fs.existsSync(filePath)) {
            try {
                // 1. Define Local Backup Directory (_backups inside the file's own folder)
                const fileDir = path.dirname(filePath);
                const backupDir = path.join(fileDir, '_backups');

                // 2. Create the folder asynchronously if it doesn't exist
                if (!fs.existsSync(backupDir)) {
                    await fs.promises.mkdir(backupDir, { recursive: true });
                }

                // 3. Create Timestamped Filename (YYYY-MM-DD_HH-MM-SS)
                const ext = path.extname(filePath);
                const name = path.basename(filePath, ext);
                
                const now = new Date();
                const dateStr = now.toISOString().split('T')[0];
                const timeStr = `${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}`;
                
                // Result: script_BACKUP_2026-01-30_14-30-05.js
                const backupFilename = `${name}_BACKUP_${dateStr}_${timeStr}${ext}`;
                const backupPath = path.join(backupDir, backupFilename);

                // 4. Copy the OLD file to backup folder (Async & Fast)
                // We use copyFile instead of read/write because it's faster and safer
                await fs.promises.copyFile(filePath, backupPath);
                
            } catch (backupErr) {
                // If backup fails (e.g. permission error), log it but proceed with saving
                console.error("Backup Failed (skipping):", backupErr);
            }
        }

        // B. SAVE NEW CONTENT (Async)
        await fs.promises.writeFile(filePath, content, 'utf-8');
        return true;

    } catch (e) {
        console.error("Save Operation Failed:", e);
        return false;
    }
});

// 3. Multi-Terminal Logic
ipcMain.handle('open-terminal', async (event, { filePath, type }) => {
    if (!filePath) return;
    const folder = path.dirname(filePath);

    let command = '';
    
    if (process.platform === 'win32') {
        switch (type) {
            case 'cmd':
                command = `start cmd.exe /K "cd /d "${folder}""`; 
                break;
            case 'gitbash':
                const gitBashPath = 'C:\\Program Files\\Git\\git-bash.exe';
                if (fs.existsSync(gitBashPath)) {
                    command = `"${gitBashPath}" --cd="${folder}"`;
                } else {
                    command = `start git-bash --cd="${folder}"`;
                }
                break;
            default: // PowerShell
                command = `start powershell.exe -NoExit -Command "cd '${folder}'"`; 
                break;
        }
    } else {
        command = `open -a Terminal "${folder}"`; 
    }

    exec(command, (error) => {
        if (error) {
            console.error(`Error launching ${type}:`, error);
        }
    });
});

// 4. App Control Logic
ipcMain.handle('save-as-dialog', async (event) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: "Save File As...",
        defaultPath: "Untitled",
        filters: [
            { name: 'All Files', extensions: ['*'] },
            { name: 'JavaScript', extensions: ['js', 'jsx', 'mjs'] },
            { name: 'HTML', extensions: ['html', 'htm'] },
            { name: 'CSS', extensions: ['css', 'scss'] },
            { name: 'Python', extensions: ['py', 'pyw'] },
            { name: 'Text File', extensions: ['txt', 'md', 'json'] },
            { name: 'C/C++', extensions: ['c', 'cpp', 'h'] },
            { name: 'C#', extensions: ['cs'] },
            { name: 'Java', extensions: ['java'] }
        ]
    });
    if (canceled) return null;
    return filePath;
});

// 5. Config/Session Logic (ASYNC FIX)
ipcMain.handle('get-config', async () => {
    const configPath = path.join(app.getPath('userData'), 'config.json');
    return new Promise((resolve) => {
        fs.readFile(configPath, 'utf-8', (err, data) => {
            if (err) resolve({});
            else {
                try { resolve(JSON.parse(data)); } 
                catch (e) { resolve({}); }
            }
        });
    });
});

ipcMain.handle('save-config', async (event, data) => {
    const configPath = path.join(app.getPath('userData'), 'config.json');
    
    // Read old config first (Async)
    fs.readFile(configPath, 'utf-8', (err, oldContent) => {
        let current = {};
        if (!err && oldContent) {
            try { current = JSON.parse(oldContent); } catch (e) {}
        }
        
        const updated = { ...current, ...data };
        
        // Write new config (Async)
        fs.writeFile(configPath, JSON.stringify(updated, null, 2), (err) => {
            if (err) console.error("Config Save Error:", err);
        });
    });
});

// 6. Exit Handlers (The Handshake)
ipcMain.handle('exit-app', () => {
    mainWindow.close();
});

ipcMain.on('close-confirmed', () => {
    isQuitting = true; 
    app.quit();
});

// 7. Native Dialog Handler (Prevents Freezing)
ipcMain.handle('show-confirm', async (event, { message, detail }) => {
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Yes', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Confirmation',
        message: message,
        detail: detail,
        noLink: true
    });
    return result.response === 0; // Returns true if 'Yes' was clicked
});

