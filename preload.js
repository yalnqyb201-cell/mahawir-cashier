'use strict';
// The only bridge between the web system and the computer: list printers, print raw bytes, print a document silently.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mahawirDesktop', {
  isDesktop: true,
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  printRaw: (name, base64) => ipcRenderer.invoke('print:raw', String(name || ''), String(base64 || '')),
  printHtml: (name, html, opts) => ipcRenderer.invoke('print:html', String(name || ''), String(html || ''),
    { paper: opts && opts.paper === 'A4' ? 'A4' : 'thermal', copies: Math.min(20, Math.max(1, Number(opts && opts.copies) || 1)) }),
});
