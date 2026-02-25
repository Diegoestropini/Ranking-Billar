"use strict";

const STORAGE_KEY = "billar_ranking_v1";

const state = {
  data: {
    players: [],
    championships: [],
  },
  editingChampionshipId: null,
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
  rankingBody: document.getElementById("ranking-body"),
  championshipList: document.getElementById("championship-list"),
  toast: document.getElementById("toast"),
};

function createId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`;
}

function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { players: [], championships: [] };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.players) || !Array.isArray(parsed.championships)) {
      return { players: [], championships: [] };
    }
    return parsed;
  } catch (error) {
    return { players: [], championships: [] };
  }
}

function saveStore(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
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

function parseNumber(value) {
  if (value === "" || value === null || typeof value === "undefined") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function computeRanking(championships, players) {
  const statsMap = new Map();

  championships.forEach((championship) => {
    championship.results.forEach((result) => {
      if (!statsMap.has(result.playerId)) {
        statsMap.set(result.playerId, {
          playerId: result.playerId,
          championships: 0,
          pointsTotal: 0,
          saldoTotal: 0,
        });
      }
      const row = statsMap.get(result.playerId);
      row.championships += 1;
      row.pointsTotal += Number(result.points) || 0;
      row.saldoTotal += Number(result.saldo) || 0;
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
    const ajusteSaldo = row.saldoTotal * 0.1;
    const factorExp = 1 + Math.min(0.15, Math.log(1 + row.championships) * 0.05);
    const rating = (promedio + ajusteSaldo) * factorExp;

    ranking.push({
      playerId: row.playerId,
      name: player.name,
      championships: row.championships,
      promedio,
      saldoTotal: row.saldoTotal,
      rating,
    });
  });

  ranking.sort((a, b) => {
    if (b.rating !== a.rating) {
      return b.rating - a.rating;
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
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="6" class="empty">Sin datos de ranking todavia.</td>';
    refs.rankingBody.appendChild(tr);
    return;
  }

  ranking.forEach((entry, idx) => {
    const tr = document.createElement("tr");
    if (idx < 4) {
      tr.classList.add("rank-top");
    } else {
      tr.classList.add("rank-dynamic");
      const dynamicCount = Math.max(1, ranking.length - 4);
      const progress = Math.min(1, Math.max(0, (idx - 4) / (dynamicCount - 1 || 1)));
      const hue = 190 - 190 * progress;
      const alpha = 0.2 + progress * 0.17;
      tr.style.setProperty("--row-color", `hsla(${hue.toFixed(1)}, 96%, 56%, ${alpha.toFixed(3)})`);
    }
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${entry.name}</td>
      <td>${formatNum(entry.rating, 3)}</td>
      <td>${entry.championships}</td>
      <td>${formatNum(entry.promedio, 2)}</td>
      <td>${formatNum(entry.saldoTotal, 2)}</td>
    `;
    refs.rankingBody.appendChild(tr);
  });
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

  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Aun no hay campeonatos cargados.";
    refs.championshipList.appendChild(empty);
    return;
  }

  list.forEach((championship) => {
    const item = document.createElement("article");
    item.className = "championship-item";

    const left = document.createElement("div");
    left.innerHTML = `
      <h4>${championship.name}</h4>
      <p class="championship-meta">${championship.date} | ${championship.results.length} jugadores</p>
    `;

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
}

function renderAll() {
  renderRanking();
  renderChampionships();
}

function bindUIEvents() {
  refs.toggleFormBtn.addEventListener("click", () => {
    const formCard = document.querySelector(".form-card");
    setFormCollapsed(!formCard.classList.contains("collapsed"));
  });

  refs.addRowBtn.addEventListener("click", () => {
    addResultRow();
  });

  refs.cancelEditBtn.addEventListener("click", () => {
    resetForm();
    showToast("Edicion cancelada.");
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

function init() {
  state.data = loadStore();
  bindUIEvents();
  setFormCollapsed(false);
  resetForm();
  renderAll();
}

init();
