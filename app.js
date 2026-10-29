/**
 * Brasileirão 2026 - Poisson Relegation & Match Simulator
 * Integrado com a API da ESPN
 */

(function () {
  'use strict';

  // --- STATE ---
  let originalTeams = [];
  let fixtures = [];
  let simulatedResults = {}; // matchId -> { homeScore, awayScore }
  let currentTab = 'relegation';
  let matchFilter = 'all'; // 'all', 'z4', or round name
  let isSimulatingAll = false;
  let lastSyncTime = null;

  // Cache for Poisson factorial
  const FACTORIAL_CACHE = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800];
  function factorial(n) {
    if (n < FACTORIAL_CACHE.length) return FACTORIAL_CACHE[n];
    let res = FACTORIAL_CACHE[FACTORIAL_CACHE.length - 1];
    for (let i = FACTORIAL_CACHE.length; i <= n; i++) res *= i;
    return res;
  }

  function poissonPMF(k, lambda) {
    return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
  }

  function samplePoisson(lambda) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }

  // --- MODELING / POISSON ENGINE ---
  function calculateLeagueRatings(teamsList) {
    const totalMatchesPlayed = teamsList.reduce((acc, t) => acc + t.played, 0) / 2;
    const totalGoals = teamsList.reduce((acc, t) => acc + t.goalsFor, 0);
    const avgGoalsPerTeamPerGame = totalMatchesPlayed > 0 ? (totalGoals / (totalMatchesPlayed * 2)) : 1.25;

    // Home advantage: in Serie A, home teams score ~57% of total goals
    const homeGoalsAvg = avgGoalsPerTeamPerGame * 1.15;
    const awayGoalsAvg = avgGoalsPerTeamPerGame * 0.85;

    const ratings = {};
    teamsList.forEach(t => {
      const gScoredPerGame = t.played > 0 ? (t.goalsFor / t.played) : avgGoalsPerTeamPerGame;
      const gConcPerGame = t.played > 0 ? (t.goalsAgainst / t.played) : avgGoalsPerTeamPerGame;
      ratings[t.id] = {
        name: t.name,
        attackStrength: Math.max(0.3, gScoredPerGame / avgGoalsPerTeamPerGame),
        defenseWeakness: Math.max(0.3, gConcPerGame / avgGoalsPerTeamPerGame)
      };
    });

    return {
      ratings,
      homeGoalsAvg,
      awayGoalsAvg,
      avgGoalsPerTeamPerGame
    };
  }

  function calculateMatchExpectedGoals(homeId, awayId, leagueData) {
    const homeTeam = leagueData.ratings[homeId] || { attackStrength: 1.0, defenseWeakness: 1.0 };
    const awayTeam = leagueData.ratings[awayId] || { attackStrength: 1.0, defenseWeakness: 1.0 };

    const lambdaHome = Math.max(0.2, homeTeam.attackStrength * awayTeam.defenseWeakness * leagueData.homeGoalsAvg);
    const lambdaAway = Math.max(0.2, awayTeam.attackStrength * homeTeam.defenseWeakness * leagueData.awayGoalsAvg);

    return { lambdaHome, lambdaAway };
  }

  function getMatchProbabilities(homeId, awayId, leagueData) {
    const { lambdaHome, lambdaAway } = calculateMatchExpectedGoals(homeId, awayId, leagueData);
    let pHome = 0;
    let pDraw = 0;
    let pAway = 0;

    for (let h = 0; h <= 8; h++) {
      for (let a = 0; a <= 8; a++) {
        const prob = poissonPMF(h, lambdaHome) * poissonPMF(a, lambdaAway);
        if (h > a) pHome += prob;
        else if (h === a) pDraw += prob;
        else pAway += prob;
      }
    }

    const sum = pHome + pDraw + pAway;
    return {
      home: (pHome / sum) * 100,
      draw: (pDraw / sum) * 100,
      away: (pAway / sum) * 100,
      lambdaHome: lambdaHome.toFixed(2),
      lambdaAway: lambdaAway.toFixed(2)
    };
  }

  // --- STANDINGS & SIMULATION ---
  function computeCurrentStandings() {
    // Clone original teams
    const currentTable = originalTeams.map(t => ({
      ...t,
      playedOrig: t.played,
      pointsOrig: t.points,
      winsOrig: t.wins,
      drawsOrig: t.draws,
      lossesOrig: t.losses,
      goalsForOrig: t.goalsFor,
      goalsAgainstOrig: t.goalsAgainst,
      goalDiffOrig: t.goalDiff,
      simulatedMatchesCount: 0
    }));

    const map = {};
    currentTable.forEach(t => { map[t.id] = t; });

    // Apply simulated matches
    fixtures.forEach(m => {
      const sim = simulatedResults[m.id];
      if (sim && sim.homeScore !== null && sim.awayScore !== null) {
        const h = map[m.homeTeam.id];
        const a = map[m.awayTeam.id];
        if (h && a) {
          h.played += 1;
          a.played += 1;
          h.simulatedMatchesCount += 1;
          a.simulatedMatchesCount += 1;

          h.goalsFor += sim.homeScore;
          h.goalsAgainst += sim.awayScore;
          h.goalDiff = h.goalsFor - h.goalsAgainst;

          a.goalsFor += sim.awayScore;
          a.goalsAgainst += sim.homeScore;
          a.goalDiff = a.goalsFor - a.goalsAgainst;

          if (sim.homeScore > sim.awayScore) {
            h.wins += 1;
            h.points += 3;
            a.losses += 1;
          } else if (sim.awayScore > sim.homeScore) {
            a.wins += 1;
            a.points += 3;
            h.losses += 1;
          } else {
            h.draws += 1;
            h.points += 1;
            a.draws += 1;
            a.points += 1;
          }
        }
      }
    });

    // CBF tiebreakers: Points > Wins > Goal Diff > Goals For
    currentTable.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.goalDiff !== a.goalDiff) return b.goalDiff - a.goalDiff;
      return b.goalsFor - a.goalsFor;
    });

    // Assign rank
    currentTable.forEach((t, idx) => {
      t.currentRank = idx + 1;
    });

    return currentTable;
  }

  // --- MONTE CARLO POISSON SIMULATION FOR RELEGATION ---
  function runPoissonRelegationSimulation(currentStandings, numIterations = 8000) {
    const leagueData = calculateLeagueRatings(currentStandings);

    // Identify remaining matches that have not been simulated yet
    const unsimulatedFixtures = fixtures.filter(m => {
      const sim = simulatedResults[m.id];
      return !sim || sim.homeScore === null || sim.awayScore === null;
    });

    // Precalculate match lambdas for unsimulated fixtures to maximize simulation speed
    const precalcMatches = unsimulatedFixtures.map(m => {
      const { lambdaHome, lambdaAway } = calculateMatchExpectedGoals(m.homeTeam.id, m.awayTeam.id, leagueData);
      return {
        homeId: m.homeTeam.id,
        awayId: m.awayTeam.id,
        lambdaHome,
        lambdaAway
      };
    });

    // Mathematical safety bounds
    const teamRemainingGames = {};
    currentStandings.forEach(t => teamRemainingGames[t.id] = 0);
    precalcMatches.forEach(m => {
      teamRemainingGames[m.homeId]++;
      teamRemainingGames[m.awayId]++;
    });

    const relegatedCounter = {};
    const finalPointsAccumulator = {};
    currentStandings.forEach(t => {
      relegatedCounter[t.id] = 0;
      finalPointsAccumulator[t.id] = 0;
    });

    // Monte Carlo loop
    const baseTable = currentStandings.map(t => ({
      id: t.id,
      points: t.points,
      wins: t.wins,
      goalDiff: t.goalDiff,
      goalsFor: t.goalsFor
    }));

    for (let iter = 0; iter < numIterations; iter++) {
      // Fast clone
      const simTable = new Array(baseTable.length);
      const teamMap = {};
      for (let i = 0; i < baseTable.length; i++) {
        const item = {
          id: baseTable[i].id,
          points: baseTable[i].points,
          wins: baseTable[i].wins,
          goalDiff: baseTable[i].goalDiff,
          goalsFor: baseTable[i].goalsFor
        };
        simTable[i] = item;
        teamMap[item.id] = item;
      }

      // Simulate matches
      for (let m = 0; m < precalcMatches.length; m++) {
        const match = precalcMatches[m];
        const sH = samplePoisson(match.lambdaHome);
        const sA = samplePoisson(match.lambdaAway);

        const h = teamMap[match.homeId];
        const a = teamMap[match.awayId];
        if (h && a) {
          h.goalsFor += sH;
          h.goalDiff += (sH - sA);
          a.goalsFor += sA;
          a.goalDiff += (sA - sH);

          if (sH > sA) {
            h.points += 3;
            h.wins += 1;
          } else if (sA > sH) {
            a.points += 3;
            a.wins += 1;
          } else {
            h.points += 1;
            a.points += 1;
          }
        }
      }

      // Sort final table
      simTable.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.goalDiff !== a.goalDiff) return b.goalDiff - a.goalDiff;
        return b.goalsFor - a.goalsFor;
      });

      // Accumulate final points
      for (let i = 0; i < simTable.length; i++) {
        finalPointsAccumulator[simTable[i].id] += simTable[i].points;
      }

      // Bottom 4 are relegated: index 16, 17, 18, 19
      for (let pos = 16; pos < 20; pos++) {
        relegatedCounter[simTable[pos].id]++;
      }
    }

    // Mathematical guarantees:
    // Safe: team's current points > max possible points of the 17th place team
    // Calculate theoretical max points for each team
    const maxPossiblePoints = {};
    currentStandings.forEach(t => {
      maxPossiblePoints[t.id] = t.points + (teamRemainingGames[t.id] * 3);
    });
    // Sorted max possible points
    const sortedMaxPts = Object.values(maxPossiblePoints).sort((a, b) => b - a);
    const maxPoints17thCanReach = sortedMaxPts[16] || 0; // 17th highest max points

    // Map probabilities back to teams
    const results = currentStandings.map(t => {
      let riskPct = (relegatedCounter[t.id] / numIterations) * 100;

      // If team is mathematically safe, strictly 0%
      if (t.points > maxPoints17thCanReach) {
        riskPct = 0;
      }

      // If remaining games == 0 and rank <= 16, 0%
      if (teamRemainingGames[t.id] === 0 && t.currentRank <= 16) {
        riskPct = 0;
      }

      // If remaining games == 0 and rank > 16, 100%
      if (teamRemainingGames[t.id] === 0 && t.currentRank > 16) {
        riskPct = 100;
      }

      const projectedPoints = (finalPointsAccumulator[t.id] / numIterations).toFixed(1);

      return {
        ...t,
        relegationRisk: riskPct,
        remainingGames: teamRemainingGames[t.id],
        maxPossiblePoints: maxPossiblePoints[t.id],
        projectedPoints: Number(projectedPoints)
      };
    });

    return results;
  }

  // --- RENDERERS ---
  function renderAll() {
    const standings = computeCurrentStandings();
    const evaluatedTeams = runPoissonRelegationSimulation(standings);
    const leagueData = calculateLeagueRatings(standings);

    renderHeaderMetrics(evaluatedTeams);
    renderRelegationCard(evaluatedTeams);
    renderStandingsTable(evaluatedTeams);
    renderMatchesSimulator(leagueData, evaluatedTeams);
  }

  function renderHeaderMetrics(evaluatedTeams) {
    const riskTeams = evaluatedTeams.filter(t => t.relegationRisk > 0);
    const simulatedCount = Object.keys(simulatedResults).filter(
      k => simulatedResults[k].homeScore !== null
    ).length;

    const highestRisk = riskTeams.length > 0 
      ? [...riskTeams].sort((a, b) => b.relegationRisk - a.relegationRisk)[0] 
      : null;

    const riskCountEl = document.getElementById('metric-risk-count');
    if (riskCountEl) riskCountEl.textContent = `${riskTeams.length} times`;

    const simCountEl = document.getElementById('metric-sim-count');
    if (simCountEl) simCountEl.textContent = `${simulatedCount} / ${fixtures.length}`;

    const highRiskEl = document.getElementById('metric-highest-risk');
    if (highRiskEl && highestRisk) {
      highRiskEl.innerHTML = `
        <div class="team-mini-badge">
          <img src="${highestRisk.logo}" alt="" class="badge-img-xs" onerror="this.style.display='none'">
          <span>${highestRisk.shortName || highestRisk.name} (${highestRisk.relegationRisk.toFixed(1)}%)</span>
        </div>
      `;
    }

    const resetBtn = document.getElementById('btn-reset-sims');
    if (resetBtn) {
      resetBtn.style.display = simulatedCount > 0 ? 'inline-flex' : 'none';
    }
  }

  // TAB 1: RELEGATION RISK (ONLY SHOW TEAMS WITH CHANCE > 0%)
  function renderRelegationCard(evaluatedTeams) {
    const container = document.getElementById('relegation-cards-container');
    if (!container) return;

    // USER REQUIREMENT:
    // "preciso que ele deixe visivel a probabilidade em porcentagem dos times que tem chance de cair,
    // ou seja, se um time não tem chance de cair não deve aparecer nas probabilidades."
    const teamsWithRisk = evaluatedTeams
      .filter(t => t.relegationRisk > 0.009) // Filter out 0%
      .sort((a, b) => b.relegationRisk - a.relegationRisk);

    if (teamsWithRisk.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎉</div>
          <h3>Nenhum time corre risco no momento!</h3>
          <p>Com as configurações atuais ou simulações inseridas, todos os times restantes garantiram permanência.</p>
        </div>
      `;
      return;
    }

    let html = `
      <div class="risk-summary-banner">
        <div class="banner-icon">⚠️</div>
        <div>
          <h4>Modelo de Poisson: ${teamsWithRisk.length} clubes possuem risco matemático de rebaixamento</h4>
          <p>Apenas clubes com probabilidade estritamente maior que <strong>0%</strong> são listados abaixo. Times matematicamente salvos não aparecem.</p>
        </div>
      </div>
      <div class="risk-grid">
    `;

    teamsWithRisk.forEach(team => {
      const risk = team.relegationRisk;
      let riskTierClass = 'risk-low';
      let riskLabel = 'Risco Baixo';
      let barColor = 'var(--neon-green)';

      if (risk >= 75) {
        riskTierClass = 'risk-critical';
        riskLabel = 'Risco Crítico';
        barColor = 'var(--danger-red)';
      } else if (risk >= 40) {
        riskTierClass = 'risk-high';
        riskLabel = 'Risco Alto';
        barColor = 'var(--warning-orange)';
      } else if (risk >= 15) {
        riskTierClass = 'risk-medium';
        riskLabel = 'Risco Moderado';
        barColor = 'var(--accent-gold)';
      } else {
        barColor = 'var(--neon-blue)';
      }

      // Safe magic points estimate: ~43-45 points in Brasileirão
      const pointsNeededFor44 = Math.max(0, 44 - team.points);

      html += `
        <div class="risk-card ${riskTierClass}">
          <div class="risk-card-header">
            <div class="team-identity">
              <span class="pos-badge ${team.currentRank >= 17 ? 'pos-z4' : 'pos-safe'}">${team.currentRank}º</span>
              <img src="${team.logo}" alt="${team.name}" class="team-crest-sm" onerror="this.onerror=null;this.src='https://a.espncdn.com/i/teamlogos/soccer/500/default-team-logo.png'">
              <div>
                <h3 class="team-title">${team.name}</h3>
                <span class="team-subtitle">${team.points} pts • ${team.played}/38 jogos • Saldo: ${team.goalDiff >= 0 ? '+' : ''}${team.goalDiff}</span>
              </div>
            </div>
            <div class="risk-pct-pill ${riskTierClass}">
              <span class="pct-val">${risk.toFixed(1)}%</span>
              <span class="pct-lbl">${riskLabel}</span>
            </div>
          </div>

          <div class="risk-bar-container">
            <div class="risk-bar-fill" style="width: ${Math.min(100, Math.max(3, risk))}%; background: ${barColor};"></div>
          </div>

          <div class="risk-stats-row">
            <div class="r-stat">
              <span class="r-label">Jogos Restantes</span>
              <span class="r-val">${team.remainingGames}</span>
            </div>
            <div class="r-stat">
              <span class="r-label">Pontos Projetados</span>
              <span class="r-val highlight">${team.projectedPoints}</span>
            </div>
            <div class="r-stat">
              <span class="r-label">Máx. Possível</span>
              <span class="r-val">${team.maxPossiblePoints} pts</span>
            </div>
            <div class="r-stat">
              <span class="r-label">Para atingir 44 pts</span>
              <span class="r-val">${pointsNeededFor44 > 0 ? `+${pointsNeededFor44} pts` : 'Atingido'}</span>
            </div>
          </div>

          <div class="risk-card-footer">
            <button class="btn-filter-team" data-team-id="${team.id}" data-team-name="${team.name}">
              ⚽ Ver próximos jogos do ${team.shortName || team.name}
            </button>
          </div>
        </div>
      `;
    });

    html += `</div>`;
    container.innerHTML = html;

    // Attach listeners to "Ver jogos do time"
    container.querySelectorAll('.btn-filter-team').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const teamId = e.currentTarget.getAttribute('data-team-id');
        matchFilter = `team-${teamId}`;
        switchTab('simulator');
      });
    });
  }

  // TAB 2: FULL STANDINGS TABLE
  function renderStandingsTable(evaluatedTeams) {
    const tbody = document.getElementById('standings-tbody');
    if (!tbody) return;

    let html = '';
    evaluatedTeams.forEach(team => {
      const isZ4 = team.currentRank >= 17;
      const isLibertadores = team.currentRank <= 4;
      const isPreLibertadores = team.currentRank === 5 || team.currentRank === 6;
      const isSulAmericana = team.currentRank >= 7 && team.currentRank <= 12;

      let zoneClass = '';
      let zoneBadge = '';
      if (isLibertadores) {
        zoneClass = 'zone-libertadores';
        zoneBadge = '<span class="zone-indicator lib" title="Fase de Grupos Libertadores">LIB</span>';
      } else if (isPreLibertadores) {
        zoneClass = 'zone-pre-lib';
        zoneBadge = '<span class="zone-indicator pre-lib" title="Pré-Libertadores">PRÉ</span>';
      } else if (isSulAmericana) {
        zoneClass = 'zone-sula';
        zoneBadge = '<span class="zone-indicator sula" title="Copa Sul-Americana">SUL</span>';
      } else if (isZ4) {
        zoneClass = 'zone-z4';
        zoneBadge = '<span class="zone-indicator z4" title="Zona de Rebaixamento">Z-4</span>';
      }

      // Check if team rank changed from original
      let rankDelta = '';
      if (team.simulatedMatchesCount > 0) {
        const diff = team.rank - team.currentRank; // positive = went up
        if (diff > 0) {
          rankDelta = `<span class="rank-delta up" title="Subiu ${diff} posições">▲${diff}</span>`;
        } else if (diff < 0) {
          rankDelta = `<span class="rank-delta down" title="Caiu ${Math.abs(diff)} posições">▼${Math.abs(diff)}</span>`;
        } else {
          rankDelta = `<span class="rank-delta same">-</span>`;
        }
      }

      // Relegation badge cell
      let riskCell = '<span class="risk-zero">0%</span>';
      if (team.relegationRisk > 0.009) {
        const r = team.relegationRisk.toFixed(1);
        let cClass = 'risk-pill-sm-low';
        if (team.relegationRisk >= 75) cClass = 'risk-pill-sm-crit';
        else if (team.relegationRisk >= 40) cClass = 'risk-pill-sm-high';
        else if (team.relegationRisk >= 15) cClass = 'risk-pill-sm-med';

        riskCell = `<span class="risk-pill-sm ${cClass}">${r}%</span>`;
      }

      const aproveitamento = team.played > 0 
        ? ((team.points / (team.played * 3)) * 100).toFixed(0) 
        : 0;

      html += `
        <tr class="${zoneClass} ${team.simulatedMatchesCount > 0 ? 'row-simulated' : ''}">
          <td class="col-pos">
            <div class="pos-cell">
              ${zoneBadge}
              <span class="pos-number">${team.currentRank}º</span>
              ${rankDelta}
            </div>
          </td>
          <td class="col-team">
            <div class="team-cell">
              <img src="${team.logo}" alt="${team.name}" class="team-crest-table" onerror="this.onerror=null;this.src='https://a.espncdn.com/i/teamlogos/soccer/500/default-team-logo.png'">
              <div class="team-name-box">
                <span class="team-name-text">${team.name}</span>
                ${team.simulatedMatchesCount > 0 ? `<span class="sim-badge">${team.simulatedMatchesCount} simulado(s)</span>` : ''}
              </div>
            </div>
          </td>
          <td class="col-pts font-bold highlight">${team.points}</td>
          <td class="col-num">${team.played}</td>
          <td class="col-num">${team.wins}</td>
          <td class="col-num">${team.draws}</td>
          <td class="col-num">${team.losses}</td>
          <td class="col-num hide-mobile">${team.goalsFor}</td>
          <td class="col-num hide-mobile">${team.goalsAgainst}</td>
          <td class="col-num font-bold ${team.goalDiff >= 0 ? 'text-green' : 'text-red'}">
            ${team.goalDiff >= 0 ? '+' : ''}${team.goalDiff}
          </td>
          <td class="col-num hide-mobile">${aproveitamento}%</td>
          <td class="col-risk font-bold">${riskCell}</td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
  }

  // TAB 3: MATCH SIMULATOR & POISSON PREDICTIONS
  function renderMatchesSimulator(leagueData, evaluatedTeams) {
    const container = document.getElementById('matches-grid');
    if (!container) return;

    // Filter selector
    const filterSelect = document.getElementById('round-filter-select');
    if (filterSelect && filterSelect.options.length <= 1) {
      populateRoundFilters();
    }

    // Determine filtered matches
    let displayMatches = [...fixtures];

    if (matchFilter === 'z4') {
      // Show matches involving teams with risk > 0
      const riskIds = new Set(evaluatedTeams.filter(t => t.relegationRisk > 0).map(t => t.id));
      displayMatches = displayMatches.filter(m => riskIds.has(m.homeTeam.id) || riskIds.has(m.awayTeam.id));
    } else if (matchFilter.startsWith('team-')) {
      const tId = matchFilter.replace('team-', '');
      displayMatches = displayMatches.filter(m => m.homeTeam.id === tId || m.awayTeam.id === tId);
    } else if (matchFilter.startsWith('round-')) {
      const rName = matchFilter.replace('round-', '');
      displayMatches = displayMatches.filter(m => m.round === rName);
    }

    if (displayMatches.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <h3>Nenhum confronto encontrado para o filtro selecionado</h3>
          <p>Tente selecionar "Todos os Jogos Restantes" no menu de filtros acima.</p>
        </div>
      `;
      return;
    }

    // Group matches by Round
    const grouped = {};
    displayMatches.forEach(m => {
      const r = m.round || 'Rodada Restante';
      if (!grouped[r]) grouped[r] = [];
      grouped[r].push(m);
    });

    let html = '';
    Object.keys(grouped).forEach(roundName => {
      const roundMatches = grouped[roundName];
      html += `
        <div class="round-section">
          <div class="round-header">
            <h3 class="round-title">${roundName}</h3>
            <div class="round-actions">
              <button class="btn-round-sim" data-round="${roundName}">⚡ Simular Rodada com Poisson</button>
            </div>
          </div>
          <div class="matches-cards-grid">
      `;

      roundMatches.forEach(m => {
        const probs = getMatchProbabilities(m.homeTeam.id, m.awayTeam.id, leagueData);
        const sim = simulatedResults[m.id];
        const isSimulated = sim && sim.homeScore !== null && sim.awayScore !== null;
        const hScore = isSimulated ? sim.homeScore : '';
        const aScore = isSimulated ? sim.awayScore : '';

        // Format date
        let dateFormatted = 'Data a definir';
        if (m.date) {
          const d = new Date(m.date);
          dateFormatted = d.toLocaleDateString('pt-BR', {
            weekday: 'short',
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          });
        }

        html += `
          <div class="match-card ${isSimulated ? 'match-card-simulated' : ''}" id="match-card-${m.id}">
            <div class="match-meta">
              <span class="match-date">📅 ${dateFormatted}</span>
              ${isSimulated ? '<span class="badge-sim-tag">Simulado</span>' : '<span class="badge-sched-tag">A Realizar</span>'}
            </div>

            <!-- PROBABILITIES BARS (POISSON) -->
            <div class="poisson-probabilities-box">
              <div class="poisson-header">
                <span class="poisson-title">Probabilidades Poisson</span>
                <span class="poisson-xg">xG: ${probs.lambdaHome} x ${probs.lambdaAway}</span>
              </div>
              <div class="prob-bars-grid">
                <div class="prob-item prob-home" title="Vitória do Mandante">
                  <span class="prob-tag">Casa</span>
                  <span class="prob-val">${probs.home.toFixed(1)}%</span>
                  <div class="prob-bar"><div class="prob-bar-fill fill-home" style="width: ${probs.home}%"></div></div>
                </div>
                <div class="prob-item prob-draw" title="Empate">
                  <span class="prob-tag">Empate</span>
                  <span class="prob-val">${probs.draw.toFixed(1)}%</span>
                  <div class="prob-bar"><div class="prob-bar-fill fill-draw" style="width: ${probs.draw}%"></div></div>
                </div>
                <div class="prob-item prob-away" title="Vitória do Visitante">
                  <span class="prob-tag">Fora</span>
                  <span class="prob-val">${probs.away.toFixed(1)}%</span>
                  <div class="prob-bar"><div class="prob-bar-fill fill-away" style="width: ${probs.away}%"></div></div>
                </div>
              </div>
            </div>

            <!-- CLASH CONTROLS -->
            <div class="match-teams-row">
              <div class="team-side home-side">
                <img src="${m.homeTeam.logo}" alt="${m.homeTeam.name}" class="team-crest-match" onerror="this.onerror=null;this.src='https://a.espncdn.com/i/teamlogos/soccer/500/default-team-logo.png'">
                <span class="team-match-name">${m.homeTeam.shortName || m.homeTeam.name}</span>
              </div>

              <div class="score-input-box">
                <input type="number" min="0" max="15" class="score-input score-home" data-match-id="${m.id}" value="${hScore}" placeholder="-" aria-label="Gols do Mandante">
                <span class="score-sep">x</span>
                <input type="number" min="0" max="15" class="score-input score-away" data-match-id="${m.id}" value="${aScore}" placeholder="-" aria-label="Gols do Visitante">
              </div>

              <div class="team-side away-side">
                <img src="${m.awayTeam.logo}" alt="${m.awayTeam.name}" class="team-crest-match" onerror="this.onerror=null;this.src='https://a.espncdn.com/i/teamlogos/soccer/500/default-team-logo.png'">
                <span class="team-match-name">${m.awayTeam.shortName || m.awayTeam.name}</span>
              </div>
            </div>

            <!-- QUICK SIMULATION BUTTONS -->
            <div class="quick-sim-buttons">
              <button class="btn-quick-outcome ${isSimulated && hScore > aScore ? 'active' : ''}" 
                data-match-id="${m.id}" data-action="home" title="Simular vitória mandante (2x1)">
                🏠 Vitória Casa
              </button>
              <button class="btn-quick-outcome ${isSimulated && hScore === aScore && hScore !== '' ? 'active' : ''}" 
                data-match-id="${m.id}" data-action="draw" title="Simular empate (1x1)">
                🤝 Empate
              </button>
              <button class="btn-quick-outcome ${isSimulated && aScore > hScore ? 'active' : ''}" 
                data-match-id="${m.id}" data-action="away" title="Simular vitória visitante (1x2)">
                ✈️ Vitória Fora
              </button>
              ${isSimulated ? `
                <button class="btn-clear-match" data-match-id="${m.id}" title="Limpar resultado deste jogo">✕</button>
              ` : ''}
            </div>
          </div>
        `;
      });

      html += `
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
    attachMatchEventListeners(leagueData);
  }

  function populateRoundFilters() {
    const select = document.getElementById('round-filter-select');
    if (!select) return;

    select.innerHTML = '';

    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = '🌟 Todos os Jogos Restantes (56 jogos)';
    select.appendChild(allOpt);

    const z4Opt = document.createElement('option');
    z4Opt.value = 'z4';
    z4Opt.textContent = '🚨 Apenas Jogos de Times Ameaçados (Z-4 & Risco)';
    select.appendChild(z4Opt);

    // Unique rounds
    const rounds = [...new Set(fixtures.map(f => f.round || 'Rodada Restante'))];
    rounds.forEach(r => {
      const opt = document.createElement('option');
      opt.value = `round-${r}`;
      opt.textContent = `📅 ${r}`;
      select.appendChild(opt);
    });

    // Unique teams
    const teamsOptGroup = document.createElement('optgroup');
    teamsOptGroup.label = '⚽ Filtrar por Clube Específico';
    originalTeams.forEach(t => {
      const opt = document.createElement('option');
      opt.value = `team-${t.id}`;
      opt.textContent = `${t.name}`;
      teamsOptGroup.appendChild(opt);
    });
    select.appendChild(teamsOptGroup);

    select.value = matchFilter;
    select.addEventListener('change', (e) => {
      matchFilter = e.target.value;
      renderAll();
    });
  }

  function attachMatchEventListeners(leagueData) {
    // Score inputs
    document.querySelectorAll('.score-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const matchId = e.target.getAttribute('data-match-id');
        const card = document.getElementById(`match-card-${matchId}`);
        if (!card) return;

        const hInput = card.querySelector('.score-home');
        const aInput = card.querySelector('.score-away');

        const hVal = hInput.value !== '' ? parseInt(hInput.value, 10) : null;
        const aVal = aInput.value !== '' ? parseInt(aInput.value, 10) : null;

        if (hVal !== null && aVal !== null && !isNaN(hVal) && !isNaN(aVal)) {
          simulatedResults[matchId] = {
            homeScore: Math.max(0, hVal),
            awayScore: Math.max(0, aVal)
          };
        } else {
          delete simulatedResults[matchId];
        }
        renderAll();
      });
    });

    // Quick outcome buttons
    document.querySelectorAll('.btn-quick-outcome').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const matchId = e.currentTarget.getAttribute('data-match-id');
        const action = e.currentTarget.getAttribute('data-action');

        if (action === 'home') {
          simulatedResults[matchId] = { homeScore: 2, awayScore: 1 };
        } else if (action === 'draw') {
          simulatedResults[matchId] = { homeScore: 1, awayScore: 1 };
        } else if (action === 'away') {
          simulatedResults[matchId] = { homeScore: 0, awayScore: 1 };
        }
        renderAll();
      });
    });

    // Clear single match button
    document.querySelectorAll('.btn-clear-match').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const matchId = e.currentTarget.getAttribute('data-match-id');
        delete simulatedResults[matchId];
        renderAll();
      });
    });

    // Round simulation button
    document.querySelectorAll('.btn-round-sim').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const roundName = e.currentTarget.getAttribute('data-round');
        simulateSpecificRound(roundName, leagueData);
      });
    });
  }

  function simulateSpecificRound(roundName, leagueData) {
    const roundMatches = fixtures.filter(m => m.round === roundName);
    roundMatches.forEach(m => {
      const { lambdaHome, lambdaAway } = calculateMatchExpectedGoals(m.homeTeam.id, m.awayTeam.id, leagueData);
      const sH = samplePoisson(lambdaHome);
      const sA = samplePoisson(lambdaAway);
      simulatedResults[m.id] = { homeScore: sH, awayScore: sA };
    });
    renderAll();
    showToast(`⚡ ${roundMatches.length} jogos da ${roundName} simulados com o modelo Poisson!`);
  }

  function simulateAllRemainingWithPoisson() {
    const standings = computeCurrentStandings();
    const leagueData = calculateLeagueRatings(standings);

    fixtures.forEach(m => {
      const { lambdaHome, lambdaAway } = calculateMatchExpectedGoals(m.homeTeam.id, m.awayTeam.id, leagueData);
      const sH = samplePoisson(lambdaHome);
      const sA = samplePoisson(lambdaAway);
      simulatedResults[m.id] = { homeScore: sH, awayScore: sA };
    });

    renderAll();
    showToast(`🎲 Todos os 56 confrontos restantes foram simulados com o modelo de Poisson!`);
  }

  function resetAllSimulations() {
    simulatedResults = {};
    renderAll();
    showToast('🔄 Todas as simulações foram resetadas com sucesso!');
  }

  // --- TAB NAVIGATION ---
  function switchTab(tabId) {
    currentTab = tabId;
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.tab-content').forEach(section => {
      section.classList.toggle('active', section.id === `tab-${tabId}`);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- LIVE ESPN API FETCH ---
  async function fetchLiveESPNData() {
    const syncStatusEl = document.getElementById('espn-sync-status');
    const syncBtn = document.getElementById('btn-sync-espn');
    if (syncBtn) syncBtn.classList.add('syncing');
    if (syncStatusEl) syncStatusEl.textContent = 'Conectando à API da ESPN...';

    try {
      // 1. Standings
      const response = await fetch('https://site.api.espn.com/apis/v2/sports/soccer/bra.1/standings', {
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (data && data.children && data.children[0] && data.children[0].standings) {
        const entries = data.children[0].standings.entries;
        if (entries && entries.length >= 20) {
          originalTeams = entries.map(e => {
            const getStat = name => e.stats?.find(s => s.name === name)?.value ?? 0;
            return {
              id: String(e.team.id),
              name: e.team.displayName,
              shortName: e.team.shortDisplayName || e.team.name,
              abbrev: e.team.abbreviation,
              logo: e.team.logos?.[0]?.href || `https://a.espncdn.com/i/teamlogos/soccer/500/${e.team.id}.png`,
              rank: Number(getStat('rank')),
              points: Number(getStat('points')),
              played: Number(getStat('gamesPlayed')),
              wins: Number(getStat('wins')),
              draws: Number(getStat('ties')),
              losses: Number(getStat('losses')),
              goalsFor: Number(getStat('pointsFor')),
              goalsAgainst: Number(getStat('pointsAgainst')),
              goalDiff: Number(getStat('pointDifferential'))
            };
          });

          lastSyncTime = new Date();
          if (syncStatusEl) {
            syncStatusEl.textContent = `ESPN Sincronizada às ${lastSyncTime.toLocaleTimeString('pt-BR')}`;
          }
          showToast('✅ Classificação atualizada em tempo real via ESPN API!');
          renderAll();
          return;
        }
      }
      throw new Error('Formato inesperado na resposta da ESPN');
    } catch (err) {
      console.warn('ESPN Live Fetch fallback used:', err.message);
      if (syncStatusEl) {
        syncStatusEl.textContent = 'Usando dados sincronizados do Brasileirão 2026';
      }
    } finally {
      if (syncBtn) syncBtn.classList.remove('syncing');
    }
  }

  // --- TOAST NOTIFICATIONS ---
  function showToast(message) {
    let toast = document.getElementById('toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast-notification';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('visible');
    setTimeout(() => {
      toast.classList.remove('visible');
    }, 3200);
  }

  // --- INITIALIZATION ---
  function init() {
    // 1. Load initial data
    if (window.INITIAL_DATA && window.INITIAL_DATA.teams) {
      originalTeams = JSON.parse(JSON.stringify(window.INITIAL_DATA.teams));
      fixtures = JSON.parse(JSON.stringify(window.INITIAL_DATA.fixtures));
    } else {
      console.error('INITIAL_DATA not found. Please ensure data.js is loaded.');
    }

    // 2. Set up tab buttons
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabTarget = tab.getAttribute('data-tab');
        switchTab(tabTarget);
      });
    });

    // 3. Action buttons
    const simAllBtn = document.getElementById('btn-sim-all');
    if (simAllBtn) simAllBtn.addEventListener('click', simulateAllRemainingWithPoisson);

    const resetBtn = document.getElementById('btn-reset-sims');
    if (resetBtn) resetBtn.addEventListener('click', resetAllSimulations);

    const syncBtn = document.getElementById('btn-sync-espn');
    if (syncBtn) syncBtn.addEventListener('click', fetchLiveESPNData);

    // Initial render
    renderAll();

    // Try fetching live ESPN data in background if connected
    fetchLiveESPNData();
  }

  // Run on DOM loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
