/* io.js — export (JSON backup + CSV analyse) et import (avec remplacer/fusionner). */
"use strict";

const IO = (() => {
  // -------- collecte de toutes les séances loguées --------
  async function collect() {
    const { keys } = await DB.list("log:");
    const data = {};
    for (const k of keys) { const r = await DB.get(k); if (r) data[k] = JSON.parse(r.value); }
    return data;
  }

  // -------- téléchargement d'un Blob (PWA Android : va dans Téléchargements) --------
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function stamp() { return new Date().toISOString().slice(0, 10); }

  // -------- EXPORT JSON : backup complet, réimportable --------
  async function exportJSON() {
    const data = await collect();
    const obj = { _format: "carnet-export", _version: 1, exportedAt: new Date().toISOString(), data };
    download(`carnet-backup-${stamp()}.json`, JSON.stringify(obj, null, 2), "application/json");
    return Object.keys(data).length;
  }

  // -------- EXPORT CSV : vue plate, 1 ligne par série, pour Excel/Sheets/Python --------
  async function exportCSV() {
    const data = await collect();
    const rows = [["date", "exercice_uid", "serie", "charge_kg", "reps", "duree_sec", "rpe", "vitesse", "srpe_seance"]];
    for (const key of Object.keys(data).sort()) {
      const date = key.replace("log:", "");
      const rec = data[key]; const srpe = rec.srpe ?? "";
      for (const [uid, log] of Object.entries(rec.logs || {})) {
        if (!log.series) continue; // on saute la mobilité (checklist)
        log.series.forEach((s, i) => {
          if (!s.done) return;
          rows.push([date, uid, i + 1, s.charge ?? "", s.reps ?? "", s.duree_sec ?? "", s.rpe ?? "", s.vitesse ?? "", srpe]);
        });
      }
    }
    const csv = rows.map((r) => r.map((c) => {
      const v = String(c);
      return /[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(",")).join("\n");
    download(`carnet-export-${stamp()}.csv`, csv, "text/csv");
    return rows.length - 1;
  }

  // -------- IMPORT : lit un JSON d'export, applique remplacer ou fusionner --------
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsText(file);
    });
  }

  function parseExport(text) {
    const obj = JSON.parse(text);
    if (!obj || obj._format !== "carnet-export" || !obj.data) throw new Error("Fichier non reconnu (pas un backup Carnet).");
    return obj.data; // { "log:YYYY-MM-DD": {logs,srpe,meta,rest} }
  }

  // mode = "replace" | "merge"
  async function applyImport(data, mode) {
    if (mode === "replace") {
      const { keys } = await DB.list("log:");
      for (const k of keys) await DB.delete(k);
    }
    let n = 0;
    for (const [key, rec] of Object.entries(data)) {
      if (mode === "merge") {
        // fusion : on n'écrase pas une séance déjà présente
        const existing = await DB.get(key);
        if (existing) continue;
      }
      await DB.set(key, JSON.stringify(rec)); n++;
    }
    return n;
  }

  return { exportJSON, exportCSV, readFile, parseExport, applyImport };
})();
