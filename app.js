"use strict";

const STORAGE_KEY = "billar_ranking_v1";
const BACKUP_STORAGE_KEY = "billar_ranking_backups_v1";
const MAX_BACKUPS = 20;
const DB_NAME = "billar-ranking-db";
const DB_VERSION = 1;
const DB_MAIN_STORE = "kv";
const DB_BACKUP_STORE = "backups";
const DB_STATE_KEY = "app_state";

const state = {
  data: {
    players: [],
    championships: [],
  },
  backups: [],
  editingChampionshipId: null,
  selectedPlayerId: null,
  nameEditorOpen: false,
  medalsPanelOpen: false,
  playerTrendLimit: 5,
  playerMovingAvgWindow: 3,
  playerParticipationExpanded: false,
  playerVisualTimelineExpanded: false,
  playerHistoricalComparisonOpen: false,
  championshipHistoryExpanded: false,
  persistenceMode: "localStorage",
  persistenceReady: false,
  dataPanelOpen: false,
  lossCalculatorOpen: false,
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
  toggleMedalsBtn: document.getElementById("toggle-medals-btn"),
  toggleNameEditorBtn: document.getElementById("toggle-name-editor-btn"),
  rankingBody: document.getElementById("ranking-body"),
  playerDetail: document.getElementById("player-detail"),
  medalsPanel: document.getElementById("medals-panel"),
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
  toggleLossCalculatorBtn: document.getElementById("toggle-loss-calculator-btn"),
  lossCalculatorCard: document.getElementById("loss-calculator-card"),
  lossCalculatorForm: document.getElementById("loss-calculator-form"),
  lossPlayerAName: document.getElementById("loss-player-a-name"),
  lossPlayerABalls: document.getElementById("loss-player-a-balls"),
  lossPlayerBName: document.getElementById("loss-player-b-name"),
  lossPlayerBBalls: document.getElementById("loss-player-b-balls"),
  lossLoserSelect: document.getElementById("loss-loser-select"),
  resetLossCalculatorBtn: document.getElementById("reset-loss-calculator-btn"),
  lossCalculatorResult: document.getElementById("loss-calculator-result"),
};

const rankingCore = window.RankingCore;
if (!rankingCore) {
  throw new Error("RankingCore no esta disponible.");
}

const {
  APP_SCHEMA_VERSION,
  buildExportPayload,
  buildPlayerLookup,
  capSaldoForRating,
  clamp,
  cloneData,
  compareChampionshipResults,
  computeChampionshipContexts,
  computeConsistencyAdjustment,
  computeGlobalPerformanceStats,
  computeRanking,
  computeRankingMovement,
  computeRawRating,
  computeRelativeContribution,
  computeTournamentPerformance,
  createBackupRecord,
  createEmptyData,
  getOrderedChampionshipResults,
  getTournamentScore,
  normalizeName,
  normalizeRange,
  parseDataContainer,
  sanitizeStore,
  sortChampionshipsAscending,
  applyRegressionToMean,
} = rankingCore;

let dbPromise = null;

function createId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`;
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

async function persistAndApplyData(nextData) {
  const persistedData = await persistStateSnapshot(nextData);
  state.data = persistedData;
  return persistedData;
}

async function saveStore(data) {
  try {
    return await persistStateSnapshot(data);
  } catch (error) {
    updatePersistenceStatus("error", "Error de guardado");
    throw error;
  }
}

function getPlayerById(playerId) {
  return state.data.players.find((player) => player.id === playerId) || null;
}

function getPlayerByNormalizedName(normalizedName) {
  return state.data.players.find((player) => normalizeName(player.name) === normalizedName) || null;
}

function createPlayerRecord(name) {
  return {
    id: createId("p"),
    name: String(name).trim().replace(/\s+/g, " "),
    createdAt: new Date().toISOString(),
  };
}

function buildResultsPayload(validatedRows) {
  const stagedPlayers = new Map();
  const playersToCreate = [];

  const results = validatedRows.map((row) => {
    const normalized = normalizeName(row.playerName);
    const existingPlayer = getPlayerByNormalizedName(normalized);
    if (existingPlayer) {
      return {
        playerId: existingPlayer.id,
        points: row.points,
        saldo: row.saldo,
      };
    }

    let stagedPlayer = stagedPlayers.get(normalized);
    if (!stagedPlayer) {
      stagedPlayer = createPlayerRecord(row.playerName);
      stagedPlayers.set(normalized, stagedPlayer);
      playersToCreate.push(stagedPlayer);
    }

    return {
      playerId: stagedPlayer.id,
      points: row.points,
      saldo: row.saldo,
    };
  });

  return {
    results,
    playersToCreate,
  };
}

async function commitDataMutation(mutator) {
  const previousData = cloneData(state.data);
  try {
    mutator(state.data);
    await saveStore(state.data);
    return true;
  } catch (error) {
    state.data = previousData;
    throw error;
  }
}

async function createChampionship(payload) {
  const now = new Date().toISOString();
  const championship = {
    id: createId("c"),
    name: payload.name,
    date: payload.date,
    results: payload.results,
    createdAt: now,
    updatedAt: now,
  };
  await commitDataMutation((draft) => {
    if (payload.playersToCreate?.length) {
      draft.players.push(...payload.playersToCreate.map((player) => ({ ...player })));
    }
    draft.championships.push(championship);
  });
  return championship;
}

async function updateChampionship(championshipId, payload) {
  let updated = null;
  await commitDataMutation((draft) => {
    const item = draft.championships.find((championship) => championship.id === championshipId);
    if (!item) {
      throw new Error("No se pudo actualizar el campeonato.");
    }

    if (payload.playersToCreate?.length) {
      draft.players.push(...payload.playersToCreate.map((player) => ({ ...player })));
    }

    item.name = payload.name;
    item.date = payload.date;
    item.results = payload.results;
    item.updatedAt = new Date().toISOString();
    updated = item;
  });
  return updated;
}

async function deleteChampionship(championshipId) {
  let deleted = false;
  await commitDataMutation((draft) => {
    const idx = draft.championships.findIndex((championship) => championship.id === championshipId);
    if (idx === -1) {
      return;
    }
    draft.championships.splice(idx, 1);
    deleted = true;
  });
  return deleted;
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

function parseBallCount(value) {
  const num = parseNumber(value);
  if (num === null || !Number.isInteger(num) || num < 0 || num > 7) {
    return null;
  }
  return num;
}

function getVeryLowPlacementStart(totalParticipants) {
  if (totalParticipants <= 1) {
    return Number.POSITIVE_INFINITY;
  }
  return totalParticipants <= 4 ? totalParticipants : Math.max(2, totalParticipants - 1);
}

const MEDAL_ICONS = {
  gold: "\u{1F947}",
  silver: "\u{1F948}",
  bronze: "\u{1F949}",
  total: "\u{1F3C5}",
};

function getMovementMeta(entry) {
  if (entry.previousPosition === null) {
    return {
      className: "movement-neutral",
      badge: "Nuevo",
      detail: "Sin ranking anterior",
    };
  }

  if (entry.movementDelta > 0) {
    const names = entry.climbedPast.length ? entry.climbedPast.join(", ") : "sin cruces directos";
    return {
      className: "movement-up",
      badge: `+${entry.movementDelta}`,
      detail: `Subio sobre ${names}`,
    };
  }

  if (entry.movementDelta < 0) {
    const names = entry.overtakenBy.length ? entry.overtakenBy.join(", ") : "sin cruces directos";
    return {
      className: "movement-down",
      badge: String(entry.movementDelta),
      detail: `Bajo por ${names}`,
    };
  }

  return {
    className: "movement-neutral",
    badge: "=",
    detail: "Sin cambios",
  };
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

function setLossCalculatorOpen(open) {
  state.lossCalculatorOpen = Boolean(open);
  refs.lossCalculatorCard.classList.toggle("hidden", !state.lossCalculatorOpen);
  refs.toggleLossCalculatorBtn.setAttribute("aria-expanded", state.lossCalculatorOpen ? "true" : "false");
  refs.toggleLossCalculatorBtn.textContent = state.lossCalculatorOpen ? "Ocultar calculadora de perdidas" : "Calculadora de perdidas";
}

function resetLossCalculator() {
  refs.lossCalculatorForm.reset();
  refs.lossPlayerABalls.value = "0";
  refs.lossPlayerBBalls.value = "0";
  refs.lossLoserSelect.value = "A";
  refs.lossCalculatorResult.classList.add("hidden");
  refs.lossCalculatorResult.innerHTML = "";
}

function calculateLossOutcome(payload) {
  const loserKey = payload.loserKey;
  const winnerKey = loserKey === "A" ? "B" : "A";
  const loser = payload.players[loserKey];
  const winner = payload.players[winnerKey];
  const saldo = winner.balls < loser.balls ? loser.balls - winner.balls : 0;

  return {
    loserKey,
    winnerKey,
    loser,
    winner,
    saldo,
  };
}

function renderLossCalculatorResult(result) {
  const winnerLabel = result.winner.name || `Participante ${result.winnerKey}`;
  const loserLabel = result.loser.name || `Participante ${result.loserKey}`;
  const saldoLabel = result.saldo > 0 ? `+${result.saldo}` : "0";
  const detail =
    result.saldo > 0
      ? `${winnerLabel} estaba mas cerca de ganar (${result.winner.balls} contra ${result.loser.balls}) y se lleva la diferencia completa.`
      : `${loserLabel} era quien estaba mas cerca de ganar o iba empatado, asi que ${winnerLabel} gana la partida pero el saldo queda en 0.`;

  refs.lossCalculatorResult.replaceChildren();

  const badge = document.createElement("div");
  badge.className = "loss-result-badge";
  badge.textContent = `Gana ${winnerLabel}`;

  const score = document.createElement("p");
  score.className = "loss-result-score";
  score.append("Saldo: ");
  const scoreValue = document.createElement("strong");
  scoreValue.textContent = saldoLabel;
  score.appendChild(scoreValue);

  const detailNode = document.createElement("p");
  detailNode.className = "loss-result-detail";
  detailNode.textContent = detail;

  refs.lossCalculatorResult.appendChild(badge);
  refs.lossCalculatorResult.appendChild(score);
  refs.lossCalculatorResult.appendChild(detailNode);
  refs.lossCalculatorResult.classList.remove("hidden");
}

function handleLossCalculatorSubmit(event) {
  event.preventDefault();

  const playerA = {
    name: refs.lossPlayerAName.value.trim(),
    balls: parseBallCount(refs.lossPlayerABalls.value),
  };
  const playerB = {
    name: refs.lossPlayerBName.value.trim(),
    balls: parseBallCount(refs.lossPlayerBBalls.value),
  };

  if (playerA.balls === null || playerB.balls === null) {
    showToast("Las bolas restantes deben ser numeros enteros entre 0 y 7.", true);
    return;
  }

  const loserKey = refs.lossLoserSelect.value === "B" ? "B" : "A";
  const result = calculateLossOutcome({
    loserKey,
    players: {
      A: playerA,
      B: playerB,
    },
  });

  renderLossCalculatorResult(result);
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
  const editingChampionship = state.editingChampionshipId
    ? state.data.championships.find((championship) => championship.id === state.editingChampionshipId) || null
    : null;
  const originalPlayerCount = editingChampionship ? editingChampionship.results.length : 0;
  const isLegacyChampionship = originalPlayerCount > 0 && originalPlayerCount < 8;

  if (!isLegacyChampionship && rows.length < 8) {
    throw new Error("Debe guardar como minimo 8 jugadores.");
  }
  if (isLegacyChampionship && rows.length < originalPlayerCount) {
    throw new Error(`Este campeonato ya tenia ${originalPlayerCount} jugadores. No puede guardar con menos de esa cantidad.`);
  }

  const normalizedInChampionship = new Set();
  const validatedRows = [];

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

    validatedRows.push({
      playerName,
      points,
      saldo,
    });
  });

  const { results, playersToCreate } = buildResultsPayload(validatedRows);

  return {
    name,
    date,
    results,
    playersToCreate,
  };
}

function renderRanking() {
  const ranking = computeRankingMovement(state.data.championships, state.data.players);
  refs.rankingBody.innerHTML = "";

  if (!ranking.length) {
    state.selectedPlayerId = null;
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="9" class="empty empty-state">Sin datos de ranking todavia. Crea un campeonato para comenzar.</td>';
    refs.rankingBody.appendChild(tr);
    return;
  }

  const maxChampionshipWins = ranking.reduce((maxWins, entry) => Math.max(maxWins, entry.championshipsWon), 0);

  if (!ranking.some((entry) => entry.playerId === state.selectedPlayerId)) {
    state.selectedPlayerId = ranking[0].playerId;
    state.playerParticipationExpanded = false;
    state.playerVisualTimelineExpanded = false;
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
        state.playerVisualTimelineExpanded = false;
        state.playerHistoricalComparisonOpen = false;
      }
      renderRanking();
      renderPlayerDetail();
      refs.playerDetail.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    playerTd.appendChild(playerBtn);

    const movementTd = document.createElement("td");
    movementTd.setAttribute("data-label", "+/-");
    const movementMeta = getMovementMeta(entry);
    movementTd.className = `movement-cell ${movementMeta.className}`;
    const movementStrong = document.createElement("strong");
    movementStrong.textContent = movementMeta.badge;
    const movementSmall = document.createElement("small");
    movementSmall.textContent = movementMeta.detail;
    movementTd.appendChild(movementStrong);
    movementTd.appendChild(movementSmall);

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

    const podiumRateTd = document.createElement("td");
    podiumRateTd.setAttribute("data-label", "Efectividad de podio");
    podiumRateTd.textContent = `${formatNum(entry.podiumRate, 1)}%`;

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
    tr.appendChild(movementTd);
    tr.appendChild(ratingTd);
    tr.appendChild(championshipsTd);
    tr.appendChild(championshipsWonTd);
    tr.appendChild(podiumRateTd);
    tr.appendChild(promedioTd);
    tr.appendChild(saldoTd);
    refs.rankingBody.appendChild(tr);
  });
}

function getChampionshipPlacement(championship, playerId) {
  const ordered = getOrderedChampionshipResults(championship.results, buildPlayerLookup(state.data.players));

  const position = ordered.findIndex((item) => item.playerId === playerId);
  if (position === -1) {
    return null;
  }

  return {
    position: position + 1,
    totalParticipants: ordered.length,
  };
}

function getPerformanceLabel(position, totalParticipants) {
  if (position === 1) {
    return "Excelente";
  }
  if (position >= getVeryLowPlacementStart(totalParticipants)) {
    return "Muy insuficiente";
  }
  if (position >= 2 && position <= 4) {
    return "Muy bueno";
  }
  if (position >= 5 && position <= 8) {
    return "Bueno";
  }
  if (position >= 9) {
    return "Insuficiente";
  }
  return "Bueno";
}

function getPerformanceTone(position, totalParticipants) {
  if (position === 1) {
    return "strong";
  }
  if (position >= getVeryLowPlacementStart(totalParticipants)) {
    return "very-low";
  }
  if (position >= 2 && position <= 4) {
    return "strong";
  }
  if (position >= 5 && position <= 8) {
    return "mid";
  }
  if (position >= 9) {
    return "low";
  }
  return "low";
}

function getPlacementMedal(position) {
  if (position === 1) {
    return "\u{1F947}";
  }
  if (position === 2) {
    return "\u{1F948}";
  }
  if (position === 3) {
    return "\u{1F949}";
  }
  return "";
}

function getPlayerTimeline(playerId) {
  const timeline = [];
  const playerLookup = buildPlayerLookup(state.data.players);
  const championshipContexts = computeChampionshipContexts(state.data.championships, playerLookup);
  const globalPerformanceStats = computeGlobalPerformanceStats(state.data.championships, championshipContexts);
  const baselineScore = globalPerformanceStats.mean;
  let championships = 0;
  let performanceTotal = 0;
  const performanceHistory = [];
  let previousRating = null;

  sortChampionshipsAscending(state.data.championships).forEach((championship) => {
    const result = championship.results.find((row) => row.playerId === playerId);
    if (!result) {
      return;
    }

    championships += 1;
    const saldoRaw = Number(result.saldo) || 0;
    const context = championshipContexts.get(championship.id);
    const tournamentScore = computeTournamentPerformance(result, context);
    performanceTotal += tournamentScore;
    performanceHistory.push(tournamentScore);

    const rawRating = computeRawRating(performanceTotal, championships);
    const regressedRating = applyRegressionToMean(rawRating, championships, baselineScore);
    const consistencyAdjustment = computeConsistencyAdjustment(
      performanceHistory,
      globalPerformanceStats.std,
      championships,
    );
    const rating = clamp(regressedRating + consistencyAdjustment, 0, 100);
    const placement = getChampionshipPlacement(championship, playerId) || {
      position: championship.results.length,
      totalParticipants: championship.results.length,
    };
    const ratingDelta = previousRating === null ? 0 : rating - previousRating;
    previousRating = rating;

    timeline.push({
      championshipId: championship.id,
      championshipName: championship.name,
      date: championship.date,
      points: Number(result.points) || 0,
      saldo: saldoRaw,
      tournamentScore,
      rating,
      ratingDelta,
      position: placement.position,
      totalParticipants: placement.totalParticipants,
      performanceLabel: getPerformanceLabel(placement.position, placement.totalParticipants),
      performanceTone: getPerformanceTone(placement.position, placement.totalParticipants),
      placementMedal: getPlacementMedal(placement.position),
      wonChampionship: placement.position === 1,
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

function getNormalizedMetric(value, min, max) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return 1;
  }
  return (value - min) / (max - min);
}

function getRatingDeltaMeta(delta) {
  if (delta > 0) {
    return {
      symbol: "\u25B2",
      className: "is-positive",
      text: `+${formatNum(delta, 3)}`,
    };
  }
  if (delta < 0) {
    return {
      symbol: "\u25BC",
      className: "is-negative",
      text: formatNum(delta, 3),
    };
  }
  return {
    symbol: "\u2022",
    className: "is-neutral",
    text: formatNum(delta, 3),
  };
}

function ensurePersistenceReady(actionLabel = "hacer cambios") {
  if (state.persistenceReady) {
    return true;
  }
  showToast(`Espera a que termine la carga antes de ${actionLabel}.`, true);
  return false;
}

function updateMutationControls() {
  const disabled = !state.persistenceReady;
  refs.saveBtn.disabled = disabled;
  refs.backupBtn.disabled = disabled;
  refs.importInput.disabled = disabled;
}

function getHistoricalComparisonMeta(delta) {
  const threshold = 0.35;
  if (delta > threshold) {
    return {
      label: "Por encima de su media",
      className: "is-positive",
      shortLabel: "Arriba",
    };
  }
  if (delta < -threshold) {
    return {
      label: "Por debajo de su media",
      className: "is-negative",
      shortLabel: "Abajo",
    };
  }
  return {
    label: "En linea con su media",
    className: "is-neutral",
    shortLabel: "Igual",
  };
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
  const visualTimelineItems = state.playerVisualTimelineExpanded ? participations : participations.slice(0, 2);
  const visibleParticipations = state.playerParticipationExpanded ? participations : participations.slice(0, 5);
  const historicalAverage = timeline.length
    ? timeline.reduce((sum, item) => sum + item.tournamentScore, 0) / timeline.length
    : 0;
  const historicalComparisonItems = [...timeline]
    .map((item) => {
      const deltaVsAverage = item.tournamentScore - historicalAverage;
      return {
        ...item,
        deltaVsAverage,
        comparisonMeta: getHistoricalComparisonMeta(deltaVsAverage),
      };
    })
    .reverse();

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
  const podiumCount = timeline.filter((item) => item.position <= 3).length;
  const podiumRate = timeline.length ? (podiumCount / timeline.length) * 100 : 0;

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
  bestItem.appendChild(document.createTextNode(`Rendimiento torneo: ${formatNum(bestTournament.tournamentScore, 2)}`));

  const worstItem = document.createElement("div");
  worstItem.className = "player-stat-item player-stat-worst";
  const worstStrong = document.createElement("strong");
  worstStrong.textContent = "Peor torneo";
  worstItem.appendChild(worstStrong);
  worstItem.appendChild(document.createElement("br"));
  worstItem.appendChild(document.createTextNode(`${worstTournament.date} | ${worstTournament.championshipName}`));
  worstItem.appendChild(document.createElement("br"));
  worstItem.appendChild(document.createTextNode(`Rendimiento torneo: ${formatNum(worstTournament.tournamentScore, 2)}`));

  const podiumItem = document.createElement("div");
  podiumItem.className = "player-stat-item";
  const podiumStrong = document.createElement("strong");
  podiumStrong.textContent = "Efectividad de podio";
  podiumItem.appendChild(podiumStrong);
  podiumItem.appendChild(document.createElement("br"));
  podiumItem.appendChild(document.createTextNode(`${formatNum(podiumRate, 1)}%`));
  podiumItem.appendChild(document.createElement("br"));
  podiumItem.appendChild(document.createTextNode(`${podiumCount} podios en ${timeline.length} participaciones`));

  summary.appendChild(bestItem);
  summary.appendChild(worstItem);
  summary.appendChild(podiumItem);
  refs.playerDetail.appendChild(summary);

  const timelineTitle = document.createElement("h4");
  timelineTitle.className = "player-section-title player-section-timeline";
  timelineTitle.textContent = "Linea de tiempo competitiva";
  refs.playerDetail.appendChild(timelineTitle);

  const timelineVisual = document.createElement("div");
  timelineVisual.className = "player-visual-timeline";

  const ratingValues = timeline.map((item) => item.rating);
  const scoreValues = timeline.map((item) => item.tournamentScore);
  const minRating = Math.min(...ratingValues);
  const maxRating = Math.max(...ratingValues);
  const minScore = Math.min(...scoreValues);
  const maxScore = Math.max(...scoreValues);

  visualTimelineItems.forEach((item) => {
    const deltaMeta = getRatingDeltaMeta(item.ratingDelta);
    const entry = document.createElement("article");
    entry.className = `player-timeline-entry tone-${item.performanceTone}`;

    const marker = document.createElement("div");
    marker.className = "player-timeline-marker";
    marker.textContent = item.placementMedal || String(item.position);

    const content = document.createElement("div");
    content.className = "player-timeline-content";

    const head = document.createElement("div");
    head.className = "player-timeline-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "player-timeline-title-wrap";

    const itemTitle = document.createElement("strong");
    itemTitle.className = "player-timeline-title";
    itemTitle.textContent = item.championshipName;

    const itemDate = document.createElement("span");
    itemDate.className = "player-timeline-date";
    itemDate.textContent = item.date;

    titleWrap.appendChild(itemTitle);
    titleWrap.appendChild(itemDate);

    const badge = document.createElement("span");
    badge.className = `player-timeline-badge tone-${item.performanceTone}`;
    badge.textContent = `${item.performanceLabel} | ${item.position}/${item.totalParticipants}`;

    head.appendChild(titleWrap);
    head.appendChild(badge);

    const metrics = document.createElement("div");
    metrics.className = "player-timeline-metrics";

    const ratingMetric = document.createElement("div");
    ratingMetric.className = "player-timeline-metric";
    ratingMetric.innerHTML = `<span>Rating</span><strong>${formatNum(item.rating, 3)}</strong><small class="${deltaMeta.className}">${deltaMeta.symbol} ${deltaMeta.text} vs. torneo anterior</small>`;

    const scoreMetric = document.createElement("div");
    scoreMetric.className = "player-timeline-metric";
    scoreMetric.innerHTML = `<span>Rendimiento</span><strong>${formatNum(item.tournamentScore, 2)}</strong><small>Puntos ${formatNum(item.points, 2)} | Saldo ${formatNum(item.saldo, 2)}</small>`;

    metrics.appendChild(ratingMetric);
    metrics.appendChild(scoreMetric);

    const bars = document.createElement("div");
    bars.className = "player-timeline-bars";

    const ratingBar = document.createElement("div");
    ratingBar.className = "player-timeline-bar";
    ratingBar.innerHTML = `<label>Momento de rating</label><div><span style="width:${Math.max(10, getNormalizedMetric(item.rating, minRating, maxRating) * 100)}%"></span></div>`;

    const scoreBar = document.createElement("div");
    scoreBar.className = "player-timeline-bar";
    scoreBar.innerHTML = `<label>Como le fue en ese campeonato</label><div><span style="width:${Math.max(10, getNormalizedMetric(item.tournamentScore, minScore, maxScore) * 100)}%"></span></div>`;

    bars.appendChild(ratingBar);
    bars.appendChild(scoreBar);

    content.appendChild(head);
    content.appendChild(metrics);
    content.appendChild(bars);

    entry.appendChild(marker);
    entry.appendChild(content);
    timelineVisual.appendChild(entry);
  });

  refs.playerDetail.appendChild(timelineVisual);

  if (participations.length > 2) {
    const timelineToggleBtn = document.createElement("button");
    timelineToggleBtn.type = "button";
    timelineToggleBtn.className = "player-detail-toggle";
    timelineToggleBtn.textContent = state.playerVisualTimelineExpanded ? "Mostrar menos" : "Mostrar mas";
    timelineToggleBtn.addEventListener("click", () => {
      state.playerVisualTimelineExpanded = !state.playerVisualTimelineExpanded;
      renderPlayerDetail();
    });
    refs.playerDetail.appendChild(timelineToggleBtn);
  }

  const historicalToggleBtn = document.createElement("button");
  historicalToggleBtn.type = "button";
  historicalToggleBtn.className = "player-detail-toggle player-detail-toggle-compare";
  historicalToggleBtn.textContent = state.playerHistoricalComparisonOpen
    ? "Ocultar comparacion con su promedio"
    : "Ver comparacion con su promedio";
  historicalToggleBtn.addEventListener("click", () => {
    state.playerHistoricalComparisonOpen = !state.playerHistoricalComparisonOpen;
    renderPlayerDetail();
  });
  refs.playerDetail.appendChild(historicalToggleBtn);

  if (state.playerHistoricalComparisonOpen) {
    const comparisonTitle = document.createElement("h4");
    comparisonTitle.className = "player-section-title player-section-comparison";
    comparisonTitle.textContent = "Comparacion contra su promedio historico";
    refs.playerDetail.appendChild(comparisonTitle);

    const comparisonHint = document.createElement("p");
    comparisonHint.className = "player-comparison-hint";
    comparisonHint.textContent = `Media historica de rendimiento: ${formatNum(historicalAverage, 2)} puntos.`;
    refs.playerDetail.appendChild(comparisonHint);

    const comparisonChart = document.createElement("div");
    comparisonChart.className = "player-comparison-chart";

    const maxDelta = historicalComparisonItems.reduce(
      (max, item) => Math.max(max, Math.abs(item.deltaVsAverage)),
      0,
    );
    const normalizedMaxDelta = maxDelta > 0 ? maxDelta : 1;

    historicalComparisonItems.forEach((item) => {
      const row = document.createElement("article");
      row.className = "player-comparison-row";

      const header = document.createElement("div");
      header.className = "player-comparison-head";

      const titleWrap = document.createElement("div");
      titleWrap.className = "player-comparison-title-wrap";

      const eventTitle = document.createElement("strong");
      eventTitle.className = "player-comparison-title";
      eventTitle.textContent = item.championshipName;

      const eventMeta = document.createElement("span");
      eventMeta.className = "player-comparison-date";
      eventMeta.textContent = `${item.date} | Rendimiento ${formatNum(item.tournamentScore, 2)}`;

      titleWrap.appendChild(eventTitle);
      titleWrap.appendChild(eventMeta);

      const status = document.createElement("span");
      status.className = `player-comparison-badge ${item.comparisonMeta.className}`;
      status.textContent = item.comparisonMeta.label;

      header.appendChild(titleWrap);
      header.appendChild(status);

      const barWrap = document.createElement("div");
      barWrap.className = "player-comparison-bar-wrap";

      const barTrack = document.createElement("div");
      barTrack.className = "player-comparison-bar-track";

      const bar = document.createElement("span");
      bar.className = `player-comparison-bar ${item.comparisonMeta.className}`;
      const width = (Math.abs(item.deltaVsAverage) / normalizedMaxDelta) * 50;
      bar.style.width = `${Math.max(Math.abs(item.deltaVsAverage) < 0.01 ? 4 : width, 4)}%`;
      if (item.deltaVsAverage >= 0) {
        bar.classList.add("to-right");
      } else {
        bar.classList.add("to-left");
      }

      barTrack.appendChild(bar);
      barWrap.appendChild(barTrack);

      const footer = document.createElement("div");
      footer.className = "player-comparison-footer";
      footer.innerHTML = `<span>Diferencia vs media</span><strong class="${item.comparisonMeta.className}">${item.deltaVsAverage >= 0 ? "+" : ""}${formatNum(
        item.deltaVsAverage,
        2,
      )}</strong><small>${item.comparisonMeta.shortLabel}</small>`;

      row.appendChild(header);
      row.appendChild(barWrap);
      row.appendChild(footer);
      comparisonChart.appendChild(row);
    });

    refs.playerDetail.appendChild(comparisonChart);
  }

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

async function savePlayerNameChanges() {
  if (!ensurePersistenceReady("guardar nombres")) {
    return;
  }
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
    if (nextName && player.name !== nextName) {
      changed = true;
    }
  });

  if (!changed) {
    showToast("No hay cambios en nombres.");
    return;
  }

  await commitDataMutation((draft) => {
    draft.players.forEach((player) => {
      const nextName = namesById.get(player.id);
      if (nextName) {
        player.name = nextName;
      }
    });
  });
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
  saveBtn.addEventListener("click", async () => {
    try {
      await savePlayerNameChanges();
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

function computeMedalStandings() {
  const medalMap = new Map();

  state.data.players.forEach((player) => {
    medalMap.set(player.id, {
      playerId: player.id,
      name: player.name,
      gold: 0,
      silver: 0,
      bronze: 0,
      total: 0,
    });
  });

  state.data.championships.forEach((championship) => {
    const ordered = [...championship.results].sort((a, b) => {
      const pointsDiff = (Number(b.points) || 0) - (Number(a.points) || 0);
      if (pointsDiff !== 0) {
        return pointsDiff;
      }

      const saldoDiff = (Number(b.saldo) || 0) - (Number(a.saldo) || 0);
      if (saldoDiff !== 0) {
        return saldoDiff;
      }

      const playerA = getPlayerById(a.playerId);
      const playerB = getPlayerById(b.playerId);
      return String(playerA?.name || "").localeCompare(String(playerB?.name || ""), "es");
    });

    ordered.slice(0, 3).forEach((result, index) => {
      const item = medalMap.get(result.playerId);
      if (!item) {
        return;
      }

      if (index === 0) {
        item.gold += 1;
      } else if (index === 1) {
        item.silver += 1;
      } else if (index === 2) {
        item.bronze += 1;
      }

      item.total += 1;
    });
  });

  return [...medalMap.values()]
    .filter((item) => item.total > 0)
    .sort((a, b) => {
      if (b.gold !== a.gold) {
        return b.gold - a.gold;
      }
      if (b.silver !== a.silver) {
        return b.silver - a.silver;
      }
      if (b.bronze !== a.bronze) {
        return b.bronze - a.bronze;
      }
      return a.name.localeCompare(b.name, "es");
    });
}

function getMedalCategoryLeader(entries, key) {
  const maxValue = entries.reduce((max, item) => Math.max(max, item[key]), 0);
  if (maxValue <= 0) {
    return null;
  }

  return {
    value: maxValue,
    names: entries.filter((item) => item[key] === maxValue).map((item) => item.name),
  };
}

function renderMedalsPanelLegacyUnsafe() {
  refs.medalsPanel.innerHTML = "";

  if (!state.medalsPanelOpen) {
    refs.medalsPanel.classList.add("hidden");
    refs.toggleMedalsBtn.textContent = "Medallas";
    return;
  }

  refs.medalsPanel.classList.remove("hidden");
  refs.toggleMedalsBtn.textContent = "Cerrar medallas";

  const title = document.createElement("h3");
  title.className = "medals-panel-title";
  title.textContent = "Medallero";
  refs.medalsPanel.appendChild(title);

  const standings = computeMedalStandings();
  if (!standings.length) {
    const empty = document.createElement("p");
    empty.className = "empty empty-state";
    empty.textContent = "Todavia no hay suficientes campeonatos para mostrar medallas.";
    refs.medalsPanel.appendChild(empty);
    return;
  }

  const summary = document.createElement("div");
  summary.className = "medals-summary-grid";

  [
    { icon: "🥇", label: "Mas oros", key: "gold" },
    { icon: "🥈", label: "Mas platas", key: "silver" },
    { icon: "🥉", label: "Mas bronces", key: "bronze" },
    { icon: "🏅", label: "Medallas totales", key: "total" },
  ].forEach((category) => {
    const leader = getMedalCategoryLeader(standings, category.key);
    const card = document.createElement("article");
    card.className = "medal-summary-card";

    const cardLabel = document.createElement("span");
    cardLabel.className = "medal-summary-label";
    cardLabel.textContent = `${category.icon} ${category.label}`;

    const cardNames = document.createElement("strong");
    cardNames.className = "medal-summary-names";
    cardNames.textContent = leader ? leader.names.join(" / ") : "Sin lider";

    const cardValue = document.createElement("small");
    cardValue.className = "medal-summary-value";
    cardValue.textContent = leader ? `${leader.value} ${leader.value === 1 ? "medalla" : "medallas"}` : "0 medallas";

    card.appendChild(cardLabel);
    card.appendChild(cardNames);
    card.appendChild(cardValue);
    summary.appendChild(card);
  });

  refs.medalsPanel.appendChild(summary);

  const tableTitle = document.createElement("h4");
  tableTitle.className = "player-section-title medals-table-title";
  tableTitle.textContent = "Medallero general";
  refs.medalsPanel.appendChild(tableTitle);

  const list = document.createElement("div");
  list.className = "medals-list";

  standings.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "medals-row";
    row.innerHTML = `<strong>${entry.name}</strong><span>🥇 ${entry.gold}</span><span>🥈 ${entry.silver}</span><span>🥉 ${entry.bronze}</span><span>🏅 ${entry.total}</span>`;
    list.appendChild(row);
  });

  refs.medalsPanel.appendChild(list);
}

function renderMedalsPanel() {
  refs.medalsPanel.innerHTML = "";

  if (!state.medalsPanelOpen) {
    refs.medalsPanel.classList.add("hidden");
    refs.toggleMedalsBtn.textContent = "Medallas";
    return;
  }

  refs.medalsPanel.classList.remove("hidden");
  refs.toggleMedalsBtn.textContent = "Cerrar medallas";

  const title = document.createElement("h3");
  title.className = "medals-panel-title";
  title.textContent = "Medallero";
  refs.medalsPanel.appendChild(title);

  const standings = computeMedalStandings();
  if (!standings.length) {
    const empty = document.createElement("p");
    empty.className = "empty empty-state";
    empty.textContent = "Todavia no hay suficientes campeonatos para mostrar medallas.";
    refs.medalsPanel.appendChild(empty);
    return;
  }

  const summary = document.createElement("div");
  summary.className = "medals-summary-grid";

  [
    { icon: MEDAL_ICONS.gold, label: "Mas oros", key: "gold" },
    { icon: MEDAL_ICONS.silver, label: "Mas platas", key: "silver" },
    { icon: MEDAL_ICONS.bronze, label: "Mas bronces", key: "bronze" },
    { icon: MEDAL_ICONS.total, label: "Medallas totales", key: "total" },
  ].forEach((category) => {
    const leader = getMedalCategoryLeader(standings, category.key);
    const card = document.createElement("article");
    card.className = "medal-summary-card";

    const cardLabel = document.createElement("span");
    cardLabel.className = "medal-summary-label";
    cardLabel.textContent = `${category.icon} ${category.label}`;

    const cardNames = document.createElement("strong");
    cardNames.className = "medal-summary-names";
    cardNames.textContent = leader ? leader.names.join(" / ") : "Sin lider";

    const cardValue = document.createElement("small");
    cardValue.className = "medal-summary-value";
    cardValue.textContent = leader ? `${leader.value} ${leader.value === 1 ? "medalla" : "medallas"}` : "0 medallas";

    card.appendChild(cardLabel);
    card.appendChild(cardNames);
    card.appendChild(cardValue);
    summary.appendChild(card);
  });

  refs.medalsPanel.appendChild(summary);

  const tableTitle = document.createElement("h4");
  tableTitle.className = "player-section-title medals-table-title";
  tableTitle.textContent = "Medallero general";
  refs.medalsPanel.appendChild(tableTitle);

  const list = document.createElement("div");
  list.className = "medals-list";

  standings.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "medals-row";

    const name = document.createElement("strong");
    name.textContent = entry.name;

    const gold = document.createElement("span");
    gold.textContent = `${MEDAL_ICONS.gold} ${entry.gold}`;

    const silver = document.createElement("span");
    silver.textContent = `${MEDAL_ICONS.silver} ${entry.silver}`;

    const bronze = document.createElement("span");
    bronze.textContent = `${MEDAL_ICONS.bronze} ${entry.bronze}`;

    const total = document.createElement("span");
    total.textContent = `${MEDAL_ICONS.total} ${entry.total}`;

    row.appendChild(name);
    row.appendChild(gold);
    row.appendChild(silver);
    row.appendChild(bronze);
    row.appendChild(total);
    list.appendChild(row);
  });

  refs.medalsPanel.appendChild(list);
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
    deleteBtn.disabled = !state.persistenceReady;
    deleteBtn.addEventListener("click", async () => {
      if (!ensurePersistenceReady("eliminar campeonatos")) {
        return;
      }
      const ok = window.confirm(`Seguro que quiere eliminar "${championship.name}"? Esta accion no se puede deshacer.`);
      if (!ok) {
        return;
      }
      try {
        const deleted = await deleteChampionship(championship.id);
        if (!deleted) {
          return;
        }
        if (state.editingChampionshipId === championship.id) {
          resetForm();
        }
        renderAll();
        showToast("Campeonato eliminado.");
      } catch (error) {
        showToast(error.message || "No se pudo eliminar el campeonato.", true);
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
    restoreBtn.disabled = !state.persistenceReady;
    restoreBtn.addEventListener("click", async () => {
      if (!ensurePersistenceReady("restaurar backups")) {
        return;
      }
      const ok = window.confirm(`Se restaurara el backup "${backup.label}". Antes se guardara una copia del estado actual. Continuar?`);
      if (!ok) {
        return;
      }
      try {
        await createBackup("Antes de restaurar", state.data);
        await persistAndApplyData(cloneData(backup.data));
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
  renderMedalsPanel();
  renderNameEditor();
  renderChampionships();
  renderBackups();
}

async function handleCreateBackup() {
  if (!ensurePersistenceReady("crear backups")) {
    return;
  }
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
  if (!ensurePersistenceReady("importar datos")) {
    refs.importInput.value = "";
    return;
  }

  try {
    const text = await readFileAsText(file);
    const importedData = parseDataContainer(text);
    await createBackup("Antes de importar", state.data);
    await persistAndApplyData(importedData);
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
  refs.toggleLossCalculatorBtn.addEventListener("click", () => {
    setLossCalculatorOpen(!state.lossCalculatorOpen);
    if (state.lossCalculatorOpen) {
      refs.lossCalculatorCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

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

  refs.toggleMedalsBtn.addEventListener("click", () => {
    state.medalsPanelOpen = !state.medalsPanelOpen;
    renderMedalsPanel();
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

  refs.resetLossCalculatorBtn.addEventListener("click", () => {
    resetLossCalculator();
  });

  refs.lossCalculatorForm.addEventListener("submit", handleLossCalculatorSubmit);

  refs.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ensurePersistenceReady("guardar campeonatos")) {
      return;
    }
    try {
      const payload = validateAndBuildPayload();

      if (state.editingChampionshipId) {
        const updated = await updateChampionship(state.editingChampionshipId, payload);
        if (!updated) {
          throw new Error("No se pudo actualizar el campeonato.");
        }
        showToast("Campeonato actualizado.");
      } else {
        await createChampionship(payload);
        showToast("Campeonato guardado.");
      }

      resetForm();
      renderAll();
    } catch (error) {
      showToast(error.message || "No se pudo guardar el campeonato.", true);
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
  updateMutationControls();
  setFormCollapsed(false);
  resetForm();
  resetLossCalculator();
  setLossCalculatorOpen(false);
  renderAll();

  try {
    const persistedData = await loadStore();
    const persistedBackups = await loadBackups();
    const shouldRenderData = !isSameDataSnapshot(state.data, persistedData);
    const shouldRenderBackups = JSON.stringify(state.backups) !== JSON.stringify(persistedBackups);

    state.data = persistedData;
    state.backups = persistedBackups;
    state.persistenceReady = true;
    updateMutationControls();

    if (shouldRenderData || shouldRenderBackups) {
      renderAll();
    } else {
      renderChampionships();
      renderBackups();
    }
  } catch (error) {
    state.persistenceReady = true;
    updateMutationControls();
    updatePersistenceStatus("localStorage", "Usando localStorage");
    renderChampionships();
    renderBackups();
  }
}

init();
