"use strict";

const PASSWORD = "12345123";
const QUESTOES_PATH = "src/questoes/";
const LETTERS = ["A", "B", "C", "D", "E"];
const GROUP_ORDER = [
  "Conceitos básicos",
  "Métodos e técnicas",
  "Elementos técnicos",
  "Taquigrafia e tecnologia"
];
const STORAGE = {
  theme: "taquigrafia_theme",
  history: "taquigrafia_history",
  wrong: "taquigrafia_wrong_questions",
  saved: "taquigrafia_saved_questions",
  lastConfig: "taquigrafia_last_config",
  accumulated: "taquigrafia_accumulated",
  unlocked: "taquigrafia_unlocked"
};

const STORAGE_LIMITS = {
  maxHistoryEntries: 60,
  maxHistoryBytes: 900 * 1024,
  warningBytes: 650 * 1024
};

const defaultFilters = {
  mode: "geral",
  selectedGroups: [],
  selectedSubjects: [],
  selectedSubthemes: [],
  quantity: 20,
  shuffleQuestions: true
};

const state = {
  manifest: null,
  files: [],
  rawQuestions: [],
  questions: [],
  questionById: new Map(),
  contentTree: [],
  validationWarnings: [],
  filters: { ...defaultFilters },
  session: null,
  notice: "",
  expandedGroups: new Set(GROUP_ORDER),
  currentView: "home",
  shellMounted: false,
  stickyCTAObserver: null,
  sidebarOpen: false,
  sidebarLastFocus: null,
  pendingAnchor: null
};

const VIEW_ORDER = ["home", "training", "review", "history", "indicators", "content-map", "diagnostic"];
const NAV_TO_VIEW = {
  home: "home",
  training: "home",
  review: "review",
  history: "history",
  indicators: "home",
  "content-map": "home",
  diagnostic: "history"
};
const NAV_ANCHORS = {
  training: { view: "home", anchor: "training-anchor" },
  indicators: { view: "home", anchor: "indicators-anchor" },
  "content-map": { view: "home", anchor: "content-map-anchor" },
  diagnostic: { view: "history", anchor: "diagnostic-anchor", openDetails: true }
};

document.addEventListener("DOMContentLoaded", initApp);

function initApp() {
  state.filters = normalizeStoredFilters({ ...defaultFilters, ...loadLastConfig() });
  applyTheme(loadTheme());

  if (sessionStorage.getItem(STORAGE.unlocked) !== "1") {
    renderUnlock();
    return;
  }

  bootstrap();
}

async function bootstrap() {
  try {
    renderLoadingFullPage();
    state.manifest = await loadManifest();
    state.files = await loadQuestionFiles(state.manifest);
    const audit = auditAndNormalizeBank(state.manifest, state.files);
    state.rawQuestions = audit.rawQuestions;
    state.questions = audit.questions;
    state.questionById = new Map(state.questions.map((question) => [question.id, question]));
    state.validationWarnings = audit.warnings;
    state.contentTree = buildContentTree(state.questions);
    const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
    state.expandedGroups = new Set(isDesktop ? state.contentTree.map((group) => group.nome) : []);
    clampQuantityToAvailable();
    mountShell();
    navigateTo("home");
  } catch (error) {
    renderLoadErrorFullPage(error);
  }
}

async function loadManifest() {
  const response = await fetch(`${QUESTOES_PATH}manifest.json`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Não foi possível carregar o manifest.json (${response.status}).`);
  }
  return response.json();
}

async function loadQuestionFiles(manifest) {
  if (!manifest || !Array.isArray(manifest.questoes)) {
    throw new Error("Manifest inválido: lista de arquivos não encontrada.");
  }

  return Promise.all(
    manifest.questoes.map(async (item) => {
      const response = await fetch(`${QUESTOES_PATH}${item.arquivo}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Falha ao carregar ${item.arquivo} (${response.status}).`);
      }
      return {
        manifestItem: item,
        data: await response.json()
      };
    })
  );
}

function auditAndNormalizeBank(manifest, files) {
  const warnings = [];
  const normalized = [];
  const rawQuestions = [];
  const ids = new Set();
  const expectedFiles = manifest.total_arquivos || manifest.questoes.length;
  const expectedTotal = manifest.total_questoes_esperado || manifest.questoes.reduce((sum, item) => sum + (item.quantidade || 0), 0);

  if (files.length !== expectedFiles) {
    warnings.push(`Manifest informa ${expectedFiles} arquivos, mas ${files.length} foram carregados.`);
  }

  for (const file of files) {
    const { data, manifestItem } = file;
    const fileName = manifestItem?.arquivo || "arquivo desconhecido";
    const metadata = data?.metadata || {};
    const list = extractQuestionList(data);

    if (!manifestItem?.grupo && !metadata.grupo && !data?.assuntoGeral) {
      warnings.push(`${fileName}: grupo geral ausente; usando "Sem grupo".`);
    }
    if (!Array.isArray(list)) {
      warnings.push(`${fileName}: lista de questões ausente ou inválida.`);
      continue;
    }
    if (manifestItem?.quantidade && list.length !== manifestItem.quantidade) {
      warnings.push(`${fileName}: possui ${list.length} questões; manifest informa ${manifestItem.quantidade}.`);
    }

    for (const [index, raw] of list.entries()) {
      rawQuestions.push(raw);
      const question = normalizeQuestion(raw, data, manifestItem, index);
      const missing = validateNormalizedQuestion(question);
      if (missing.length) {
        warnings.push(`${fileName}: questão ${raw?.id || index + 1} ignorada (${missing.join(", ")}).`);
        continue;
      }
      if (ids.has(question.id)) {
        warnings.push(`${fileName}: id duplicado ${question.id}; questão ignorada.`);
        continue;
      }
      ids.add(question.id);
      normalized.push(question);
    }
  }

  if (normalized.length !== expectedTotal) {
    warnings.push(`Banco normalizado com ${normalized.length} questões; esperado pelo manifest: ${expectedTotal}.`);
  }

  return { warnings, questions: normalized, rawQuestions };
}

function extractQuestionList(data) {
  if (Array.isArray(data?.questoes)) return data.questoes;
  if (Array.isArray(data?.questions)) return data.questions;
  if (Array.isArray(data?.subassuntos)) {
    return data.subassuntos.flatMap((sub) =>
      (sub.questoes || sub.questions || []).map((question) => ({ ...question, subtema: question.subtema || sub.nome || sub.titulo }))
    );
  }
  return [];
}

function normalizeQuestion(raw, fileData, manifestItem, index) {
  const metadata = fileData?.metadata || {};
  const area = raw.area || fileData.area || metadata.area || "Taquigrafia";
  const assuntoGeral = raw.assuntoGeral || raw.grupo || metadata.grupo || manifestItem?.grupo || "Sem grupo";
  const subassunto = raw.subassunto || raw.assunto || metadata.titulo || manifestItem?.titulo || "Geral";
  const subtema = raw.subtema || raw.tema || "Geral";
  if (!raw.subtema) {
    console.warn(`Questão ${raw.id || `${manifestItem?.id || "sem-id"}-${index + 1}`} sem subtema; usando "Geral".`);
  }

  const alternativas = normalizeAlternatives(raw);

  return {
    id: String(raw.id || `${manifestItem?.id || "questao"}-${String(index + 1).padStart(3, "0")}`),
    area,
    assuntoGeral,
    subassunto,
    subtema,
    enunciado: raw.enunciado || raw.pergunta || raw.question || "",
    alternativas,
    explicacao: raw.explicacao || raw.explanation || "Explicação não informada.",
    fonte: raw.fonte || metadata.fonte_principal || "taquigrafia.pdf",
    raw
  };
}

function normalizeAlternatives(raw) {
  const correctId = String(raw.gabarito || raw.resposta || raw.correta || "").trim().toUpperCase();
  const source = raw.alternativas || raw.options || [];

  if (Array.isArray(source)) {
    return source.map((item, index) => {
      const id = String(item.id || item.letra || LETTERS[index] || String(index + 1)).toUpperCase();
      return {
        id,
        texto: String(item.texto || item.text || item.label || item),
        correta: Boolean(item.correta || item.correct || id === correctId)
      };
    });
  }

  return LETTERS.map((letter) => ({
    id: letter,
    texto: String(source?.[letter] || ""),
    correta: letter === correctId
  }));
}

function validateNormalizedQuestion(question) {
  const missing = [];
  if (!question.id) missing.push("id");
  if (!question.enunciado) missing.push("enunciado");
  if (!question.assuntoGeral) missing.push("assuntoGeral");
  if (!question.subassunto) missing.push("subassunto");
  if (!question.subtema) missing.push("subtema");
  if (!question.explicacao) missing.push("explicacao");
  if (!Array.isArray(question.alternativas) || question.alternativas.length < 2) missing.push("alternativas");
  if (question.alternativas.some((alt) => !alt.id || !alt.texto)) missing.push("alternativas completas");
  if (question.alternativas.filter((alt) => alt.correta).length !== 1) missing.push("uma alternativa correta");
  return [...new Set(missing)];
}

function buildContentTree(questions) {
  const groupMap = new Map();
  for (const question of questions) {
    if (!groupMap.has(question.assuntoGeral)) {
      groupMap.set(question.assuntoGeral, { nome: question.assuntoGeral, total: 0, assuntos: new Map() });
    }
    const group = groupMap.get(question.assuntoGeral);
    group.total += 1;
    if (!group.assuntos.has(question.subassunto)) {
      group.assuntos.set(question.subassunto, { nome: question.subassunto, total: 0, subtemas: new Map() });
    }
    const subject = group.assuntos.get(question.subassunto);
    subject.total += 1;
    subject.subtemas.set(question.subtema, (subject.subtemas.get(question.subtema) || 0) + 1);
  }

  return [...groupMap.values()]
    .sort((a, b) => groupSort(a.nome, b.nome))
    .map((group) => ({
      ...group,
      assuntos: [...group.assuntos.values()]
        .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
        .map((subject) => ({
          ...subject,
          subtemas: [...subject.subtemas.entries()]
            .map(([nome, total]) => ({ nome, total }))
            .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
        }))
    }));
}

function groupSort(a, b) {
  const ai = GROUP_ORDER.indexOf(a);
  const bi = GROUP_ORDER.indexOf(b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  return a.localeCompare(b, "pt-BR");
}

function renderUnlock(message = "") {
  app().innerHTML = `
    <main class="unlock">
      <section class="card unlock-card">
        <div class="unlock-brand">
          <span class="brand-mark" aria-hidden="true">${icon("shield")}</span>
          <h1>Simulador de Taquigrafia</h1>
          <p>Treine com inteligência. Evolua com consistência.</p>
        </div>
        <div class="unlock-divider" aria-hidden="true"><span></span></div>
        ${message ? `<div class="error-box" style="margin-bottom:14px">${escapeHtml(message)}</div>` : ""}
        <form class="unlock-form" onsubmit="unlockApp(event)" autocomplete="off">
          <label for="password">Insira sua senha:</label>
          <div class="input-wrap">
            <span class="input-icon" aria-hidden="true">${icon("lock")}</span>
            <input id="password" type="password" placeholder="Digite sua senha" autocomplete="current-password" autofocus>
            <button class="input-action" type="button" id="toggle-password" onclick="togglePasswordVisibility()" aria-label="Mostrar senha" title="Mostrar senha">${icon("eye")}</button>
          </div>
          <button class="btn btn-primary btn-lg unlock-submit" type="submit">
            <span>Entrar</span>${icon("arrowRight")}
          </button>
        </form>
        <div class="unlock-credit">
          <small>Desenvolvido por <strong>Marcos Duailibi</strong></small>
          <a href="https://wa.me/5595981114983" target="_blank" rel="noopener noreferrer" aria-label="Falar com Marcos Duailibi no WhatsApp">
            ${icon("whatsapp")}<span>+55 95 98111-4983</span>
          </a>
        </div>
      </section>
    </main>
  `;
}

/* ---------- Confirm modal + safe home navigation ---------- */

function isQuizInProgress() {
  const session = state.session;
  if (!session || !Array.isArray(session.questions) || !session.questions.length) return false;
  const lastIndex = session.questions.length - 1;
  const finished = session.index >= lastIndex && session.answered;
  return !finished;
}

function goHomeFromBrand() {
  if (isQuizInProgress()) {
    const session = state.session;
    openConfirmModal({
      title: "Sair do simulado em andamento?",
      message: `Você está na questão ${session.index + 1} de ${session.questions.length}. Se sair agora, o progresso desta sessão será descartado e não será salvo no histórico.`,
      confirmLabel: "Sair e voltar ao início",
      cancelLabel: "Continuar simulado",
      tone: "danger",
      onConfirm: () => {
        state.session = null;
        renderHome();
      }
    });
    return;
  }
  renderHome();
}

function openConfirmModal({ title, message, confirmLabel = "Confirmar", cancelLabel = "Cancelar", tone = "primary", onConfirm }) {
  const existing = document.getElementById("confirm-modal");
  if (existing) existing.remove();

  const confirmClass = tone === "danger" ? "btn btn-danger" : "btn btn-primary";
  const overlay = document.createElement("div");
  overlay.id = "confirm-modal";
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "confirm-modal-title");
  overlay.innerHTML = `
    <div class="modal modal-confirm" role="document">
      <header class="modal-head">
        <div class="confirm-title">
          <span class="confirm-icon" aria-hidden="true">${icon("alert")}</span>
          <h3 id="confirm-modal-title">${escapeHtml(title)}</h3>
        </div>
        <button class="modal-close-btn" type="button" aria-label="Fechar" onclick="closeConfirmModal()">${icon("x")}</button>
      </header>
      <div class="modal-body">
        <p>${escapeHtml(message)}</p>
      </div>
      <footer class="modal-foot">
        <button class="btn btn-ghost" type="button" onclick="closeConfirmModal()">${escapeHtml(cancelLabel)}</button>
        <button class="${confirmClass}" type="button" id="confirm-modal-ok">${escapeHtml(confirmLabel)}</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeConfirmModal();
  });
  document.addEventListener("keydown", handleConfirmModalKey);

  const okBtn = document.getElementById("confirm-modal-ok");
  okBtn?.addEventListener("click", () => {
    closeConfirmModal();
    if (typeof onConfirm === "function") onConfirm();
  });
  setTimeout(() => okBtn?.focus(), 30);
}

function handleConfirmModalKey(event) {
  if (event.key === "Escape") closeConfirmModal();
}

function closeConfirmModal() {
  const overlay = document.getElementById("confirm-modal");
  if (overlay) overlay.remove();
  document.body.style.overflow = "";
  document.removeEventListener("keydown", handleConfirmModalKey);
}

function togglePasswordVisibility() {
  const input = document.getElementById("password");
  const btn = document.getElementById("toggle-password");
  if (!input || !btn) return;
  const willShow = input.type === "password";
  input.type = willShow ? "text" : "password";
  btn.innerHTML = icon(willShow ? "eyeOff" : "eye");
  const label = willShow ? "Ocultar senha" : "Mostrar senha";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
  input.focus();
}

function unlockApp(event) {
  event.preventDefault();
  const input = document.getElementById("password");
  if (input?.value === PASSWORD) {
    sessionStorage.setItem(STORAGE.unlocked, "1");
    bootstrap();
  } else {
    renderUnlock("Senha incorreta.");
  }
}

function renderLoadingFullPage() {
  app().innerHTML = `
    <div class="full-page-state">
      <section class="card">
        <h2>${icon("clock")}Carregando banco</h2>
        <p class="muted">Lendo manifest, JSONs e normalizando questões.</p>
      </section>
    </div>
  `;
}

function renderLoadErrorFullPage(error) {
  app().innerHTML = `
    <div class="full-page-state">
      <section class="card">
        <h2>${icon("alert")}Não foi possível carregar o simulador</h2>
        <div class="error-box">${escapeHtml(error.message || String(error))}</div>
        <p class="muted" style="margin-top:12px">
          Rode <strong>python -m http.server 8000</strong> no diretório do projeto e acesse <strong>http://localhost:8000</strong>.
        </p>
      </section>
    </div>
  `;
}

/* ---------- Persistent shell ---------- */

function mountShell() {
  if (state.shellMounted) return;
  app().innerHTML = `
    <div class="app-layout">
      ${renderDesktopSidebar()}
      <div class="app-main">
        ${renderAppHeader()}
        <div class="main-scroll" id="main-scroll">
          <main id="view-root" class="view-root" aria-live="polite"></main>
          ${renderSiteFooter()}
        </div>
      </div>
    </div>
    ${renderMobileSidebar()}
    <div class="mobile-sidebar-overlay" id="mobile-sidebar-overlay" hidden></div>
    ${renderMobileBottomNav()}
    <div id="sticky-cta-mount" aria-hidden="true"></div>
    <div id="toast-stack" aria-live="polite" aria-atomic="false"></div>
  `;
  state.shellMounted = true;
  wireShellEvents();
}

function navigateTo(view) {
  if (!state.shellMounted) {
    bootstrap();
    return;
  }
  if (NAV_ANCHORS[view]) {
    const cfg = NAV_ANCHORS[view];
    navigateToAnchor(cfg.view, cfg.anchor, { open: cfg.openDetails, activeView: view });
    return;
  }
  state.currentView = view;
  state.notice = "";
  updateActiveNavState(view);
  updateHeaderCrumb(view);
  closeSidebar();
  const target = document.getElementById("view-root");
  if (!target) return;
  const scroller = document.getElementById("main-scroll");
  target.classList.add("view-fading");
  requestAnimationFrame(() => {
    target.innerHTML = renderViewBody(view);
    target.classList.remove("view-fading");
    if (scroller) scroller.scrollTop = 0;
    else window.scrollTo({ top: 0, behavior: "auto" });
    requestAnimationFrame(() => wireViewEvents(view));
  });
}

function renderViewBody(view) {
  switch (view) {
    case "home": return renderHomeView();
    case "history": return renderHistoryView();
    case "review": return renderReviewView();
    case "question": return renderQuestionView();
    case "result": return renderResultView(state.lastResult);
    default: return renderHomeView();
  }
}

function refreshHomeContent({ preserveScroll = true, activeView } = {}) {
  const target = document.getElementById("view-root");
  if (!target) {
    navigateTo(activeView || "home");
    return;
  }
  const scroller = document.getElementById("main-scroll");
  const currentScroll = scroller ? scroller.scrollTop : window.scrollY;
  const nextActiveView = activeView || (((NAV_TO_VIEW[state.currentView] || state.currentView) === "home") ? state.currentView : "home");

  state.currentView = nextActiveView;
  updateActiveNavState(nextActiveView);
  updateHeaderCrumb(nextActiveView);
  target.innerHTML = renderHomeView();

  requestAnimationFrame(() => {
    wireViewEvents("home");
    if (!preserveScroll) return;
    if (scroller) scroller.scrollTop = currentScroll;
    else window.scrollTo({ top: currentScroll, behavior: "auto" });
  });
}

function refreshTrainingConfig() {
  refreshHomeContent({ preserveScroll: true, activeView: "training" });
}

function navigateToAnchor(view, anchorId, opts = {}) {
  state.pendingAnchor = { id: anchorId, open: !!opts.open, activeView: opts.activeView || view };
  if (state.currentView !== view) {
    navigateTo(view);
    setTimeout(() => consumePendingAnchor(), 80);
  } else {
    consumePendingAnchor();
  }
}

function consumePendingAnchor() {
  const pending = state.pendingAnchor;
  if (!pending) return;
  state.pendingAnchor = null;
  state.currentView = pending.activeView;
  state.notice = "";
  updateActiveNavState(pending.activeView);
  updateHeaderCrumb(pending.activeView);
  closeSidebar();
  scrollToAnchor(pending.id, { open: pending.open });
}

function scrollToAnchor(id, { open = false } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  if (open && el.tagName === "DETAILS") el.open = true;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("anchor-highlight");
  setTimeout(() => el.classList.remove("anchor-highlight"), 1400);
}

function updateActiveNavState(view) {
  document.querySelectorAll("[data-nav-target]").forEach((btn) => {
    const active = btn.dataset.navTarget === view;
    btn.classList.toggle("is-active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
}

function wireShellEvents() {
  document.addEventListener("keydown", handleGlobalKey);
  const overlay = document.getElementById("mobile-sidebar-overlay");
  overlay?.addEventListener("click", closeSidebar);
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if ((NAV_TO_VIEW[state.currentView] || state.currentView) === "home") {
        if (window.matchMedia("(min-width: 1024px)").matches) teardownMobileStickyCTA();
        else wireMobileStickyCTA();
      }
    }, 250);
  });
}

function wireViewEvents(view) {
  if (view === "home") wireMobileStickyCTA();
  else teardownMobileStickyCTA();
}

function wireMobileStickyCTA() {
  teardownMobileStickyCTA();
  if (window.matchMedia("(min-width: 1024px)").matches) return;
  const mount = document.getElementById("sticky-cta-mount");
  const card = document.querySelector(".training-card");
  if (!mount || !card) return;
  mount.innerHTML = `
    <button class="sticky-cta" type="button" onclick="startQuiz()" aria-label="Iniciar treino">
      ${icon("play")}<span>Iniciar treino</span>
    </button>
  `;
  state.stickyCTAObserver = new IntersectionObserver(([entry]) => {
    mount.classList.toggle("is-visible", !entry.isIntersecting);
  }, { rootMargin: "-140px 0px 0px 0px", threshold: 0 });
  state.stickyCTAObserver.observe(card);
}

function teardownMobileStickyCTA() {
  if (state.stickyCTAObserver) {
    state.stickyCTAObserver.disconnect();
    state.stickyCTAObserver = null;
  }
  const mount = document.getElementById("sticky-cta-mount");
  if (mount) {
    mount.classList.remove("is-visible");
    mount.innerHTML = "";
  }
}

/* ---------- Mobile sidebar (drawer) ---------- */

function openSidebar() {
  const sidebar = document.getElementById("mobile-sidebar");
  const overlay = document.getElementById("mobile-sidebar-overlay");
  if (!sidebar || !overlay) return;
  state.sidebarLastFocus = document.activeElement;
  sidebar.classList.add("is-open");
  sidebar.removeAttribute("hidden");
  sidebar.setAttribute("aria-modal", "true");
  overlay.removeAttribute("hidden");
  overlay.classList.add("is-open");
  document.body.classList.add("has-sidebar-open");
  state.sidebarOpen = true;
  setTimeout(() => {
    const first = sidebar.querySelector("[data-sidebar-first]") || sidebar.querySelector("button, a");
    first?.focus();
  }, 50);
}

function closeSidebar() {
  const sidebar = document.getElementById("mobile-sidebar");
  const overlay = document.getElementById("mobile-sidebar-overlay");
  if (!sidebar || !overlay || !state.sidebarOpen) return;
  sidebar.classList.remove("is-open");
  sidebar.removeAttribute("aria-modal");
  overlay.classList.remove("is-open");
  document.body.classList.remove("has-sidebar-open");
  state.sidebarOpen = false;
  setTimeout(() => {
    if (!state.sidebarOpen) {
      sidebar.setAttribute("hidden", "");
      overlay.setAttribute("hidden", "");
    }
  }, 220);
  if (state.sidebarLastFocus && typeof state.sidebarLastFocus.focus === "function") {
    state.sidebarLastFocus.focus();
  }
}

function toggleSidebar() {
  if (state.sidebarOpen) closeSidebar();
  else openSidebar();
}

function handleGlobalKey(event) {
  if (event.key === "Escape" && state.sidebarOpen) {
    event.stopPropagation();
    closeSidebar();
  }
}

/* ---------- Shell components ---------- */

function navItems() {
  return [
    { view: "home", label: "Início", icon: "home" },
    { view: "training", label: "Treino", icon: "target" },
    { view: "review", label: "Revisão", icon: "refresh" },
    { view: "history", label: "Histórico", icon: "history" }
  ];
}

function sidebarShortcuts() {
  return [
    { view: "indicators", label: "Indicadores", icon: "barChart" },
    { view: "content-map", label: "Mapa de conteúdos", icon: "book" },
    { view: "diagnostic", label: "Diagnóstico local", icon: "sliders" }
  ];
}

function renderSidebarBrand() {
  return `
    <button class="sidebar-brand" type="button" onclick="goHomeFromBrand()" aria-label="Início">
      <span class="brand-mark" aria-hidden="true">${icon("shield")}</span>
      <span class="sidebar-brand-copy">
        <strong>Simulador de Taquigrafia</strong>
        <span>Treine com inteligência. Evolua com consistência.</span>
      </span>
    </button>
  `;
}

function renderSidebarNav(extraClass = "") {
  return `
    <nav class="sidebar-nav ${extraClass}" aria-label="Navegação principal">
      <span class="sidebar-section-title">Navegação</span>
      ${navItems().map((item) => `
        <button class="sidebar-nav-item" type="button" data-nav-target="${item.view}" onclick="navigateTo('${item.view}')">
          ${icon(item.icon)}<span>${escapeHtml(item.label)}</span>
        </button>
      `).join("")}
      <span class="sidebar-section-title">Atalhos</span>
      ${sidebarShortcuts().map((item) => `
        <button class="sidebar-nav-item" type="button" onclick="navigateTo('${item.view}')">
          ${icon(item.icon)}<span>${escapeHtml(item.label)}</span>
        </button>
      `).join("")}
    </nav>
  `;
}

function renderSidebarThemeToggle() {
  const isDark = document.documentElement.dataset.theme === "dark";
  return `
    <div class="sidebar-theme">
      <span class="sidebar-section-title">Tema</span>
      <div class="theme-segmented" role="group" aria-label="Alternar tema">
        <button class="theme-segment ${!isDark ? "is-active" : ""}" type="button" onclick="setTheme('light')" data-theme-segment="light">
          ${icon("sun")}<span>Claro</span>
        </button>
        <button class="theme-segment ${isDark ? "is-active" : ""}" type="button" onclick="setTheme('dark')" data-theme-segment="dark">
          ${icon("moon")}<span>Escuro</span>
        </button>
      </div>
    </div>
  `;
}

function renderSidebarActions() {
  return `
    <div class="sidebar-actions">
      <span class="sidebar-section-title">Ações</span>
      <button class="sidebar-action-btn" type="button" onclick="navigateTo('review')">${icon("refresh")}<span>Revisar erros</span></button>
      <button class="sidebar-action-btn" type="button" onclick="openUnifiedExportPopover(event)" aria-haspopup="menu" aria-expanded="false">${icon("swap")}<span>Exportar / Importar</span></button>
      <button class="sidebar-action-btn sidebar-action-danger" type="button" onclick="clearHistory()">${icon("trash")}<span>Limpar histórico</span></button>
    </div>
  `;
}

function renderDeveloperContactCard() {
  return `
    <a class="developer-contact-card" href="https://wa.me/5595981114983" target="_blank" rel="noopener noreferrer" aria-label="Falar com Marcos Duailibi no WhatsApp">
      <span class="developer-contact-icon" aria-hidden="true">${icon("whatsapp")}</span>
      <span class="developer-contact-text">
        <strong>Desenvolvido por Marcos Duailibi</strong>
        <span>+55 95 98111-4983</span>
      </span>
    </a>
  `;
}

function renderDesktopSidebar() {
  return `
    <aside class="desktop-sidebar" aria-label="Menu lateral">
      ${renderSidebarBrand()}
      ${renderSidebarNav()}
      ${renderSidebarActions()}
      ${renderSidebarThemeToggle()}
      ${renderDeveloperContactCard()}
    </aside>
  `;
}

function renderMobileSidebar() {
  return `
    <aside class="mobile-sidebar" id="mobile-sidebar" role="dialog" aria-labelledby="mobile-sidebar-title" hidden>
      <header class="mobile-sidebar-head">
        ${renderSidebarBrand()}
        <button class="modal-close-btn" type="button" onclick="closeSidebar()" aria-label="Fechar menu" data-sidebar-first>${icon("x")}</button>
      </header>
      <span id="mobile-sidebar-title" class="sr-only">Menu</span>
      ${renderSidebarNav("mobile-sidebar-nav")}
      ${renderSidebarActions()}
      ${renderSidebarThemeToggle()}
      ${renderDeveloperContactCard()}
    </aside>
  `;
}

function renderMobileTopbar() {
  return renderAppHeader();
}

function viewTitle(view) {
  const titles = {
    home: "Início",
    history: "Desempenho e histórico",
    review: "Revisão de erros",
    question: "Treino em andamento",
    result: "Resultados do treino",
    training: "Treino",
    indicators: "Indicadores",
    "content-map": "Mapa de conteúdos",
    diagnostic: "Diagnóstico local"
  };
  return titles[view] || "Início";
}

function renderAppHeader() {
  return `
    <header class="app-header" role="banner">
      <button class="icon-btn hamburger" type="button" onclick="openSidebar()" aria-label="Abrir menu">${icon("menu")}</button>
      <button class="header-brand" type="button" onclick="goHomeFromBrand()" aria-label="Início">
        <span class="header-brand-mark" aria-hidden="true">${icon("shield")}</span>
        <span class="header-title">
          <span class="crumb-prefix">Simulador</span>
          <span class="crumb-sep" aria-hidden="true">·</span>
          <span class="crumb-now" id="crumb-now">${escapeHtml(viewTitle(state.currentView || "home"))}</span>
        </span>
      </button>
      <div class="header-spacer"></div>
      <div class="header-actions-group">
        <button class="btn ghost header-export-btn" type="button" onclick="openUnifiedExportPopover(event)" aria-haspopup="menu" aria-expanded="false" title="Exportar / Importar">
          ${icon("swap")}<span class="header-export-label">Exportar / Importar</span>
        </button>
        <button class="icon-btn" type="button" onclick="toggleTheme()" data-theme-icon aria-label="${themeLabel()}" title="${themeLabel()}">${themeIcon()}</button>
      </div>
    </header>
  `;
}

function updateHeaderCrumb(view) {
  const el = document.getElementById("crumb-now");
  if (el) el.textContent = viewTitle(view);
}

function renderMobileBottomNav() {
  return `
    <nav class="mobile-bottom-nav" aria-label="Navegação rápida">
      ${navItems().map((item) => `
        <button type="button" data-nav-target="${item.view}" onclick="navigateTo('${item.view}')" aria-label="${escapeHtml(item.label)}">
          ${icon(item.icon)}<span>${escapeHtml(item.label)}</span>
        </button>
      `).join("")}
    </nav>
  `;
}

function renderSiteFooter() {
  const year = new Date().getFullYear();
  const totalQuestions = state.questions?.length || 0;
  const totalSubjects = unique((state.questions || []).map((q) => q.subassunto)).length;
  return `
    <footer class="site-footer">
      <div class="footer-row">
        <button class="footer-brand footer-brand-btn" type="button" onclick="goHomeFromBrand()" aria-label="Voltar ao início">
          <span class="brand-mark" aria-hidden="true">${icon("shield")}</span>
          <span class="footer-brand-copy">
            <strong>Simulador de Taquigrafia</strong>
            <span class="muted small">Treino com foco no concurso da ALE-RR.</span>
          </span>
        </button>
        <div class="footer-credits">
          <strong>Desenvolvido por Marcos Duailibi</strong>
          <a href="https://wa.me/5595981114983" target="_blank" rel="noopener noreferrer" aria-label="Falar com Marcos Duailibi no WhatsApp">
            ${icon("whatsapp")}<span>+55 95 98111-4983</span>
          </a>
        </div>
      </div>
      <p class="muted small">Simulador de questões para o cargo de Taquígrafo. Ferramenta de estudo independente. Banco local em JSON, histórico salvo apenas neste navegador.</p>
      <div class="footer-meta">
        <span>© ${year} Simulador de Taquigrafia</span>
        <span>${totalQuestions} questões · ${totalSubjects} assuntos</span>
      </div>
    </footer>
  `;
}

function renderHomeView() {
  clampQuantityToAvailable();
  const history = loadHistory();
  const wrongs = Object.values(loadWrongAnswers());
  const aggregate = calculateAggregateMetrics(history);
  const found = getFilteredQuestions({ applyQuantity: false }).length;
  const subjectsCount = unique(state.questions.map((q) => q.subassunto)).length;
  const canStart = canStartCurrentMode(found, wrongs.length);

  return `
    <div class="layout home-shell">
      <div class="home-stack">
      ${state.validationWarnings.length ? renderWarnings() : ""}
      ${state.notice ? `<section class="warning-box" aria-live="polite">${escapeHtml(state.notice)}</section>` : ""}
      <section class="home-greeting">
        <h1>Boa ${greetingPart()}!</h1>
        <p class="muted">Continue firme! Seu próximo avanço está a um treino de distância.</p>
      </section>
      <section class="dashboard-grid home-stats-grid" aria-label="Estatísticas gerais">
        ${metricCard(state.questions.length, "Questões carregadas", "file")}
        ${metricCard(subjectsCount, "Assuntos carregados", "book")}
        ${metricCard(history.length, "Tentativas salvas", "bookmark")}
        ${metricCard(wrongs.length, "Questões em revisão", "refresh")}
        ${metricCard(`${aggregate.percentual}%`, "Acerto acumulado", "target")}
      </section>
      <section class="home-main-grid">
        <div class="home-left-column">
          <section class="card training-card" id="training-anchor">
          <div class="section-heading">
            <div>
              <h2>${icon("target")}Configurar treino</h2>
              <p class="muted config-intro">Monte seu treino personalizado em poucos passos.</p>
            </div>
          </div>
          ${renderTrainingConfig(found, canStart)}
          </section>
        </div>
        <aside class="home-right-column" aria-label="Ações rápidas e indicadores">
          <section class="card quick-card">
          <h2>${icon("spark")}Ações rápidas</h2>
          ${renderQuickActions()}
          <div class="tip-card">
            <span class="tip-icon" aria-hidden="true">${icon("bulb")}</span>
            <div>
              <strong>Dica</strong>
              <span>Use os filtros para focar no que você mais precisa estudar.</span>
            </div>
          </div>
          ${renderActivityWidget()}
          <div id="indicators-anchor">${renderQuickIndicators()}</div>
          </section>
        </aside>
      </section>
      <section class="card content-map-section" id="content-map-anchor">
        <div class="section-heading">
          <div>
            <h2>${icon("book")}Mapa de conteúdos</h2>
            <p class="muted">Visualize todos os grupos, assuntos e quantidades disponíveis.</p>
          </div>
          <div class="actions compact-actions">
            <button class="btn btn-ghost" type="button" onclick="selectAllContent()">Selecionar todos</button>
            <button class="btn btn-ghost" type="button" onclick="clearContentSelection()">Limpar seleção</button>
          </div>
        </div>
        ${renderContentMap()}
      </section>
      </div>
    </div>
  `;
}

function greetingPart() {
  const h = new Date().getHours();
  if (h < 12) return "manhã";
  if (h < 18) return "tarde";
  return "noite";
}

/* ---------- Legacy nav aliases (compat) ---------- */
function renderHome() { navigateTo("home"); }
function renderHistory() { navigateTo("history"); }
function renderReviewMode() { navigateTo("review"); }

function renderTrainingConfig(found, canStart) {
  const wrongCount = Object.keys(loadWrongAnswers()).length;
  const reviewMode = state.filters.mode === "erros";
  const available = reviewMode ? wrongCount : found;
  return `
    <div class="mode-grid">
      ${modeButton("geral", "Simulado geral", "Todas as questões, com quantidade definida.")}
      ${modeButton("personalizado", "Treino personalizado", "Escolha grupos, assuntos e subtemas.")}
      ${modeButton("erros", "Revisão de erros", "Refaça questões que você errou.")}
    </div>
    ${renderTrainingAvailabilitySummary(available, reviewMode)}
    ${reviewMode ? renderReviewModeOptions(wrongCount) : renderFilterControls(found)}
    <div class="training-footer training-start-row">
      <button class="btn btn-primary btn-lg start-training-button primary-button" type="button" onclick="startQuiz()" ${canStart ? "" : "disabled"}>
        ${icon("play")}<span>Iniciar treino</span>
      </button>
    </div>
    ${renderStudyTips()}
  `;
}

function renderTrainingAvailabilitySummary(total, reviewMode) {
  const selected = total ? Math.min(Math.max(1, Number(state.filters.quantity) || 1), total) : 0;
  const text = reviewMode
    ? `questões erradas salvas. Você pode escolher até ${selected} para revisar.`
    : `questões encontradas com os filtros atuais. Treino configurado com ${selected}.`;
  return `
    <div class="count-pill training-count-summary ${total ? "" : "is-empty"}" aria-live="polite">
      ${icon(total ? "check" : "alert")}
      <strong>${total}</strong>
      <span>${total ? text : reviewMode ? "Nenhuma questão errada salva para revisar." : "Nenhuma questão encontrada com os filtros atuais."}</span>
    </div>
  `;
}

function renderStudyTips() {
  const tips = [
    {
      iconName: "refresh",
      title: "Revise no mesmo dia",
      text: "Volte às questões erradas logo após o treino e releia a explicação antes de refazer."
    },
    {
      iconName: "target",
      title: "Separe por subtema",
      text: "Se errar muitas questões parecidas, treine apenas aquele subtema por alguns minutos."
    },
    {
      iconName: "book",
      title: "Compare alternativas",
      text: "Ao revisar, identifique por que a correta é melhor e por que as demais não servem."
    },
    {
      iconName: "bulb",
      title: "Faça ciclos curtos",
      text: "Use blocos de 20 a 30 questões para manter atenção e acompanhar evolução real."
    }
  ];

  return `
    <section class="study-tips-panel" aria-label="Dicas de estudo">
      <div class="study-tips-head">
        <span class="study-tips-icon" aria-hidden="true">${icon("bulb")}</span>
        <div>
          <h3>Dicas de estudo e revisão</h3>
          <p>Preencha o treino com uma rotina simples de correção e reforço.</p>
        </div>
      </div>
      <div class="study-tips-grid">
        ${tips.map((tip) => `
          <article class="study-tip">
            <span class="study-tip-icon" aria-hidden="true">${icon(tip.iconName)}</span>
            <div>
              <strong>${escapeHtml(tip.title)}</strong>
              <span>${escapeHtml(tip.text)}</span>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function modeButton(mode, label, description) {
  const active = state.filters.mode === mode ? "is-active" : "";
  const icons = { geral: "file", personalizado: "sliders", erros: "alert" };
  const tone = { geral: "", personalizado: "tone-sliders", erros: "tone-alert" }[mode] || "";
  return `
    <button class="mode-card ${active}" type="button" onclick="setMode('${mode}')">
      <span class="mode-icon ${tone}" aria-hidden="true">${icon(icons[mode] || "target")}</span>
      <span>
        <strong>${escapeHtml(label)}</strong>
        <span class="mode-sub">${escapeHtml(description)}</span>
      </span>
      <span class="mode-radio" aria-hidden="true"></span>
    </button>
  `;
}

function renderFilterControls(found) {
  const availableSubjects = getAvailableSubjects();
  const availableSubthemes = getAvailableSubthemes();
  const groupsCount = state.filters.selectedGroups.length;
  const subjectsCount = state.filters.selectedSubjects.length;
  const subthemesCount = state.filters.selectedSubthemes.length;
  const max = Math.max(1, found);
  const quantity = Math.min(state.filters.quantity, max);
  return `
    <div class="filter-block">
      <div class="filter-heading">
        <h3>1. Grupo geral</h3>
        <span>${groupsCount || "Todos"}</span>
      </div>
      <div class="chip-grid">
        ${state.contentTree.map((group) => bigChip(group.nome, group.total, "group")).join("")}
      </div>
    </div>
    <div class="filter-block">
      <div class="filter-heading">
        <h3>2. Assuntos</h3>
        <span>${subjectsCount || "Todos"}</span>
      </div>
      <div class="chip-grid">
        ${availableSubjects.map((subject) => bigChip(subject.nome, subject.total, "subject")).join("")}
      </div>
    </div>
    <div class="filter-block">
      <div class="filter-heading">
        <h3>3. Subtemas</h3>
        <span>${subthemesCount || "Todos"}</span>
      </div>
      ${renderSubthemePreview(availableSubthemes)}
    </div>
    <div class="settings-row training-options-row">
      ${renderQuantityControl(max, quantity, "Quantidade de questões")}
      ${renderShuffleControl()}
    </div>
    ${found && state.filters.quantity > found ? `<div class="warning-box" style="margin-top:12px">A quantidade foi limitada ao total encontrado pelos filtros.</div>` : ""}
  `;
}

function renderReviewModeOptions(wrongCount) {
  const max = Math.max(1, wrongCount);
  const quantity = wrongCount ? Math.min(state.filters.quantity || 1, wrongCount) : 0;
  return `
    ${renderReviewSummary(wrongCount)}
    <div class="settings-row training-options-row review-options-row">
      ${renderQuantityControl(max, quantity, "Quantidade para revisar", wrongCount === 0)}
      ${renderShuffleControl(wrongCount === 0)}
    </div>
  `;
}

function renderQuantityControl(max, quantity, label, disabled = false) {
  return `
    <div class="field quantity-control">
      <label class="field-label" for="quantity">${escapeHtml(label)}</label>
      <div class="stepper ${disabled ? "is-disabled" : ""}">
        <button type="button" onclick="adjustQuantity(-1)" aria-label="Diminuir" ${disabled ? "disabled" : ""}>−</button>
        <input id="quantity" type="number" min="1" max="${max}" value="${quantity}" onchange="setQuantity(this.value)" ${disabled ? "disabled" : ""}>
        <button type="button" onclick="adjustQuantity(1)" aria-label="Aumentar" ${disabled ? "disabled" : ""}>+</button>
      </div>
    </div>
  `;
}

function renderShuffleControl(disabled = false) {
  return `
    <div class="toggle-row shuffle-option-card ${disabled ? "is-disabled" : ""}">
      <div class="toggle-copy">
        <strong>Embaralhar questões</strong>
        <span>Exibe as questões em ordem aleatória.</span>
      </div>
      <button class="switch ${state.filters.shuffleQuestions ? "is-on" : ""}" type="button" role="switch" aria-checked="${state.filters.shuffleQuestions}" aria-label="Embaralhar questões" onclick="setShuffleQuestions(${!state.filters.shuffleQuestions})" ${disabled ? "disabled" : ""}></button>
    </div>
  `;
}

function renderReviewSummary(wrongCount) {
  return `
    <div class="review-summary-box ${wrongCount ? "success-box" : "warning-box"}">
      ${wrongCount ? `Você tem ${wrongCount} questões erradas salvas para revisar.` : "Ainda não há questões erradas salvas."}
    </div>
  `;
}

function renderQuickActions() {
  return `
    <div class="quick-actions">
      <button class="btn btn-primary" type="button" onclick="quickGeneral()">${icon("play")}<span>Iniciar simulado geral</span></button>
      <button class="btn btn-secondary" type="button" onclick="renderReviewMode()">${icon("refresh")}<span>Revisar erros</span></button>
      <button class="btn btn-secondary" type="button" onclick="renderHistory()">${icon("history")}<span>Ver histórico</span></button>
      ${renderExportMenu("quick")}
      <button class="btn btn-danger" type="button" onclick="clearWrongAnswers()">${icon("trash")}<span>Limpar erros</span></button>
      <button class="btn btn-danger" type="button" onclick="clearHistory()">${icon("trash")}<span>Limpar histórico</span></button>
    </div>
  `;
}

function renderContentMap() {
  return `
    <div class="content-map">
      ${state.contentTree.map((group) => {
        const expanded = state.expandedGroups.has(group.nome);
        return `
          <article class="content-group">
            <button class="group-toggle" type="button" aria-expanded="${expanded}" onclick="toggleGroupExpansion('${escapeAttr(group.nome)}')">
              <span class="group-icon" aria-hidden="true">${icon("book")}</span>
              <span class="group-copy">
                <strong>${escapeHtml(group.nome)}</strong>
                <span>${group.total} questões</span>
              </span>
              <span class="group-chev" aria-hidden="true">${icon("chevronDown")}</span>
            </button>
            ${expanded ? `
              <div class="subject-list">
                ${group.assuntos.map((subject) => `
                  <button class="subject-row" type="button" onclick="toggleFilter('subject', '${escapeAttr(subject.nome)}')" title="Filtrar por ${escapeAttr(subject.nome)}">
                    <strong>${escapeHtml(subject.nome)}</strong>
                    <span>${subject.total}</span>
                  </button>
                `).join("")}
              </div>
              ${renderSelectedSubthemesForGroup(group)}
            ` : ""}
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderSelectedSubthemesForGroup(group) {
  const selectedSubjects = group.assuntos.filter((subject) => state.filters.selectedSubjects.includes(subject.nome));
  if (!selectedSubjects.length) return "";
  return `
    <div class="subject-list" style="border-top:1px solid var(--line);">
      ${selectedSubjects.map((subject) => `
        <div>
          <strong style="display:block;margin:6px 12px;color:var(--muted);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.06em;">${escapeHtml(subject.nome)}</strong>
          <div class="chip-grid subtheme-grid">
            ${subject.subtemas.map((subtheme) => checkChip(subtheme.nome, subtheme.total, "subtheme")).join("")}
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function chipButton(value, label, type) {
  const active = isSelected(type, value) ? "is-active" : "";
  return `<button class="chip ${active}" type="button" onclick="toggleFilter('${type}', '${escapeAttr(value)}')">${escapeHtml(label)}</button>`;
}

function bigChip(value, count, type) {
  const active = isSelected(type, value) ? "is-active" : "";
  return `
    <button class="chip ${active}" type="button" onclick="toggleFilter('${type}', '${escapeAttr(value)}')">
      <span>${escapeHtml(value)}</span>
      <span class="chip-count">${count}</span>
    </button>
  `;
}

function checkChip(value, count, type) {
  const active = isSelected(type, value) ? "is-active" : "";
  return `
    <button class="chip chip-check ${active}" type="button" onclick="toggleFilter('${type}', '${escapeAttr(value)}')" aria-pressed="${active ? "true" : "false"}">
      <span class="chip-box" aria-hidden="true">${icon("check")}</span>
      <span class="chip-body">
        <span>${escapeHtml(value)}</span>
        <span class="chip-count">(${count})</span>
      </span>
    </button>
  `;
}

function adjustQuantity(delta) {
  const available = getFilteredQuestions({ applyQuantity: false }).length;
  if (!available) {
    refreshTrainingConfig();
    return;
  }
  const max = Math.max(1, available);
  const next = Math.max(1, Math.min(max, (Number(state.filters.quantity) || 1) + delta));
  state.filters.quantity = next;
  saveLastConfig();
  refreshTrainingConfig();
}

/* ---------- Subtemas: preview + modal ---------- */
const SUBTHEME_PREVIEW_LIMIT = 12;

function renderSubthemePreview(availableSubthemes) {
  if (!availableSubthemes.length) {
    return `<span class="muted small">Nenhum subtema disponível com os filtros atuais.</span>`;
  }
  const totalAvailable = availableSubthemes.length;
  const selected = state.filters.selectedSubthemes;
  const visible = pickPreviewSubthemes(availableSubthemes, selected, SUBTHEME_PREVIEW_LIMIT);
  const visibleNames = new Set(visible.map((s) => s.nome));
  const hiddenSelected = selected.filter((s) => !visibleNames.has(s)).length;
  const allTotal = getAllSubthemes().length;
  return `
    <div class="chip-grid subtheme-grid">
      ${visible.map((subtheme) => checkChip(subtheme.nome, subtheme.total, "subtheme")).join("")}
    </div>
    <button class="see-more-btn" type="button" onclick="openSubthemeModal()">
      ${icon("sliders")}
      <span>${hiddenSelected ? `+${hiddenSelected} selecionado${hiddenSelected > 1 ? "s" : ""} · ` : ""}Ver todos os subtemas (${allTotal})</span>
    </button>
    ${totalAvailable > SUBTHEME_PREVIEW_LIMIT && !hiddenSelected
      ? `<span class="muted small">Mostrando ${visible.length} de ${totalAvailable} subtemas disponíveis. Use o botão acima para buscar.</span>`
      : ""}
  `;
}

function pickPreviewSubthemes(available, selected, limit) {
  const selectedSet = new Set(selected);
  const inSelection = available.filter((s) => selectedSet.has(s.nome));
  const rest = available
    .filter((s) => !selectedSet.has(s.nome))
    .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, "pt-BR"));
  return [...inSelection, ...rest].slice(0, limit);
}

function getAllSubthemes() {
  const map = new Map();
  for (const question of state.questions) {
    map.set(question.subtema, (map.get(question.subtema) || 0) + 1);
  }
  return [...map.entries()]
    .map(([nome, total]) => ({ nome, total }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

function getSubthemesGroupedBySubject() {
  const groups = new Map();
  for (const question of state.questions) {
    if (!groups.has(question.subassunto)) groups.set(question.subassunto, new Map());
    const sub = groups.get(question.subassunto);
    sub.set(question.subtema, (sub.get(question.subtema) || 0) + 1);
  }
  return [...groups.entries()]
    .map(([subject, subthemes]) => ({
      subject,
      subthemes: [...subthemes.entries()]
        .map(([nome, total]) => ({ nome, total }))
        .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject, "pt-BR"));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function openSubthemeModal() {
  const existing = document.getElementById("subtheme-modal");
  if (existing) existing.remove();

  if (state.filters.mode === "geral") state.filters.mode = "personalizado";

  const overlay = document.createElement("div");
  overlay.id = "subtheme-modal";
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "subtheme-modal-title");
  overlay.innerHTML = `
    <div class="modal" role="document">
      <header class="modal-head">
        <div>
          <h3 id="subtheme-modal-title">Selecionar subtemas</h3>
          <div class="modal-counter" id="subtheme-modal-counter">${state.filters.selectedSubthemes.length} selecionado${state.filters.selectedSubthemes.length === 1 ? "" : "s"}</div>
        </div>
        <button class="modal-close-btn" type="button" aria-label="Fechar" onclick="closeSubthemeModal()">${icon("x")}</button>
      </header>
      <div class="modal-body">
        <input id="subtheme-search" class="modal-search" type="search" placeholder="Buscar subtema..." autocomplete="off" oninput="filterSubthemes(this.value)">
        <div id="subtheme-modal-list"></div>
      </div>
      <footer class="modal-foot">
        <button class="btn btn-ghost" type="button" onclick="clearSubthemeSelection()">${icon("trash")}<span>Limpar seleção</span></button>
        <button class="btn btn-primary" type="button" onclick="closeSubthemeModal()">${icon("check")}<span>Aplicar</span></button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeSubthemeModal();
  });
  document.addEventListener("keydown", handleSubthemeModalKey);

  renderSubthemeModalList("");
  setTimeout(() => document.getElementById("subtheme-search")?.focus(), 30);
}

function handleSubthemeModalKey(event) {
  if (event.key === "Escape") closeSubthemeModal();
}

function closeSubthemeModal() {
  const overlay = document.getElementById("subtheme-modal");
  if (overlay) overlay.remove();
  document.body.style.overflow = "";
  document.removeEventListener("keydown", handleSubthemeModalKey);
  saveLastConfig();
  clampQuantityToAvailable();
  refreshTrainingConfig();
}

function filterSubthemes(query) {
  renderSubthemeModalList(query);
}

function renderSubthemeModalList(query) {
  const target = document.getElementById("subtheme-modal-list");
  if (!target) return;
  const needle = normalizeText(query);
  const groups = getSubthemesGroupedBySubject();
  const html = groups.map((group) => {
    const items = group.subthemes.filter((s) => !needle || normalizeText(s.nome).includes(needle));
    if (!items.length) return "";
    return `
      <section class="subtheme-group">
        <h4>${escapeHtml(group.subject)} <span class="muted">· ${items.length}</span></h4>
        <div class="chip-grid subtheme-grid">
          ${items.map((s) => checkChip(s.nome, s.total, "subtheme")).join("")}
        </div>
      </section>
    `;
  }).filter(Boolean).join("");
  target.innerHTML = html || `<p class="muted">Nenhum subtema encontrado para "${escapeHtml(query)}".</p>`;
}

function clearSubthemeSelection() {
  state.filters.selectedSubthemes = [];
  saveLastConfig();
  updateSubthemeModalCounter();
  renderSubthemeModalList(document.getElementById("subtheme-search")?.value || "");
}

function updateSubthemeModalCounter() {
  const counter = document.getElementById("subtheme-modal-counter");
  if (!counter) return;
  const n = state.filters.selectedSubthemes.length;
  counter.textContent = `${n} selecionado${n === 1 ? "" : "s"}`;
}

function isSelected(type, value) {
  const key = type === "group" ? "selectedGroups" : type === "subject" ? "selectedSubjects" : "selectedSubthemes";
  return state.filters[key].includes(value);
}

function toggleFilter(type, value) {
  if (state.filters.mode === "geral") state.filters.mode = "personalizado";
  const key = type === "group" ? "selectedGroups" : type === "subject" ? "selectedSubjects" : "selectedSubthemes";
  toggleInArray(state.filters[key], value);
  reconcileFilters();
  clampQuantityToAvailable();
  saveLastConfig();
  state.notice = "";

  const modalOpen = document.getElementById("subtheme-modal");
  if (modalOpen && type === "subtheme") {
    updateSubthemeModalCounter();
    renderSubthemeModalList(document.getElementById("subtheme-search")?.value || "");
    return;
  }

  if (state.filters.mode === "erros") {
    if (state.currentView === "review") renderReviewMode();
    else refreshTrainingConfig();
    return;
  }
  refreshTrainingConfig();
}

function toggleGroupExpansion(groupName) {
  if (state.expandedGroups.has(groupName)) state.expandedGroups.delete(groupName);
  else state.expandedGroups.add(groupName);
  refreshHomeContent({ preserveScroll: true });
}

function setMode(mode) {
  state.filters.mode = mode;
  if (mode === "geral" || mode === "erros") {
    state.filters.selectedGroups = [];
    state.filters.selectedSubjects = [];
    state.filters.selectedSubthemes = [];
  }
  reconcileFilters();
  clampQuantityToAvailable();
  saveLastConfig();
  state.notice = "";
  showTrainingModeHint(mode);
  refreshTrainingConfig();
}

function showTrainingModeHint(mode) {
  const labels = {
    geral: "Simulado geral",
    personalizado: "Treino personalizado",
    erros: "Revisão de erros"
  };
  showToast(`${labels[mode] || "Modo"} selecionado. Role um pouco para ajustar a quantidade antes de iniciar.`, "info", 2600);
}

function setQuantity(value) {
  const available = getFilteredQuestions({ applyQuantity: false }).length;
  const next = Math.max(1, Math.floor(Number(value) || 1));
  state.filters.quantity = available ? Math.min(next, available) : next;
  saveLastConfig();
  refreshTrainingConfig();
}

function setShuffleQuestions(value) {
  state.filters.shuffleQuestions = Boolean(value);
  saveLastConfig();
  refreshTrainingConfig();
}

function selectAllContent() {
  state.filters.mode = "personalizado";
  state.filters.selectedGroups = state.contentTree.map((group) => group.nome);
  state.filters.selectedSubjects = state.contentTree.flatMap((group) => group.assuntos.map((subject) => subject.nome));
  state.filters.selectedSubthemes = [];
  clampQuantityToAvailable();
  saveLastConfig();
  refreshHomeContent({ preserveScroll: true });
}

function clearContentSelection() {
  state.filters.selectedGroups = [];
  state.filters.selectedSubjects = [];
  state.filters.selectedSubthemes = [];
  if (state.filters.mode === "personalizado") state.filters.mode = "geral";
  clampQuantityToAvailable();
  saveLastConfig();
  refreshHomeContent({ preserveScroll: true });
}

function quickGeneral() {
  state.filters.mode = "geral";
  state.filters.selectedGroups = [];
  state.filters.selectedSubjects = [];
  state.filters.selectedSubthemes = [];
  clampQuantityToAvailable();
  startQuiz();
}

function getAvailableSubjects() {
  const selectedGroups = state.filters.selectedGroups;
  return state.contentTree
    .filter((group) => !selectedGroups.length || selectedGroups.includes(group.nome))
    .flatMap((group) => group.assuntos);
}

function getAvailableSubthemes() {
  const selectedGroups = state.filters.selectedGroups;
  const selectedSubjects = state.filters.selectedSubjects;
  const map = new Map();
  for (const question of state.questions) {
    if (selectedGroups.length && !selectedGroups.includes(question.assuntoGeral)) continue;
    if (selectedSubjects.length && !selectedSubjects.includes(question.subassunto)) continue;
    map.set(question.subtema, (map.get(question.subtema) || 0) + 1);
  }
  return [...map.entries()].map(([nome, total]) => ({ nome, total })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

function getFilteredQuestions({ applyQuantity = true } = {}) {
  let questions = [];
  if (state.filters.mode === "erros") {
    questions = Object.keys(loadWrongAnswers()).map((id) => state.questionById.get(id)).filter(Boolean);
    if (state.filters.selectedGroups.length) {
      questions = questions.filter((question) => state.filters.selectedGroups.includes(question.assuntoGeral));
    }
    if (state.filters.selectedSubjects.length) {
      questions = questions.filter((question) => state.filters.selectedSubjects.includes(question.subassunto));
    }
    if (state.filters.selectedSubthemes.length) {
      questions = questions.filter((question) => state.filters.selectedSubthemes.includes(question.subtema));
    }
  } else {
    questions = [...state.questions];
    if (state.filters.mode === "personalizado") {
      if (state.filters.selectedGroups.length) {
        questions = questions.filter((question) => state.filters.selectedGroups.includes(question.assuntoGeral));
      }
      if (state.filters.selectedSubjects.length) {
        questions = questions.filter((question) => state.filters.selectedSubjects.includes(question.subassunto));
      }
      if (state.filters.selectedSubthemes.length) {
        questions = questions.filter((question) => state.filters.selectedSubthemes.includes(question.subtema));
      }
    }
  }

  if (state.filters.shuffleQuestions) questions = shuffleArray(questions);
  if (applyQuantity) {
    questions = questions.slice(0, Math.min(state.filters.quantity, questions.length));
  }
  return questions;
}

function canStartCurrentMode(found, wrongCount) {
  if (state.filters.mode === "erros") return found > 0 && wrongCount > 0;
  return found > 0 && state.filters.quantity > 0;
}

function clampQuantityToAvailable() {
  const found = getFilteredQuestions({ applyQuantity: false }).length;
  if (found > 0 && state.filters.quantity > found) {
    state.filters.quantity = found;
  }
}

function reconcileFilters() {
  const availableSubjects = new Set(getAvailableSubjects().map((subject) => subject.nome));
  state.filters.selectedSubjects = state.filters.selectedSubjects.filter((subject) => availableSubjects.has(subject));
  const availableSubthemes = new Set(getAvailableSubthemes().map((subtheme) => subtheme.nome));
  state.filters.selectedSubthemes = state.filters.selectedSubthemes.filter((subtheme) => availableSubthemes.has(subtheme));
}

function startQuiz() {
  state.notice = "";
  clampQuantityToAvailable();
  const candidates = getFilteredQuestions({ applyQuantity: true });
  if (!candidates.length) {
    state.notice = state.filters.mode === "erros"
      ? "Não há questões erradas salvas para revisar."
      : "Nenhuma questão encontrada com os filtros atuais.";
    if (state.currentView === "review") renderReviewMode();
    else refreshTrainingConfig();
    return;
  }

  state.session = {
    id: `sessao-${Date.now()}`,
    mode: state.filters.mode,
    filters: snapshotFilters(candidates),
    questions: candidates,
    index: 0,
    answers: [],
    selected: "",
    answered: false,
    startedAt: Date.now(),
    questionStartedAt: Date.now()
  };
  saveLastConfig();
  renderQuestion();
}

function renderQuestion() {
  navigateTo("question");
}

function renderQuestionView() {
  const session = state.session;
  if (!session) return renderHomeView();
  const question = session.questions[session.index];
  const progress = Math.round(((session.index + 1) / session.questions.length) * 100);
  const answer = session.answers.find((item) => item.questionId === question.id);
  const saved = isSaved(question.id);
  const wrongInfo = loadWrongAnswers()[question.id];

  return `
    <div class="layout">
      <section class="card question-card">
        <div class="quiz-topline">
          <div class="quiz-title">
            <strong>Questão ${session.index + 1} de ${session.questions.length}</strong>
            <span>${escapeHtml(modeLabel(session.mode))}</span>
          </div>
          <div class="progress-shell" aria-label="Progresso"><div class="progress-bar" style="width:${progress}%"></div></div>
          <span class="timer-pill">${icon("clock")}${escapeHtml(formatDuration(Date.now() - session.startedAt))}</span>
        </div>
        <div class="pill-row">
          <span class="pill">${icon("book")}${escapeHtml(question.assuntoGeral)}</span>
          <span class="pill">${icon("file")}${escapeHtml(question.subassunto)}</span>
          <span class="pill">${icon("bookmark")}${escapeHtml(question.subtema)}</span>
        </div>
        ${wrongInfo ? `<div class="warning-box">Última resposta errada salva: ${escapeHtml(wrongInfo.lastAnswer || "-")}.</div>` : ""}
        <h2 class="question-title">${escapeHtml(question.enunciado)}</h2>
        <div class="options">
          ${question.alternativas.map((alt) => renderOption(question, alt, session, answer)).join("")}
        </div>
        <div id="answer-feedback" aria-live="polite">
          ${session.answered ? renderExplanation(question, answer) : ""}
        </div>
        <div class="question-actions">
          <button class="btn btn-ghost" type="button" onclick="toggleSavedQuestion('${escapeAttr(question.id)}')">${icon("bookmark")}<span>${saved ? "Remover marcação" : "Marcar para revisão"}</span></button>
          <div class="right-actions">
            ${session.index > 0 ? `<button class="btn btn-ghost" type="button" onclick="previousQuestion()">${icon("arrowLeft")}<span>Anterior</span></button>` : ""}
            ${session.answered
              ? `<button class="btn btn-primary" type="button" onclick="nextQuestion()">${session.index + 1 === session.questions.length ? "Finalizar" : "Próxima questão"}${icon("arrowRight")}</button>`
              : `<button class="btn btn-primary" type="button" onclick="submitAnswer()">Responder</button>`}
            <button class="btn btn-secondary" type="button" onclick="finishQuiz()">Finalizar</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderOption(question, alternative, session, answer) {
  const selected = session.selected === alternative.id;
  const correct = session.answered && alternative.correta;
  const wrong = session.answered && answer?.selected === alternative.id && !alternative.correta;
  const status = correct ? "Correta" : wrong ? "Sua resposta" : "";
  const className = [
    "option",
    selected && !session.answered ? "option-selected" : "",
    correct ? "option-correct" : "",
    wrong ? "option-wrong" : ""
  ].filter(Boolean).join(" ");

  return `
    <button class="${className}" type="button" onclick="selectAlternative('${escapeAttr(alternative.id)}')" ${session.answered ? "disabled" : ""}>
      <span class="option-letter">${escapeHtml(alternative.id)}</span>
      <span class="option-text">${escapeHtml(alternative.texto)}</span>
      ${status ? `<span class="option-status">${correct ? icon("check") : icon("x")}${escapeHtml(status)}</span>` : `<span></span>`}
    </button>
  `;
}

function selectAlternative(id) {
  if (!state.session || state.session.answered) return;
  state.session.selected = id;
  state.notice = "";
  renderQuestion();
}

function submitAnswer() {
  const session = state.session;
  if (!session || session.answered) return;
  const question = session.questions[session.index];
  if (!session.selected) {
    state.notice = "Selecione uma alternativa antes de responder.";
    renderQuestion();
    return;
  }

  const selectedAlternative = question.alternativas.find((alt) => alt.id === session.selected);
  const correctAlternative = question.alternativas.find((alt) => alt.correta);
  const correct = Boolean(selectedAlternative?.correta);
  const answer = {
    questionId: question.id,
    area: question.area,
    assuntoGeral: question.assuntoGeral,
    subassunto: question.subassunto,
    subtema: question.subtema,
    selected: selectedAlternative?.id || "",
    selectedText: selectedAlternative?.texto || "",
    correctId: correctAlternative?.id || "",
    correctText: correctAlternative?.texto || "",
    correct,
    timeMs: Date.now() - session.questionStartedAt
  };

  session.answers.push(answer);
  session.answered = true;
  if (!correct) saveWrongAnswer(question, answer);
  else removeWrongAnswer(question.id);
  renderQuestion();
}

function renderExplanation(question, answer) {
  const ok = answer?.correct;
  const split = splitExplanation(question.explicacao || "");
  return `
    <span class="feedback-banner ${ok ? "ok" : "bad"}" role="status">
      ${ok ? icon("check") : icon("x")}
      ${ok ? "Resposta correta!" : `Resposta incorreta. Correta: ${escapeHtml(answer.correctId)}.`}
    </span>
    <div class="explanation-card">
      <h3>${icon("bulb")}Explicação</h3>
      <div class="explanation-grid">
        <div class="explanation-block ok">
          <strong>${icon("check")}Por que a correta está certa</strong>
          <p>${escapeHtml(split.correct)}</p>
        </div>
        ${split.others ? `
          <div class="explanation-block bad">
            <strong>${icon("x")}Por que as outras estão erradas</strong>
            <p>${escapeHtml(split.others)}</p>
          </div>
        ` : ""}
      </div>
    </div>
  `;
}

function splitExplanation(text) {
  if (!text) return { correct: "Explicação não informada.", others: "" };
  const markers = [
    /\bAs demais alternativas[^.]*\./i,
    /\bAs outras alternativas[^.]*\./i,
    /\bDemais alternativas[^.]*\./i
  ];
  for (const marker of markers) {
    const match = text.match(marker);
    if (match && match.index > 0) {
      const correct = text.slice(0, match.index).trim();
      const others = text.slice(match.index).trim();
      return { correct, others };
    }
  }
  return { correct: text, others: "" };
}

function nextQuestion() {
  const session = state.session;
  if (!session) return;
  if (session.index + 1 >= session.questions.length) return finishQuiz();
  session.index += 1;
  session.selected = "";
  session.answered = false;
  session.questionStartedAt = Date.now();
  renderQuestion();
}

function previousQuestion() {
  const session = state.session;
  if (!session || session.index <= 0) return;
  session.index -= 1;
  const prev = session.questions[session.index];
  const prevAnswer = session.answers.find((item) => item.questionId === prev.id);
  if (prevAnswer) {
    session.answered = true;
    session.selected = prevAnswer.selected;
  } else {
    session.answered = false;
    session.selected = "";
  }
  session.questionStartedAt = Date.now();
  renderQuestion();
}

function finishQuiz() {
  const session = state.session;
  if (!session) return renderHome();
  const durationMs = Date.now() - session.startedAt;
  const metrics = calculateMetrics(session.answers, durationMs);
  const entry = {
    id: session.id,
    date: new Date().toISOString(),
    mode: session.mode,
    filters: session.filters,
    durationMs,
    metrics,
    answers: session.answers
  };
  if (session.answers.length) saveHistory(entry);
  state.session = null;
  renderResult(entry);
}

function renderResult(entry) {
  state.lastResult = entry;
  navigateTo("result");
}

function renderResultView(entry) {
  if (!entry) return renderHomeView();
  const metrics = entry.metrics;
  const errors = entry.answers.filter((answer) => !answer.correct);
  const tone = metrics.percentual >= 70 ? "success" : metrics.percentual >= 50 ? "warning" : "danger";
  const message = metrics.percentual >= 80 ? "Ótimo trabalho!" : metrics.percentual >= 60 ? "Bom desempenho." : "Hora de revisar.";
  return `
    <div class="layout">
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>${icon("target")}Resultados do treino</h2>
            <p class="muted">Treino concluído em ${new Date(entry.date).toLocaleString("pt-BR")}.</p>
          </div>
          <button class="btn btn-ghost" type="button" onclick="navigateTo('home')">${icon("home")}<span>Voltar ao início</span></button>
        </div>
        <div class="dashboard-grid">
          ${metricCard(`${metrics.percentual}%`, "Acerto geral", "target")}
          ${metricCard(metrics.acertos, "Acertos", "check")}
          ${metricCard(metrics.erros, "Erros", "x")}
          ${metricCard(formatDuration(metrics.tempoTotalMs), "Tempo total", "clock")}
          ${metricCard(formatAverageTime(metrics.tempoMedioMs), "Tempo médio", "history")}
        </div>
      </section>
      <section class="card">
        <div class="result-hero">
          <div class="donut-card">
            ${renderDonut(metrics.percentual, tone)}
            <strong>${escapeHtml(message)}</strong>
            <span class="muted small">${metrics.acertos} de ${metrics.total} questões corretas</span>
          </div>
          <div>
            <h3 style="display:inline-flex;align-items:center;gap:8px;margin-bottom:14px;">${icon("spark")}Desempenho por grupo</h3>
            ${renderBarChart(metrics.porGrupo)}
          </div>
        </div>
      </section>
      <section class="result-grid">
        <div class="card">
          <h2>${icon("book")}Desempenho por assunto</h2>
          ${renderProgressMetrics(metrics.porAssunto, "Sem dados por assunto.")}
        </div>
        <div class="card">
          <h2>${icon("bookmark")}Desempenho por subtema</h2>
          ${renderProgressMetrics(metrics.porSubtema, "Sem dados por subtema.")}
        </div>
      </section>
      <section class="card">
        <h2>${icon("alert")}Erros cometidos (${errors.length})</h2>
        ${renderErrorsTable(errors)}
        <div class="actions full-actions" style="margin-top:14px">
          <button class="btn btn-primary" type="button" onclick="navigateTo('review')">${icon("refresh")}<span>Revisar erros</span></button>
          <button class="btn btn-secondary" type="button" onclick="repeatLastFilters()">${icon("refresh")}<span>Refazer com mesmos filtros</span></button>
          <button class="btn btn-ghost" type="button" onclick="navigateTo('home')">${icon("home")}<span>Novo treino</span></button>
        </div>
      </section>
    </div>
  `;
}

function renderDonut(percentual, tone = "success") {
  const colors = { success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", primary: "var(--primary)" };
  const color = colors[tone] || colors.primary;
  return `
    <div class="donut" style="--pct:${percentual};--color:${color}" role="img" aria-label="${percentual}%">
      <div class="donut-text">
        <strong>${percentual}%</strong>
        <span>aproveitamento</span>
      </div>
    </div>
  `;
}

function renderBarChart(data) {
  const entries = Object.entries(data);
  if (!entries.length) return `<p class="muted">Sem dados de grupos.</p>`;
  return `
    <div class="bar-chart">
      ${entries.map(([label, value]) => `
        <div class="bar-row">
          <div class="bar-row-head">
            <span>${escapeHtml(label)}</span>
            <span>${value.acertos}/${value.total} · ${value.percentual}%</span>
          </div>
          <div class="bar-row-shell"><div class="bar-row-fill" style="width:${value.percentual}%"></div></div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderErrorsTable(errors) {
  if (!errors.length) return `<p class="muted">Nenhum erro nesta tentativa.</p>`;
  return `
    <div style="overflow-x:auto">
      <table class="error-table">
        <thead><tr><th>#</th><th>Assunto</th><th>Subtema</th><th>Sua resposta</th><th>Correta</th></tr></thead>
        <tbody>
          ${errors.map((answer, index) => `
            <tr>
              <td>${index + 1}</td>
              <td>${escapeHtml(answer.subassunto || "-")}</td>
              <td>${escapeHtml(answer.subtema || "-")}</td>
              <td><span class="badge bad">${escapeHtml(answer.selected || "-")}</span></td>
              <td><span class="badge ok">${escapeHtml(answer.correctId || "-")}</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderMetricCards(data) {
  const entries = Object.entries(data);
  if (!entries.length) return `<p class="muted">Sem dados.</p>`;
  return `<div class="mini-metric-list">${entries.map(([key, value]) => `
    <div class="mini-metric">
      <strong>${escapeHtml(key)}</strong>
      <span>${value.acertos}/${value.total} acertos · ${value.percentual}%</span>
    </div>
  `).join("")}</div>`;
}

function renderProgressMetrics(data, emptyMessage) {
  const entries = Object.entries(data).sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0], "pt-BR"));
  if (!entries.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `
    <div class="progress-list">
      ${entries.slice(0, 8).map(([key, value]) => `
        <div class="progress-row">
          <div>
            <strong>${escapeHtml(key)}</strong>
            <span>${value.total} questões</span>
          </div>
          <div class="progress-row-bar" aria-label="${escapeAttr(`${value.percentual}% em ${key}`)}">
            <span style="width:${value.percentual}%"></span>
          </div>
          <strong>${value.percentual}%</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function renderAnswerList(answers, emptyMessage) {
  if (!answers.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `<div class="answer-list">${answers.map((answer) => `
    <article class="answer-card">
      <strong>${escapeHtml(answer.subassunto)}</strong>
      <span>${escapeHtml(answer.subtema)} · marcada ${escapeHtml(answer.selected)} · correta ${escapeHtml(answer.correctId)}</span>
    </article>
  `).join("")}</div>`;
}

function renderHistoryView() {
  const history = loadHistory();
  const aggregate = calculateAggregateMetrics(history);
  const storageReport = getStorageReport();
  const wrongCount = Object.keys(loadWrongAnswers()).length;
  setTimeout(refreshBrowserStorageEstimate, 50);
  return `
    <div class="layout">
      <section class="history-hero card">
        <div>
          <h2>${icon("history")}Desempenho e histórico</h2>
          <p class="muted">Acompanhe sua evolução e revisões salvas neste navegador.</p>
        </div>
        <div class="actions">
          ${renderExportMenu("hero")}
          <button class="btn btn-secondary" type="button" onclick="navigateTo('home')">${icon("home")}<span>Início</span></button>
        </div>
      </section>
      <section class="dashboard-grid" aria-label="Resumo do histórico">
        ${metricCard(`${aggregate.percentual}%`, "Acurácia", "target")}
        ${metricCard(history.length, "Simulados concluídos", "file")}
        ${metricCard(formatAverageTime(aggregate.tempoMedioMs), "Tempo médio", "clock")}
        ${metricCard(aggregate.total, "Questões respondidas", "book")}
        ${metricCard(wrongCount, "Questões em revisão", "refresh")}
      </section>
      <section class="history-panel-grid">
        <section class="card">
          <div class="section-heading">
            <div>
              <h2>${icon("spark")}Desempenho por assunto</h2>
              <p class="muted">Percentual acumulado por conteúdo treinado.</p>
            </div>
          </div>
          ${renderProgressMetrics(aggregate.porAssunto, "Sem dados por assunto ainda.")}
        </section>
        <section class="card">
          <div class="section-heading">
            <div>
              <h2>${icon("file")}Últimos simulados</h2>
              <p class="muted">${history.length ? "Tentativas mais recentes." : "Nenhuma tentativa salva."}</p>
            </div>
          </div>
          ${history.length ? `<div class="answer-list">${history.slice(0, 8).map(renderHistoryItem).join("")}</div>` : `<p class="muted">Conclua um treino para gerar o primeiro registro.</p>`}
        </section>
      </section>
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>${icon("sliders")}Ações do histórico</h2>
            <p class="muted">Limpeza e exportação dos dados salvos no navegador.</p>
          </div>
        </div>
        <div class="actions full-actions">
          ${renderExportMenu()}
          <button class="btn btn-danger" type="button" onclick="clearHistory()">${icon("trash")}<span>Limpar histórico</span></button>
          <button class="btn btn-ghost" type="button" onclick="navigateTo('home')">${icon("home")}<span>Voltar</span></button>
        </div>
      </section>
      <details class="advanced-panel" id="diagnostic-anchor">
        <summary>
          <span class="summary-title">${icon("sliders")}Diagnóstico avançado · cache local</span>
        </summary>
        <div class="advanced-body">
          ${renderStoragePanel(storageReport)}
        </div>
      </details>
    </div>
  `;
}

function renderHistoryItem(entry) {
  const metrics = entry.metrics || calculateMetrics(entry.answers || [], entry.durationMs || 0);
  return `
    <article class="history-card">
      <div class="history-card-top">
        <div>
          <strong>${escapeHtml(modeLabel(entry.mode))}</strong>
          <span>${new Date(entry.date).toLocaleString("pt-BR")} · ${metrics.total} questões</span>
        </div>
        <span class="score ${metrics.percentual >= 70 ? "score-good" : "score-low"}">${metrics.percentual}%</span>
      </div>
      <div class="mini-progress" aria-hidden="true"><span style="width:${metrics.percentual}%"></span></div>
      <div class="history-stats">
        <span>${metrics.acertos} acertos</span>
        <span>${metrics.erros} erros</span>
        <span>${formatDuration(metrics.tempoTotalMs)}</span>
      </div>
      <button class="btn btn-ghost" type="button" onclick="reviewErrorsFromHistory('${escapeAttr(entry.id)}')">${icon("refresh")}<span>Revisar erros deste treino</span></button>
    </article>
  `;
}

function renderStoragePanel(report) {
  const pressureClass = report.historyBytes > STORAGE_LIMITS.warningBytes ? "warning-box" : "success-box";
  const pct = Math.min(100, Math.round((report.historyBytes / STORAGE_LIMITS.maxHistoryBytes) * 100));
  return `
    <p class="muted small">O simulador usa <strong>localStorage</strong> para histórico, erros, marcadas e preferências. Tudo fica apenas no seu navegador.</p>
    <div class="${pressureClass}">
      ${report.historyBytes > STORAGE_LIMITS.warningBytes
        ? "Histórico perto do limite. Use otimizar ou limpar."
        : `Uso atual: ${formatBytes(report.historyBytes)} de ${formatBytes(STORAGE_LIMITS.maxHistoryBytes)} (${pct}%).`}
    </div>
    <div class="storage-meter" aria-label="Uso do limite do histórico">
      <span style="width:${pct}%"></span>
    </div>
    <p class="muted small" id="browser-storage-estimate">Estimativa do navegador: calculando...</p>
    <div class="storage-list">
      ${report.rows.map((row) => `
        <div class="storage-row">
          <span>${escapeHtml(row.label)}</span>
          <strong>${formatBytes(row.bytes)}</strong>
        </div>
      `).join("")}
    </div>
    <div class="actions full-actions">
      <button class="btn btn-ghost" type="button" onclick="optimizeHistoryStorage()">${icon("spark")}<span>Otimizar histórico</span></button>
      <button class="btn btn-danger" type="button" onclick="clearWrongAnswers('history')">${icon("trash")}<span>Limpar erros</span></button>
      <button class="btn btn-danger" type="button" onclick="clearSavedQuestions()">${icon("trash")}<span>Limpar marcadas</span></button>
      <button class="btn btn-danger" type="button" onclick="clearPreferences()">${icon("sliders")}<span>Limpar preferências</span></button>
      <button class="btn btn-danger" type="button" onclick="clearAllLocalData()">${icon("trash")}<span>Limpar cache completo</span></button>
    </div>
  `;
}

function renderReviewView() {
  state.filters.mode = "erros";
  const allWrongs = Object.values(loadWrongAnswers());
  const wrongs = getFilteredWrongEntries();
  const subjects = unique(allWrongs.map((wrong) => wrong.subassunto).filter(Boolean));
  return `
    <div class="layout">
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>${icon("refresh")}Revisão de erros</h2>
            <p class="muted">${allWrongs.length ? `${wrongs.length} de ${allWrongs.length} questões erradas no filtro atual.` : "Nenhum erro salvo no momento."}</p>
          </div>
          <button class="btn btn-ghost" type="button" onclick="navigateTo('home')">${icon("home")}<span>Início</span></button>
        </div>
        ${subjects.length ? `
          <div class="filter-block">
            <div class="filter-heading"><h3>Filtrar por assunto</h3></div>
            <div class="chip-grid">
              ${subjects.map((subject) => bigChip(subject, allWrongs.filter((wrong) => wrong.subassunto === subject).length, "subject")).join("")}
            </div>
          </div>
        ` : ""}
        <div class="answer-list" style="margin-top:14px">
          ${wrongs.map((wrong) => `
            <article class="answer-card">
              <strong>${escapeHtml(wrong.subassunto || "Assunto")}</strong>
              <span>${escapeHtml(wrong.subtema || "Geral")} · marcada ${escapeHtml(wrong.lastAnswer || "-")} · correta ${escapeHtml(wrong.correctAnswer || "-")}</span>
            </article>
          `).join("") || `<p class="muted">Nenhum erro encontrado com este filtro.</p>`}
        </div>
        <div class="actions full-actions" style="margin-top:14px">
          <button class="btn btn-primary" type="button" onclick="startQuiz()" ${wrongs.length ? "" : "disabled"}>${icon("play")}<span>Refazer somente erros</span></button>
          <button class="btn btn-danger" type="button" onclick="clearWrongAnswers()">${icon("trash")}<span>Limpar erros</span></button>
          <button class="btn btn-ghost" type="button" onclick="navigateTo('home')">${icon("home")}<span>Voltar</span></button>
        </div>
      </section>
    </div>
  `;
}

function getFilteredWrongEntries() {
  return Object.values(loadWrongAnswers()).filter((wrong) => {
    if (state.filters.selectedGroups.length && !state.filters.selectedGroups.includes(wrong.assuntoGeral)) return false;
    if (state.filters.selectedSubjects.length && !state.filters.selectedSubjects.includes(wrong.subassunto)) return false;
    if (state.filters.selectedSubthemes.length && !state.filters.selectedSubthemes.includes(wrong.subtema)) return false;
    return true;
  });
}

function calculateMetrics(answers, durationMs) {
  const total = answers.length;
  const acertos = answers.filter((answer) => answer.correct).length;
  const erros = total - acertos;
  const base = {
    total,
    acertos,
    erros,
    percentual: total ? Math.round((acertos / total) * 100) : 0,
    tempoTotalMs: durationMs,
    tempoMedioMs: total ? Math.round(durationMs / total) : 0,
    porGrupo: {},
    porAssunto: {},
    porSubtema: {}
  };
  for (const answer of answers) {
    addMetric(base.porGrupo, answer.assuntoGeral, answer.correct);
    addMetric(base.porAssunto, answer.subassunto, answer.correct);
    addMetric(base.porSubtema, answer.subtema, answer.correct);
  }
  return base;
}

function addMetric(target, key = "Geral", correct) {
  if (!target[key]) target[key] = { total: 0, acertos: 0, erros: 0, percentual: 0 };
  target[key].total += 1;
  if (correct) target[key].acertos += 1;
  target[key].erros = target[key].total - target[key].acertos;
  target[key].percentual = Math.round((target[key].acertos / target[key].total) * 100);
}

function saveHistory(entry) {
  const history = loadHistory();
  history.unshift(compactHistoryEntry(entry));
  const next = pruneHistory(history);
  persistHistory(next);
}

function loadHistory() {
  const history = safeJson(localStorage.getItem(STORAGE.history), []);
  return Array.isArray(history) ? history : [];
}

function compactHistoryEntry(entry) {
  return {
    id: entry.id,
    date: entry.date,
    mode: entry.mode,
    filters: entry.filters,
    durationMs: entry.durationMs || 0,
    metrics: entry.metrics,
    answers: (entry.answers || []).map(compactAnswer)
  };
}

function compactAnswer(answer) {
  return {
    questionId: answer.questionId,
    assuntoGeral: answer.assuntoGeral,
    subassunto: answer.subassunto,
    subtema: answer.subtema,
    selected: answer.selected,
    correctId: answer.correctId,
    correct: Boolean(answer.correct),
    timeMs: answer.timeMs || 0
  };
}

function pruneHistory(history) {
  let next = history.map(compactHistoryEntry).slice(0, STORAGE_LIMITS.maxHistoryEntries);
  while (next.length > 0 && estimateBytes(JSON.stringify(next)) > STORAGE_LIMITS.maxHistoryBytes) {
    next.pop();
  }
  return next;
}

function persistHistory(history) {
  const next = pruneHistory(history);
  try {
    localStorage.setItem(STORAGE.history, JSON.stringify(next));
  } catch (error) {
    const reduced = pruneHistory(next.slice(0, Math.max(1, Math.floor(next.length / 2))));
    localStorage.setItem(STORAGE.history, JSON.stringify(reduced));
  }
  localStorage.setItem(STORAGE.accumulated, JSON.stringify(calculateAggregateMetrics(loadHistory())));
}

function saveWrongAnswer(question, answer) {
  const wrongs = loadWrongAnswers();
  const previous = wrongs[question.id] || {};
  wrongs[question.id] = {
    questionId: question.id,
    assuntoGeral: question.assuntoGeral,
    subassunto: question.subassunto,
    subtema: question.subtema,
    lastAnswer: answer.selected,
    lastAnswerText: answer.selectedText,
    correctAnswer: answer.correctId,
    correctText: answer.correctText,
    count: (previous.count || 0) + 1,
    lastAt: new Date().toISOString()
  };
  localStorage.setItem(STORAGE.wrong, JSON.stringify(wrongs));
}

function removeWrongAnswer(questionId) {
  const wrongs = loadWrongAnswers();
  if (wrongs[questionId]) {
    delete wrongs[questionId];
    localStorage.setItem(STORAGE.wrong, JSON.stringify(wrongs));
  }
}

function loadWrongAnswers() {
  return safeJson(localStorage.getItem(STORAGE.wrong), {});
}

function clearWrongAnswers(target = "home") {
  openConfirmModal({
    title: "Limpar erros salvos?",
    message: "Todas as questões erradas salvas serão removidas. Você ainda poderá errá-las novamente em novos treinos.",
    confirmLabel: "Limpar erros",
    cancelLabel: "Cancelar",
    tone: "danger",
    onConfirm: () => {
      localStorage.setItem(STORAGE.wrong, JSON.stringify({}));
      if (target === "history") navigateTo("history");
      else navigateTo(state.currentView || "home");
    }
  });
}

function clearHistory() {
  openConfirmModal({
    title: "Limpar histórico de simulados?",
    message: "Todas as tentativas registradas serão removidas. Essa ação não pode ser desfeita.",
    confirmLabel: "Limpar histórico",
    cancelLabel: "Cancelar",
    tone: "danger",
    onConfirm: () => {
      localStorage.setItem(STORAGE.history, JSON.stringify([]));
      localStorage.setItem(STORAGE.accumulated, JSON.stringify(calculateAggregateMetrics([])));
      navigateTo("history");
    }
  });
}

function clearSavedQuestions() {
  openConfirmModal({
    title: "Limpar questões marcadas?",
    message: "Todas as questões marcadas para revisão serão removidas.",
    confirmLabel: "Limpar marcadas",
    cancelLabel: "Cancelar",
    tone: "danger",
    onConfirm: () => {
      localStorage.setItem(STORAGE.saved, JSON.stringify({}));
      navigateTo("history");
    }
  });
}

function clearPreferences() {
  openConfirmModal({
    title: "Limpar preferências?",
    message: "Tema e filtros salvos voltarão ao padrão.",
    confirmLabel: "Limpar preferências",
    cancelLabel: "Cancelar",
    tone: "danger",
    onConfirm: () => {
      localStorage.removeItem(STORAGE.theme);
      localStorage.removeItem(STORAGE.lastConfig);
      state.filters = { ...defaultFilters };
      setTheme("light");
      navigateTo("history");
    }
  });
}

function clearAllLocalData() {
  openConfirmModal({
    title: "Limpar cache completo?",
    message: "Histórico, erros, marcadas e preferências serão TODOS removidos. Essa ação não pode ser desfeita.",
    confirmLabel: "Limpar tudo",
    cancelLabel: "Cancelar",
    tone: "danger",
    onConfirm: () => {
      for (const key of Object.values(STORAGE)) {
        if (key !== STORAGE.unlocked) localStorage.removeItem(key);
      }
      state.filters = { ...defaultFilters };
      setTheme("light");
      navigateTo("history");
    }
  });
}

function optimizeHistoryStorage() {
  const before = getStorageReport().historyBytes;
  const optimized = pruneHistory(loadHistory());
  persistHistory(optimized);
  const after = getStorageReport().historyBytes;
  state.notice = `Histórico otimizado: ${formatBytes(before)} -> ${formatBytes(after)}.`;
  renderHistory();
}

/* ---------- Export menu + downloaders ---------- */

function renderExportMenu(variant = "actions") {
  const cls = variant === "hero" ? "btn btn-ghost" : "btn btn-secondary";
  return `
    <button class="${cls} export-button" type="button" onclick="openUnifiedExportPopover(event)" aria-haspopup="menu" aria-expanded="false" title="Exportar / Importar dados">
      ${icon("swap")}<span>Exportar / Importar</span>
    </button>
  `;
}

function toggleExportMenu(event) {
  event?.stopPropagation();
  const trigger = event.currentTarget;
  const pop = trigger.nextElementSibling;
  if (!pop) return;
  const willOpen = pop.hasAttribute("hidden");
  document.querySelectorAll(".export-menu-pop").forEach((node) => {
    node.setAttribute("hidden", "");
    node.previousElementSibling?.setAttribute("aria-expanded", "false");
  });
  if (willOpen) {
    pop.removeAttribute("hidden");
    trigger.setAttribute("aria-expanded", "true");
    setTimeout(() => document.addEventListener("click", closeExportMenuOnce, { once: true }), 0);
    document.addEventListener("keydown", closeExportMenuOnEsc);
  }
}

function closeExportMenuOnce() {
  document.querySelectorAll(".export-menu-pop").forEach((node) => {
    node.setAttribute("hidden", "");
    node.previousElementSibling?.setAttribute("aria-expanded", "false");
  });
  document.removeEventListener("keydown", closeExportMenuOnEsc);
}

function closeExportMenuOnEsc(event) {
  if (event.key === "Escape") closeExportMenuOnce();
}

/* ---------- Unified export/import popover (body-mounted) ---------- */

function openUnifiedExportPopover(event) {
  event?.stopPropagation();
  const trigger = event?.currentTarget;
  closeExportMenuOnce();
  const existing = document.getElementById("global-export-popover");
  if (existing) {
    existing.remove();
    document.removeEventListener("click", closeUnifiedExportPopoverOnce);
    document.removeEventListener("keydown", closeUnifiedExportPopoverOnEsc);
    trigger?.setAttribute("aria-expanded", "false");
    return;
  }
  const pop = document.createElement("div");
  pop.id = "global-export-popover";
  pop.className = "popover popover-floating";
  pop.setAttribute("role", "menu");
  pop.innerHTML = renderExportPopoverContent();
  document.body.appendChild(pop);

  if (trigger) {
    const rect = trigger.getBoundingClientRect();
    const popWidth = 280;
    const margin = 12;
    let left = rect.right - popWidth;
    if (left < margin) left = margin;
    if (left + popWidth > window.innerWidth - margin) left = window.innerWidth - popWidth - margin;
    let top = rect.bottom + 8;
    if (top + 380 > window.innerHeight) top = Math.max(margin, rect.top - 380 - 8);
    pop.style.top = top + "px";
    pop.style.left = left + "px";
    trigger.setAttribute("aria-expanded", "true");
  } else {
    pop.style.top = "84px";
    pop.style.right = "16px";
  }

  setTimeout(() => document.addEventListener("click", closeUnifiedExportPopoverOnce), 0);
  document.addEventListener("keydown", closeUnifiedExportPopoverOnEsc);
}

function closeUnifiedExportPopoverOnce(event) {
  const pop = document.getElementById("global-export-popover");
  if (!pop) return;
  if (event && pop.contains(event.target)) return;
  pop.remove();
  document.removeEventListener("click", closeUnifiedExportPopoverOnce);
  document.removeEventListener("keydown", closeUnifiedExportPopoverOnEsc);
  document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function closeUnifiedExportPopoverOnEsc(event) {
  if (event.key === "Escape") closeUnifiedExportPopoverOnce();
}

function renderExportPopoverContent() {
  return `
    <div class="popover-section">Exportar dados</div>
    <button class="popover-item" type="button" role="menuitem" onclick="closeUnifiedExportPopoverOnce(); exportHistoryJSON()">
      ${icon("download")}<span>Exportar como JSON</span><span class="kbd">.json</span>
    </button>
    <button class="popover-item" type="button" role="menuitem" onclick="closeUnifiedExportPopoverOnce(); exportHistoryCSV()">
      ${icon("download")}<span>Exportar como CSV</span><span class="kbd">.csv</span>
    </button>
    <button class="popover-item" type="button" role="menuitem" onclick="closeUnifiedExportPopoverOnce(); exportHistoryPDF()">
      ${icon("download")}<span>Imprimir como PDF</span><span class="kbd">.pdf</span>
    </button>
    <div class="popover-divider"></div>
    <div class="popover-section">Importar dados</div>
    <button class="popover-item" type="button" role="menuitem" onclick="closeUnifiedExportPopoverOnce(); openImportFilePicker()">
      ${icon("upload")}<span>Importar do arquivo</span><span class="kbd">.json</span>
    </button>
    <div class="popover-divider"></div>
    <div class="popover-section">Exportar erros</div>
    <button class="popover-item" type="button" role="menuitem" onclick="closeUnifiedExportPopoverOnce(); exportErrorsJSON()">
      ${icon("download")}<span>Erros como JSON</span><span class="kbd">.json</span>
    </button>
    <button class="popover-item" type="button" role="menuitem" onclick="closeUnifiedExportPopoverOnce(); exportErrorsCSV()">
      ${icon("download")}<span>Erros como CSV</span><span class="kbd">.csv</span>
    </button>
    <p class="popover-foot">Tudo fica salvo só no seu navegador.</p>
  `;
}

/* ---------- Import (file picker + handler) ---------- */

function openImportFilePicker() {
  let input = document.getElementById("global-import-input");
  if (!input) {
    input = document.createElement("input");
    input.id = "global-import-input";
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener("change", handleImportFile);
    document.body.appendChild(input);
  }
  input.value = "";
  input.click();
}

async function handleImportFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = applyImportedData(data);
    if (result.imported === 0) {
      showToast("Arquivo válido, mas sem dados reconhecidos para importar.", "info");
      return;
    }
    showToast(`Importação concluída: ${result.summary}.`, "success");
    if (state.currentView === "history" || state.currentView === "home") navigateTo(state.currentView);
  } catch (err) {
    console.error("Import error:", err);
    showToast("Arquivo inválido. Selecione um JSON exportado pelo simulador.", "error");
  }
}

function applyImportedData(data) {
  const parts = [];
  let imported = 0;
  const bundle = Array.isArray(data) ? { history: data } : (data && typeof data === "object" ? data : {});

  if (Array.isArray(bundle.history)) {
    const valid = bundle.history.filter((entry) => entry && typeof entry === "object" && Array.isArray(entry.answers));
    if (valid.length) {
      localStorage.setItem(STORAGE.history, JSON.stringify(valid));
      localStorage.setItem(STORAGE.accumulated, JSON.stringify(calculateAggregateMetrics(valid)));
      parts.push(`${valid.length} simulado${valid.length === 1 ? "" : "s"}`);
      imported += valid.length;
    }
  }
  if (bundle.wrong && typeof bundle.wrong === "object") {
    localStorage.setItem(STORAGE.wrong, JSON.stringify(bundle.wrong));
    const n = Object.keys(bundle.wrong).length;
    if (n) parts.push(`${n} erro${n === 1 ? "" : "s"}`);
    imported += n;
  } else if (Array.isArray(bundle.wrong)) {
    const map = {};
    for (const w of bundle.wrong) if (w && w.questionId) map[w.questionId] = w;
    localStorage.setItem(STORAGE.wrong, JSON.stringify(map));
    const n = Object.keys(map).length;
    if (n) parts.push(`${n} erro${n === 1 ? "" : "s"}`);
    imported += n;
  }
  if (bundle.saved && typeof bundle.saved === "object") {
    localStorage.setItem(STORAGE.saved, JSON.stringify(bundle.saved));
    const n = Object.keys(bundle.saved).length;
    if (n) parts.push(`${n} marcada${n === 1 ? "" : "s"}`);
    imported += n;
  }
  return { imported, summary: parts.join(" · ") || "nenhum item novo" };
}

/* ---------- Toast notification stack ---------- */

function showToast(text, kind = "info", durationMs = 3200) {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const iconName = kind === "success" ? "check" : kind === "error" ? "alert" : "spark";
  const toast = document.createElement("div");
  toast.id = id;
  toast.className = `toast toast-${kind}`;
  toast.setAttribute("role", "status");
  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icon(iconName)}</span>
    <span class="toast-text">${escapeHtml(text)}</span>
    <button class="toast-close" type="button" aria-label="Fechar" onclick="dismissToast('${id}')">${icon("x")}</button>
  `;
  stack.appendChild(toast);
  setTimeout(() => toast.classList.add("toast-leave"), durationMs);
  setTimeout(() => toast.remove(), durationMs + 280);
}

function dismissToast(id) {
  const t = document.getElementById(id);
  if (!t) return;
  t.classList.add("toast-leave");
  setTimeout(() => t.remove(), 250);
}

function downloadBlob(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[;"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function buildHistoryCSV(history) {
  const header = ["data", "modo", "grupos", "assuntos", "subtemas", "quantidade", "acertos", "erros", "percentual", "tempo_total_ms", "tempo_medio_ms"];
  const rows = history.map((entry) => {
    const metrics = entry.metrics || calculateMetrics(entry.answers || [], entry.durationMs || 0);
    const filters = entry.filters || {};
    return [
      new Date(entry.date).toISOString(),
      modeLabel(entry.mode),
      (filters.grupos || []).join(" | "),
      (filters.assuntos || []).join(" | "),
      (filters.subtemas || []).join(" | "),
      metrics.total ?? 0,
      metrics.acertos ?? 0,
      metrics.erros ?? 0,
      metrics.percentual ?? 0,
      metrics.tempoTotalMs ?? 0,
      metrics.tempoMedioMs ?? 0
    ].map(csvEscape).join(";");
  });
  return "﻿" + [header.join(";"), ...rows].join("\r\n");
}

function buildErrorsCSV(wrongs) {
  const header = ["id_questao", "grupo", "assunto", "subtema", "ultima_resposta", "resposta_correta", "ocorrencias", "data_ultima"];
  const rows = wrongs.map((wrong) => [
    wrong.questionId || "",
    wrong.assuntoGeral || "",
    wrong.subassunto || "",
    wrong.subtema || "",
    wrong.lastAnswer || "",
    wrong.correctAnswer || "",
    wrong.count || 1,
    wrong.lastAt || ""
  ].map(csvEscape).join(";"));
  return "﻿" + [header.join(";"), ...rows].join("\r\n");
}

function exportHistoryJSON() {
  closeExportMenuOnce();
  const bundle = {
    exportedAt: new Date().toISOString(),
    appVersion: "1.0.0",
    history: loadHistory(),
    wrong: loadWrongAnswers(),
    saved: loadSavedQuestions()
  };
  downloadBlob("historico-taquigrafia.json", JSON.stringify(bundle, null, 2), "application/json;charset=utf-8");
  showToast(`Exportado: ${bundle.history.length} simulado(s) + erros + marcadas.`, "success");
}

function exportHistoryCSV() {
  closeExportMenuOnce();
  const history = loadHistory();
  downloadBlob("historico-taquigrafia.csv", buildHistoryCSV(history), "text/csv;charset=utf-8");
  showToast(`CSV exportado · ${history.length} linha(s).`, "success");
}

function exportHistoryPDF() {
  closeExportMenuOnce();
  openPrintReport(buildHistoryReportHTML(loadHistory()));
  showToast("Janela de impressão aberta · escolha 'Salvar como PDF'.", "info");
}

function exportErrorsJSON() {
  closeExportMenuOnce();
  const wrongs = Object.values(loadWrongAnswers());
  downloadBlob("erros-taquigrafia.json", JSON.stringify(wrongs, null, 2), "application/json;charset=utf-8");
  showToast(`${wrongs.length} erro(s) exportado(s).`, "success");
}

function exportErrorsCSV() {
  closeExportMenuOnce();
  const wrongs = Object.values(loadWrongAnswers());
  downloadBlob("erros-taquigrafia.csv", buildErrorsCSV(wrongs), "text/csv;charset=utf-8");
  showToast(`CSV de erros · ${wrongs.length} linha(s).`, "success");
}

function exportErrorsPDF() {
  closeExportMenuOnce();
  openPrintReport(buildErrorsReportHTML(Object.values(loadWrongAnswers())));
  showToast("Janela de impressão aberta · escolha 'Salvar como PDF'.", "info");
}

function openPrintReport(html) {
  const win = window.open("", "_blank", "width=960,height=720");
  if (!win) {
    alert("Permita pop-ups para gerar o PDF. Você pode usar Ctrl+P na nova janela para salvar como PDF.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => {
    try { win.print(); } catch {}
  }, 350);
}

function reportStyles() {
  return `
    <style>
      @media print { @page { margin: 14mm; } }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 22px; font: 13px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; color: #14233b; }
      header.report { border-bottom: 2px solid #087f9a; padding-bottom: 12px; margin-bottom: 18px; }
      header.report h1 { margin: 0 0 4px; font-size: 20px; color: #087f9a; }
      header.report .meta { color: #5d6f89; font-size: 12px; line-height: 1.5; }
      header.report .meta a { color: #087f9a; text-decoration: none; }
      .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 18px 0; }
      .kpi { border: 1px solid #dce7f0; border-radius: 8px; padding: 10px 12px; background: #f6f9fc; }
      .kpi strong { display: block; font-size: 18px; color: #14233b; }
      .kpi span { color: #5d6f89; font-size: 11px; }
      h2 { font-size: 14px; margin: 18px 0 8px; color: #075f74; text-transform: uppercase; letter-spacing: 0.06em; }
      table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
      th, td { padding: 7px 9px; border-bottom: 1px solid #dce7f0; text-align: left; vertical-align: top; }
      th { background: #eaf3f8; font-weight: 700; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.04em; color: #075f74; }
      tr:nth-child(even) td { background: #fafcfe; }
      .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-weight: 700; font-size: 10.5px; }
      .badge.ok { background: #ddf5e7; color: #0d7a4f; }
      .badge.bad { background: #fde4e1; color: #b32f27; }
      footer.report { margin-top: 28px; font-size: 11px; color: #5d6f89; border-top: 1px solid #dce7f0; padding-top: 10px; }
      .empty { padding: 24px; text-align: center; color: #5d6f89; border: 1px dashed #dce7f0; border-radius: 8px; }
    </style>
  `;
}

function reportHeaderHTML(title) {
  return `
    <header class="report">
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        <div><strong>Simulador de Taquigrafia</strong> · ALE-RR · Cargo de Taquígrafo</div>
        <div>Desenvolvido por <strong>Marcos Duailibi</strong> · Contato: <a href="https://wa.me/5595981114983">+55 95 98111-4983</a></div>
        <div>Gerado em ${new Date().toLocaleString("pt-BR")}</div>
      </div>
    </header>
  `;
}

function reportFooterHTML() {
  return `<footer class="report">Relatório gerado localmente no navegador. O banco de questões e o histórico ficam apenas no seu dispositivo (localStorage).</footer>`;
}

function buildHistoryReportHTML(history) {
  const aggregate = calculateAggregateMetrics(history);
  const rowsHtml = history.length ? `
    <table>
      <thead><tr>
        <th>#</th><th>Data</th><th>Modo</th><th>Questões</th><th>Acertos</th><th>Erros</th><th>%</th><th>Tempo</th>
      </tr></thead>
      <tbody>
        ${history.map((entry, i) => {
          const m = entry.metrics || calculateMetrics(entry.answers || [], entry.durationMs || 0);
          return `<tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(new Date(entry.date).toLocaleString("pt-BR"))}</td>
            <td>${escapeHtml(modeLabel(entry.mode))}</td>
            <td>${m.total}</td>
            <td>${m.acertos}</td>
            <td>${m.erros}</td>
            <td><span class="badge ${m.percentual >= 70 ? "ok" : "bad"}">${m.percentual}%</span></td>
            <td>${escapeHtml(formatDuration(m.tempoTotalMs))}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  ` : `<div class="empty">Nenhuma tentativa registrada ainda.</div>`;

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Histórico — Simulador de Taquigrafia</title>${reportStyles()}</head>
<body>
  ${reportHeaderHTML("Histórico de simulados")}
  <section class="summary">
    <div class="kpi"><strong>${aggregate.percentual}%</strong><span>Acurácia acumulada</span></div>
    <div class="kpi"><strong>${history.length}</strong><span>Simulados concluídos</span></div>
    <div class="kpi"><strong>${aggregate.total}</strong><span>Questões respondidas</span></div>
    <div class="kpi"><strong>${formatAverageTime(aggregate.tempoMedioMs)}</strong><span>Tempo médio por questão</span></div>
  </section>
  <h2>Tentativas</h2>
  ${rowsHtml}
  ${reportFooterHTML()}
</body></html>`;
}

function buildErrorsReportHTML(wrongs) {
  const tableHtml = wrongs.length ? `
    <table>
      <thead><tr>
        <th>#</th><th>Grupo</th><th>Assunto</th><th>Subtema</th><th>Marcada</th><th>Correta</th><th>Ocorrências</th><th>Última</th>
      </tr></thead>
      <tbody>
        ${wrongs.map((w, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(w.assuntoGeral || "-")}</td>
            <td>${escapeHtml(w.subassunto || "-")}</td>
            <td>${escapeHtml(w.subtema || "-")}</td>
            <td><span class="badge bad">${escapeHtml(w.lastAnswer || "-")}</span></td>
            <td><span class="badge ok">${escapeHtml(w.correctAnswer || "-")}</span></td>
            <td>${w.count || 1}</td>
            <td>${w.lastAt ? escapeHtml(new Date(w.lastAt).toLocaleString("pt-BR")) : "-"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : `<div class="empty">Nenhum erro salvo no momento.</div>`;

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Erros salvos — Simulador de Taquigrafia</title>${reportStyles()}</head>
<body>
  ${reportHeaderHTML("Erros salvos para revisão")}
  <section class="summary">
    <div class="kpi"><strong>${wrongs.length}</strong><span>Questões com erro</span></div>
    <div class="kpi"><strong>${unique(wrongs.map((w) => w.subassunto)).length}</strong><span>Assuntos afetados</span></div>
    <div class="kpi"><strong>${unique(wrongs.map((w) => w.assuntoGeral)).length}</strong><span>Grupos afetados</span></div>
    <div class="kpi"><strong>${wrongs.reduce((sum, w) => sum + (w.count || 1), 0)}</strong><span>Ocorrências totais</span></div>
  </section>
  <h2>Detalhamento</h2>
  ${tableHtml}
  ${reportFooterHTML()}
</body></html>`;
}

/* legacy alias */
function exportHistory() { exportHistoryJSON(); }

function reviewErrorsFromHistory(historyId) {
  const entry = loadHistory().find((item) => item.id === historyId);
  if (!entry) return;
  const ids = new Set((entry.answers || []).filter((answer) => !answer.correct).map((answer) => answer.questionId));
  if (!ids.size) {
    state.notice = "Esse treino não teve erros para revisar.";
    renderHome();
    return;
  }
  const wrongs = loadWrongAnswers();
  for (const id of ids) {
    const question = state.questionById.get(id);
    if (question && !wrongs[id]) {
      const alt = question.alternativas.find((item) => item.correta);
      wrongs[id] = {
        questionId: id,
        assuntoGeral: question.assuntoGeral,
        subassunto: question.subassunto,
        subtema: question.subtema,
        correctAnswer: alt?.id || "",
        correctText: alt?.texto || "",
        count: 1,
        lastAt: new Date().toISOString()
      };
    }
  }
  localStorage.setItem(STORAGE.wrong, JSON.stringify(wrongs));
  renderReviewMode();
}

function toggleSavedQuestion(questionId) {
  const saved = loadSavedQuestions();
  if (saved[questionId]) delete saved[questionId];
  else {
    const question = state.questionById.get(questionId);
    saved[questionId] = {
      questionId,
      assuntoGeral: question?.assuntoGeral,
      subassunto: question?.subassunto,
      subtema: question?.subtema,
      savedAt: new Date().toISOString()
    };
  }
  localStorage.setItem(STORAGE.saved, JSON.stringify(saved));
  renderQuestion();
}

function loadSavedQuestions() {
  return safeJson(localStorage.getItem(STORAGE.saved), {});
}

function isSaved(questionId) {
  return Boolean(loadSavedQuestions()[questionId]);
}

function repeatLastFilters() {
  const history = loadHistory();
  const last = history[0];
  if (last?.filters?.config) {
    state.filters = normalizeStoredFilters({ ...defaultFilters, ...last.filters.config });
  }
  startQuiz();
}

function calculateAggregateMetrics(history) {
  const answers = history.flatMap((entry) => entry.answers || []);
  const duration = history.reduce((sum, entry) => sum + (entry.durationMs || 0), 0);
  return calculateMetrics(answers, duration);
}

/* ---------- Activity widget (last 7 days) ---------- */

function renderActivityWidget() {
  const history = loadHistory();
  const days = buildLast7DaysActivity(history);
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const correct = days.reduce((sum, day) => sum + day.correct, 0);
  const accuracy = total ? Math.round((correct / total) * 100) : 0;
  const streak = computeStreak(days);
  const maxCount = Math.max(1, ...days.map((day) => day.count));

  return `
    <div class="activity-card">
      <div class="activity-head">
        <h3>${icon("spark")}Atividade — últimos 7 dias</h3>
      </div>
      ${total === 0 ? `
        <p class="muted small activity-empty">Conclua um treino para começar a registrar seu desempenho aqui.</p>
        <div class="activity-chart activity-chart-empty" aria-hidden="true">
          ${days.map((day) => `
            <div class="activity-day">
              <div class="activity-bar-shell"><span class="activity-bar activity-bar-ghost" style="height:${20 + ((day.date.getDate() * 7) % 60)}%"></span></div>
              <span class="activity-day-label">${escapeHtml(day.short)}</span>
            </div>
          `).join("")}
        </div>
      ` : `
        <div class="activity-chart" role="img" aria-label="Questões respondidas por dia nos últimos 7 dias">
          ${days.map((day) => {
            const height = day.count ? Math.max(6, Math.round((day.count / maxCount) * 100)) : 2;
            const fill = day.count ? (day.correct / day.count) : 0;
            const tone = day.count === 0 ? "is-empty" : fill >= 0.7 ? "is-good" : fill >= 0.5 ? "is-mid" : "is-low";
            return `
              <div class="activity-day ${day.isToday ? "is-today" : ""}">
                <div class="activity-bar-shell">
                  <span class="activity-bar ${tone}" style="height:${height}%" title="${day.count} questões em ${escapeHtml(day.label)} (${day.count ? Math.round(fill * 100) : 0}% acerto)"></span>
                </div>
                <span class="activity-day-label">${escapeHtml(day.short)}</span>
              </div>
            `;
          }).join("")}
        </div>
        <div class="activity-stats">
          <div><strong>${total}</strong><span>Questões</span></div>
          <div><strong>${accuracy}%</strong><span>Acertos</span></div>
          <div><strong>${streak}</strong><span>${streak === 1 ? "Dia seguido" : "Dias seguidos"}</span></div>
        </div>
      `}
    </div>
  `;
}

function buildLast7DaysActivity(history) {
  const dayNames = ["D", "S", "T", "Q", "Q", "S", "S"];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = today.toISOString().slice(0, 10);
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    days.push({
      date,
      key,
      short: dayNames[date.getDay()],
      label: date.toLocaleDateString("pt-BR"),
      isToday: key === todayKey,
      count: 0,
      correct: 0
    });
  }
  const index = new Map(days.map((day, position) => [day.key, position]));
  for (const entry of history) {
    const dateKey = new Date(entry.date).toISOString().slice(0, 10);
    const position = index.get(dateKey);
    if (position === undefined) continue;
    const answers = entry.answers || [];
    days[position].count += answers.length;
    days[position].correct += answers.filter((answer) => answer.correct).length;
  }
  return days;
}

function computeStreak(days) {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].count > 0) streak += 1;
    else break;
  }
  return streak;
}

/* ---------- Quick indicators (KPI grid - BEM) ---------- */

function renderQuickIndicators() {
  const history = loadHistory();
  const aggregate = calculateAggregateMetrics(history);
  const wrongs = Object.values(loadWrongAnswers());
  const totalQuestions = Math.max(1, state.questions.length || 1);
  const accumulatedAccuracy = clampPercent(aggregate.percentual);
  const averageTimeMs = safeNumber(aggregate.tempoMedioMs);
  const averageTimeFormatted = formatAverageTime(averageTimeMs);
  const reviewedCount = safeNumber(aggregate.total);
  const pendingCount = safeNumber(wrongs.length);
  const reviewedProgress = clampPercent((reviewedCount / totalQuestions) * 100);
  const pendingProgress = clampPercent((pendingCount / Math.max(20, pendingCount || 1)) * 100);
  const timeProgress = clampPercent((averageTimeMs / 300000) * 100);

  return `
    <section class="quick-indicators-panel" aria-label="Indicadores rápidos">
      <div class="quick-indicators-header">
        <div class="quick-indicators-header__icon" aria-hidden="true">${icon("barChart")}</div>
        <div>
          <h2>Indicadores rápidos</h2>
          <p>Resumo do seu progresso de estudo.</p>
        </div>
      </div>
      <div class="quick-indicators-grid quick-indicators-grid--four">
        ${renderQuickIndicatorCard({
          title: "Aproveitamento",
          value: Math.round(accumulatedAccuracy),
          unit: "%",
          icon: icon("target"),
          variant: "success",
          progress: accumulatedAccuracy
        })}
        ${renderQuickIndicatorCard({
          title: "Tempo médio",
          value: averageTimeFormatted,
          icon: icon("clock"),
          variant: "purple compact-time",
          progress: timeProgress
        })}
        ${renderQuickIndicatorCard({
          title: "Revisadas",
          value: reviewedCount,
          icon: icon("check"),
          variant: "success",
          progress: reviewedProgress
        })}
        ${renderQuickIndicatorCard({
          title: "Pendentes",
          value: pendingCount,
          icon: icon("file"),
          variant: "warning",
          progress: pendingProgress
        })}
      </div>
    </section>
  `;
}

function renderQuickIndicatorCard({
  title,
  value,
  unit = "",
  icon: iconMarkup = "•",
  variant = "primary",
  progress = 0
}) {
  const safeTitle = String(title || "");
  const safeValue = value === undefined || value === null || Number.isNaN(value) ? "0" : String(value);
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const variantParts = String(variant || "primary").split(/\s+/).filter(Boolean);
  const tone = variantParts.shift() || "primary";
  const extraClasses = variantParts.join(" ");
  const isTime = safeTitle.toLocaleLowerCase("pt-BR") === "tempo médio" || extraClasses.includes("compact-time");
  const cardClasses = [
    "qi-card",
    "quick-indicator-card",
    `qi-card--${tone}`,
    `quick-indicator-card--${tone}`,
    extraClasses,
    isTime ? "quick-indicator-card--compact-time compact-time" : ""
  ].filter(Boolean).join(" ");
  const timeClass = isTime ? " qi-card__value-row--time indicator-value-row--time" : "";

  return `
    <article class="${escapeAttr(cardClasses)}">
      <div class="qi-card__icon indicator-icon" aria-hidden="true">${iconMarkup}</div>
      <div class="qi-card__content indicator-content">
        <span class="qi-card__title indicator-title">${escapeHtml(safeTitle)}</span>
        <div class="qi-card__value-row indicator-value-row${timeClass}">
          <strong class="qi-card__value indicator-value">${escapeHtml(safeValue)}</strong>
          ${unit ? `<span class="qi-card__unit indicator-unit">${escapeHtml(unit)}</span>` : ""}
        </div>
        <div class="qi-card__bar indicator-progress" aria-hidden="true">
          <span style="width:${safeProgress}%"></span>
        </div>
      </div>
    </article>
  `;
}

function getStorageReport() {
  const rows = [
    { key: STORAGE.history, label: "Histórico" },
    { key: STORAGE.wrong, label: "Erros salvos" },
    { key: STORAGE.saved, label: "Questões marcadas" },
    { key: STORAGE.lastConfig, label: "Preferências de treino" },
    { key: STORAGE.accumulated, label: "Métricas acumuladas" },
    { key: STORAGE.theme, label: "Tema" }
  ].map((item) => {
    const value = localStorage.getItem(item.key) || "";
    return { ...item, bytes: estimateBytes(value) };
  });
  const historyBytes = rows.find((row) => row.key === STORAGE.history)?.bytes || 0;
  return {
    rows,
    historyBytes,
    historyEntries: loadHistory().length,
    totalAppBytes: rows.reduce((sum, row) => sum + row.bytes, 0)
  };
}

function estimateBytes(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function refreshBrowserStorageEstimate() {
  const target = document.getElementById("browser-storage-estimate");
  if (!target) return;
  if (!navigator.storage?.estimate) {
    target.textContent = "Estimativa do navegador indisponível neste ambiente.";
    return;
  }
  try {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage || 0;
    const quota = estimate.quota || 0;
    target.textContent = quota
      ? `Estimativa do navegador para esta origem: ${formatBytes(usage)} usados de ${formatBytes(quota)} disponíveis.`
      : `Estimativa do navegador para esta origem: ${formatBytes(usage)} usados.`;
  } catch {
    target.textContent = "Não foi possível consultar a estimativa de armazenamento do navegador.";
  }
}

function snapshotFilters(questions) {
  return {
    config: { ...state.filters },
    grupos: unique(questions.map((q) => q.assuntoGeral)),
    assuntos: unique(questions.map((q) => q.subassunto)),
    subtemas: unique(questions.map((q) => q.subtema)),
    quantidade: questions.length
  };
}

function formatFilterSummary(filters = {}) {
  const groups = filters.grupos?.length ? filters.grupos.join(", ") : "todos os grupos";
  const subjects = filters.assuntos?.length ? filters.assuntos.join(", ") : "todos os assuntos";
  const subthemes = filters.subtemas?.length ? filters.subtemas.join(", ") : "todos os subtemas";
  return `${groups} · ${subjects} · ${subthemes}`;
}

function modeLabel(mode) {
  if (mode === "erros") return "Revisão de erros";
  if (mode === "personalizado") return "Treino personalizado";
  return "Simulado geral";
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(next);
}

function setTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalized;
  try { localStorage.setItem(STORAGE.theme, normalized); } catch {}
  updateThemeButtons();
  updateThemeSegments(normalized);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

function loadTheme() {
  return localStorage.getItem(STORAGE.theme) || "light";
}

function themeLabel() {
  return document.documentElement.dataset.theme === "dark" ? "Tema claro" : "Tema escuro";
}

function themeIcon() {
  return icon(document.documentElement.dataset.theme === "dark" ? "sun" : "moon");
}

function updateThemeButtons() {
  document.querySelectorAll("[data-theme-icon]").forEach((button) => {
    button.setAttribute("aria-label", themeLabel());
    button.setAttribute("title", themeLabel());
    button.innerHTML = themeIcon();
  });
}

function updateThemeSegments(theme) {
  document.querySelectorAll("[data-theme-segment]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.themeSegment === theme);
  });
}

/* renderFooter / renderHeader (legacy) substituted by renderSiteFooter / renderDesktopSidebar / renderMobileTopbar */

function icon(name) {
  const icons = {
    alert: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v6"></path><path d="M12 16h.01"></path>',
    arrowLeft: '<path d="m15 18-6-6 6-6"></path>',
    arrowRight: '<path d="m9 6 6 6-6 6"></path>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H7a3 3 0 0 0-3 3z"></path><path d="M4 5.5V22"></path><path d="M8 7h8"></path>',
    bookmark: '<path d="M6 4h12v17l-6-4-6 4z"></path>',
    bulb: '<path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M12 2a7 7 0 0 1 4 12.7c-.6.6-1 1.4-1 2.3v1H9v-1c0-.9-.4-1.7-1-2.3A7 7 0 0 1 12 2z"></path>',
    check: '<path d="M20 6 9 17l-5-5"></path>',
    chevronDown: '<path d="m6 9 6 6 6-6"></path>',
    clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
    download: '<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path>',
    barChart: '<path d="M3 3v18h18"></path><rect x="7" y="13" width="3" height="6" rx="1"></rect><rect x="12" y="9" width="3" height="10" rx="1"></rect><rect x="17" y="5" width="3" height="14" rx="1"></rect>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>',
    flame: '<path d="M12 2c.5 3 2.5 4 3.5 6 1 2 1 4 0 6a4.5 4.5 0 0 1-9 0c0-2 1-3.5 2-5 .5 1 1.5 1.5 2.5 1.5 0-2.5-1-4 1-8.5z"></path>',
    eyeOff: '<path d="m3 3 18 18"></path><path d="M10.6 6.1A10 10 0 0 1 22 12a18 18 0 0 1-3.3 4.4"></path><path d="M6.6 6.6A18 18 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.6-1.1"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><path d="M14 3v6h6"></path><path d="M8 13h8"></path><path d="M8 17h5"></path>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path>',
    menu: '<path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h16"></path>',
    swap: '<path d="M4 8h13"></path><path d="M14 4l3 4-3 4"></path><path d="M20 16H7"></path><path d="M10 20l-3-4 3-4"></path>',
    upload: '<path d="M12 20V8"></path><path d="M7 13l5-5 5 5"></path><path d="M4 4h16"></path>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"></path><path d="M10 19a2 2 0 0 0 4 0"></path>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path><path d="M12 7v5l4 2"></path>',
    home: '<path d="m3 10 9-7 9 7"></path><path d="M5 10v10h14V10"></path><path d="M9 20v-6h6v6"></path>',
    moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 7 7 0 1 0 20.5 14.5z"></path>',
    play: '<path d="m8 5 12 7-12 7z"></path>',
    refresh: '<path d="M21 12a9 9 0 0 1-15 6.7"></path><path d="M3 12a9 9 0 0 1 15-6.7"></path><path d="M21 4v6h-6"></path><path d="M3 20v-6h6"></path>',
    shield: '<path d="M12 3 4 6v6c0 5 3.4 8.2 8 9 4.6-.8 8-4 8-9V6z"></path><path d="M9 12l2 2 4-5"></path>',
    sliders: '<path d="M4 7h10"></path><path d="M18 7h2"></path><path d="M16 5v4"></path><path d="M4 17h2"></path><path d="M10 17h10"></path><path d="M8 15v4"></path>',
    spark: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"></path>',
    sun: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path>',
    whatsapp: '<path d="M20.5 3.4A11 11 0 0 0 3.5 17.3L2 22l4.8-1.5A11 11 0 1 0 20.5 3.4z"></path><path d="M16.5 14.3c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.2-.7.2-.2.3-.8.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.6.1-.1.3-.3.4-.5.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5-.1-.1-.7-1.6-1-2.2-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.2 5.2 4.5.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.7-.7 2-1.4.3-.7.3-1.3.2-1.4-.1-.1-.3-.2-.6-.3z"></path>',
    target: '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1"></circle>',
    trash: '<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 15H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>',
    x: '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>'
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.target}</svg>`;
}

function renderWarnings() {
  return `
    <section class="warning-box">
      <strong>Auditoria do banco</strong>
      <ul>${state.validationWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
    </section>
  `;
}

function metricCard(value, label, iconName) {
  const name = iconName || metricIcon(label);
  const tone = metricTone(name);
  const labelText = String(label || "");
  const valueText = String(value ?? 0);
  const isTime = labelText.toLowerCase().includes("tempo");
  const cardClass = isTime ? " metric-card--time stat-card--time" : "";
  return `
    <div class="metric-card stat-card${cardClass}">
      <span class="metric-icon stat-icon ${tone}" aria-hidden="true">${icon(name)}</span>
      <span class="metric-text stat-text">
        <strong class="metric-value stat-value" title="${escapeAttr(valueText)}">${escapeHtml(valueText)}</strong>
        <span class="metric-label stat-label" title="${escapeAttr(labelText)}">${escapeHtml(labelText)}</span>
      </span>
    </div>
  `;
}

function metricIcon(label) {
  const text = String(label).toLowerCase();
  if (text.includes("assunto")) return "book";
  if (text.includes("tentativa") || text.includes("simulado")) return "file";
  if (text.includes("revis")) return "refresh";
  if (text.includes("acerto") || text.includes("acur") || text.includes("aproveitamento")) return "target";
  if (text.includes("tempo")) return "clock";
  if (text.includes("hist")) return "history";
  if (text.includes("limite") || text.includes("uso")) return "spark";
  return "file";
}

function metricTone(iconName) {
  const map = {
    file: "",
    book: "tone-book",
    bookmark: "tone-bookmark",
    refresh: "tone-refresh",
    target: "tone-target",
    clock: "tone-clock",
    history: "tone-history",
    check: "tone-target",
    x: "tone-refresh",
    spark: "tone-bookmark"
  };
  return map[iconName] || "";
}

function toggleInArray(array, value) {
  const index = array.indexOf(value);
  if (index >= 0) array.splice(index, 1);
  else array.push(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function shuffleArray(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function loadLastConfig() {
  return safeJson(localStorage.getItem(STORAGE.lastConfig), {});
}

function saveLastConfig() {
  localStorage.setItem(STORAGE.lastConfig, JSON.stringify(state.filters));
}

function normalizeStoredFilters(filters) {
  return {
    mode: ["geral", "personalizado", "erros"].includes(filters.mode) ? filters.mode : "geral",
    selectedGroups: Array.isArray(filters.selectedGroups) ? filters.selectedGroups : [],
    selectedSubjects: Array.isArray(filters.selectedSubjects) ? filters.selectedSubjects : [],
    selectedSubthemes: Array.isArray(filters.selectedSubthemes) ? filters.selectedSubthemes : [],
    quantity: Math.max(1, Math.floor(Number(filters.quantity || filters.quantidade || 20))),
    shuffleQuestions: filters.shuffleQuestions !== false
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (minutes < 60) return `${minutes}min ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours > 99) return "99h+";
  return `${hours}h ${String(rest).padStart(2, "0")}min`;
}

function formatAverageTime(ms) {
  return formatDuration(ms);
}

function formatMMSS(ms) {
  const totalSeconds = Math.max(0, Math.round((ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, safeNumber(value)));
}

function app() {
  return document.getElementById("app");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

window.unlockApp = unlockApp;
window.togglePasswordVisibility = togglePasswordVisibility;
window.goHomeFromBrand = goHomeFromBrand;
window.closeConfirmModal = closeConfirmModal;
window.toggleTheme = toggleTheme;
window.renderHome = renderHome;
window.renderHistory = renderHistory;
window.renderReviewMode = renderReviewMode;
window.setMode = setMode;
window.toggleFilter = toggleFilter;
window.toggleGroupExpansion = toggleGroupExpansion;
window.setQuantity = setQuantity;
window.setShuffleQuestions = setShuffleQuestions;
window.selectAllContent = selectAllContent;
window.clearContentSelection = clearContentSelection;
window.quickGeneral = quickGeneral;
window.startQuiz = startQuiz;
window.selectAlternative = selectAlternative;
window.submitAnswer = submitAnswer;
window.nextQuestion = nextQuestion;
window.previousQuestion = previousQuestion;
window.finishQuiz = finishQuiz;
window.adjustQuantity = adjustQuantity;
window.toggleSavedQuestion = toggleSavedQuestion;
window.clearWrongAnswers = clearWrongAnswers;
window.clearHistory = clearHistory;
window.clearSavedQuestions = clearSavedQuestions;
window.clearPreferences = clearPreferences;
window.clearAllLocalData = clearAllLocalData;
window.optimizeHistoryStorage = optimizeHistoryStorage;
window.exportHistory = exportHistory;
window.exportHistoryJSON = exportHistoryJSON;
window.exportHistoryCSV = exportHistoryCSV;
window.exportHistoryPDF = exportHistoryPDF;
window.exportErrorsJSON = exportErrorsJSON;
window.exportErrorsCSV = exportErrorsCSV;
window.exportErrorsPDF = exportErrorsPDF;
window.toggleExportMenu = toggleExportMenu;
window.openSubthemeModal = openSubthemeModal;
window.closeSubthemeModal = closeSubthemeModal;
window.filterSubthemes = filterSubthemes;
window.clearSubthemeSelection = clearSubthemeSelection;
window.reviewErrorsFromHistory = reviewErrorsFromHistory;
window.repeatLastFilters = repeatLastFilters;
window.navigateTo = navigateTo;
window.navigateToAnchor = navigateToAnchor;
window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;
window.toggleSidebar = toggleSidebar;
window.setTheme = setTheme;
window.openUnifiedExportPopover = openUnifiedExportPopover;
window.closeUnifiedExportPopoverOnce = closeUnifiedExportPopoverOnce;
window.openImportFilePicker = openImportFilePicker;
window.dismissToast = dismissToast;
window.showToast = showToast;
