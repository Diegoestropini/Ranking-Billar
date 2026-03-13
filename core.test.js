const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("./core.js");

function makePlayers() {
  return [
    { id: "p1", name: "Ana", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "p2", name: "Beto", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "p3", name: "Carla", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
}

function makeChampionship(id, date, rows) {
  return {
    id,
    name: `Torneo ${id}`,
    date,
    createdAt: `${date}T10:00:00.000Z`,
    updatedAt: `${date}T10:00:00.000Z`,
    results: rows.map((row) => ({
      playerId: row.playerId,
      points: row.points,
      saldo: row.saldo,
    })),
  };
}

test("caso borde: ranking vacio cuando no hay campeonatos", () => {
  const ranking = core.computeRanking([], makePlayers());
  assert.deepEqual(ranking, []);
});

test("desempate en un campeonato usa puntos, luego saldo y luego nombre", () => {
  const players = makePlayers();
  const ordered = core.getOrderedChampionshipResults(
    [
      { playerId: "p2", points: 10, saldo: 2 },
      { playerId: "p1", points: 10, saldo: 2 },
      { playerId: "p3", points: 10, saldo: 1 },
    ],
    core.buildPlayerLookup(players),
  );

  assert.deepEqual(
    ordered.map((item) => item.playerId),
    ["p1", "p2", "p3"],
  );
});

test("desempate de ranking global usa rating, campeonatos ganados, saldo y nombre", () => {
  const players = makePlayers();
  const championships = [
    makeChampionship("c1", "2026-01-10", [
      { playerId: "p1", points: 10, saldo: 2 },
      { playerId: "p2", points: 10, saldo: 2 },
    ]),
  ];

  const ranking = core.computeRanking(championships, players);

  assert.equal(ranking[0].playerId, "p1");
  assert.equal(ranking[1].playerId, "p2");
});

test("regresion a la media acerca una muestra chica al baseline", () => {
  const baseline = 50;
  const rawRating = 90;

  const withOneTournament = core.applyRegressionToMean(rawRating, 1, baseline);
  const withTwentyTournaments = core.applyRegressionToMean(rawRating, 20, baseline);

  assert.ok(withOneTournament < withTwentyTournaments);
  assert.ok(Math.abs(withOneTournament - baseline) < Math.abs(rawRating - baseline));
});

test("movimiento de ranking detecta subidas y cruces despues de un nuevo torneo", () => {
  const players = makePlayers();
  const championships = [
    makeChampionship("c1", "2026-01-10", [
      { playerId: "p1", points: 15, saldo: 5 },
      { playerId: "p2", points: 12, saldo: 2 },
      { playerId: "p3", points: 8, saldo: -1 },
    ]),
    makeChampionship("c2", "2026-01-20", [
      { playerId: "p2", points: 20, saldo: 7 },
      { playerId: "p1", points: 9, saldo: 0 },
      { playerId: "p3", points: 7, saldo: -2 },
    ]),
  ];

  const movement = core.computeRankingMovement(championships, players);
  const beto = movement.find((entry) => entry.playerId === "p2");
  const ana = movement.find((entry) => entry.playerId === "p1");

  assert.equal(beto.currentPosition, 1);
  assert.equal(beto.previousPosition, 2);
  assert.equal(beto.movementDelta, 1);
  assert.deepEqual(beto.climbedPast, ["Ana"]);

  assert.equal(ana.currentPosition, 2);
  assert.equal(ana.previousPosition, 1);
  assert.equal(ana.movementDelta, -1);
  assert.deepEqual(ana.overtakenBy, ["Beto"]);
});

test("import/export preserva schema y sanitiza datos", () => {
  const raw = {
    players: [{ id: "p1", name: "  Ana   Perez  ", createdAt: "2026-01-01T00:00:00.000Z" }],
    championships: [
      {
        id: "c1",
        name: " Apertura ",
        date: "2026-02-01",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
        results: [{ playerId: "p1", points: 12, saldo: 3 }],
      },
    ],
  };

  const payload = core.buildExportPayload(raw, "current-state", {
    exportedAt: "2026-03-13T12:00:00.000Z",
  });
  const reparsed = core.parseDataContainer(JSON.stringify(payload));

  assert.equal(payload.app, "Ranking de Billar");
  assert.equal(payload.schemaVersion, core.APP_SCHEMA_VERSION);
  assert.equal(payload.exportedAt, "2026-03-13T12:00:00.000Z");
  assert.equal(reparsed.players[0].name, "Ana Perez");
  assert.equal(reparsed.championships[0].name, "Apertura");
});

test("backup crea snapshot sanitizado sin depender de localStorage", () => {
  const backup = core.createBackupRecord(
    {
      players: [{ id: "p1", name: "  Ana  ", createdAt: "2026-01-01T00:00:00.000Z" }],
      championships: [],
    },
    "Backup manual",
    {
      id: "b_fixed",
      nowIso: "2026-03-13T12:30:00.000Z",
    },
  );

  assert.equal(backup.id, "b_fixed");
  assert.equal(backup.label, "Backup manual");
  assert.equal(backup.createdAt, "2026-03-13T12:30:00.000Z");
  assert.equal(backup.data.players[0].name, "Ana");
  assert.deepEqual(backup.data.championships, []);
});

test("import invalido rechaza jugadores duplicados dentro del mismo campeonato", () => {
  assert.throws(() => {
    core.parseDataContainer(
      JSON.stringify({
        players: [{ id: "p1", name: "Ana", createdAt: "2026-01-01T00:00:00.000Z" }],
        championships: [
          {
            id: "c1",
            name: "Apertura",
            date: "2026-02-01",
            createdAt: "2026-02-01T00:00:00.000Z",
            updatedAt: "2026-02-01T00:00:00.000Z",
            results: [
              { playerId: "p1", points: 10, saldo: 1 },
              { playerId: "p1", points: 8, saldo: -1 },
            ],
          },
        ],
      }),
    );
  }, /jugadores repetidos/i);
});
