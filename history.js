/* history.js — agrège tous les logs passés, indexés par EXERCICE (pas par date). */
"use strict";

const HIST = (() => {
  // l'uid "s2-backSquat-0" -> exId "backSquat" (les ids sont en camelCase, sans tiret)
  function exIdFromUid(uid) {
    const parts = uid.split("-");
    if (parts.length < 3) return null; // mobilité (checklist) = "s1" -> pas d'exo
    return parts.slice(1, -1).join("-");
  }

  // nom lisible depuis le programme courant
  function nameIndex() {
    const idx = {};
    for (const j of WEEK.semaine.jours) {
      if (j.type !== "seance") continue;
      for (const sec of j.sections) for (const ex of sec.exercices) idx[ex.id] = { nom: ex.nom, top: !!(ex.metadonnees && ex.metadonnees.top_set_suivi) || !!ex.top_set, bloc: j.bloc };
    }
    return idx;
  }

  const e1rmOf = (charge, reps) => (charge != null && reps ? +(charge * (1 + reps / 30)).toFixed(1) : null);

  // synthèse d'un exercice sur une séance : top set (charge max), e1RM (RPE>=8), tonnage
  function summarize(series) {
    const done = series.filter((s) => s.done && s.charge != null);
    if (!done.length) {
      const reps = series.filter((s) => s.done);
      return { topCharge: null, topReps: reps[0] ? reps[0].reps : null, e1rm: null, tonnage: 0, rpe: reps.length ? Math.max(...reps.map((s) => s.rpe || 0)) || null : null };
    }
    const top = done.reduce((a, b) => (b.charge > a.charge ? b : a));
    let e1rm = null;
    for (const s of done) if ((s.rpe || 0) >= 8) { const e = e1rmOf(s.charge, s.reps); if (e && (!e1rm || e > e1rm)) e1rm = e; }
    const tonnage = Math.round(done.reduce((t, s) => t + s.charge * (s.reps || 0), 0));
    return { topCharge: top.charge, topReps: top.reps, e1rm, tonnage, rpe: top.rpe };
  }

  // charge tout l'historique -> { exId: [ {date, ...summary}, ... ] trié par date }
  async function buildIndex() {
    const { keys } = await DB.list("log:");
    const byEx = {};
    for (const key of keys.sort()) {
      const r = await DB.get(key); if (!r) continue;
      const date = key.replace("log:", "");
      const rec = JSON.parse(r.value);
      for (const [uid, log] of Object.entries(rec.logs || {})) {
        if (!log.series) continue;
        const exId = exIdFromUid(uid); if (!exId) continue;
        const sum = summarize(log.series);
        if (sum.topCharge == null && sum.topReps == null) continue;
        (byEx[exId] = byEx[exId] || []).push({ date, ...sum });
      }
    }
    for (const k in byEx) byEx[k].sort((a, b) => a.date.localeCompare(b.date));
    return byEx;
  }

  // dernière séance (strictement avant `beforeDate`) où cet exo a été fait
  function lastBefore(index, exId, beforeDate) {
    const arr = index[exId]; if (!arr) return null;
    const prev = arr.filter((e) => e.date < beforeDate);
    return prev.length ? prev[prev.length - 1] : null;
  }

  return { buildIndex, lastBefore, nameIndex, e1rmOf };
})();
