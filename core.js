"use strict";

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
    return;
  }
  root.RankingCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const APP_SCHEMA_VERSION = 2;
  const RATING_REGRESSION_K = 6;
  const SALDO_CAP_PER_TOURNAMENT = 25;
  const TOURNAMENT_REFERENCE_SIZE = 16;
  const RELATIVE_Z_CAP = 2.5;
  const RELATIVE_SCORE_SCALE = 1;
  const PERFORMANCE_CENTER = 50;
  const PERFORMANCE_POINTS_WEIGHT = 0.4;
  const PERFORMANCE_SALDO_WEIGHT = 0.1;
  const PERFORMANCE_RELATIVE_WEIGHT = 0.3;
  const PERFORMANCE_PLACEMENT_WEIGHT = 0.2;
  const CONSISTENCY_BONUS_MAX = 3;

  function createId(prefix, now = Date.now()) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${now}_${rand}`;
  }

  function normalizeName(name) {
    return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function buildPlayerLookup(players) {
    return new Map(players.map((player) => [player.id, player]));
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

  function normalizeRange(value, min, max) {
    if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      return 0.5;
    }
    return clamp((value - min) / (max - min), 0, 1);
  }

  function compareChampionshipResults(a, b, playerLookup) {
    const pointsDiff = (Number(b.points) || 0) - (Number(a.points) || 0);
    if (pointsDiff !== 0) {
      return pointsDiff;
    }

    const saldoDiff = (Number(b.saldo) || 0) - (Number(a.saldo) || 0);
    if (saldoDiff !== 0) {
      return saldoDiff;
    }

    const playerA = playerLookup.get(a.playerId);
    const playerB = playerLookup.get(b.playerId);
    return String(playerA?.name || "").localeCompare(String(playerB?.name || ""), "es");
  }

  function getOrderedChampionshipResults(results, playerLookup) {
    return [...results].sort((a, b) => compareChampionshipResults(a, b, playerLookup));
  }

  function computeChampionshipContexts(championships, playerLookup) {
    const contexts = new Map();

    championships.forEach((championship) => {
      const scores = championship.results.map((result) => getTournamentScore(result.points, result.saldo));
      const participants = scores.length;

      if (!participants) {
        contexts.set(championship.id, {
          mean: 0,
          std: 0,
          sizeWeight: 0,
          minPoints: 0,
          maxPoints: 0,
          minSaldo: 0,
          maxSaldo: 0,
          placements: new Map(),
        });
        return;
      }

      const orderedResults = getOrderedChampionshipResults(championship.results, playerLookup);
      const placements = new Map();
      orderedResults.forEach((result, idx) => {
        placements.set(result.playerId, idx + 1);
      });

      const mean = scores.reduce((sum, value) => sum + value, 0) / participants;
      const variance = scores.reduce((sum, value) => {
        const diff = value - mean;
        return sum + diff * diff;
      }, 0) / participants;
      const std = Math.sqrt(variance);
      const sizeScale = Math.min(1, Math.sqrt(participants / TOURNAMENT_REFERENCE_SIZE));
      const sizeWeight = 0.7 + sizeScale * 0.3;
      const pointsValues = championship.results.map((result) => Number(result.points) || 0);
      const saldoValues = championship.results.map((result) => capSaldoForRating(result.saldo));

      contexts.set(championship.id, {
        mean,
        std,
        sizeWeight,
        minPoints: Math.min(...pointsValues),
        maxPoints: Math.max(...pointsValues),
        minSaldo: Math.min(...saldoValues),
        maxSaldo: Math.max(...saldoValues),
        placements,
      });
    });

    return contexts;
  }

  function computeRelativeContribution(score, context) {
    if (!context || context.std <= 0) {
      return 0.5;
    }
    const zScore = (score - context.mean) / context.std;
    const cappedZScore = clamp(zScore, -RELATIVE_Z_CAP, RELATIVE_Z_CAP);
    return ((cappedZScore / RELATIVE_Z_CAP) * RELATIVE_SCORE_SCALE + 1) / 2;
  }

  function computeTournamentPerformance(result, context) {
    const points = Number(result.points) || 0;
    const saldo = capSaldoForRating(result.saldo);
    const pointsScore = normalizeRange(points, context?.minPoints, context?.maxPoints);
    const saldoScore = normalizeRange(saldo, context?.minSaldo, context?.maxSaldo);
    const relativeScore = computeRelativeContribution(getTournamentScore(points, saldo), context);
    const participants = context?.placements?.size || 0;
    const position = context?.placements?.get(result.playerId) || participants || 1;
    const placementScore = participants <= 1 ? 1 : 1 - (position - 1) / (participants - 1);
    const weightedPerformance =
      pointsScore * PERFORMANCE_POINTS_WEIGHT +
      saldoScore * PERFORMANCE_SALDO_WEIGHT +
      relativeScore * PERFORMANCE_RELATIVE_WEIGHT +
      placementScore * PERFORMANCE_PLACEMENT_WEIGHT;

    return clamp(PERFORMANCE_CENTER + (weightedPerformance * 100 - PERFORMANCE_CENTER) * (context?.sizeWeight || 1), 0, 100);
  }

  function computeGlobalPerformanceStats(championships, championshipContexts) {
    const performances = [];

    championships.forEach((championship) => {
      championship.results.forEach((result) => {
        const context = championshipContexts.get(championship.id);
        performances.push(computeTournamentPerformance(result, context));
      });
    });

    if (!performances.length) {
      return {
        mean: PERFORMANCE_CENTER,
        std: 0,
      };
    }

    const mean = performances.reduce((sum, value) => sum + value, 0) / performances.length;
    const variance =
      performances.reduce((sum, value) => {
        const diff = value - mean;
        return sum + diff * diff;
      }, 0) / performances.length;

    return {
      mean,
      std: Math.sqrt(variance),
    };
  }

  function computeRawRating(performanceTotal, championshipsCount) {
    if (championshipsCount <= 0) {
      return PERFORMANCE_CENTER;
    }
    return performanceTotal / championshipsCount;
  }

  function applyRegressionToMean(rawRating, championshipsCount, baselineScore) {
    if (championshipsCount <= 0) {
      return baselineScore;
    }
    const weight = championshipsCount / (championshipsCount + RATING_REGRESSION_K);
    return rawRating * weight + baselineScore * (1 - weight);
  }

  function computeConsistencyAdjustment(performances, globalStd, championshipsCount) {
    if (performances.length <= 1 || globalStd <= 0) {
      return 0;
    }

    const mean = performances.reduce((sum, value) => sum + value, 0) / performances.length;
    const variance =
      performances.reduce((sum, value) => {
        const diff = value - mean;
        return sum + diff * diff;
      }, 0) / performances.length;
    const playerStd = Math.sqrt(variance);
    const normalizedGap = clamp((globalStd - playerStd) / globalStd, -1, 1);
    const reliability = championshipsCount / (championshipsCount + RATING_REGRESSION_K);

    return normalizedGap * CONSISTENCY_BONUS_MAX * reliability;
  }

  function computeRanking(championships, players) {
    const statsMap = new Map();
    const playerLookup = buildPlayerLookup(players);
    const championshipContexts = computeChampionshipContexts(championships, playerLookup);
    const globalPerformanceStats = computeGlobalPerformanceStats(championships, championshipContexts);
    const baselineScore = globalPerformanceStats.mean;

    championships.forEach((championship) => {
      const context = championshipContexts.get(championship.id);
      const orderedResults = getOrderedChampionshipResults(championship.results, playerLookup);
      const winnerId = orderedResults[0]?.playerId || null;

      championship.results.forEach((result) => {
        if (!statsMap.has(result.playerId)) {
          statsMap.set(result.playerId, {
            playerId: result.playerId,
            championships: 0,
            championshipsWon: 0,
            podiums: 0,
            pointsTotal: 0,
            saldoTotalRaw: 0,
            performanceTotal: 0,
            performanceHistory: [],
          });
        }
      });

      championship.results.forEach((result) => {
        const row = statsMap.get(result.playerId);
        if (!row) {
          return;
        }
        const position = context?.placements?.get(result.playerId) || championship.results.length;
        row.championships += 1;
        row.pointsTotal += Number(result.points) || 0;
        row.saldoTotalRaw += Number(result.saldo) || 0;
        const tournamentPerformance = computeTournamentPerformance(result, context);
        row.performanceTotal += tournamentPerformance;
        row.performanceHistory.push(tournamentPerformance);
        if (result.playerId === winnerId) {
          row.championshipsWon += 1;
        }
        if (position <= 3) {
          row.podiums += 1;
        }
      });
    });

    const ranking = [];
    statsMap.forEach((row) => {
      if (row.championships <= 0) {
        return;
      }
      const player = players.find((item) => item.id === row.playerId);
      if (!player) {
        return;
      }
      const promedio = row.pointsTotal / row.championships;
      const podiumRate = row.championships > 0 ? (row.podiums / row.championships) * 100 : 0;
      const rawRating = computeRawRating(row.performanceTotal, row.championships);
      const regressedRating = applyRegressionToMean(rawRating, row.championships, baselineScore);
      const consistencyAdjustment = computeConsistencyAdjustment(
        row.performanceHistory,
        globalPerformanceStats.std,
        row.championships,
      );
      const rating = clamp(regressedRating + consistencyAdjustment, 0, 100);

      ranking.push({
        playerId: row.playerId,
        name: player.name,
        championships: row.championships,
        championshipsWon: row.championshipsWon,
        podiums: row.podiums,
        podiumRate,
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

  function sortChampionshipsAscending(championships) {
    return [...championships].sort((a, b) => {
      const byDate = String(a.date).localeCompare(String(b.date));
      if (byDate !== 0) {
        return byDate;
      }
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
  }

  function computeRankingMovement(championships, players) {
    const sortedChampionships = sortChampionshipsAscending(championships);
    const currentRanking = computeRanking(sortedChampionships, players);

    if (!sortedChampionships.length) {
      return currentRanking.map((entry, index) => ({
        ...entry,
        currentPosition: index + 1,
        previousPosition: null,
        movementDelta: null,
        climbedPast: [],
        overtakenBy: [],
      }));
    }

    const previousRanking = computeRanking(sortedChampionships.slice(0, -1), players);
    const previousPositionByPlayerId = new Map(previousRanking.map((entry, index) => [entry.playerId, index + 1]));
    const previousAboveByPlayerId = new Map(
      previousRanking.map((entry, index) => [entry.playerId, previousRanking.slice(0, index).map((item) => item.playerId)]),
    );
    const playerNameById = new Map(players.map((player) => [player.id, player.name]));

    return currentRanking.map((entry, index) => {
      const currentPosition = index + 1;
      const previousPosition = previousPositionByPlayerId.get(entry.playerId) ?? null;

      if (previousPosition === null) {
        return {
          ...entry,
          currentPosition,
          previousPosition,
          movementDelta: null,
          climbedPast: [],
          overtakenBy: [],
        };
      }

      const previousAbove = previousAboveByPlayerId.get(entry.playerId) || [];
      const currentAbove = currentRanking.slice(0, index).map((item) => item.playerId);

      return {
        ...entry,
        currentPosition,
        previousPosition,
        movementDelta: previousPosition - currentPosition,
        climbedPast: previousAbove
          .filter((playerId) => !currentAbove.includes(playerId))
          .map((playerId) => playerNameById.get(playerId) || "Jugador"),
        overtakenBy: currentAbove
          .filter((playerId) => !previousAbove.includes(playerId))
          .map((playerId) => playerNameById.get(playerId) || "Jugador"),
      };
    });
  }

  function createBackupRecord(data, label, options = {}) {
    const nowIso = options.nowIso || new Date().toISOString();
    const id = options.id || createId("b");
    return {
      id,
      label: String(label || "Backup manual"),
      createdAt: nowIso,
      data: sanitizeStore(data),
    };
  }

  function buildExportPayload(data, source, options = {}) {
    return {
      app: "Ranking de Billar",
      schemaVersion: options.schemaVersion || APP_SCHEMA_VERSION,
      exportedAt: options.exportedAt || new Date().toISOString(),
      source,
      data: sanitizeStore(data),
    };
  }

  return {
    APP_SCHEMA_VERSION,
    applyRegressionToMean,
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
    createId,
    getOrderedChampionshipResults,
    getTournamentScore,
    normalizeName,
    normalizeRange,
    parseDataContainer,
    sanitizeStore,
    sortChampionshipsAscending,
  };
});
