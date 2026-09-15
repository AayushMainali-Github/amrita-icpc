(() => {
  "use strict";

  const API_ROOT = "https://codeforces.com/api";
  const API_PAGE_SIZE = 10000;
  const API_GAP_MS = 2100;
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const CACHE_PREFIX = "amrita-icpc-scoreboard-v2:";

  const state = {
    users: [],
    problemIds: [],
    problemInfo: [],
    results: new Map(),
    cacheKey: "",
    updatedAt: null,
  };

  let nextApiRequestAt = 0;

  const elements = {
    body: document.getElementById("scoreboard-body"),
    head: document.getElementById("scoreboard-head"),
    problemSummary: document.getElementById("problem-summary"),
    refreshButton: document.getElementById("refresh-button"),
    statusLine: document.querySelector(".status-line"),
    statusText: document.getElementById("status-text"),
    updatedAt: document.getElementById("updated-at"),
    userSummary: document.getElementById("user-summary"),
  };

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function setStatus(message, isError = false) {
    elements.statusText.textContent = message;
    elements.statusLine.classList.toggle("error", isError);
  }

  function getUserHandle(user) {
    return String(user.username || user.handle || "").trim();
  }

  function getProblemId(problem) {
    if (typeof problem === "string") {
      return problem.trim().toUpperCase();
    }
    if (problem && typeof problem === "object") {
      return String(problem.id || problem.problemId || "")
        .trim()
        .toUpperCase();
    }
    return "";
  }

  function parseProblemId(problemId) {
    const match = /^(\d+)([A-Z]\d*)$/.exec(problemId);
    if (!match) {
      throw new Error(
        `Invalid problem id "${problemId}". Use a contest id followed by an index, for example 4A.`,
      );
    }
    return { contestId: match[1], index: match[2] };
  }

  function normalizeConfig(users, problems) {
    if (!Array.isArray(users) || !Array.isArray(problems)) {
      throw new Error("Configuration files must each contain a JSON array.");
    }

    const normalizedUsers = users.map((user, index) => {
      if (!user || typeof user !== "object") {
        throw new Error(`User entry ${index + 1} is not an object.`);
      }
      const name = String(user.name || "").trim();
      const username = getUserHandle(user);
      if (!name || !username) {
        throw new Error(`User entry ${index + 1} needs name and username.`);
      }
      return { name, username };
    });

    const normalizedProblems = problems.map(getProblemId);
    if (normalizedProblems.some((problemId) => !problemId)) {
      throw new Error("Every problem entry needs a problem id.");
    }
    normalizedProblems.forEach(parseProblemId);

    const duplicateUsers = findDuplicate(normalizedUsers.map((user) => user.username.toLowerCase()));
    if (duplicateUsers) {
      throw new Error(`Duplicate Codeforces username: ${duplicateUsers}`);
    }
    const duplicateProblems = findDuplicate(normalizedProblems);
    if (duplicateProblems) {
      throw new Error(`Duplicate problem id: ${duplicateProblems}`);
    }

    return { users: normalizedUsers, problemIds: normalizedProblems };
  }

  function findDuplicate(values) {
    const seen = new Set();
    for (const value of values) {
      if (seen.has(value)) return value;
      seen.add(value);
    }
    return null;
  }

  async function fetchJson(path) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${path} returned HTTP ${response.status}.`);
    }
    return response.json();
  }

  async function getConfig() {
    const [users, problems] = await Promise.all([
      fetchJson("usernames.json"),
      fetchJson("problems.json"),
    ]);
    return normalizeConfig(users, problems);
  }

  async function waitForApiSlot() {
    const delay = Math.max(0, nextApiRequestAt - Date.now());
    if (delay > 0) await wait(delay);
    nextApiRequestAt = Date.now() + API_GAP_MS;
  }

  function buildApiUrl(handle, from) {
    const params = new URLSearchParams({
      handle,
      from: String(from),
      count: String(API_PAGE_SIZE),
    });
    return `${API_ROOT}/user.status?${params.toString()}`;
  }

  function requestJsonp(url) {
    return new Promise((resolve, reject) => {
      const callbackName = `cfScoreboardCallback${Date.now()}${Math.floor(Math.random() * 100000)}`;
      const script = document.createElement("script");
      let settled = false;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        delete window[callbackName];
        script.remove();
        callback(value);
      };

      const timeoutId = window.setTimeout(
        () => finish(reject, new Error("Codeforces API request timed out.")),
        15000,
      );

      window[callbackName] = (payload) => finish(resolve, payload);
      script.onerror = () =>
        finish(reject, new Error("Codeforces API could not be reached."));
      script.src = `${url}&jsonp=${encodeURIComponent(callbackName)}`;
      document.head.appendChild(script);
    });
  }

  async function requestApi(url, retry = 0) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      const payload = await response.json();
      if (response.ok && payload.status === "OK") return payload.result;
      throw new Error(payload.comment || `Codeforces API returned HTTP ${response.status}.`);
    } catch (fetchError) {
      if (retry === 0) {
        try {
          const payload = await requestJsonp(url);
          if (payload.status === "OK") return payload.result;
          throw new Error(payload.comment || "Codeforces API returned a failed response.");
        } catch (_jsonpError) {
          // The fetch error below is usually more useful when CORS is the cause.
        }
      }
      if (retry < 2) {
        await wait(4000);
        return requestApi(url, retry + 1);
      }
      throw new Error(fetchError.message || "Codeforces API request failed.");
    }
  }

  async function fetchAllSubmissions(handle, progress) {
    const submissions = [];
    let from = 1;

    while (true) {
      progress(from, submissions.length);
      await waitForApiSlot();
      const batch = await requestApi(buildApiUrl(handle, from));
      if (!Array.isArray(batch)) {
        throw new Error(`Unexpected submission data for ${handle}.`);
      }
      submissions.push(...batch);
      if (batch.length < API_PAGE_SIZE) break;
      from += batch.length;
    }

    return submissions;
  }

  function submissionProblemId(submission) {
    if (!submission || !submission.problem) return "";
    const { contestId, index } = submission.problem;
    if (contestId === undefined || !index) return "";
    return `${contestId}${String(index).toUpperCase()}`;
  }

  function summarizeSubmissions(submissions, problemIds) {
    const targetProblems = new Set(problemIds);
    const allSolved = new Set();
    const problems = Object.fromEntries(
      problemIds.map((problemId) => [problemId, { solved: false }]),
    );

    for (const submission of submissions) {
      const problemId = submissionProblemId(submission);
      if (submission.verdict === "OK" && problemId) allSolved.add(problemId);
      if (targetProblems.has(problemId) && submission.verdict === "OK") {
        problems[problemId].solved = true;
      }
    }

    return {
      allSolvedCount: allSolved.size,
      solvedCount: Object.values(problems).filter((problem) => problem.solved).length,
      problems,
    };
  }

  function getCacheKey() {
    const users = state.users.map((user) => [user.name, user.username]);
    return `${CACHE_PREFIX}${JSON.stringify({ users, problems: state.problemIds })}`;
  }

  function readCache() {
    try {
      const raw = window.localStorage.getItem(state.cacheKey);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (!cached.fetchedAt || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
      return cached;
    } catch (_error) {
      return null;
    }
  }

  function writeCache() {
    try {
      const results = Object.fromEntries(state.results.entries());
      window.localStorage.setItem(
        state.cacheKey,
        JSON.stringify({ fetchedAt: Date.now(), results }),
      );
    } catch (_error) {
      // Private browsing or a full storage quota should not stop the scoreboard.
    }
  }

  function getProblemInfo(problemId) {
    const parsed = parseProblemId(problemId);
    return {
      ...parsed,
      url: `https://codeforces.com/problemset/problem/${parsed.contestId}/${parsed.index}`,
    };
  }

  function renderHeader() {
    elements.problemSummary.textContent = `${state.problemIds.length} target problems`;
    elements.userSummary.textContent = `${state.users.length} contestants`;
    elements.head.innerHTML = `
      <tr>
        <th class="rank-column sticky-column sticky-rank" scope="col">#</th>
        <th class="name-column sticky-column sticky-name" scope="col">Name</th>
        <th class="handle-column sticky-column sticky-handle" scope="col">Codeforces username</th>
        <th class="solved-column sticky-column sticky-solved" scope="col">Solved</th>
        ${state.problemInfo
          .map(
            (problem) => `
              <th class="problem-heading" scope="col">
                <a href="${problem.url}" target="_blank" rel="noreferrer">${problem.contestId}${problem.index}</a>
                <small>problem</small>
              </th>`,
          )
          .join("")}
      </tr>`;
  }

  function emptyResult() {
    return {
      loading: true,
      allSolvedCount: 0,
      solvedCount: 0,
      problems: Object.fromEntries(
        state.problemIds.map((problemId) => [problemId, { solved: false }]),
      ),
    };
  }

  function compareResults(left, right) {
    const leftResult = state.results.get(left.username) || emptyResult();
    const rightResult = state.results.get(right.username) || emptyResult();
    if (rightResult.solvedCount !== leftResult.solvedCount) {
      return rightResult.solvedCount - leftResult.solvedCount;
    }
    return left.name.localeCompare(right.name);
  }

  function getRankedUsers() {
    return [...state.users].sort(compareResults);
  }

  function formatRankedRows() {
    const rankedUsers = getRankedUsers();
    let previousSolved = null;
    let previousRank = 0;

    return rankedUsers.map((user, index) => {
      const result = state.results.get(user.username) || emptyResult();
      const solved = result.solvedCount || 0;
      if (solved !== previousSolved) {
        previousRank = index + 1;
        previousSolved = solved;
      }
      return { user, result, rank: previousRank };
    });
  }

  function renderBody() {
    const rows = formatRankedRows();
    elements.body.innerHTML = rows
      .map(({ user, result, rank }) => {
        const problemCells = state.problemIds
          .map((problemId) => renderProblemCell(result, problemId))
          .join("");
        const solved = result.loading ? "..." : `${result.solvedCount}/${state.problemIds.length}`;
        return `
          <tr>
            <td class="rank sticky-column sticky-rank">${result.loading ? "-" : rank}</td>
            <td class="name sticky-column sticky-name" title="${escapeHtml(user.name)}">${escapeHtml(user.name)}</td>
            <td class="handle sticky-column sticky-handle">
              <a href="https://codeforces.com/profile/${encodeURIComponent(user.username)}" target="_blank" rel="noreferrer">${escapeHtml(user.username)}</a>
            </td>
            <td class="solved sticky-column sticky-solved">${solved}</td>
            ${problemCells}
          </tr>`;
      })
      .join("");
  }

  function renderProblemCell(result, problemId) {
    const problem = result.problems?.[problemId];
    if (!problem || result.loading) {
      return `
        <td class="problem-cell loading" title="Waiting for Codeforces data">
          <span class="cell-state">...</span>
          <span class="cell-meta">loading</span>
        </td>`;
    }
    if (!problem.solved) {
      return `
        <td class="problem-cell unsolved" title="Not solved in the fetched submissions">
          <span class="cell-state">.</span>
          <span class="cell-meta">not solved</span>
        </td>`;
    }
    return `
      <td class="problem-cell accepted" title="Solved">
        <span class="cell-state">+</span>
        <span class="cell-meta">accepted</span>
      </td>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderUpdatedAt(timestamp) {
    elements.updatedAt.textContent = timestamp
      ? `updated ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(timestamp)}`
      : "";
  }

  async function loadScoreboard(forceRefresh = false) {
    elements.refreshButton.hidden = true;
    elements.refreshButton.disabled = true;
    state.results = new Map();
    state.updatedAt = null;
    renderUpdatedAt(null);

    try {
      const config = await getConfig();
      state.users = config.users;
      state.problemIds = config.problemIds;
      state.problemInfo = state.problemIds.map(getProblemInfo);
      state.cacheKey = getCacheKey();
      renderHeader();
      state.users.forEach((user) => state.results.set(user.username, emptyResult()));
      renderBody();

      const cached = forceRefresh ? null : readCache();
      if (cached?.results) {
        for (const user of state.users) {
          const cachedResult = cached.results[user.username];
          if (cachedResult) state.results.set(user.username, cachedResult);
        }
        state.updatedAt = cached.fetchedAt;
        renderBody();
        renderUpdatedAt(state.updatedAt);
        const cachedSolved = [...state.results.values()].reduce(
          (total, result) => total + (result.solvedCount || 0),
          0,
        );
        setStatus(
          `Loaded cached data: ${cachedSolved} target solve${cachedSolved === 1 ? "" : "s"}. Press Refresh to query Codeforces again.`,
        );
      } else {
        const estimatedSeconds = state.users.length * (API_GAP_MS / 1000);
        setStatus(
          `Fetching Codeforces submissions for ${state.users.length} users. API pacing may take about ${Math.ceil(estimatedSeconds)} seconds.`,
        );
        for (let index = 0; index < state.users.length; index += 1) {
          const user = state.users[index];
          setStatus(
            `Fetching ${index + 1}/${state.users.length}: ${user.username}. Codeforces API pacing is active.`,
          );
          const submissions = await fetchAllSubmissions(user.username, (from, loaded) => {
            if (from > 1) {
              setStatus(
                `Fetching ${index + 1}/${state.users.length}: ${user.username} (page from ${from}; ${loaded.toLocaleString("en-IN")} submissions loaded).`,
              );
            }
          });
          state.results.set(
            user.username,
            summarizeSubmissions(submissions, state.problemIds),
          );
          renderBody();
        }
        state.updatedAt = Date.now();
        writeCache();
        renderBody();
        renderUpdatedAt(state.updatedAt);
        const totalSolved = [...state.results.values()].reduce(
          (total, result) => total + result.solvedCount,
          0,
        );
        setStatus(
          `Loaded ${state.users.length} users: ${totalSolved} target solve${totalSolved === 1 ? "" : "s"}.`,
        );
      }
    } catch (error) {
      setStatus(error.message || "Could not load the scoreboard.", true);
      elements.refreshButton.hidden = false;
    } finally {
      elements.refreshButton.disabled = false;
    }
  }

  elements.refreshButton.addEventListener("click", () => loadScoreboard(true));
  loadScoreboard();
})();
