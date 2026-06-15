/* app.js — logique de l'app en JS vanilla (pas de framework, pas de build). */
"use strict";

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const k in attrs) {
    if (k === "class") n.className = attrs[k];
    else if (k === "html") n.innerHTML = attrs[k];
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] === true) n.setAttribute(k, "");
    else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
};
const RPE_COLOR = { 6: "#7FB069", 7: "#A8B545", 8: "#D2A03A", 9: "#D97B2F", 10: "#D9532B" };
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const chargeLabel = (c) => !c ? "" :
  c.type === "fixe" ? `${c.valeur_kg} kg` :
  c.type === "par_main" ? `${c.valeur_kg} kg / main` :
  c.type === "plage" ? `${c.min_kg}–${c.max_kg} kg` : (c.libelle || "");
const seriesCount = (f) => (f && f.series) || 1;
const unitOf = (f) =>
  f.type === "series_temps" ? { key: "duree_sec", step: 5, suffix: "s", init: f.duree_sec } :
  f.type === "series_distance" ? { key: "distance_m", step: 5, suffix: "m", init: f.distance_m } :
  { key: "reps", step: 1, suffix: "", init: f.reps != null ? f.reps : "" };

function buildCards(day) {
  const cards = [];
  for (const sec of day.sections) {
    if (sec.titre.toUpperCase().includes("MOBILIT")) cards.push({ kind: "checklist", uid: `s${sec.numero}`, section: sec, steps: sec.exercices });
    else sec.exercices.forEach((ex, i) => cards.push({ kind: "exo", uid: `s${sec.numero}-${ex.id}-${i}`, section: sec, ex }));
  }
  cards.push({ kind: "fin", uid: "fin" });
  return cards;
}
const initExoLog = (ex) => ({
  ramp: {},
  series: Array.from({ length: seriesCount(ex.format) }, () => {
    const u = unitOf(ex.format);
    return { charge: ex.charge && ex.charge.valeur_kg != null ? ex.charge.valeur_kg : null, [u.key]: u.init, rpe: null, vitesse: null, done: false };
  }),
});

function computeStats(cards, logs) {
  let total = 0, done = 0, tonnage = 0; const rpes = [];
  for (const c of cards) {
    if (c.kind === "exo") {
      const l = logs[c.uid];
      total += l ? l.series.length : seriesCount(c.ex.format);
      if (l) for (const s of l.series) if (s.done) { done++; if (s.charge != null && s.reps != null) tonnage += s.charge * s.reps; if (s.rpe) rpes.push(s.rpe); }
    } else if (c.kind === "checklist") {
      total += c.steps.length;
      const l = logs[c.uid]; if (l) done += Object.values(l.steps).filter(Boolean).length;
    }
  }
  return { total, done, tonnage: Math.round(tonnage), rpeMoyen: rpes.length ? (rpes.reduce((a, b) => a + b, 0) / rpes.length).toFixed(1) : null };
}

/* ---------- state ---------- */
const S = {
  dayIdx: null, screen: "apercu", logs: {}, srpe: null, meta: {},
  rest: null, pos: 0, loggedDates: [], ui: {}, hist: {}, progEx: null,
};
const toggleUI = (k) => { S.ui[k] = !S.ui[k]; render(); };
async function refreshHist() { try { S.hist = await HIST.buildIndex(); } catch (e) { S.hist = {}; } }
const days = WEEK.semaine.jours;
const root = $("#app");
const dayOf = () => (S.dayIdx != null ? days[S.dayIdx] : null);
const storageKey = () => (dayOf() ? `log:${dayOf().date}` : null);

function persist() {
  const key = storageKey(); if (!key) return;
  DB.set(key, JSON.stringify({ logs: S.logs, srpe: S.srpe, meta: S.meta, rest: S.rest })).catch(() => {});
}
async function loadDay() {
  const key = storageKey(); S.logs = {}; S.srpe = null; S.meta = {}; S.rest = null;
  if (!key) return;
  try { const r = await DB.get(key); if (r) { const d = JSON.parse(r.value); S.logs = d.logs || {}; S.srpe = d.srpe ?? null; S.meta = d.meta || {}; S.rest = d.rest || null; } } catch (e) {}
  // chrono périmé (rouvert bien après la fin du repos) → on l'oublie
  if (S.rest && (Date.now() - S.rest.startedAt) / 1000 > S.rest.target + 3600) S.rest = null;
}
async function refreshLogged() {
  try { const r = await DB.list("log:"); S.loggedDates = (r.keys || []).map((k) => String(k).replace("log:", "")); } catch (e) {}
}
const setLog = (uid, value) => { S.logs = { ...S.logs, [uid]: value }; persist(); render(); };

/* ---------- rest dock ---------- */
let dockTimer = null, dockBuzzed = false;
function startRest(target, label) { S.rest = { startedAt: Date.now(), target, label }; dockBuzzed = false; persist(); render(); }
function stopRest() { S.rest = null; persist(); render(); }
function tickDock() {
  const d = $("#dock"); if (!d || !S.rest) return;
  const elapsed = Math.floor((Date.now() - S.rest.startedAt) / 1000);
  const ready = elapsed >= S.rest.target;
  $(".dock-time", d).textContent = fmtClock(elapsed);
  $(".dock-time", d).style.color = ready ? "var(--green)" : "var(--ink)";
  $(".pbar > div", d).style.width = Math.min(100, (elapsed / S.rest.target) * 100) + "%";
  $(".pbar > div", d).style.background = ready ? "var(--green)" : "var(--brass)";
  if (ready && !dockBuzzed) { dockBuzzed = true; try { navigator.vibrate && navigator.vibrate([180, 90, 180]); } catch (e) {} }
}

/* ---------- mini graphe SVG (sans librairie) ---------- */
function lineChart(points, opts = {}) {
  // points : [{x:'2026-06-01', y:100}], déjà triés
  const W = 320, H = 130, padL = 34, padR = 10, padT = 12, padB = 22;
  const vals = points.filter((p) => p.y != null);
  if (vals.length === 0) return el("div", { class: "sub", style: "font-size:13px" }, "Pas encore de donnée.");
  const ys = vals.map((p) => p.y);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.15; min -= pad; max += pad;
  const n = points.length;
  const xAt = (i) => padL + (n <= 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (n - 1));
  const yAt = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "chart"); svg.setAttribute("width", "100%");
  const add = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
  // graduations min/max
  [min + pad, max - pad].forEach((v) => {
    add("text", { x: 2, y: yAt(v) + 4, fill: "#6B747E", "font-size": "10" }).textContent = Math.round(v);
    add("line", { x1: padL, y1: yAt(v), x2: W - padR, y2: yAt(v), stroke: "#2C333B", "stroke-width": "1" });
  });
  // ligne
  const color = opts.color || "#E0A93C";
  let d = "";
  vals.forEach((p, i) => { const idx = points.indexOf(p); d += (i ? "L" : "M") + xAt(idx) + " " + yAt(p.y) + " "; });
  add("path", { d, fill: "none", stroke: color, "stroke-width": "2.5", "stroke-linejoin": "round" });
  // points
  points.forEach((p, i) => { if (p.y == null) return; add("circle", { cx: xAt(i), cy: yAt(p.y), r: "3.5", fill: color }); });
  // labels x (1er et dernier)
  [0, n - 1].forEach((i) => { if (points[i]) add("text", { x: xAt(i), y: H - 6, fill: "#6B747E", "font-size": "10", "text-anchor": i === 0 ? "start" : "end" }).textContent = points[i].x.slice(5); });
  return svg;
}

/* ---------- mini graphe SVG (sans librairie) — fin ---------- */
function stepper(value, step, suffix, onChange) {
  return el("div", { class: "stepper" },
    el("button", { onclick: () => onChange(-step) }, "−"),
    el("div", { class: "val" }, String(value), suffix ? el("span", { html: ` ${suffix}`, style: "font-size:14px;color:var(--dim)" }) : null),
    el("button", { onclick: () => onChange(step) }, "+"));
}

// Stepper poids : ±2,5 et ±1,25, + saisie manuelle directe (kettlebell, plaques 1,5 kg, etc.)
function weightStepper(value, onSet) {
  const clamp = (v) => Math.max(0, +Number(v).toFixed(2));
  const input = el("input", { class: "wval", type: "number", inputmode: "decimal", step: "0.25", value: String(value),
    onchange: (e) => onSet(clamp(e.target.value)) });
  return el("div", {},
    el("div", { class: "stepper" },
      el("button", { onclick: () => onSet(clamp(value - 2.5)) }, "−"),
      input,
      el("button", { onclick: () => onSet(clamp(value + 2.5)) }, "+")),
    el("div", { class: "fine" },
      el("button", { class: "finebtn", onclick: () => onSet(clamp(value - 1.25)) }, "−1.25"),
      el("button", { class: "finebtn", onclick: () => onSet(clamp(value - 0.5)) }, "−0.5"),
      el("button", { class: "finebtn", onclick: () => onSet(clamp(value + 0.5)) }, "+0.5"),
      el("button", { class: "finebtn", onclick: () => onSet(clamp(value + 1.25)) }, "+1.25")));
}

/* ---------- série row ---------- */
const VITESSE_OPTS = ["très lent", "lent", "moyen", "rapide", "explosif"];

function serieRow(card, l, i) {
  const ex = card.ex, s = l.series[i], u = unitOf(ex.format);
  const openKey = `open:${card.uid}:${i}`;
  const isOpen = !!S.ui[openKey];
  const showVit = ex.metadonnees && ex.metadonnees.vitesse_pertinente;
  const setSeries = (p) => { const series = l.series.slice(); series[i] = { ...s, ...p }; setLog(card.uid, { ...l, series }); };
  // valider = capter le RPE (tap) + figer la série + lancer le repos
  const validate = (rpe) => {
    S.ui[openKey] = false;
    const series = l.series.slice(); series[i] = { ...s, rpe, done: true }; setLog(card.uid, { ...l, series });
    if (ex.repos_sec) startRest(ex.repos_sec, ex.nom);
  };

  // ----- en-tête : valeurs prévues + (repli) bouton éditer -----
  const head = el("div", { class: "serie-head" },
    el("button", { class: "serie-tag" + (s.done ? " ok" : ""), onclick: () => toggleUI(openKey),
      "aria-label": "éditer", title: "éditer charge / reps" }, s.done ? "✓" : `S${i + 1}`),
    el("button", { class: "serie-main", onclick: () => toggleUI(openKey), title: "toucher pour ajuster" },
      (s.charge != null ? `${s.charge} kg × ` : "") + `${s[u.key]}${u.suffix}`,
      ex.format.par_cote ? el("span", { style: "color:var(--dim);font-weight:500" }, " /côté") : null,
      el("span", { class: "edit-hint" }, " ✎")),
    s.vitesse ? el("span", { class: "vtag" }, s.vitesse) : null);

  const kids = [head];

  // ----- zone rapide TOUJOURS visible : (vitesse si exo explosif) + RPE qui valide -----
  const quick = el("div", { class: "quick" });
  if (showVit) {
    quick.append(el("div", { class: "field-label", style: "margin:10px 0 4px" }, "VITESSE"));
    quick.append(el("div", { class: "row wrap" }, VITESSE_OPTS.map((v) =>
      el("button", { class: "vit5" + (s.vitesse === v ? " on" : ""), onclick: () => setSeries({ vitesse: s.vitesse === v ? null : v }) }, v))));
  }
  quick.append(el("div", { class: "field-label", style: "margin:10px 0 4px" }, s.done ? "RPE — touche pour corriger" : "RPE — touche pour valider"));
  quick.append(el("div", { class: "row" }, [6, 7, 8, 9, 10].map((r) =>
    el("button", { class: "rpe" + (s.rpe === r ? " on" : ""),
      style: s.rpe === r ? `background:${RPE_COLOR[r]};color:#15181C;border-color:${RPE_COLOR[r]}` : "",
      onclick: () => validate(r) }, String(r)))));
  kids.push(quick);

  // ----- panneau d'ajustement (ouvert seulement si écart) -----
  if (isOpen) {
    const body = el("div", { class: "serie-body" });
    const fields = el("div", { style: "display:flex;gap:16px;flex-wrap:wrap;padding:12px 0" });
    if (s.charge != null) fields.append(el("div", {}, el("div", { class: "field-label" }, "CHARGE (kg)"),
      weightStepper(s.charge, (v) => setSeries({ charge: v }))));
    fields.append(el("div", {}, el("div", { class: "field-label" }, u.key === "reps" ? "REPS" : u.key === "duree_sec" ? "DURÉE (s)" : "DISTANCE (m)"),
      stepper(s[u.key], u.step, u.suffix, (d) => setSeries({ [u.key]: Math.max(0, s[u.key] + d) }))));
    body.append(fields);
    body.append(el("div", { class: "sub", style: "font-size:13px;padding-bottom:4px" }, "Ajuste si différent du prévu, puis touche ton RPE au-dessus pour valider."));
    kids.push(body);
  }

  return el("div", { class: "serie" + (s.done ? " done" : "") }, kids);
}

/* ---------- exo card ---------- */
function exoCard(card) {
  const ex = card.ex, l = S.logs[card.uid] || initExoLog(ex);
  const allDone = l.series.every((s) => s.done);
  const node = el("div", { class: "wrap", style: "padding-top:16px" });

  node.append(el("div", { style: "display:flex;justify-content:space-between;align-items:baseline" },
    el("div", { class: "eyebrow" }, `${card.section.numero} · ${card.section.titre.replace(/\s*\(.*\)/, "")}`),
    ex.top_set ? el("span", { class: "bc", style: "font-size:12px;color:var(--amber);border:1px solid #E0A93C55;border-radius:6px;padding:1px 7px" }, "TOP SET") : null));
  node.append(el("h2", { class: "exo" }, ex.nom, allDone ? el("span", { style: "color:var(--green);font-size:22px" }, " ✓") : null));

  const chips = el("div", { class: "chips" }, el("span", { class: "chip" }, ex.format_texte));
  if (chargeLabel(ex.charge)) chips.append(el("span", { class: "chip" }, chargeLabel(ex.charge)));
  if (ex.repos_texte) chips.append(el("span", { class: "chip" }, `repos ${ex.repos_texte}`));
  node.append(chips);

  // F10 — rappel "dernière fois" (séance précédente du même exo)
  const prev = dayOf() ? HIST.lastBefore(S.hist, ex.id, dayOf().date) : null;
  if (prev && prev.topCharge != null) {
    node.append(el("div", { class: "lasttime" },
      el("span", { class: "lt-k" }, "Dernière fois"),
      el("span", { class: "lt-v num" }, `${prev.topCharge} kg × ${prev.topReps}${prev.rpe ? " @" + prev.rpe : ""}`),
      el("span", { class: "lt-d num" }, prev.date.slice(5))));
  } else if (prev && prev.topReps != null) {
    node.append(el("div", { class: "lasttime" },
      el("span", { class: "lt-k" }, "Dernière fois"),
      el("span", { class: "lt-v num" }, `${prev.topReps} reps${prev.rpe ? " @" + prev.rpe : ""}`),
      el("span", { class: "lt-d num" }, prev.date.slice(5))));
  }

  if (ex.montee_en_gamme && ex.montee_en_gamme.length) {
    node.append(el("div", { class: "field-label", style: "margin-top:0" }, "MONTÉE EN GAMME"));
    node.append(el("div", { class: "ramp", style: "margin-bottom:14px" }, ex.montee_en_gamme.map((p) =>
      el("button", { class: "pill" + (l.ramp[p.palier] ? " on" : ""), onclick: () => setLog(card.uid, { ...l, ramp: { ...l.ramp, [p.palier]: !l.ramp[p.palier] } }) },
        (l.ramp[p.palier] ? "✓ " : "") + `${p.charge_kg} kg`,
        el("span", { style: "font-weight:500;opacity:.75" }, ` · ${String(p.reps_label).split(" ")[0]}r`)))));
  }

  l.series.forEach((_, i) => node.append(serieRow(card, l, i)));

  const addRow = el("div", { class: "addrow" },
    el("button", { class: "adder", onclick: () => { const last = l.series[l.series.length - 1]; setLog(card.uid, { ...l, series: [...l.series, { ...last, rpe: null, vitesse: null, done: false, _open: false }] }); } }, "+ série"));
  if (l.series.length > 1) addRow.append(el("button", { class: "adder", style: "flex:0 0 90px;color:var(--faint)", onclick: () => setLog(card.uid, { ...l, series: l.series.slice(0, -1) }) }, "− série"));
  node.append(addRow);

  // commentaire libre par exercice
  const noteKey = `note:${card.uid}`, noteOpen = !!S.ui[noteKey] || (l.commentaire && l.commentaire.length);
  if (noteOpen) {
    node.append(el("textarea", { class: "exonote", placeholder: "Note (sensation, matériel, douleur…)",
      oninput: (e) => { l.commentaire = e.target.value; S.logs = { ...S.logs, [card.uid]: l }; persist(); } },
      l.commentaire || ""));
  } else {
    node.append(el("button", { class: "addnote", onclick: () => toggleUI(noteKey) }, "＋ ajouter une note"));
  }

  if (ex.reference && (ex.reference.intention || ex.reference.execution)) {
    const refKey = `ref:${card.uid}`, open = !!S.ui[refKey];
    node.append(el("button", { class: "reftoggle", onclick: () => toggleUI(refKey) }, open ? "▾ Masquer les détails" : "▸ Intention · exécution · cues"));
    if (open) {
      const r = ex.reference, box = el("div", { class: "ref" });
      if (r.note) box.append(el("p", { style: "margin:0;color:var(--amber)" }, r.note));
      if (r.intention) box.append(el("p", { style: "margin:0", html: `<b>Intention.</b> ${r.intention}` }));
      if (r.execution) box.append(el("p", { style: "margin:0", html: `<b>Exécution.</b> ${r.execution}` }));
      if (r.cues) box.append(el("p", { style: "margin:0", html: `<b>Cues.</b> ${r.cues}` }));
      if (r.erreur) box.append(el("p", { style: "margin:0;color:#D9846B", html: `<b>Erreur.</b> ${r.erreur}` }));
      node.append(box);
    }
  }
  return node;
}

/* ---------- checklist card ---------- */
function checklistCard(card) {
  const l = S.logs[card.uid] || { steps: {} };
  const node = el("div", { class: "wrap", style: "padding-top:16px" });
  node.append(el("div", { class: "eyebrow" }, `${card.section.numero} · Mobilité`));
  node.append(el("h2", { class: "exo" }, card.section.titre.replace(/\s*\(.*\)/, "")));
  if (card.section.sous_titre) node.append(el("div", { class: "sub", style: "margin-bottom:12px" }, card.section.sous_titre));
  card.steps.forEach((st, i) => {
    const on = !!l.steps[i];
    const stepKey = `step:${card.uid}:${i}`, stOpen = !!S.ui[stepKey];
    const toggleStep = () => {
      const nextOn = !on;
      const steps = { ...l.steps, [i]: nextOn };
      // tenue au temps → on lance un chrono visible pendant l'exercice
      if (nextOn && st.format && st.format.duree_sec) startRest(st.format.duree_sec, st.nom);
      // passage auto à la page suivante quand TOUT est coché
      const allDone = card.steps.every((_, j) => (j === i ? nextOn : !!l.steps[j]));
      setLog(card.uid, { steps });
      if (allDone && card._idx != null) setTimeout(() => scrollToSlide(card._idx + 1), 120);
    };
    const row = el("div", { class: "step" + (on ? " on" : "") },
      el("div", { class: "step-row" },
        el("button", { class: "step-check" + (on ? " on" : ""), onclick: toggleStep }, on ? "✓" : "○"),
        el("button", { style: "flex:1;text-align:left;padding:10px 12px 10px 0", onclick: () => toggleUI(stepKey) },
          el("div", { class: "step-name" + (on ? " on" : "") }, st.nom),
          el("div", { class: "sub", style: "font-size:13px" }, st.format_texte))));
    if (stOpen && st.reference) row.append(el("div", { class: "sub", style: "padding:0 14px 12px", html: `${st.reference.execution || ""}${st.reference.cues ? `<br><i style="color:var(--ink)">${st.reference.cues}</i>` : ""}` }));
    node.append(row);
  });
  return node;
}

/* ---------- fin card ---------- */
function finCard() {
  const node = el("div", { class: "wrap", style: "padding:40px 20px;text-align:center" });
  node.append(el("div", { class: "eyebrow" }, "Fin de séance"));
  node.append(el("h2", { class: "exo" }, "Difficulté globale ?"));
  node.append(el("p", { class: "sub", style: "margin-bottom:20px" }, "sRPE — la séance entière, de 1 à 10."));
  const grid = el("div", { style: "display:grid;grid-template-columns:repeat(5,1fr);gap:8px;max-width:340px;margin:0 auto" });
  for (let n = 1; n <= 10; n++) grid.append(el("button", {
    class: "bc num", style: `height:54px;border-radius:12px;font-size:20px;font-weight:700;border:1px solid ${S.srpe === n ? "var(--amber)" : "var(--line)"};background:${S.srpe === n ? "var(--amber)" : "var(--card)"};color:${S.srpe === n ? "#15181C" : "var(--dim)"}`,
    onclick: () => { S.srpe = n; if (!S.meta.endedAt) S.meta = { ...S.meta, endedAt: Date.now() }; persist(); render(); }
  }, String(n)));
  node.append(grid);
  if (S.srpe) node.append(el("button", { class: "bc", style: "margin-top:24px;height:50px;padding:0 28px;border-radius:12px;background:var(--green);color:#15181C;font-size:17px;font-weight:700", onclick: () => { S.screen = "bilan"; render(); } }, "Voir le bilan →"));
  return node;
}

/* ---------- écran Progression (F11 charge + F12 e1RM) ---------- */
function screenProgression() {
  const names = HIST.nameIndex();
  const node = el("div", { class: "wrap" });
  node.append(el("button", { class: "back", style: "margin-bottom:14px", onclick: () => { S.screen = "apercu"; S.progEx = null; render(); } }, "← Mes séances"));
  node.append(el("div", { class: "eyebrow" }, "Suivi"));
  node.append(el("h1", { class: "title" }, "Progression"));

  // exos ayant ≥ 2 séances loguées (sinon pas de tendance)
  const exos = Object.keys(S.hist).filter((id) => S.hist[id].length >= 1)
    .sort((a, b) => { const ta = names[a] && names[a].top, tb = names[b] && names[b].top; return (tb - ta) || (names[a] ? names[a].nom : a).localeCompare(names[b] ? names[b].nom : b); });

  if (exos.length === 0) {
    node.append(el("p", { class: "sub", style: "margin-top:16px" }, "Aucun historique pour l'instant. Logue quelques séances (ou importe un backup depuis Données) pour voir tes courbes."));
    return node;
  }

  // sélecteur d'exercice
  const chosen = S.progEx && S.hist[S.progEx] ? S.progEx : exos[0];
  node.append(el("div", { class: "prog-pills" }, exos.map((id) =>
    el("button", { class: "ppill" + (id === chosen ? " on" : ""), onclick: () => { S.progEx = id; render(); } },
      (names[id] ? names[id].nom : id), names[id] && names[id].top ? el("span", { class: "ptop" }, " ★") : null))));

  const data = S.hist[chosen];
  const nm = names[chosen] ? names[chosen].nom : chosen;

  // F11 — charge de travail réelle dans le temps
  node.append(el("div", { class: "io-h", style: "margin:18px 0 4px" }, "Charge de travail (kg)"));
  const chargePts = data.map((d) => ({ x: d.date, y: d.topCharge }));
  node.append(lineChart(chargePts, { color: "#E0A93C" }));

  // delta
  const firstC = data.find((d) => d.topCharge != null), lastC = [...data].reverse().find((d) => d.topCharge != null);
  if (firstC && lastC && firstC !== lastC) {
    const dlt = +(lastC.topCharge - firstC.topCharge).toFixed(1);
    node.append(el("p", { class: "prog-delta", style: `color:${dlt >= 0 ? "var(--green)" : "#D9846B"}` },
      `${dlt >= 0 ? "+" : ""}${dlt} kg depuis le ${firstC.date.slice(5)} (${firstC.topCharge} → ${lastC.topCharge} kg)`));
  }

  // F12 — e1RM estimé (Epley sur séries RPE ≥ 8)
  const e1Pts = data.map((d) => ({ x: d.date, y: d.e1rm }));
  if (e1Pts.some((p) => p.y != null)) {
    node.append(el("div", { class: "io-h", style: "margin:20px 0 4px" }, "1RM estimé (Epley, séries RPE ≥ 8)"));
    node.append(lineChart(e1Pts, { color: "#6FCF7C" }));
    node.append(el("p", { class: "sub", style: "font-size:12px;margin:6px 0 0" }, "Calculé seulement sur les séries proches de l'échec — les séries de vitesse ne comptent pas."));
  }

  // RPE à charge constante (info)
  node.append(el("div", { class: "io-h", style: "margin:20px 0 4px" }, "Détail par séance"));
  const tbl = el("div", {});
  data.slice().reverse().forEach((d) => tbl.append(el("div", { style: "display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)" },
    el("span", { class: "num", style: "font-size:14px;color:var(--dim)" }, d.date),
    el("span", { class: "bc num", style: "font-size:14px" }, `${d.topCharge != null ? d.topCharge + " kg × " : ""}${d.topReps ?? ""}${d.rpe ? " @" + d.rpe : ""}${d.e1rm ? "  ·  e1RM " + d.e1rm : ""}`))));
  node.append(tbl);
  return node;
}

/* ---------- écran Données (export / import) ---------- */
function screenDonnees() {
  const node = el("div", { class: "wrap" });
  node.append(el("button", { class: "back", style: "margin-bottom:14px", onclick: () => { S.screen = "apercu"; render(); } }, "← Mes séances"));
  node.append(el("div", { class: "eyebrow" }, "Sauvegarde"));
  node.append(el("h1", { class: "title" }, "Données"));

  const msg = el("p", { class: "sub", id: "io-msg", style: "min-height:20px;margin:14px 0" }, `${S.loggedDates.length} séance(s) enregistrée(s) sur cet appareil.`);
  const setMsg = (t, color) => { msg.textContent = t; msg.style.color = color || "var(--dim)"; };

  // EXPORT
  node.append(el("div", { class: "io-sec" },
    el("div", { class: "io-h" }, "Exporter"),
    el("p", { class: "sub", style: "font-size:13px;margin:2px 0 10px" }, "JSON = sauvegarde complète, réimportable. CSV = vue plate pour Excel / Sheets / Python (lecture seule)."),
    el("div", { class: "io-row" },
      el("button", { class: "io-act", onclick: async () => { try { const n = await IO.exportJSON(); setMsg(`Backup JSON exporté (${n} séances).`, "var(--green)"); } catch (e) { setMsg("Échec export JSON.", "#D9846B"); } } }, "⤓ Backup JSON"),
      el("button", { class: "io-act ghost", onclick: async () => { try { const n = await IO.exportCSV(); setMsg(`CSV exporté (${n} lignes de séries).`, "var(--green)"); } catch (e) { setMsg("Échec export CSV.", "#D9846B"); } } }, "⤓ CSV"))));

  // IMPORT
  const fileInput = el("input", { type: "file", accept: ".json,application/json", style: "display:none",
    onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = IO.parseExport(await IO.readFile(f));
        S.ui.pendingImport = data; setMsg(`Fichier lu : ${Object.keys(data).length} séances. Choisis comment l'appliquer.`, "var(--amber)");
        render();
      } catch (err) { setMsg(err.message || "Fichier invalide.", "#D9846B"); }
      e.target.value = "";
    } });
  const importSec = el("div", { class: "io-sec" },
    el("div", { class: "io-h" }, "Importer"),
    el("p", { class: "sub", style: "font-size:13px;margin:2px 0 10px" }, "Restaure un backup JSON. On te demandera quoi faire si des données existent déjà."),
    el("button", { class: "io-act", onclick: () => fileInput.click() }, "⤒ Choisir un fichier JSON"),
    fileInput);

  // panneau de confirmation remplacer / fusionner
  if (S.ui.pendingImport) {
    const apply = async (mode) => {
      try { const n = await IO.applyImport(S.ui.pendingImport, mode); S.ui.pendingImport = null; await refreshLogged(); await refreshHist();
        setMsg(`${mode === "replace" ? "Remplacé" : "Fusionné"} : ${n} séances importées.`, "var(--green)"); render();
      } catch (e) { setMsg("Échec de l'import.", "#D9846B"); }
    };
    importSec.append(el("div", { class: "io-confirm" },
      el("div", { class: "sub", style: "margin-bottom:8px;color:var(--ink)" }, "Des données existent déjà. Que faire ?"),
      el("div", { class: "io-row" },
        el("button", { class: "io-act", onclick: () => apply("merge") }, "Fusionner"),
        el("button", { class: "io-act danger", onclick: () => apply("replace") }, "Remplacer tout")),
      el("button", { class: "addnote", style: "margin-top:6px", onclick: () => { S.ui.pendingImport = null; render(); } }, "Annuler")));
  }

  node.append(msg);
  node.append(el("div", { class: "io-sec" },
    el("div", { class: "io-h" }, "À savoir"),
    el("p", { class: "sub", style: "font-size:13px;margin:2px 0" }, "Le téléchargement va dans tes fichiers ; envoie-le ensuite où tu veux (Drive, mail…). Pense à exporter régulièrement : tes données vivent sur ce téléphone.")));
  node.append(importSec);
  return node;
}

/* ---------- écran sélection des jours ---------- */
function screenDays() {
  const node = el("div", { class: "wrap" });
  node.append(el("div", { style: "display:flex;justify-content:space-between;align-items:flex-start" },
    el("div", {}, el("div", { class: "eyebrow" }, WEEK.semaine.titre), el("h1", { class: "title" }, "Mes séances")),
    el("div", { style: "display:flex;gap:8px" },
      el("button", { class: "iobtn", onclick: () => { S.screen = "progression"; refreshHist().then(render); } }, "📈 Progression"),
      el("button", { class: "iobtn", onclick: () => { S.screen = "donnees"; render(); } }, "⤓ Données"))));
  node.append(el("p", { class: "sub", style: "margin:0 0 16px" }, "Aperçu avant, bilan après — tout reste consultable."));
  days.forEach((d, i) => {
    const logged = S.loggedDates.includes(d.date);
    const c = el("button", { class: "daycard" + (d.type === "cardio" ? " cardio" : "") + (logged ? " logged" : ""), onclick: () => { if (d.type === "seance") { S.dayIdx = i; S.screen = "apercu"; S.rest = null; loadDay().then(refreshHist).then(render); } } },
      el("div", { style: "display:flex;justify-content:space-between" },
        el("div", { class: "daydate" }, d.date),
        logged ? el("span", { class: "bc", style: "font-size:12px;color:var(--green)" }, "✓ loguée") : null),
      el("div", { class: "dayname" }, d.titre),
      d.type === "cardio" ? el("div", { class: "sub", style: "font-size:13px" }, d.contenu) : null);
    node.append(c);
  });
  return node;
}

function screenApercu() {
  const day = dayOf(), cards = buildCards(day), st = computeStats(cards, S.logs);
  const started = st.done > 0;
  const node = el("div", { style: "padding-bottom:96px" });
  const w = el("div", { class: "wrap" });
  w.append(el("button", { class: "back", style: "margin-bottom:14px", onclick: () => { S.dayIdx = null; refreshLogged().then(render); } }, "← Semaine"));
  w.append(el("div", { class: "eyebrow" }, `${day.date} · ${day.bloc}`));
  w.append(el("h1", { class: "title" }, (day.titre.split(":")[1] || day.titre).trim()));
  if (day.intention) w.append(el("p", { class: "sub", style: "margin:0 0 18px" }, day.intention));
  day.sections.forEach((sec) => {
    w.append(el("div", { class: "bc", style: "font-size:13px;font-weight:600;color:var(--brass);letter-spacing:.1em;margin:14px 0 6px" }, `${sec.numero} · ${sec.titre.replace(/\s*\(.*\)/, "")}`));
    sec.exercices.forEach((ex) => w.append(el("div", { style: "display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)" },
      el("span", { style: "font-size:15px" }, ex.nom),
      el("span", { class: "bc num", style: "font-size:14px;color:var(--dim);white-space:nowrap" }, `${ex.format_texte}${ex.charge && ex.charge.valeur_kg ? " · " + chargeLabel(ex.charge) : ""}`))));
  });
  node.append(w);

  const footer = el("div", { class: "footer" },
    el("button", { class: "cta " + (started ? "resume" : "go"), onclick: () => { if (!S.meta.startedAt) { S.meta = { ...S.meta, startedAt: Date.now() }; persist(); } pendingScrollIdx = started ? firstIncompleteIdx(cards) : 0; S.screen = "live"; S.pos = pendingScrollIdx; render(); } },
      started ? `Reprendre (${st.done}/${st.total})` : "Commencer la séance"));
  if (S.srpe || started) footer.append(el("button", { class: "cta ghost", onclick: () => { S.screen = "bilan"; render(); } }, "Bilan"));
  node.append(footer);
  return node;
}

function screenBilan() {
  const day = dayOf(), cards = buildCards(day), st = computeStats(cards, S.logs);
  const duree = S.meta.startedAt && S.meta.endedAt ? Math.round((S.meta.endedAt - S.meta.startedAt) / 60000) : null;
  const node = el("div", { class: "wrap", style: "padding-bottom:40px" });
  node.append(el("button", { class: "back", style: "margin-bottom:14px", onclick: () => { S.screen = "apercu"; render(); } }, "← Retour"));
  node.append(el("div", { class: "eyebrow" }, `Bilan · ${day.date}`));
  node.append(el("h1", { class: "title", style: "font-size:28px;margin-bottom:16px" }, `${day.bloc} · ${(day.titre.split(":")[1] || "").trim()}`));
  const stat = (l, v, suf) => el("div", { class: "stat" }, el("div", { class: "v" }, v != null ? String(v) : "—", v != null && suf ? el("span", { html: suf, style: "font-size:15px;color:var(--dim)" }) : null), el("div", { class: "l" }, l));
  node.append(el("div", { class: "stats" },
    stat("SÉRIES / ÉTAPES", `${st.done}/${st.total}`, ""),
    stat("TONNAGE", st.tonnage || null, " kg"),
    stat("RPE MOYEN", st.rpeMoyen, ""),
    stat("sRPE SÉANCE", S.srpe, " /10")));
  if (duree != null) node.append(el("p", { class: "sub", style: "margin:0 0 18px" }, `Durée : ${duree} min`));
  node.append(el("div", { class: "bc", style: "font-size:13px;font-weight:600;color:var(--brass);letter-spacing:.1em;margin-bottom:8px" }, "DÉTAIL DU RÉALISÉ"));
  cards.filter((c) => c.kind === "exo").forEach((c) => {
    const l = S.logs[c.uid], dones = l ? l.series.filter((s) => s.done) : [];
    const line = el("div", { style: "padding:8px 0;border-bottom:1px solid var(--line)" },
      el("div", { style: "display:flex;justify-content:space-between;gap:8px" },
        el("span", { style: `font-size:15px;color:${dones.length ? "var(--ink)" : "var(--faint)"}` }, c.ex.nom),
        el("span", { class: "bc num", style: "font-size:13px;color:var(--dim)" }, `${dones.length}/${l ? l.series.length : seriesCount(c.ex.format)} séries`)));
    if (dones.length) line.append(el("div", { class: "bc num", style: "font-size:13px;color:var(--dim);margin-top:2px" },
      dones.map((s) => `${s.charge != null ? s.charge + "kg×" : ""}${s.reps != null ? s.reps : (s.duree_sec != null ? s.duree_sec + "s" : "")}${s.rpe ? "@" + s.rpe : ""}`).join("  ·  ")));
    node.append(line);
  });
  return node;
}

function screenLive() {
  const day = dayOf(), cards = buildCards(day), st = computeStats(cards, S.logs);
  const pct = st.total ? (st.done / st.total) * 100 : 0;
  const node = el("div", { style: "padding-bottom:110px" });

  const header = el("header", {},
    el("div", { class: "hrow" },
      el("button", { class: "back", onclick: () => { S.screen = "apercu"; render(); } }, "← Aperçu"),
      el("div", { class: "htitle" }, `${day.bloc} · ${(day.titre.split(":")[1] || "").trim()}`),
      el("div", { class: "nav" },
        el("button", { class: "navbtn", disabled: S.pos === 0, onclick: () => scrollBy(-1) }, "‹"),
        el("span", { class: "count" }, `${S.pos + 1}/${cards.length}`),
        el("button", { class: "navbtn", disabled: S.pos === cards.length - 1, onclick: () => scrollBy(1) }, "›"))),
    el("div", { class: "progress" }, el("div", { style: `width:${pct}%` })));
  node.append(header);

  const track = el("div", { class: "track", id: "track" });
  track.addEventListener("scroll", () => { const p = Math.round(track.scrollLeft / track.clientWidth); if (p !== S.pos) { S.pos = p; const cnt = $(".count"); if (cnt) cnt.textContent = `${p + 1}/${cards.length}`; } });
  cards.forEach((c, idx) => {
    c._idx = idx;
    const slide = el("div", { class: "slide" });
    slide.append(c.kind === "exo" ? exoCard(c) : c.kind === "checklist" ? checklistCard(c) : finCard());
    track.append(slide);
  });
  node.append(track);

  if (S.rest) {
    node.append(el("div", { class: "dock", id: "dock" },
      el("div", { class: "pbar" }, el("div", { style: "width:0%" })),
      el("div", { class: "dock-row" },
        el("div", {}, el("div", { class: "dock-label" }, `REPOS · ${S.rest.label}`), el("div", { class: "dock-time num" }, "0:00")),
        el("div", { style: "display:flex;align-items:center;gap:8px" },
          el("div", { class: "dock-target" }, `cible ${fmtClock(S.rest.target)}`),
          el("button", { class: "dock-x", onclick: stopRest }, "×")))));
  }
  return node;
}

/* ---------- render ---------- */
let restoreScroll = 0, pendingScrollIdx = null;
function scrollBy(dir) { const t = $("#track"); if (t) t.scrollBy({ left: dir * t.clientWidth, behavior: "smooth" }); }
function scrollToSlide(idx) { const t = $("#track"); if (t) { const i = Math.max(0, Math.min(idx, t.children.length - 1)); t.scrollTo({ left: i * t.clientWidth, behavior: "smooth" }); S.pos = i; const cnt = $(".count"); if (cnt) cnt.textContent = `${i + 1}/${t.children.length}`; } }

// index de la première carte non terminée (pour "Reprendre")
function firstIncompleteIdx(cards) {
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (c.kind === "exo") { const l = S.logs[c.uid]; if (!l || !l.series.every((s) => s.done)) return i; }
    else if (c.kind === "checklist") { const l = S.logs[c.uid]; if (!l || c.steps.some((_, j) => !l.steps[j])) return i; }
  }
  return 0;
}
function render() {
  const t = $("#track"); if (t) restoreScroll = t.scrollLeft;
  root.innerHTML = "";
  const day = dayOf();
  let view;
  if (S.screen === "donnees") view = screenDonnees();
  else if (S.screen === "progression") view = screenProgression();
  else if (!day) view = screenDays();
  else if (S.screen === "apercu") view = screenApercu();
  else if (S.screen === "bilan") view = screenBilan();
  else view = screenLive();
  root.append(view);
  const t2 = $("#track");
  if (t2) {
    if (pendingScrollIdx != null) { t2.scrollLeft = pendingScrollIdx * (t2.clientWidth || window.innerWidth); pendingScrollIdx = null; }
    else t2.scrollLeft = restoreScroll;
  }
}

/* ---------- boot ---------- */
(async function boot() {
  await refreshLogged();
  await refreshHist();
  DB.persist().catch(() => {});
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  dockTimer = setInterval(tickDock, 500);
})();
