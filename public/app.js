import { BOOK_PRINCIPLES } from "./sim/books.js";
import { createSession, applyUserTurn, buildClientState } from "./sim/engine.js";
import { BOARD_ROLES } from "./sim/roles.js";
import { SCENARIOS, SECTORS } from "./sim/scenarios.js";
import { DEFAULT_PROMPT_PROFILE } from "./sim/prompt-profile.js";

const authShell = document.getElementById("authShell");
const appShell = document.getElementById("appShell");
const signInTab = document.getElementById("signInTab");
const registerTab = document.getElementById("registerTab");
const authForm = document.getElementById("authForm");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const resetPasswordBtn = document.getElementById("resetPasswordBtn");
const authError = document.getElementById("authError");
const authStatus = document.getElementById("authStatus");
const nameInput = document.getElementById("nameInput");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");

const roleSelect = document.getElementById("roleSelect");
const sectorSelect = document.getElementById("sectorSelect");
const scenarioSelect = document.getElementById("scenarioSelect");
const companyInput = document.getElementById("companyInput");
const startBtn = document.getElementById("startBtn");
const signOutBtn = document.getElementById("signOutBtn");
const chatWindow = document.getElementById("chatWindow");
const optionsWrap = document.getElementById("optionsWrap");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const metricsGrid = document.getElementById("metricsGrid");
const scoreText = document.getElementById("scoreText");
const turnText = document.getElementById("turnText");
const stageText = document.getElementById("stageText");
const dimensionGrid = document.getElementById("dimensionGrid");
const principleList = document.getElementById("principleList");
const scenarioTitle = document.getElementById("scenarioTitle");
const scenarioMandate = document.getElementById("scenarioMandate");
const scenarioTension = document.getElementById("scenarioTension");
const scenarioAnchor = document.getElementById("scenarioAnchor");
const latestEvent = document.getElementById("latestEvent");
const savedSessionSelect = document.getElementById("savedSessionSelect");
const loadSavedBtn = document.getElementById("loadSavedBtn");
const savedHint = document.getElementById("savedHint");

const services = window.firebaseServices || {};
const auth = services.auth;
const db = services.db;
const firebaseCompat = services.firebase || window.firebase || null;
const FieldValue =
  firebaseCompat && firebaseCompat.firestore && firebaseCompat.firestore.FieldValue
    ? firebaseCompat.firestore.FieldValue
    : { serverTimestamp: () => new Date().toISOString() };

let authMode = "signin";
let sessionState = null;
let sessionView = null;
let sessionDocId = null;
let busy = false;
let transcript = [];
let readOnlySnapshot = false;
let currentUser = null;
let scenariosBySector = new Map();
const principleMap = new Map(BOOK_PRINCIPLES.map((item) => [item.id, item.title]));
const sectorMap = new Map(SECTORS.map((item) => [item.id, item]));

if (!auth || !db) {
  authError.hidden = false;
  authError.textContent = "Firebase services unavailable. Check configuration in public/firebase-config.js.";
}

function renderAuthStatus() {
  if (!authStatus) return;
  const projectId = services.config && services.config.projectId ? services.config.projectId : "unknown-project";
  authStatus.textContent = services.usingMock
    ? `Mock mode active (${projectId})`
    : `Live Firebase: ${projectId}`;
}

function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === "register";
  signInTab.classList.toggle("is-active", !isRegister);
  registerTab.classList.toggle("is-active", isRegister);
  nameInput.style.display = isRegister ? "block" : "none";
  nameInput.required = isRegister;
  passwordInput.autocomplete = isRegister ? "new-password" : "current-password";
  authSubmitBtn.textContent = isRegister ? "Create Account" : "Continue to Simulator";
  if (resetPasswordBtn) {
    resetPasswordBtn.disabled = isRegister;
  }
}

function showAuthError(message) {
  authError.hidden = false;
  authError.textContent = message;
}

function formatAuthError(error, mode) {
  const code = error && error.code ? String(error.code) : "";
  if (mode === "signin" && (code.includes("auth/invalid-credential") || code.includes("auth/wrong-password"))) {
    return "Sign-in failed. Check your email/password and try again.";
  }
  if (code.includes("auth/too-many-requests")) {
    return "Too many attempts. Wait a few minutes, then try again.";
  }
  if (mode === "register" && code.includes("auth/email-already-in-use")) {
    return "That email already has an account. Use Existing Account to sign in.";
  }
  if (error && error.message) {
    return code ? `${error.message} (${code})` : error.message;
  }
  return code ? `Authentication failed. (${code})` : "Authentication failed.";
}

function hideAuthError() {
  authError.hidden = true;
  authError.textContent = "";
}

function showSignedOutState() {
  authShell.hidden = false;
  appShell.hidden = true;
  sessionState = null;
  sessionDocId = null;
  readOnlySnapshot = false;
  resetChat();
}

async function showSignedInState(user) {
  authShell.hidden = true;
  appShell.hidden = false;
  renderSelectors();
  await refreshSavedSessions();
  savedHint.textContent = services.usingMock
    ? "Running in localhost mock mode. Set window.FORCE_REAL_FIREBASE=1 to use live project."
    : "Connected to Firebase.";
  if (!sessionView && chatWindow.childElementCount === 0) {
    appendMessage("system", `Signed in as ${user.email}. Select role/sector/scenario and start session.`);
  }
}

function validateAuthInput(mode, email, password, name) {
  if (!email) return "Email is required.";
  if (!email.includes("@")) return "Enter a valid email address.";
  if (!password) return "Password is required.";
  if (mode === "register" && !name) return "Full name is required for account creation.";
  return "";
}

function metricLabel(key) {
  const labels = {
    revenueGrowth: "Revenue Growth",
    operatingMargin: "Operating Margin",
    aiAdoption: "AI Adoption",
    modelRisk: "Model Risk",
    workforceReadiness: "Workforce Readiness",
    customerTrust: "Customer Trust",
    cashFlow: "Cash Flow Index",
    executionConfidence: "Execution Confidence",
  };
  return labels[key] || key;
}

function metricValue(key, value) {
  if (key === "revenueGrowth" || key === "operatingMargin") {
    return `${Number(value).toFixed(1)}%`;
  }
  return Number(value).toFixed(1);
}

function appendMessage(role, text) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  chatWindow.appendChild(bubble);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function resetChat() {
  chatWindow.innerHTML = "";
  transcript = [];
}

function pushTranscript(role, content) {
  transcript.push({
    role,
    content,
    at: new Date().toISOString(),
  });
}

function renderScenarioPreview(scenarioId, sectorId) {
  const scenario = SCENARIOS.find((item) => item.id === scenarioId);
  const sector = sectorMap.get(sectorId);
  scenarioTitle.textContent = scenario
    ? `${scenario.name}${sector ? ` (${sector.name})` : ""}`
    : "Scenario";
  scenarioMandate.textContent = `Mandate: ${scenario ? scenario.boardMandate : "-"}`;
  scenarioTension.textContent = `Tension: ${scenario ? scenario.tension : "-"}`;
  scenarioAnchor.textContent = `Book anchor: ${scenario && scenario.chapterAnchors[0] ? scenario.chapterAnchors[0] : "-"}`;
  latestEvent.textContent = "Latest event: none";
}

function renderMetrics(view) {
  metricsGrid.innerHTML = "";
  for (const [key, value] of Object.entries(view.metrics || {})) {
    const card = document.createElement("article");
    card.className = "metric";
    card.innerHTML = `
      <span class="metric-label">${metricLabel(key)}</span>
      <div class="metric-value">${metricValue(key, value)}</div>
    `;
    metricsGrid.appendChild(card);
  }
  scoreText.textContent = `${view.scorecard.overall.toFixed(1)} (${view.scorecard.rating})`;
  turnText.textContent = `Meeting ${view.turn} of ${view.maxTurns} | Incidents ${view.scorecard.incidents}`;
  stageText.textContent = `Stage: ${view.stage || "-"}`;
}

function renderDimensions(view) {
  const values = view.scorecard.outcomeDimensions || {};
  const rows = [
    ["Business Value", values.businessValue],
    ["Decision Quality", values.decisionQuality],
    ["Leadership Capability", values.leadershipCapability],
    ["Speed to Impact", values.speedToImpact],
    ["Risk Control", values.riskControl],
  ];
  dimensionGrid.innerHTML = "";
  rows.forEach(([name, score]) => {
    const row = document.createElement("div");
    row.className = "dimension-item";
    row.innerHTML = `<span>${name}</span><strong>${Number(score).toFixed(1)}</strong>`;
    dimensionGrid.appendChild(row);
  });
}

function renderPrinciples(view) {
  principleList.innerHTML = "";
  if (!view.principlesCovered || view.principlesCovered.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No principles covered yet.";
    principleList.appendChild(li);
    return;
  }
  view.principlesCovered.forEach((id) => {
    const li = document.createElement("li");
    li.textContent = principleMap.get(id) || id;
    principleList.appendChild(li);
  });
}

function renderOptions(view) {
  optionsWrap.innerHTML = "";
  if (readOnlySnapshot) {
    const msg = document.createElement("p");
    msg.className = "subtext";
    msg.textContent = "Snapshot loaded in read-only mode. Start a new session to continue simulation.";
    optionsWrap.appendChild(msg);
    return;
  }
  if (!view.options || view.options.length === 0) {
    const msg = document.createElement("p");
    msg.className = "subtext";
    msg.textContent = "No options left. Session is complete.";
    optionsWrap.appendChild(msg);
    return;
  }
  view.options.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-btn";
    button.innerHTML = `
      <span class="title">Option ${option.index}. ${option.title}</span>
      ${option.recommended ? '<span class="badge">Board Pack Priority</span>' : ""}
      <span class="detail">${option.description}</span>
    `;
    button.addEventListener("click", () => sendTurn({ optionId: option.id, message: option.title }));
    optionsWrap.appendChild(button);
  });
}

function renderScenarioDetails(view) {
  const sector = view.sector || {};
  const scenario = view.scenario || {};
  const events = view.scenarioEventHistory || [];
  const lastEvent = events.length ? events[events.length - 1] : null;
  scenarioTitle.textContent = `${scenario.name || "Scenario"}${sector.name ? ` (${sector.name})` : ""}`;
  scenarioMandate.textContent = `Mandate: ${scenario.boardMandate || "-"}`;
  scenarioTension.textContent = `Tension: ${scenario.tension || "-"}`;
  scenarioAnchor.textContent = `Book anchor: ${(scenario.chapterAnchors && scenario.chapterAnchors[0]) || "-"}`;
  latestEvent.textContent = `Latest event: ${lastEvent ? `${lastEvent.title} (Q${lastEvent.quarter})` : "none"}`;
}

function renderSession(view, includeBoardMessage = true) {
  sessionView = view;
  renderScenarioDetails(view);
  renderMetrics(view);
  renderDimensions(view);
  renderPrinciples(view);
  renderOptions(view);
  if (includeBoardMessage && view.lastBoardMessage) {
    appendMessage("system", view.lastBoardMessage);
    pushTranscript("system", view.lastBoardMessage);
  }
}

function setBusy(value) {
  busy = value;
  startBtn.disabled = value;
  signOutBtn.disabled = value;
  roleSelect.disabled = value || readOnlySnapshot;
  sectorSelect.disabled = value || readOnlySnapshot;
  scenarioSelect.disabled = value || readOnlySnapshot;
  companyInput.disabled = value || readOnlySnapshot;
  messageInput.disabled = value || !sessionState || readOnlySnapshot;
  loadSavedBtn.disabled = value;
  authSubmitBtn.disabled = value;
}

async function saveSnapshot() {
  if (!currentUser || !sessionView || !sessionDocId) return;
  const payload = {
    ownerUid: currentUser.uid,
    ownerEmail: currentUser.email || "",
    companyName: sessionView.companyName,
    roleId: sessionView.role.id,
    roleName: sessionView.role.name,
    sectorId: sessionView.sector.id,
    sectorName: sessionView.sector.name,
    scenarioId: sessionView.scenario.id,
    scenarioName: sessionView.scenario.name,
    turn: sessionView.turn,
    maxTurns: sessionView.maxTurns,
    completed: sessionView.completed,
    score: sessionView.scorecard.overall,
    stage: sessionView.stage,
    snapshot: sessionView,
    transcript: transcript.slice(-200),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.collection("simulationSessions").doc(sessionDocId).set(payload, { merge: true });
}

async function refreshSavedSessions() {
  if (!currentUser) return;
  savedSessionSelect.innerHTML = "";
  const query = await db
    .collection("simulationSessions")
    .where("ownerUid", "==", currentUser.uid)
    .get();

  const docs = (query.docs || []).slice().sort((a, b) => {
    const av = a.data().updatedAt || "";
    const bv = b.data().updatedAt || "";
    return av > bv ? -1 : av < bv ? 1 : 0;
  });

  if (docs.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No saved sessions";
    savedSessionSelect.appendChild(option);
    return;
  }
  docs.forEach((doc) => {
    const data = doc.data();
    const label = `${data.scenarioName || "Scenario"} | ${data.roleName || "Role"} | Score ${Number(
      data.score || 0
    ).toFixed(1)} | Turn ${data.turn || 0}`;
    const option = document.createElement("option");
    option.value = doc.id;
    option.textContent = label;
    savedSessionSelect.appendChild(option);
  });
}

async function startSession() {
  if (!currentUser) return;
  setBusy(true);
  readOnlySnapshot = false;
  resetChat();
  try {
    const seed = Date.now();
    sessionState = createSession({
      roleId: roleSelect.value,
      sectorId: sectorSelect.value,
      scenarioId: scenarioSelect.value,
      companyName: companyInput.value.trim() || "Northstar Holdings",
      seed,
      promptProfile: DEFAULT_PROMPT_PROFILE,
    });
    sessionView = buildClientState(sessionState);
    const createRes = await db.collection("simulationSessions").add({
      ownerUid: currentUser.uid,
      ownerEmail: currentUser.email || "",
      companyName: sessionView.companyName,
      roleId: sessionView.role.id,
      roleName: sessionView.role.name,
      sectorId: sessionView.sector.id,
      sectorName: sessionView.sector.name,
      scenarioId: sessionView.scenario.id,
      scenarioName: sessionView.scenario.name,
      turn: sessionView.turn,
      maxTurns: sessionView.maxTurns,
      completed: sessionView.completed,
      score: sessionView.scorecard.overall,
      stage: sessionView.stage,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      snapshot: sessionView,
      transcript: [],
    });
    sessionDocId = createRes.id;
    renderSession(sessionView, true);
    await saveSnapshot();
    await refreshSavedSessions();
  } catch (error) {
    appendMessage("system", `Failed to start session: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function sendTurn(payload) {
  if (!sessionState || busy || readOnlySnapshot) return;
  const userMessage = (payload.message || "").trim();
  if (userMessage) {
    appendMessage("user", userMessage);
    pushTranscript("user", userMessage);
  }
  setBusy(true);
  try {
    const result = applyUserTurn(sessionState, payload);
    sessionView = buildClientState(sessionState);
    renderSession(sessionView, true);
    if (result.scenarioEvent) {
      appendMessage("system", `Scenario event: ${result.scenarioEvent.title}`);
      pushTranscript("system", `Scenario event: ${result.scenarioEvent.title}`);
    }
    if (result.incident) {
      appendMessage("system", `Incident: ${result.incident.title}`);
      pushTranscript("system", `Incident: ${result.incident.title}`);
    }
    await saveSnapshot();
    await refreshSavedSessions();
  } catch (error) {
    appendMessage("system", `Turn failed: ${error.message}`);
  } finally {
    messageInput.value = "";
    setBusy(false);
  }
}

async function loadSavedSnapshot() {
  const id = savedSessionSelect.value;
  if (!id) return;
  setBusy(true);
  try {
    const doc = await db.collection("simulationSessions").doc(id).get();
    if (!doc.exists) {
      savedHint.textContent = "Selected snapshot no longer exists.";
      return;
    }
    const data = doc.data();
    sessionDocId = id;
    sessionState = null;
    readOnlySnapshot = true;
    resetChat();
    sessionView = data.snapshot;
    if (!sessionView) {
      savedHint.textContent = "Snapshot payload missing.";
      return;
    }
    renderSession(sessionView, false);
    transcript = Array.isArray(data.transcript) ? data.transcript : [];
    transcript.forEach((item) => appendMessage(item.role === "user" ? "user" : "system", item.content));
    savedHint.textContent = `Loaded snapshot from ${data.scenarioName} (${data.roleName}).`;
  } catch (error) {
    savedHint.textContent = `Failed to load snapshot: ${error.message}`;
  } finally {
    setBusy(false);
  }
}

function renderSelectors() {
  roleSelect.innerHTML = "";
  BOARD_ROLES.forEach((role) => {
    const option = document.createElement("option");
    option.value = role.id;
    option.textContent = role.name;
    roleSelect.appendChild(option);
  });
  roleSelect.value = "board-chair";

  sectorSelect.innerHTML = "";
  scenariosBySector = new Map();
  SECTORS.forEach((sector) => {
    const option = document.createElement("option");
    option.value = sector.id;
    option.textContent = sector.name;
    sectorSelect.appendChild(option);
    scenariosBySector.set(sector.id, []);
  });
  SCENARIOS.forEach((scenario) => {
    const list = scenariosBySector.get(scenario.sectorId) || [];
    list.push(scenario);
    scenariosBySector.set(scenario.sectorId, list);
  });
  sectorSelect.value = "financial-services";
  renderScenarioOptions();
}

function renderScenarioOptions() {
  scenarioSelect.innerHTML = "";
  const scenarios = scenariosBySector.get(sectorSelect.value) || [];
  scenarios.forEach((scenario) => {
    const option = document.createElement("option");
    option.value = scenario.id;
    option.textContent = scenario.name;
    scenarioSelect.appendChild(option);
  });
  if (scenarioSelect.options.length > 0) {
    scenarioSelect.selectedIndex = 0;
  }
  renderScenarioPreview(scenarioSelect.value, sectorSelect.value);
}

signInTab.addEventListener("click", () => setAuthMode("signin"));
registerTab.addEventListener("click", () => setAuthMode("register"));
sectorSelect.addEventListener("change", () => {
  if (!readOnlySnapshot) renderScenarioOptions();
});
scenarioSelect.addEventListener("change", () => {
  if (!readOnlySnapshot) renderScenarioPreview(scenarioSelect.value, sectorSelect.value);
});
startBtn.addEventListener("click", startSession);
loadSavedBtn.addEventListener("click", loadSavedSnapshot);
signOutBtn.addEventListener("click", async () => {
  if (!auth) return;
  await auth.signOut();
});

if (resetPasswordBtn) {
  resetPasswordBtn.addEventListener("click", async () => {
    if (!auth || busy) return;
    hideAuthError();
    const email = emailInput.value.trim();
    if (!email) {
      showAuthError("Enter your email first, then click Reset Password.");
      return;
    }
    setBusy(true);
    try {
      await auth.sendPasswordResetEmail(email);
      showAuthError("Password reset email sent. Check your inbox.");
    } catch (error) {
      showAuthError(formatAuthError(error, "signin"));
    } finally {
      setBusy(false);
    }
  });
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  sendTurn({ message: text });
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!auth || busy) return;
  hideAuthError();
  setBusy(true);
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const name = nameInput.value.trim();
  const validationError = validateAuthInput(authMode, email, password, name);
  if (validationError) {
    showAuthError(validationError);
    setBusy(false);
    return;
  }
  try {
    if (authMode === "register") {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      if (cred.user && cred.user.updateProfile) {
        await cred.user.updateProfile({ displayName: name });
      }
      await db.collection("users").doc(cred.user.uid).set({
        uid: cred.user.uid,
        email,
        name,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await showSignedInState(cred.user);
    } else {
      const cred = await auth.signInWithEmailAndPassword(email, password);
      await showSignedInState(cred.user);
    }
  } catch (error) {
    showAuthError(formatAuthError(error, authMode));
  } finally {
    setBusy(false);
  }
});

if (auth) {
  auth.onAuthStateChanged(async (user) => {
    currentUser = user || null;
    if (!user) {
      showSignedOutState();
      return;
    }

    await showSignedInState(user);
  });
}

setAuthMode("signin");
renderAuthStatus();
