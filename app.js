"use strict";

const STORAGE_KEY = "billar_ranking_v1";
const BACKUP_STORAGE_KEY = "billar_ranking_backups_v1";
const APP_SCHEMA_VERSION = 2;
const MAX_BACKUPS = 20;
const DB_NAME = "billar-ranking-db";
const DB_VERSION = 1;
const DB_MAIN_STORE = "kv";
const DB_BACKUP_STORE = "backups";
const DB_STATE_KEY = "app_state";
const RATING_REGRESSION_K = 2;
const SALDO_CAP_PER_TOURNAMENT = 25;
const TOURNAMENT_REFERENCE_SIZE = 16;
const RELATIVE_Z_CAP = 2.5;
const RELATIVE_SCORE_SCALE = 2.5;

const state = {
  data: {
    players: [],
    championships: [],
  },
  backups: [],
  editingChampionshipId: null,
  selectedPlayerId: null,
  nameEditorOpen: false,
  playerTrendLimit: 5,
  playerMovingAvgWindow: 3,
  playerParticipationExpanded: false,
  championshipHistoryExpanded: false,
  persistenceMode: "localStorage",
  persistenceReady: false,
  dataPanelOpen: false,
};

const refs = {
  layout: document.querySelector(".layout"),
  form: document.getElementById("championship-form"),
  formTitle: document.getElementById("form-title"),
  editingBadge: document.getElementById("editing-badge"),
  championshipName: document.getElementById("championship-name"),
  championshipDate: document.getElementById("championship-date"),
  addRowBtn: document.getElementById("add-row-btn"),
  resultsBody: document.getElementById("results-body"),
  rowTemplate: document.getElementById("result-row-template"),
  saveBtn: document.getElementById("save-btn"),
  cancelEditBtn: document.getElementById("cancel-edit-btn"),
  toggleFormBtn: document.getElementById("toggle-form-btn"),
  toggleNameEditorBtn: document.getElementById("toggle-name-editor-btn"),
  rankingBody: document.getElementById("ranking-body"),
  playerDetail: document.getElementById("player-detail"),
  nameEditor: document.getElementById("name-editor"),
  championshipList: document.getElementById("championship-list"),
  toast: document.getElementById("toast"),
  toggleDataBtn: document.getElementById("toggle-data-btn"),
  dataPanel: document.getElementById("data-panel"),
  dataToggleLabel: document.getElementById("data-toggle-label"),
  storageStatus: document.getElementById("storage-status"),
  backupBtn: document.getElementById("backup-btn"),
  exportBtn: document.getElementById("export-btn"),
  importInput: document.getElementById("import-input"),
  backupList: document.getElementById("backup-list"),
  floatingExpandFormBtn: document.getElementById("floating-expand-form-btn"),
};

let dbPromise = null;

function createId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`;
}

function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function createEmptyData() {
  return { players: [], championships: [] };
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data || createEmptyData()));
}

function sanitizePlayer(player, index) {
  if (!player || typeof player !== "object") {
    throw new Error(`Jugador invalido en posicion ${index + 1}.`);
  }

  const name = String(player.name || "").trim().replace(/\s+/g, " ");
  if (!name) {
    throw new Error(`Jugador invalido en posicion ${index + 1}: falta nombre.`);
  }

  return {
    id: String(player.id || createId("p")),
    name,
    createdAt: String(player.createdAt || new Date().toISOString()),
  };
}

function sanitizeResult(result, playerIds, championshipName, index) {
  if (!result || typeof result !== "object") {
    throw new Error(`Resultado invalido en ${championshipName || "campeonato"}.`);
  }

  const playerId = String(result.playerId || "");
  if (!playerId || !playerIds.has(playerId)) {
    throw new Error(`Resultado invalido en ${championshipName || "campeonato"}: jugador no encontrado.`);
  }

  const points = Number(result.points);
  const saldo = Number(result.saldo);
  if (!Number.isFinite(points) || !Number.isFinite(saldo)) {
    throw new Error(`Resultado invalido en ${championshipName || "campeonato"}, fila ${index + 1}.`);
  }

  return {
    playerId,
    points,
    saldo,
  };
}

function sanitizeChampionship(championship, playerIds, index) {
  if (!championship || typeof championship !== "object") {
    throw new Error(`Campeonato invalido en posicion ${index + 1}.`);
  }

  const name = String(championship.name || "").trim();
  const date = String(championship.date || "").trim();
  if (!name || !date) {
    throw new Error(`Campeonato invalido en posicion ${index + 1}: faltan nombre o fecha.`);
  }

  const rawResults = Array.isArray(championship.results) ? championship.results : [];
  const seenPlayers = new Set();
  const results = rawResults.map((result, resultIndex) => {
    const sanitized = sanitizeResult(result, playerIds, name, resultIndex);
    if (seenPlayers.has(sanitized.playerId)) {
      throw new Error(`Campeonato "${name}" tiene jugadores repetidos.`);
    }
    seenPlayers.add(sanitized.playerId);
    return sanitized;
  });

  return {
    id: String(championship.id || createId("c")),
    name,
    date,
    results,
    createdAt: String(championship.createdAt || new Date().toISOString()),
    updatedAt: String(championship.updatedAt || championship.createdAt || new Date().toISOString()),
  };
}

function sanitizeStore(input) {
  const raw = input && typeof input === "object" ? input : createEmptyData();
  const rawPlayers = Array.isArray(raw.players) ? raw.players : [];
  const players = rawPlayers.map(sanitizePlayer);
  const playerIds = new Set(players.map((player) => player.id));
  const rawChampionships = Array.isArray(raw.championships) ? raw.championships : [];
  const championships = rawChampionships.map((championship, index) => sanitizeChampionship(championship, playerIds, index));
  return { players, championships };
}

function parseDataContainer(rawText) {
  const parsed = JSON.parse(rawText);
  if (parsed && typeof parsed === "object" && parsed.data) {
    return sanitizeStore(parsed.data);
  }
  return sanitizeStore(parsed);
}

function loadLegacyStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createEmptyData();
    }
    return parseDataContainer(raw);
  } catch (error) {
    return createEmptyData();
  }
}

function writeLegacyStore(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeStore(data)));
}

function loadLegacyBackups() {
  try {
    const raw = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((backup) => ({
        id: String(backup.id || createId("b")),
        label: String(backup.label || "Backup"),
        createdAt: String(backup.createdAt || new Date().toISOString()),
        data: sanitizeStore(backup.data),
      }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } catch (error) {
    return [];
  }
}

function writeLegacyBackups(backups) {
  const sanitized = backups.slice(0, MAX_BACKUPS).map((backup) => ({
    id: backup.id,
    label: backup.label,
    createdAt: backup.createdAt,
    data: sanitizeStore(backup.data),
  }));
  localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(sanitized));
}

function canUseIndexedDb() {
  return typeof window.indexedDB !== "undefined";
}

function openDatabase() {
  if (!canUseIndexedDb()) {
    return Promise.resolve(null);
  }
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_MAIN_STORE)) {
        db.createObjectStore(DB_MAIN_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(DB_BACKUP_STORE)) {
        db.createObjectStore(DB_BACKUP_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error("No se pudo abrir IndexedDB."));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error("IndexedDB esta bloqueada por otra pestana o proceso."));
    };
  });

  return dbPromise;
}

function idbRequestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Error de IndexedDB."));
  });
}

async function idbGet(storeName, key) {
  const db = await openDatabase();
  if (!db) {
    return null;
  }
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  return idbRequestToPromise(store.get(key));
}

async function idbPut(storeName, value) {
  const db = await openDatabase();
  if (!db) {
    return null;
  }
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  const result = await idbRequestToPromise(store.put(value));
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("No se pudo guardar en IndexedDB."));
    tx.onabort = () => reject(tx.error || new Error("Transaccion abortada en IndexedDB."));
  });
  return result;
}

async function idbDelete(storeName, key) {
  const db = await openDatabase();
  if (!db) {
    return;
  }
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(key);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("No se pudo borrar en IndexedDB."));
    tx.onabort = () => reject(tx.error || new Error("Transaccion abortada en IndexedDB."));
  });
}

async function idbGetAll(storeName) {
  const db = await openDatabase();
  if (!db) {
    return [];
  }
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  return idbRequestToPromise(store.getAll());
}

function updatePersistenceStatus(mode, detail) {
  state.persistenceMode = mode;
  refs.storageStatus.textContent = detail;
  refs.storageStatus.classList.remove("status-ok", "status-warn", "status-error");
  if (mode === "indexeddb" || mode === "mixed") {
    refs.storageStatus.classList.add("status-ok");
  } else if (mode === "localStorage") {
    refs.storageStatus.classList.add("status-warn");
  } else {
    refs.storageStatus.classList.add("status-error");
  }
}

async function persistStateSnapshot(data) {
  const sanitized = sanitizeStore(data);
  writeLegacyStore(sanitized);

  if (!canUseIndexedDb()) {
    updatePersistenceStatus("localStorage", "Guardado en localStorage");
    return sanitized;
  }

  await idbPut(DB_MAIN_STORE, {
    key: DB_STATE_KEY,
    schemaVersion: APP_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    data: sanitized,
  });
  updatePersistenceStatus("mixed", "Guardado en IndexedDB + localStorage");
  return sanitized;
}

async function loadStore() {
  const legacyData = loadLegacyStore();

  if (!canUseIndexedDb()) {
    updatePersistenceStatus("localStorage", "Usando localStorage");
    return legacyData;
  }

  try {
    const stored = await idbGet(DB_MAIN_STORE, DB_STATE_KEY);
    if (stored && stored.data) {
      updatePersistenceStatus("mixed", "Persistencia activa");
      return sanitizeStore(stored.data);
    }

    await persistStateSnapshot(legacyData);
    updatePersistenceStatus("mixed", "Migrado desde localStorage");
    return legacyData;
  } catch (error) {
    updatePersistenceStatus("localStorage", "Fallback a localStorage");
    return legacyData;
  }
}

function createBackupRecord(data, label) {
  return {
    id: createId("b"),
    label: String(label || "Backup manual"),
    createdAt: new Date().toISOString(),
    data: sanitizeStore(data),
  };
}

async function loadBackups() {
  const legacyBackups = loadLegacyBackups();
  if (!canUseIndexedDb()) {
    state.backups = legacyBackups;
    return state.backups;
  }

  try {
    const records = await idbGetAll(DB_BACKUP_STORE);
    if (records.length) {
      state.backups = records
        .map((backup) => ({
          id: String(backup.id),
          label: String(backup.label || "Backup"),
          createdAt: String(backup.createdAt || new Date().toISOString()),
          data: sanitizeStore(backup.data),
        }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      writeLegacyBackups(state.backups);
      return state.backups;
    }

    state.backups = legacyBackups;
    for (const backup of legacyBackups) {
      await idbPut(DB_BACKUP_STORE, backup);
    }
    return state.backups;
  } catch (error) {
    state.backups = legacyBackups;
    return state.backups;
  }
}

async function saveBackups(backups) {
  const trimmed = backups
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, MAX_BACKUPS);

  state.backups = trimmed;
  writeLegacyBackups(trimmed);

  if (!canUseIndexedDb()) {
    return;
  }

  const existing = await idbGetAll(DB_BACKUP_STORE);
  const keepIds = new Set(trimmed.map((backup) => backup.id));
  for (const record of existing) {
    if (!keepIds.has(record.id)) {
      await idbDelete(DB_BACKUP_STORE, record.id);
    }
  }
  for (const backup of trimmed) {
    await idbPut(DB_BACKUP_STORE, backup);
  }
}

async function createBackup(label, data = state.data) {
  const backup = createBackupRecord(data, label);
  await saveBackups([backup, ...state.backups]);
  renderBackups();
  return backup;
}

function saveStore(data) {
  return persistStateSnapshot(data).catch((error) => {
    updatePersistenceStatus("error", "Error de guardado");
    showToast(error.message || "No se pudieron guardar los datos.", true);
  });
}

function getPlayerById(playerId) {
  return state.data.players.find((player) => player.id === playerId) || null;
}

function getOrCreatePlayerByName(name) {
  const normalized = normalizeName(name);
  const found = state.data.players.find((player) => normalizeName(player.name) === normalized);
  if (found) {
    return found;
  }

  const now = new Date().toISOString();
  const player = {
    id: createId("p"),
    name: String(name).trim().replace(/\s+/g, " "),
    createdAt: now,
  };
  state.data.players.push(player);
  return player;
}

function createChampionship(payload) {
  const now = new Date().toISOString();
  const championship = {
    id: createId("c"),
    name: payload.name,
    date: payload.date,
    results: payload.results,
    createdAt: now,
    updatedAt: now,
  };
  state.data.championships.push(championship);
  saveStore(state.data);
  return championship;
}

function updateChampionship(championshipId, payload) {
  const item = state.data.championships.find((championship) => championship.id === championshipId);
  if (!item) {
    return null;
  }

  item.name = payload.name;
  item.date = payload.date;
  item.results = payload.results;
  item.updatedAt = new Date().toISOString();
  saveStore(state.data);
  return item;
}

function deleteChampionship(championshipId) {
  const idx = state.data.championships.findIndex((championship) => championship.id === championshipId);
  if (idx === -1) {
    return false;
  }
  state.data.championships.splice(idx, 1);
  saveStore(state.data);
  return true;
}

function formatNum(value, decimals = 2) {
  return Number(value || 0).toFixed(decimals);
}

function formatSigned(value, decimals = 2) {
  const num = Number(value || 0);
  const fixed = num.toFixed(decimals);
  return num > 0 ? `+${fixed}` : fixed;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("es-UY", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function parseNumber(value) {
  if (value === "" || value === null || typeof value === "undefined") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function capSaldoForRating(saldo) {
  const numericSaldo = Number(saldo) || 0;
  return Math.max(-SALDO_CAP_PER_TOURNAMENT, Math.min(SALDO_CAP_PER_TOURNAMENT, numericSaldo));
}

function getTournamentScore(points, saldo) {
  return (Number(points) || 0) + capSaldoForRating(saldo) * 0.1;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeChampionshipContexts(championships) {
  const contexts = new Map();

  championships.forEach((championship) => {
    const scores = championship.results.map((result) => getTournamentScore(result.points, result.saldo));
    const participants = scores.length;

    if (!participants) {
      contexts.set(championship.id, {
        mean: 0,
        std: 0,
        sizeWeight: 0,
      });
      return;
    }

    const mean = scores.reduce((sum, value) => sum + value, 0) / participants;
    const variance = scores.reduce((sum, value) => {
      const diff = value - mean;
      return sum + diff * diff;
    }, 0) / participants;
    const std = Math.sqrt(variance);
    const sizeWeight = Math.min(1, Math.sqrt(participants / TOURNAMENT_REFERENCE_SIZE));

    contexts.set(championship.id, {
      mean,
      std,
      sizeWeight,
    });
  });

  return contexts;
}

function computeRelativeContribution(score, context) {
  if (!context || context.std <= 0) {
    return 0;
  }
  const zScore = (score - context.mean) / context.std;
  const cappedZScore = clamp(zScore, -RELATIVE_Z_CAP, RELATIVE_Z_CAP);
  return cappedZScore * RELATIVE_SCORE_SCALE * context.sizeWeight;
}

function computeGlobalBaselineScore(championships) {
  let participations = 0;
  let scoreTotal = 0;

  championships.forEach((championship) => {
    championship.results.forEach((result) => {
      scoreTotal += getTournamentScore(result.points, result.saldo);
      participations += 1;
    });
  });

  if (participations <= 0) {
    return 0;
  }
  return scoreTotal / participations;
}

function computeRawRating(pointsTotal, saldoTotal, championshipsCount) {
  if (championshipsCount <= 0) {
    return 0;
  }
  const promedio = pointsTotal / championshipsCount;
  const ajusteSaldo = saldoTotal * 0.1;
  const factorExp = 1 + Math.min(0.15, Math.log(1 + championshipsCount) * 0.05);
  return (promedio + ajusteSaldo) * factorExp;
}

function applyRegressionToMean(rawRating, championshipsCount, baselineScore) {
  if (championshipsCount !== 1) {
    return rawRating;
  }
  const weight = championshipsCount / (championshipsCount + RATING_REGRESSION_K);
  return rawRating * weight + baselineScore * (1 - weight);
}

function computeRanking(championships, players) {
  const statsMap = new Map();
  const baselineScore = computeGlobalBaselineScore(championships);
  const championshipContexts = computeChampionshipContexts(championships);

  championships.forEach((championship) => {
    const context = championshipContexts.get(championship.id);
    championship.results.forEach((result) => {
      if (!statsMap.has(result.playerId)) {
        statsMap.set(result.playerId, {
          playerId: result.playerId,
          championships: 0,
          championshipsWon: 0,
          pointsTotal: 0,
          saldoTotalRaw: 0,
          saldoTotalForRating: 0,
          relativeTotal: 0,
        });
      }
    });

    let tournamentMaxPoints = -Infinity;
    championship.results.forEach((result) => {
      const points = Number(result.points) || 0;
      if (points > tournamentMaxPoints) {
        tournamentMaxPoints = points;
      }
    });

    championship.results.forEach((result) => {
      const row = statsMap.get(result.playerId);
      if (!row) {
        return;
      }
      row.championships += 1;
      row.pointsTotal += Number(result.points) || 0;
      row.saldoTotalRaw += Number(result.saldo) || 0;
      row.saldoTotalForRating += capSaldoForRating(result.saldo);
      const tournamentScore = getTournamentScore(result.points, result.saldo);
      row.relativeTotal += computeRelativeContribution(tournamentScore, context);
      if ((Number(result.points) || 0) === tournamentMaxPoints) {
        row.championshipsWon += 1;
      }
    });
  });

  const ranking = [];
  statsMap.forEach((row) => {
    if (row.championships <= 0) {
      return;
    }
    const player = players.find((p) => p.id === row.playerId);
    if (!player) {
      return;
    }
    const promedio = row.pointsTotal / row.championships;
    const rawRating = computeRawRating(row.pointsTotal, row.saldoTotalForRating, row.championships);
    const relativeAdjustment = row.relativeTotal / row.championships;
    const adjustedRating = rawRating + relativeAdjustment;
    const rating = applyRegressionToMean(adjustedRating, row.championships, baselineScore);

    ranking.push({
      playerId: row.playerId,
      name: player.name,
      championships: row.championships,
      championshipsWon: row.championshipsWon,
      promedio,
      saldoTotal: row.saldoTotalRaw,
      rating,
    });
  });

  ranking.sort((a, b) => {
    if (b.rating !== a.rating) {
      return b.rating - a.rating;
    }
    if (b.championshipsWon !== a.championshipsWon) {
      return b.championshipsWon - a.championshipsWon;
    }
    if (b.saldoTotal !== a.saldoTotal) {
      return b.saldoTotal - a.saldoTotal;
    }
    if (b.championships !== a.championships) {
      return b.championships - a.championships;
    }
    return a.name.localeCompare(b.name, "es");
  });

  return ranking;
}

function showToast(message, isError = false) {
  refs.toast.textContent = message;
  refs.toast.classList.remove("hidden", "error");
  if (isError) {
    refs.toast.classList.add("error");
  }
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    refs.toast.classList.add("hidden");
  }, 2500);
}

function getKnownPlayerNames() {
  return state.data.players.map((player) => player.name);
}

function closeSuggestions(rowEl) {
  const box = rowEl.querySelector(".suggestions");
  box.classList.add("hidden");
  box.innerHTML = "";
}

function renderSuggestions(rowEl, queryRaw) {
  const box = rowEl.querySelector(".suggestions");
  const query = normalizeName(queryRaw);
  if (!query) {
    closeSuggestions(rowEl);
    return;
  }

  const names = getKnownPlayerNames();
  const suggestions = names
    .filter((name) => normalizeName(name).includes(query))
    .slice(0, 6);

  if (suggestions.length === 0) {
    closeSuggestions(rowEl);
    return;
  }

  box.innerHTML = "";
  suggestions.forEach((name) => {
    const item = document.createElement("div");
    item.className = "suggestion-item";
    item.textContent = name;
    item.addEventListener("mousedown", () => {
      const playerInput = rowEl.querySelector(".player-input");
      playerInput.value = name;
      closeSuggestions(rowEl);
    });
    box.appendChild(item);
  });
  box.classList.remove("hidden");
}

function attachResultRowEvents(rowEl) {
  const removeBtn = rowEl.querySelector(".row-remove-btn");
  const playerInput = rowEl.querySelector(".player-input");

  removeBtn.addEventListener("click", () => {
    rowEl.remove();
    if (!refs.resultsBody.children.length) {
      addResultRow();
    }
  });

  playerInput.addEventListener("input", () => {
    renderSuggestions(rowEl, playerInput.value);
  });

  playerInput.addEventListener("blur", () => {
    window.setTimeout(() => closeSuggestions(rowEl), 100);
  });

  playerInput.addEventListener("focus", () => {
    if (playerInput.value.trim()) {
      renderSuggestions(rowEl, playerInput.value);
    }
  });
}

function addResultRow(initialData = { playerName: "", points: "", saldo: "" }) {
  const row = refs.rowTemplate.content.firstElementChild.cloneNode(true);
  const playerInput = row.querySelector(".player-input");
  const pointsInput = row.querySelector(".points-input");
  const saldoInput = row.querySelector(".saldo-input");

  playerInput.value = initialData.playerName || "";
  pointsInput.value = initialData.points ?? "";
  saldoInput.value = initialData.saldo ?? "";

  attachResultRowEvents(row);
  refs.resultsBody.appendChild(row);
}

function clearResultRows() {
  refs.resultsBody.innerHTML = "";
}

function resetForm() {
  state.editingChampionshipId = null;
  refs.form.reset();
  refs.formTitle.textContent = "Nuevo campeonato";
  refs.editingBadge.classList.add("hidden");
  refs.cancelEditBtn.classList.add("hidden");
  refs.saveBtn.textContent = "Guardar campeonato";
  clearResultRows();
  addResultRow();
}

function setFormCollapsed(collapsed) {
  const formCard = document.querySelector(".form-card");
  formCard.classList.toggle("collapsed", collapsed);
  refs.layout.classList.toggle("form-collapsed", collapsed);
  refs.toggleFormBtn.textContent = collapsed ? "Desplegar" : "Plegar";
  refs.toggleFormBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  refs.floatingExpandFormBtn.classList.toggle("hidden", !collapsed);
}

function fillFormForEdit(championship) {
  setFormCollapsed(false);
  state.editingChampionshipId = championship.id;
  refs.formTitle.textContent = "Editar campeonato";
  refs.editingBadge.classList.remove("hidden");
  refs.cancelEditBtn.classList.remove("hidden");
  refs.saveBtn.textContent = "Guardar cambios";
  refs.championshipName.value = championship.name;
  refs.championshipDate.value = championship.date;
  clearResultRows();

  championship.results.forEach((result) => {
    const player = getPlayerById(result.playerId);
    addResultRow({
      playerName: player ? player.name : "",
      points: result.points,
      saldo: result.saldo,
    });
  });
}

function validateAndBuildPayload() {
  const name = refs.championshipName.value.trim();
  const date = refs.championshipDate.value;

  if (!name) {
    throw new Error("El nombre del campeonato es obligatorio.");
  }
  if (!date) {
    throw new Error("La fecha del campeonato es obligatoria.");
  }

  const rows = [...refs.resultsBody.querySelectorAll("tr")];
  if (rows.length === 0) {
    throw new Error("Debe haber al menos un jugador.");
  }

  const normalizedInChampionship = new Set();
  const results = [];

  rows.forEach((row, index) => {
    const playerInput = row.querySelector(".player-input");
    const pointsInput = row.querySelector(".points-input");
    const saldoInput = row.querySelector(".saldo-input");

    const playerName = playerInput.value.trim();
    const points = parseNumber(pointsInput.value);
    const saldo = parseNumber(saldoInput.value);
    const rowNum = index + 1;

    if (!playerName) {
      throw new Error(`Fila ${rowNum}: el nombre del jugador es obligatorio.`);
    }
    if (points === null) {
      throw new Error(`Fila ${rowNum}: puntos debe ser numerico.`);
    }
    if (saldo === null) {
      throw new Error(`Fila ${rowNum}: saldo debe ser numerico (positivo o negativo).`);
    }

    const normalized = normalizeName(playerName);
    if (normalizedInChampionship.has(normalized)) {
      throw new Error(`Jugador repetido en el campeonato: "${playerName}".`);
    }
    normalizedInChampionship.add(normalized);

    const player = getOrCreatePlayerByName(playerName);
    results.push({
      playerId: player.id,
      points,
      saldo,
    });
  });

  return {
    name,
    date,
    results,
  };
}

function renderRanking() {
  const ranking = computeRanking(state.data.championships, state.data.players);
  refs.rankingBody.innerHTML = "";

  if (!ranking.length) {
    state.selectedPlayerId = null;
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="7" class="empty empty-state">Sin datos de ranking todavia. Crea un campeonato para comenzar.</td>';
    refs.rankingBody.appendChild(tr);
    return;
  }

  const maxChampionshipWins = ranking.reduce((maxWins, entry) => Math.max(maxWins, entry.championshipsWon), 0);

  if (!ranking.some((entry) => entry.playerId === state.selectedPlayerId)) {
    state.selectedPlayerId = ranking[0].playerId;
    state.playerParticipationExpanded = false;
  }

  ranking.forEach((entry, idx) => {
    const tr = document.createElement("tr");
    if (idx < 4) {
      tr.classList.add("rank-top");
    } else {
      tr.classList.add("rank-dynamic");
      const dynamicCount = Math.max(1, ranking.length - 4);
      const progress = Math.min(1, Math.max(0, (idx - 4) / (dynamicCount - 1 || 1)));
      const lightness = 30 + progress * 18;
      const alpha = 0.16 + progress * 0.16;
      tr.style.setProperty("--row-color", `hsla(132, 82%, ${lightness.toFixed(1)}%, ${alpha.toFixed(3)})`);
    }

    if (entry.playerId === state.selectedPlayerId) {
      tr.classList.add("rank-selected");
    }

    const posTd = document.createElement("td");
    posTd.setAttribute("data-label", "Pos");
    const rankBadge = document.createElement("span");
    rankBadge.className = "rank-badge";
    if (idx === 0) {
      rankBadge.classList.add("rank-1");
    } else if (idx === 1) {
      rankBadge.classList.add("rank-2");
    } else if (idx === 2) {
      rankBadge.classList.add("rank-3");
    }
    rankBadge.textContent = `#${idx + 1}`;
    posTd.appendChild(rankBadge);

    const playerTd = document.createElement("td");
    playerTd.setAttribute("data-label", "Jugador");
    const playerBtn = document.createElement("button");
    playerBtn.type = "button";
    playerBtn.className = "player-name-btn";
    playerBtn.textContent = entry.name;
    playerBtn.addEventListener("click", () => {
      const changedPlayer = state.selectedPlayerId !== entry.playerId;
      state.selectedPlayerId = entry.playerId;
      if (changedPlayer) {
        state.playerParticipationExpanded = false;
      }
      renderRanking();
      renderPlayerDetail();
      refs.playerDetail.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    playerTd.appendChild(playerBtn);

    const ratingTd = document.createElement("td");
    ratingTd.setAttribute("data-label", "Rating");
    ratingTd.textContent = formatNum(entry.rating, 3);

    const championshipsTd = document.createElement("td");
    championshipsTd.setAttribute("data-label", "Participaciones");
    championshipsTd.textContent = String(entry.championships);

    const championshipsWonTd = document.createElement("td");
    championshipsWonTd.setAttribute("data-label", "Campeonatos ganados");
    championshipsWonTd.textContent = String(entry.championshipsWon);
    championshipsWonTd.classList.add("championship-wins");
    if (entry.championshipsWon > 0) {
      championshipsWonTd.classList.add("championship-wins-positive");
    }
    if (entry.championshipsWon > 0 && entry.championshipsWon === maxChampionshipWins) {
      championshipsWonTd.classList.add("championship-wins-leader");
    }

    const promedioTd = document.createElement("td");
    promedioTd.setAttribute("data-label", "Promedio");
    promedioTd.textContent = formatNum(entry.promedio, 2);

    const saldoTd = document.createElement("td");
    saldoTd.setAttribute("data-label", "Saldo");
    saldoTd.textContent = formatSigned(entry.saldoTotal, 2);
    const saldoNum = Number(entry.saldoTotal) || 0;
    if (saldoNum > 0) {
      saldoTd.classList.add("num-pos");
    } else if (saldoNum < 0) {
      saldoTd.classList.add("num-neg");
    } else {
      saldoTd.classList.add("num-zero");
    }

    tr.appendChild(posTd);
    tr.appendChild(playerTd);
    tr.appendChild(ratingTd);
    tr.appendChild(championshipsTd);
    tr.appendChild(championshipsWonTd);
    tr.appendChild(promedioTd);
    tr.appendChild(saldoTd);
    refs.rankingBody.appendChild(tr);
  });
}

function sortChampionshipsAscending(championships) {
  return [...championships].sort((a, b) => {
    const byDate = String(a.date).localeCompare(String(b.date));
    if (byDate !== 0) {
      return byDate;
    }
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

function getPlayerTimeline(playerId) {
  const timeline = [];
  const baselineScore = computeGlobalBaselineScore(state.data.championships);
  const championshipContexts = computeChampionshipContexts(state.data.championships);
  let championships = 0;
  let pointsTotal = 0;
  let saldoTotalForRating = 0;
  let relativeTotal = 0;

  sortChampionshipsAscending(state.data.championships).forEach((championship) => {
    const result = championship.results.find((row) => row.playerId === playerId);
    if (!result) {
      return;
    }

    championships += 1;
    pointsTotal += Number(result.points) || 0;
    const saldoRaw = Number(result.saldo) || 0;
    saldoTotalForRating += capSaldoForRating(saldoRaw);
    const tournamentScore = getTournamentScore(result.points, saldoRaw);
    const context = championshipContexts.get(championship.id);
    relativeTotal += computeRelativeContribution(tournamentScore, context);

    const rawRating = computeRawRating(pointsTotal, saldoTotalForRating, championships);
    const relativeAdjustment = relativeTotal / championships;
    const adjustedRating = rawRating + relativeAdjustment;
    const rating = applyRegressionToMean(adjustedRating, championships, baselineScore);

    timeline.push({
      championshipId: championship.id,
      championshipName: championship.name,
      date: championship.date,
      points: Number(result.points) || 0,
      saldo: saldoRaw,
      tournamentScore,
      rating,
    });
  });

  return timeline;
}

function computeMovingAverage(series, windowSize) {
  const normalizedWindow = Math.max(1, Math.floor(windowSize || 1));
  return series.map((value, idx) => {
    const start = Math.max(0, idx - normalizedWindow + 1);
    const slice = series.slice(start, idx + 1);
    const total = slice.reduce((sum, item) => sum + item, 0);
    return total / slice.length;
  });
}

function renderPlayerDetail() {
  refs.playerDetail.innerHTML = "";
  if (!state.selectedPlayerId) {
    refs.playerDetail.classList.add("hidden");
    return;
  }

  const player = getPlayerById(state.selectedPlayerId);
  if (!player) {
    refs.playerDetail.classList.add("hidden");
    return;
  }

  const timeline = getPlayerTimeline(state.selectedPlayerId);
  const participations = [...timeline].reverse();
  const visibleParticipations = state.playerParticipationExpanded ? participations : participations.slice(0, 5);

  const title = document.createElement("h3");
  title.className = "player-detail-title";
  title.textContent = `Participaciones y estadisticas de ${player.name}`;

  refs.playerDetail.appendChild(title);

  if (!participations.length) {
    const empty = document.createElement("p");
    empty.className = "empty empty-state";
    empty.textContent = "Este jugador no tiene participaciones registradas.";
    refs.playerDetail.appendChild(empty);
    refs.playerDetail.classList.remove("hidden");
    return;
  }

  const list = document.createElement("div");
  list.className = "player-detail-list player-participation-list";

  const bestTournament = timeline.reduce((best, item) => (item.tournamentScore > best.tournamentScore ? item : best), timeline[0]);
  const worstTournament = timeline.reduce((worst, item) => (item.tournamentScore < worst.tournamentScore ? item : worst), timeline[0]);

  const summary = document.createElement("div");
  summary.className = "player-stat-grid";

  const bestItem = document.createElement("div");
  bestItem.className = "player-stat-item player-stat-best";
  const bestStrong = document.createElement("strong");
  bestStrong.textContent = "Mejor torneo";
  bestItem.appendChild(bestStrong);
  bestItem.appendChild(document.createElement("br"));
  bestItem.appendChild(document.createTextNode(`${bestTournament.date} | ${bestTournament.championshipName}`));
  bestItem.appendChild(document.createElement("br"));
  bestItem.appendChild(document.createTextNode(`Score torneo: ${formatNum(bestTournament.tournamentScore, 2)}`));

  const worstItem = document.createElement("div");
  worstItem.className = "player-stat-item player-stat-worst";
  const worstStrong = document.createElement("strong");
  worstStrong.textContent = "Peor torneo";
  worstItem.appendChild(worstStrong);
  worstItem.appendChild(document.createElement("br"));
  worstItem.appendChild(document.createTextNode(`${worstTournament.date} | ${worstTournament.championshipName}`));
  worstItem.appendChild(document.createElement("br"));
  worstItem.appendChild(document.createTextNode(`Score torneo: ${formatNum(worstTournament.tournamentScore, 2)}`));

  summary.appendChild(bestItem);
  summary.appendChild(worstItem);
  refs.playerDetail.appendChild(summary);

  const controls = document.createElement("div");
  controls.className = "player-trend-controls";

  const limitLabel = document.createElement("label");
  limitLabel.textContent = "Ultimos N campeonatos";
  const limitInput = document.createElement("input");
  limitInput.type = "number";
  limitInput.min = "1";
  limitInput.max = String(timeline.length);
  limitInput.value = String(Math.min(state.playerTrendLimit, timeline.length));
  limitInput.addEventListener("change", () => {
    const value = Math.max(1, Math.min(timeline.length, Number(limitInput.value) || 1));
    state.playerTrendLimit = value;
    renderPlayerDetail();
  });
  limitLabel.appendChild(limitInput);

  const windowLabel = document.createElement("label");
  windowLabel.textContent = "Ventana promedio movil";
  const windowInput = document.createElement("input");
  windowInput.type = "number";
  windowInput.min = "1";
  windowInput.max = String(Math.min(timeline.length, state.playerTrendLimit));
  windowInput.value = String(Math.max(1, Math.min(state.playerMovingAvgWindow, timeline.length)));
  windowInput.addEventListener("change", () => {
    const maxAllowed = Math.max(1, Math.min(timeline.length, state.playerTrendLimit));
    const value = Math.max(1, Math.min(maxAllowed, Number(windowInput.value) || 1));
    state.playerMovingAvgWindow = value;
    renderPlayerDetail();
  });
  windowLabel.appendChild(windowInput);

  controls.appendChild(limitLabel);
  controls.appendChild(windowLabel);
  refs.playerDetail.appendChild(controls);

  const trendCount = Math.max(1, Math.min(state.playerTrendLimit, timeline.length));
  const recentTrendChronological = timeline.slice(-trendCount);
  const movingAvgWindow = Math.max(1, Math.min(state.playerMovingAvgWindow, recentTrendChronological.length));
  const movingAvg = computeMovingAverage(
    recentTrendChronological.map((item) => item.rating),
    movingAvgWindow,
  );

  const trendTitle = document.createElement("h4");
  trendTitle.className = "player-section-title player-section-trend";
  trendTitle.textContent = `Tendencia de rating (ultimos ${trendCount})`;
  refs.playerDetail.appendChild(trendTitle);

  const trendList = document.createElement("div");
  trendList.className = "player-detail-list player-trend-list";

  [...recentTrendChronological]
    .map((item, idx) => ({
      ...item,
      movingAvg: movingAvg[idx],
    }))
    .reverse()
    .forEach((item) => {
      const row = document.createElement("div");
      row.className = "player-detail-item player-detail-item-trend";
      row.textContent = `${item.date} | ${item.championshipName} | Rating: ${formatNum(item.rating, 3)} | Promedio movil(${movingAvgWindow}): ${formatNum(
        item.movingAvg,
        3,
      )}`;
      trendList.appendChild(row);
    });

  refs.playerDetail.appendChild(trendList);

  const participationTitle = document.createElement("h4");
  participationTitle.className = "player-section-title player-section-participations";
  participationTitle.textContent = `Participaciones (${participations.length})`;
  refs.playerDetail.appendChild(participationTitle);

  visibleParticipations.forEach((item) => {
    const row = document.createElement("div");
    row.className = "player-detail-item player-detail-item-participation";
    row.textContent = `${item.date} | ${item.championshipName} | Puntos: ${formatNum(item.points, 2)} | Saldo: ${formatNum(item.saldo, 2)}`;
    list.appendChild(row);
  });

  refs.playerDetail.appendChild(list);
  if (participations.length > 5) {
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "player-detail-toggle";
    toggleBtn.textContent = state.playerParticipationExpanded ? "Mostrar menos" : "Mostrar mas";
    toggleBtn.addEventListener("click", () => {
      state.playerParticipationExpanded = !state.playerParticipationExpanded;
      renderPlayerDetail();
    });
    refs.playerDetail.appendChild(toggleBtn);
  }
  refs.playerDetail.classList.remove("hidden");
}

function savePlayerNameChanges() {
  const nameInputs = [...refs.nameEditor.querySelectorAll(".edit-player-name-input")];
  if (!nameInputs.length) {
    return;
  }

  const namesById = new Map();
  const normalizedNames = new Set();

  nameInputs.forEach((input) => {
    const raw = String(input.value || "").trim().replace(/\s+/g, " ");
    const normalized = normalizeName(raw);
    if (!normalized) {
      throw new Error("Todos los jugadores deben tener nombre.");
    }
    if (normalizedNames.has(normalized)) {
      throw new Error(`Hay nombres duplicados en la edicion: "${raw}".`);
    }
    normalizedNames.add(normalized);
    namesById.set(input.dataset.playerId, raw);
  });

  let changed = false;
  state.data.players.forEach((player) => {
    const nextName = namesById.get(player.id);
    if (!nextName) {
      return;
    }
    if (player.name !== nextName) {
      player.name = nextName;
      changed = true;
    }
  });

  if (!changed) {
    showToast("No hay cambios en nombres.");
    return;
  }

  saveStore(state.data);
  renderAll();
  showToast("Nombres de jugadores actualizados.");
}

function renderNameEditor() {
  refs.nameEditor.innerHTML = "";

  if (!state.nameEditorOpen) {
    refs.nameEditor.classList.add("hidden");
    refs.toggleNameEditorBtn.textContent = "Editar nombres";
    return;
  }

  refs.nameEditor.classList.remove("hidden");
  refs.toggleNameEditorBtn.textContent = "Cerrar editor";

  const head = document.createElement("div");
  head.className = "name-editor-head";

  const title = document.createElement("h3");
  title.textContent = "Editar nombres de jugadores";

  const actions = document.createElement("div");
  actions.className = "championship-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-primary btn-sm";
  saveBtn.textContent = "Guardar nombres";
  saveBtn.addEventListener("click", () => {
    try {
      savePlayerNameChanges();
    } catch (error) {
      showToast(error.message || "No se pudieron guardar los nombres.", true);
    }
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-ghost btn-sm";
  closeBtn.textContent = "Cancelar";
  closeBtn.addEventListener("click", () => {
    state.nameEditorOpen = false;
    renderNameEditor();
  });

  actions.appendChild(saveBtn);
  actions.appendChild(closeBtn);
  head.appendChild(title);
  head.appendChild(actions);
  refs.nameEditor.appendChild(head);

  if (!state.data.players.length) {
    const empty = document.createElement("p");
    empty.className = "empty empty-state";
    empty.textContent = "Aun no hay jugadores para editar.";
    refs.nameEditor.appendChild(empty);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "name-editor-grid";

  [...state.data.players]
    .sort((a, b) => a.name.localeCompare(b.name, "es"))
    .forEach((player) => {
      const row = document.createElement("div");
      row.className = "name-editor-row";

      const currentName = document.createElement("input");
      currentName.type = "text";
      currentName.disabled = true;
      currentName.value = player.name;

      const editName = document.createElement("input");
      editName.type = "text";
      editName.className = "edit-player-name-input";
      editName.dataset.playerId = player.id;
      editName.value = player.name;
      editName.maxLength = 80;

      row.appendChild(currentName);
      row.appendChild(editName);
      grid.appendChild(row);
    });

  refs.nameEditor.appendChild(grid);
}

function sortChampionshipsForView(championships) {
  return [...championships].sort((a, b) => {
    const byDate = String(b.date).localeCompare(String(a.date));
    if (byDate !== 0) {
      return byDate;
    }
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

function renderChampionships() {
  refs.championshipList.innerHTML = "";
  const list = sortChampionshipsForView(state.data.championships);
  const visibleChampionships = state.championshipHistoryExpanded ? list : list.slice(0, 3);
  const historyColors = [
    "#4ae0ff",
    "#5ef2b9",
    "#ffcf6d",
    "#ff8ec7",
    "#9f9cff",
    "#7ff0d2",
    "#ff9f7a",
    "#9ed6ff"
  ];

  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "empty empty-state";
    empty.textContent = "Aun no hay campeonatos cargados. Completa el formulario para crear el primero.";
    refs.championshipList.appendChild(empty);
    return;
  }

  visibleChampionships.forEach((championship, index) => {
    const item = document.createElement("article");
    item.className = "championship-item";
    item.style.setProperty("--history-color", historyColors[index % historyColors.length]);

    const left = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = championship.name;
    const metaText = document.createElement("p");
    metaText.className = "championship-meta";
    metaText.textContent = `${championship.date} | ${championship.results.length} jugadores`;
    left.appendChild(title);
    left.appendChild(metaText);

    const actions = document.createElement("div");
    actions.className = "championship-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-secondary";
    editBtn.textContent = "Editar";
    editBtn.addEventListener("click", () => {
      fillFormForEdit(championship);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-danger";
    deleteBtn.textContent = "Eliminar";
    deleteBtn.addEventListener("click", () => {
      const ok = window.confirm(`Seguro que quiere eliminar "${championship.name}"? Esta accion no se puede deshacer.`);
      if (!ok) {
        return;
      }
      if (deleteChampionship(championship.id)) {
        if (state.editingChampionshipId === championship.id) {
          resetForm();
        }
        renderAll();
        showToast("Campeonato eliminado.");
      }
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(left);
    item.appendChild(actions);
    refs.championshipList.appendChild(item);
  });

  if (list.length > 3) {
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "history-toggle";
    toggleBtn.textContent = state.championshipHistoryExpanded ? "Mostrar menos" : "Mostrar mas";
    toggleBtn.addEventListener("click", () => {
      state.championshipHistoryExpanded = !state.championshipHistoryExpanded;
      renderChampionships();
    });
    refs.championshipList.appendChild(toggleBtn);
  }
}

function downloadJsonFile(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildExportPayload(data, source) {
  return {
    app: "Ranking de Billar",
    schemaVersion: APP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    source,
    data: sanitizeStore(data),
  };
}

function setDataPanelOpen(open) {
  state.dataPanelOpen = Boolean(open);
  refs.dataPanel.classList.toggle("hidden", !state.dataPanelOpen);
  refs.toggleDataBtn.setAttribute("aria-expanded", state.dataPanelOpen ? "true" : "false");
  refs.dataToggleLabel.textContent = state.dataPanelOpen ? "Ocultar" : "Desplegar";
  document.querySelector(".data-card").classList.toggle("collapsed", !state.dataPanelOpen);
}
function renderBackups() {
  refs.backupList.innerHTML = "";

  if (!state.backups.length) {
    const empty = document.createElement("p");
    empty.className = "empty empty-state";
    empty.textContent = "Todavia no hay backups manuales. Puedes crear uno antes de importar o hacer cambios grandes.";
    refs.backupList.appendChild(empty);
    return;
  }

  state.backups.forEach((backup) => {
    const item = document.createElement("article");
    item.className = "backup-item";

    const meta = document.createElement("div");
    meta.className = "backup-meta";
    const label = document.createElement("strong");
    label.textContent = backup.label;
    const createdAt = document.createElement("span");
    createdAt.textContent = formatDateTime(backup.createdAt);
    const counts = document.createElement("span");
    counts.textContent = `${backup.data.championships.length} campeonatos | ${backup.data.players.length} jugadores`;
    meta.appendChild(label);
    meta.appendChild(createdAt);
    meta.appendChild(counts);

    const actions = document.createElement("div");
    actions.className = "backup-actions";

    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "btn btn-secondary btn-sm";
    restoreBtn.textContent = "Restaurar";
    restoreBtn.addEventListener("click", async () => {
      const ok = window.confirm(`Se restaurara el backup "${backup.label}". Antes se guardara una copia del estado actual. Continuar?`);
      if (!ok) {
        return;
      }
      try {
        await createBackup("Antes de restaurar", state.data);
        state.data = cloneData(backup.data);
        await persistStateSnapshot(state.data);
        resetForm();
        renderAll();
        showToast("Backup restaurado.");
      } catch (error) {
        showToast(error.message || "No se pudo restaurar el backup.", true);
      }
    });

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "btn btn-ghost btn-sm";
    exportBtn.textContent = "Exportar";
    exportBtn.addEventListener("click", () => {
      downloadJsonFile(buildExportPayload(backup.data, `backup:${backup.label}`), `ranking-backup-${backup.id}.json`);
    });

    actions.appendChild(restoreBtn);
    actions.appendChild(exportBtn);
    item.appendChild(meta);
    item.appendChild(actions);
    refs.backupList.appendChild(item);
  });
}

function renderAll() {
  renderRanking();
  renderPlayerDetail();
  renderNameEditor();
  renderChampionships();
  renderBackups();
}

async function handleCreateBackup() {
  try {
    await createBackup("Backup manual", state.data);
    showToast("Backup creado.");
  } catch (error) {
    showToast(error.message || "No se pudo crear el backup.", true);
  }
}

function handleExport() {
  try {
    const payload = buildExportPayload(state.data, "current-state");
    const datePart = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    downloadJsonFile(payload, `ranking-billar-${datePart}.json`);
    showToast("JSON exportado.");
  } catch (error) {
    showToast(error.message || "No se pudo exportar el JSON.", true);
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsText(file, "utf-8");
  });
}

async function handleImportFile(file) {
  if (!file) {
    return;
  }

  try {
    const text = await readFileAsText(file);
    const importedData = parseDataContainer(text);
    await createBackup("Antes de importar", state.data);
    state.data = importedData;
    await persistStateSnapshot(state.data);
    await createBackup(`Importado: ${file.name}`, state.data);
    resetForm();
    renderAll();
    showToast("JSON importado correctamente.");
  } catch (error) {
    showToast(error.message || "No se pudo importar el JSON.", true);
  } finally {
    refs.importInput.value = "";
  }
}

function bindUIEvents() {
  refs.toggleFormBtn.addEventListener("click", () => {
    const formCard = document.querySelector(".form-card");
    setFormCollapsed(!formCard.classList.contains("collapsed"));
  });

  refs.floatingExpandFormBtn.addEventListener("click", () => {
    setFormCollapsed(false);
    document.querySelector(".form-card").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  refs.toggleNameEditorBtn.addEventListener("click", () => {
    state.nameEditorOpen = !state.nameEditorOpen;
    renderNameEditor();
  });

  refs.addRowBtn.addEventListener("click", () => {
    addResultRow();
  });

  refs.cancelEditBtn.addEventListener("click", () => {
    resetForm();
    showToast("Edicion cancelada.");
  });

  refs.toggleDataBtn.addEventListener("click", () => {
    setDataPanelOpen(!state.dataPanelOpen);
  });

  refs.backupBtn.addEventListener("click", () => {
    handleCreateBackup();
  });

  refs.exportBtn.addEventListener("click", () => {
    handleExport();
  });

  refs.importInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    handleImportFile(file);
  });

  refs.form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const payload = validateAndBuildPayload();

      if (state.editingChampionshipId) {
        const updated = updateChampionship(state.editingChampionshipId, payload);
        if (!updated) {
          throw new Error("No se pudo actualizar el campeonato.");
        }
        showToast("Campeonato actualizado.");
      } else {
        createChampionship(payload);
        showToast("Campeonato guardado.");
      }

      saveStore(state.data);
      resetForm();
      renderAll();
    } catch (error) {
      showToast(error.message || "Error de validacion.", true);
    }
  });
}

function isSameDataSnapshot(a, b) {
  return JSON.stringify(sanitizeStore(a)) === JSON.stringify(sanitizeStore(b));
}

async function init() {
  state.data = loadLegacyStore();
  state.backups = loadLegacyBackups();
  updatePersistenceStatus("localStorage", "Cargando persistencia...");

  bindUIEvents();
  setFormCollapsed(false);
  resetForm();
  renderAll();

  try {
    const persistedData = await loadStore();
    const persistedBackups = await loadBackups();
    const shouldRenderData = !isSameDataSnapshot(state.data, persistedData);
    const shouldRenderBackups = JSON.stringify(state.backups) !== JSON.stringify(persistedBackups);

    state.data = persistedData;
    state.backups = persistedBackups;
    state.persistenceReady = true;

    if (shouldRenderData || shouldRenderBackups) {
      renderAll();
    } else {
      renderBackups();
    }
  } catch (error) {
    state.persistenceReady = true;
    updatePersistenceStatus("localStorage", "Usando localStorage");
  }
}

init();
