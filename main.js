'use strict';
/**
 * Mahawir Cashier: the web system in a desktop window, plus direct printing to the printers installed on this computer.
 *  - lists the Windows printers (no setup),
 *  - sends raw ESC/POS / TSPL bytes to a printer's Windows queue (thermal receipts, labels, cash drawer),
 *  - prints a document silently to a normal printer (A4 invoices and reports).
 * The web system itself is loaded from the server, so it always shows the latest version; only this shell is installed.
 */
const { app, BrowserWindow, Menu, ipcMain, shell, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

const EDITIONS = {
  standard: { label: 'النسخة العادية', url: 'https://app.mahawirtech.com' },
  hr: { label: 'نسخة الموارد البشرية', url: 'https://hr.mahawirtech.com' },
};
const TRUSTED = new Set([
  ...Object.values(EDITIONS).map((e) => new URL(e.url).origin),
  'https://saudi-erp-demo.onrender.com', 'https://saudi-erp-hr.onrender.com',
]);
const IS_WIN = process.platform === 'win32';

let win = null;
let config = { edition: 'standard', autoStart: true };

// ---------------------------------------------------------------- settings
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { /* first run */ }
  if (!EDITIONS[config.edition]) config.edition = 'standard';
}
function saveConfig() {
  try { fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(config)); } catch { /* ignore */ }
}
function applyAutoStart() {
  if (!app.isPackaged) return;
  try { app.setLoginItemSettings({ openAtLogin: !!config.autoStart }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- raw printing (thermal printers, labels, drawer)
const WIN_SRC = [
  'using System; using System.Runtime.InteropServices;',
  'public class RawP {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] public class DOCINFO { [MarshalAs(UnmanagedType.LPStr)] public string n; [MarshalAs(UnmanagedType.LPStr)] public string o; [MarshalAs(UnmanagedType.LPStr)] public string t; }',
  '  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool OpenPrinter(string p, out IntPtr h, IntPtr d);',
  '  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);',
  '  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool StartDocPrinter(IntPtr h, int l, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO d);',
  '  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);',
  '  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);',
  '  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);',
  '  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);',
  '  public static void Send(string printer, byte[] data) {',
  '    IntPtr h; if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Cannot open printer: " + printer);',
  '    var d = new DOCINFO(); d.n = "Mahawir"; d.t = "RAW";',
  '    try { if (!StartDocPrinter(h, 1, d)) throw new Exception("StartDoc failed"); StartPagePrinter(h); int w; WritePrinter(h, data, data.Length, out w); EndPagePrinter(h); EndDocPrinter(h); }',
  '    finally { ClosePrinter(h); }',
  '  }',
  '}',
].join('\n');

// The helper is compiled once and cached as a small DLL, so later prints start fast.
const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$src = @'",
  WIN_SRC,
  "'@",
  '$dll = $env:MEHWAR_DLL',
  'try {',
  "  if ($dll -and (Test-Path $dll)) { Add-Type -Path $dll } else { throw 'nodll' }",
  '} catch {',
  '  if ($dll) {',
  '    try { Remove-Item $dll -Force -ErrorAction SilentlyContinue; Add-Type -TypeDefinition $src -OutputAssembly $dll; Add-Type -Path $dll }',
  '    catch { Add-Type -TypeDefinition $src }',
  '  } else { Add-Type -TypeDefinition $src }',
  '}',
  '[RawP]::Send($env:MEHWAR_PRINTER, [IO.File]::ReadAllBytes($env:MEHWAR_FILE))',
  '',
].join('\r\n');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 30000, windowsHide: true, maxBuffer: 8e6, ...opts },
    (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().slice(0, 400))) : resolve(String(out)))));

async function doSendRaw(name, buf) {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.bin`);
  fs.writeFileSync(bin, buf);
  try {
    if (IS_WIN) {
      const ps1 = path.join(dir, 'raw-print.ps1');
      fs.writeFileSync(ps1, '﻿' + PS_SCRIPT, 'utf8');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
        { env: { ...process.env, MEHWAR_PRINTER: name, MEHWAR_FILE: bin, MEHWAR_DLL: path.join(dir, 'rawp.dll') } });
    } else {
      await new Promise((resolve, reject) => {
        const c = execFile('lp', ['-d', name, '-o', 'raw'], { timeout: 30000 }, (e, _o, err) => (e ? reject(new Error(String(err || e.message).slice(0, 300))) : resolve()));
        c.stdin.end(buf);
      });
    }
  } finally { fs.rmSync(bin, { force: true }); }
}
let rawChain = Promise.resolve();
const sendRaw = (name, buf) => { const job = rawChain.then(() => doSendRaw(name, buf)); rawChain = job.catch(() => {}); return job; };

// ---------------------------------------------------------------- silent document printing (A4)
async function printDocument(name, html, opts) {
  const dir = path.join(os.tmpdir(), 'mahawir-print');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.html`);
  fs.writeFileSync(file, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
  try {
    await new Promise((resolve, reject) => {
      w.webContents.once('did-finish-load', resolve);
      w.webContents.once('did-fail-load', (_e, _c, desc) => reject(new Error(desc || 'load failed')));
      w.loadFile(file);
    });
    await new Promise((r) => setTimeout(r, 300));       // let images and fonts settle
    await new Promise((resolve, reject) => {
      const o = { silent: true, printBackground: true, copies: opts.copies || 1, margins: { marginType: opts.paper === 'A4' ? 'default' : 'none' } };
      if (name) o.deviceName = name;
      if (opts.paper === 'A4') o.pageSize = 'A4';
      w.webContents.print(o, (ok, reason) => (ok ? resolve() : reject(new Error(reason || 'print failed'))));
    });
  } finally { try { w.destroy(); } catch { /* ignore */ } fs.rmSync(file, { force: true }); }
}

// ---------------------------------------------------------------- IPC (only from the trusted sites)
const trusted = (e) => { try { return TRUSTED.has(new URL(e.senderFrame.url).origin); } catch { return false; } };
async function installed() {
  if (!win) return [];
  const list = await win.webContents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
}
const need = async (name) => { if (!(await installed()).some((p) => p.name === name)) throw new Error(`Printer not found on this computer: ${name}`); };

ipcMain.handle('printers:list', async (e) => { if (!trusted(e)) throw new Error('Not allowed'); return installed(); });
ipcMain.handle('print:raw', async (e, name, b64) => {
  if (!trusted(e)) throw new Error('Not allowed');
  await need(name);
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length || buf.length > 8e6) throw new Error('Invalid print data');
  await sendRaw(name, buf);
  return true;
});
ipcMain.handle('print:html', async (e, name, html, opts) => {
  if (!trusted(e)) throw new Error('Not allowed');
  if (name) await need(name);
  if (!html || html.length > 8e6) throw new Error('Invalid document');
  await printDocument(name, html, opts || {});
  return true;
});

// ---------------------------------------------------------------- window
function loadApp() {
  if (!win) return;
  win.loadURL(EDITIONS[config.edition].url).catch(() => { /* did-fail-load shows the offline page */ });
}

function buildMenu() {
  const editions = Object.entries(EDITIONS).map(([key, ed]) => ({
    label: ed.label, type: 'radio', checked: config.edition === key,
    click: () => { config.edition = key; saveConfig(); loadApp(); },
  }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'التطبيق', submenu: [
      { label: 'إعادة تحميل', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.reload() },
      { label: 'إعادة تحميل كاملة', accelerator: 'CmdOrCtrl+Shift+R', click: () => win && win.webContents.reloadIgnoringCache() },
      { label: 'ملء الشاشة', accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
      { label: 'تكبير', role: 'zoomIn' }, { label: 'تصغير', role: 'zoomOut' }, { label: 'الحجم الطبيعي', role: 'resetZoom' },
      { type: 'separator' },
      { label: 'تشغيل التطبيق مع ويندوز', type: 'checkbox', checked: !!config.autoStart, click: (m) => { config.autoStart = m.checked; saveConfig(); applyAutoStart(); } },
      { label: 'أدوات الدعم الفني', accelerator: 'CmdOrCtrl+Shift+I', click: () => win && win.webContents.openDevTools({ mode: 'detach' }) },
      { type: 'separator' },
      { label: 'إغلاق', role: 'quit' },
    ] },
    { label: 'النسخة', submenu: editions },
    { label: 'عن التطبيق', click: () => dialog.showMessageBox(win, { type: 'info', title: 'محاور تيك', message: 'محاور تيك — تطبيق الكاشير', detail: `الإصدار ${app.getVersion()}\nيفتح النظام ويطبع مباشرة على الطابعات المثبتة على هذا الجهاز.` }) },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 820, show: false, backgroundColor: '#ffffff', autoHideMenuBar: true, title: 'محاور تيك',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // Links to other sites (WhatsApp, etc.) open in the normal browser; the app never leaves the system's own sites.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    let u; try { u = new URL(url); } catch { e.preventDefault(); return; }
    if (u.protocol === 'file:' || TRUSTED.has(u.origin)) return;
    e.preventDefault();
    if (u.protocol === 'https:') shell.openExternal(url);
  });
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMain) => {
    if (!isMain || code === -3) return;                    // -3 = a navigation that was replaced by another one
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { u: EDITIONS[config.edition].url } });
  });
  loadApp();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.mahawirtech.cashier');
    loadConfig();
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'fullscreen', 'clipboard-sanitized-write', 'notifications'].includes(perm)));
    buildMenu();
    createWindow();
    applyAutoStart();
  });
  app.on('window-all-closed', () => app.quit());
}
