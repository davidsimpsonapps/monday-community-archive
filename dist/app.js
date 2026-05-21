const $ = (id) => document.getElementById(id);

const panels = {
  home: $("panel-home"),
  category: $("panel-category"),
  topic: $("panel-topic"),
  search: $("panel-search"),
};

const BASE_TITLE = "Community knowledge base";
const SEARCH_LIMIT = 50;
const mqSidebar = window.matchMedia("(min-width: 721px)");

function showPanel(name) {
  Object.entries(panels).forEach(([k, el]) => {
    if (!el) return;
    const on = k === name;
    el.classList.toggle("hidden", !on);
    el.setAttribute("aria-hidden", on ? "false" : "true");
  });
}

function setLoadingVisible(el, visible) {
  if (!el) return;
  el.classList.toggle("hidden", !visible);
  el.setAttribute("aria-hidden", visible ? "false" : "true");
}

function syncSidebarFold() {
  const d = $("cat-fold");
  if (!d) return;
  if (mqSidebar.matches) d.setAttribute("open", "");
}

function closeMobileCategoryFold() {
  const d = $("cat-fold");
  if (!d || mqSidebar.matches) return;
  d.removeAttribute("open");
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      const parts = [j.error, j.detail].filter(Boolean);
      throw new Error(parts.length ? parts.join(" — ") : text);
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error(text);
      throw e;
    }
  }
  return res.json();
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatShortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const PAGE_SIZE = 50;

let categories = [];
let activeCategoryId = null;
let categoryPaging = { offset: 0, total: 0, loading: false };
/** @type {Record<string, unknown> | null} */
let archiveMeta = null;

// ── Lunr search state ─────────────────────────────────────────────────────────
let searchIndex = null;   // lunr.Index instance, loaded on first search
let searchDocs  = null;   // id → doc store object
let searchReady = false;
let searchLoading = false;

async function ensureSearchIndex() {
  if (searchReady) return true;
  if (searchLoading) {
    // Already in flight — wait for it
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!searchLoading) { clearInterval(check); resolve(); }
      }, 50);
    });
    return searchReady;
  }
  searchLoading = true;
  try {
    const [rawIdx, rawDocs] = await Promise.all([
      fetch("/api/search-index.json").then(r => r.json()),
      fetch("/api/search-docs.json").then(r => r.json()),
    ]);
    searchIndex = lunr.Index.load(rawIdx);
    searchDocs  = rawDocs;
    searchReady = true;
  } catch (err) {
    console.error("Failed to load search index:", err);
    searchReady = false;
  } finally {
    searchLoading = false;
  }
  return searchReady;
}
// ─────────────────────────────────────────────────────────────────────────────

function topicShareUrl(topicId, slug) {
  const base = `${location.origin}${location.pathname}${location.search}`;
  const s = slug != null && String(slug).trim() ? String(slug).trim() : "";
  if (s) {
    return `${base}#/t/${encodeURIComponent(s)}/${topicId}`;
  }
  return `${base}#/t/${topicId}`;
}

async function copyTopicLink(topicId, slug) {
  const url = topicShareUrl(topicId, slug);
  const btn = $("copy-topic-link");
  try {
    await navigator.clipboard.writeText(url);
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = prev;
      }, 2000);
    }
  } catch {
    window.prompt("Copy this link:", url);
  }
}

function wireTopicShareActions(topicId, slug) {
  const copyBtn = $("copy-topic-link");
  const tabBtn = $("open-full-tab");
  copyBtn?.classList.remove("hidden");
  tabBtn?.classList.remove("hidden");
  if (copyBtn) {
    copyBtn.onclick = () => {
      void copyTopicLink(topicId, slug);
    };
  }
  if (tabBtn) {
    tabBtn.onclick = () => {
      window.open(topicShareUrl(topicId, slug), "_blank", "noopener,noreferrer");
    };
  }
}

function hideTopicShareActions() {
  $("copy-topic-link")?.classList.add("hidden");
  $("open-full-tab")?.classList.add("hidden");
}

function categoryName(id) {
  const c = categories.find((x) => x.id === id);
  return c ? c.name : `Category ${id}`;
}

/* ——— Hash routing: #/ #/c/:id #/t/:id #/search?q=… ——— */

function parseHash() {
  const raw = (location.hash || "").replace(/^#/, "").trim() || "/";
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  const qIdx = normalized.indexOf("?");
  const pathPart = qIdx >= 0 ? normalized.slice(0, qIdx) : normalized;
  const queryString = qIdx >= 0 ? normalized.slice(qIdx + 1) : "";
  const seg = pathPart.split("/").filter(Boolean);
  if (seg.length === 0) return { type: "home" };
  if (seg[0] === "c" && seg[1] != null) {
    const id = Number(seg[1]);
    return Number.isFinite(id) ? { type: "category", id } : { type: "home" };
  }
  if (seg[0] === "t" && seg[1] != null) {
    const last = seg[seg.length - 1];
    const id = Number(last);
    if (Number.isFinite(id)) {
      return { type: "topic", id };
    }
    if (seg.length === 2) {
      return {
        type: "topicSlug",
        slug: decodeURIComponent(seg[1].replace(/\+/g, " ")),
      };
    }
    return { type: "home" };
  }
  if (seg[0] === "search") {
    const p = new URLSearchParams(queryString);
    const q = (p.get("q") || "").trim();
    return { type: "search", q };
  }
  return { type: "home" };
}

function routeToHash(route) {
  if (route.type === "home") return "#/";
  if (route.type === "category") return `#/c/${route.id}`;
  if (route.type === "topic") return `#/t/${route.id}`;
  if (route.type === "search") return `#/search?q=${encodeURIComponent(route.q)}`;
  return "#/";
}

function navigate(route) {
  const next = routeToHash(route);
  if (location.hash === next) {
    void applyRoute(route);
    return;
  }
  location.hash = next;
}

async function applyRoute(route) {
  if (route.type === "home") {
    showPanel("home");
    setActiveNav(null);
    document.title = BASE_TITLE;
    return;
  }
  if (route.type === "category") {
    const btn = document.querySelector(`#category-nav button[data-category-id="${route.id}"]`);
    await openCategory(route.id, btn);
    document.title = `${categoryName(route.id)} — ${BASE_TITLE}`;
    return;
  }
  if (route.type === "topicSlug") {
    try {
      const t = await api(`/api/topics/by-slug/${encodeURIComponent(route.slug)}.json`);
      const slugSeg = encodeURIComponent(t.slug);
      history.replaceState(
        null,
        "",
        `${location.pathname}${location.search}#/t/${slugSeg}/${t.id}`,
      );
      await openTopic(t.id, t);
    } catch (err) {
      console.error(err);
      showPanel("home");
      setActiveNav(null);
      document.title = BASE_TITLE;
    }
    return;
  }
  if (route.type === "topic") {
    await openTopic(route.id);
    return;
  }
  if (route.type === "search") {
    if (!route.q) {
      navigate({ type: "home" });
      return;
    }
    const input = $("search-input");
    if (input) input.value = route.q;
    await runSearch(route.q);
    document.title = `Search: ${route.q} — ${BASE_TITLE}`;
  }
}

async function loadArchiveMeta() {
  try {
    archiveMeta = await api("/api/meta.json");
  } catch {
    archiveMeta = null;
  }
}

function applyFooterFromMeta() {
  const el = $("footer-line");
  if (!el) return;
  const base = "Read-only snapshot — not the live community.";
  const meta = archiveMeta;
  if (meta?.exportedAt) {
    const when = new Date(meta.exportedAt);
    const line = Number.isNaN(when.getTime())
      ? base
      : `${base} Exported ${when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`;
    el.textContent =
      meta.topicCount != null ? `${line} (${Number(meta.topicCount).toLocaleString()} topics in export.)` : line;
  } else {
    el.textContent = base;
  }
}

async function loadFeatured() {
  const loading = $("featured-loading");
  const reqSection = $("featured-requests");
  const activeSection = $("featured-active");
  const emptyEl = $("featured-empty");
  try {
    const data = await api("/api/featured.json");
    const reqList = $("featured-requests-list");
    const activeList = $("featured-active-list");
    if (data.topFeatureRequests?.length) {
      appendTopicRows(reqList, data.topFeatureRequests);
      reqSection.classList.remove("hidden");
    }
    if (data.mostActiveThreads?.length) {
      appendTopicRows(activeList, data.mostActiveThreads);
      activeSection.classList.remove("hidden");
    }
    if (!data.topFeatureRequests?.length && !data.mostActiveThreads?.length) {
      emptyEl?.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Failed to load featured:", err);
    emptyEl?.classList.remove("hidden");
  } finally {
    setLoadingVisible(loading, false);
  }
}


async function loadCategories() {
  categories = await api("/api/categories.json");
  const nav = $("category-nav");
  nav.innerHTML = "";
  if (!categories.length) {
    nav.innerHTML =
      "<p class=\"nav-empty\">No categories. If you expected data: run <code>etl/npm run export</code>, copy <code>etl/out</code> to <code>app/data/archive</code>, set <code>ARCHIVE_DATA_DIR</code>, or load MongoDB + object storage (see README).</p>";
    $("panel-home").innerHTML =
      "<p>No archive data loaded. The API returned zero categories.</p><p class=\"meta\">Local: ensure the server resolves <code>app/data/archive/manifests/categories.json</code> (run <code>npm run dev</code> from the <code>app</code> folder, or set <code>ARCHIVE_DATA_DIR</code> to your export).</p>";
    return;
  }
  const homeBtn = document.createElement("button");
  homeBtn.type = "button";
  homeBtn.dataset.categoryId = "home";
  homeBtn.className = "nav-home";
  homeBtn.textContent = "Home";
  homeBtn.addEventListener("click", () => navigate({ type: "home" }));
  nav.appendChild(homeBtn);

  const HIDDEN_CATEGORY = 58;
  categories
    .filter((c) => c.id !== HIDDEN_CATEGORY)
    .forEach((c) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.categoryId = String(c.id);
      const count = typeof c.topic_count === "number" ? c.topic_count : null;
      btn.innerHTML =
        count != null
          ? `${esc(c.name)}<span class="nav-cat-count">${count.toLocaleString()}</span>`
          : esc(c.name);
      btn.addEventListener("click", () => navigate({ type: "category", id: c.id }));
      nav.appendChild(btn);
    });
}

function setActiveNav(categoryId) {
  document.querySelectorAll("#category-nav button").forEach((b) => {
    const isMatch =
      categoryId == null
        ? b.dataset.categoryId === "home"
        : b.dataset.categoryId === String(categoryId);
    b.classList.toggle("active", isMatch);
    if (isMatch) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
}

function buildTopicRowButton(t) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "topic-row-hit";
  const excerpt = (t.excerpt || "").slice(0, 180);
  const excerptTail = (t.excerpt || "").length > 180 ? "…" : "";
  const posts = typeof t.postsCount === "number" ? t.postsCount : null;
  const dateStr = formatShortDate(t.lastPostedAt || t.bumpedAt || t.createdAt);
  const solved = t.solvedPostId ? `<span class="solved-pill">Solved</span>` : "";
  const likes = typeof t.likeCount === "number" && t.likeCount > 0
    ? `<span class="likes-pill">\u2665 ${t.likeCount.toLocaleString()}</span>` : "";
  b.innerHTML = `
    <span class="topic-row-main">
      <span class="topic-row-title">${esc(t.title)}</span>
      <span class="topic-row-excerpt">${esc(excerpt)}${excerptTail}</span>
    </span>
    <span class="topic-row-meta">
      ${likes}
      ${posts != null ? `<span>${posts} ${posts === 1 ? "post" : "posts"}</span>` : ""}
      ${dateStr ? `<span>${esc(dateStr)}</span>` : ""}
      ${solved}
    </span>`;
  b.addEventListener("click", () => navigate({ type: "topic", id: t.id }));
  return b;
}

function appendTopicRows(ul, items) {
  items.forEach((t) => {
    const li = document.createElement("li");
    li.appendChild(buildTopicRowButton(t));
    ul.appendChild(li);
  });
}

function updateCategoryPagingUi() {
  const { offset, total } = categoryPaging;
  const meta = $("category-meta");
  const btn = $("load-more-topics");
  if (total === 0) {
    meta.innerHTML = "";
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "category-empty";
    emptyDiv.innerHTML = `<p>No threads in this category.</p><p>Try <button type="button" class="link-btn" id="empty-search-link">searching</button> or pick another category from the sidebar.</p>`;
    meta.after(emptyDiv);
    emptyDiv.querySelector("#empty-search-link")?.addEventListener("click", () => {
      $("search-input")?.focus();
    });
    btn.classList.add("hidden");
    return;
  }
  meta.textContent = `Showing ${Math.min(offset, total).toLocaleString()} of ${total.toLocaleString()} threads`;
  if (offset < total) {
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
}

async function fetchCategoryPage(categoryId) {
  const { offset } = categoryPaging;
  // Flat static file — query params encoded into filename by scraper
  return api(`/api/categories/${categoryId}/topics__offset_${offset}__limit_${PAGE_SIZE}.json`);
}

async function openCategory(id, _navBtn) {
  activeCategoryId = id;
  categoryPaging = { offset: 0, total: 0, loading: false };
  setActiveNav(id);
  showPanel("category");
  closeMobileCategoryFold();
  const cat = categories.find((c) => c.id === id);
  $("category-title").textContent = cat ? cat.name : `Category ${id}`;
  document.querySelector(".category-empty")?.remove();
  const ul = $("topic-list");
  ul.innerHTML = "";
  const loading = $("category-loading");
  setLoadingVisible(loading, true);
  $("load-more-topics").onclick = async () => {
    if (categoryPaging.loading || categoryPaging.offset >= categoryPaging.total) return;
    await loadNextTopicPage(id);
  };
  try {
    await loadNextTopicPage(id);
  } finally {
    setLoadingVisible(loading, false);
  }
}

async function loadNextTopicPage(categoryId) {
  if (categoryPaging.loading) return;
  categoryPaging.loading = true;
  try {
    const data = await fetchCategoryPage(categoryId);
    categoryPaging.total = data.total;
    const ul = $("topic-list");
    appendTopicRows(ul, data.items);
    categoryPaging.offset += data.items.length;
    updateCategoryPagingUi();
  } finally {
    categoryPaging.loading = false;
  }
}

function renderTopicBreadcrumbs(topicTitle, categoryId) {
  const nav = $("topic-breadcrumbs");
  if (!nav) return;
  const ol = document.createElement("ol");
  const liHome = document.createElement("li");
  const homeBtn = document.createElement("button");
  homeBtn.type = "button";
  homeBtn.textContent = "Home";
  homeBtn.addEventListener("click", () => navigate({ type: "home" }));
  liHome.appendChild(homeBtn);
  ol.appendChild(liHome);

  if (categoryId != null) {
    const liCat = document.createElement("li");
    const catBtn = document.createElement("button");
    catBtn.type = "button";
    catBtn.textContent = categoryName(categoryId);
    catBtn.addEventListener("click", () => navigate({ type: "category", id: categoryId }));
    liCat.appendChild(catBtn);
    ol.appendChild(liCat);
  }

  const liCur = document.createElement("li");
  const span = document.createElement("span");
  span.setAttribute("aria-current", "page");
  span.textContent = topicTitle.length > 60 ? `${topicTitle.slice(0, 57)}…` : topicTitle;
  liCur.appendChild(span);
  ol.appendChild(liCur);

  nav.innerHTML = "";
  nav.appendChild(ol);
}

async function openTopic(id, prefetched = null) {
  showPanel("topic");
  hideTopicShareActions();
  const loading = $("topic-loading");
  const postsEl = $("topic-posts");
  postsEl.innerHTML = "";
  setLoadingVisible(loading, true);
  $("topic-title").textContent = "…";
  $("topic-meta").textContent = "";
  document.title = BASE_TITLE;
  renderTopicBreadcrumbs("Thread", activeCategoryId);

  const back = $("back-to-category");
  const backCatId = activeCategoryId;
  back.textContent =
    backCatId != null ? `← Back to ${categoryName(backCatId)}` : "← Back to home";
  back.onclick = () => {
    if (backCatId != null) {
      navigate({ type: "category", id: backCatId });
    } else {
      navigate({ type: "home" });
    }
  };

  try {
    const t = prefetched ?? (await api(`/api/topics/${id}.json`));
    $("topic-title").textContent = t.title;
    document.title = `${t.title} — ${BASE_TITLE}`;
    const catLabel = categoryName(t.categoryId);
    const lastStr = formatShortDate(t.lastPostedAt || t.createdAt);
    $("topic-meta").textContent = [
      `${t.postsCount} ${t.postsCount === 1 ? "post" : "posts"}`,
      `in ${catLabel}`,
      lastStr ? `last activity ${lastStr}` : null,
      t.solvedPostId ? "has accepted answer" : null,
    ]
      .filter(Boolean)
      .join(" · ");

    renderTopicBreadcrumbs(t.title, t.categoryId);
    activeCategoryId = t.categoryId;

    back.textContent = `← Back to ${catLabel}`;
    back.onclick = () => {
      navigate({ type: "category", id: t.categoryId });
    };

    wireTopicShareActions(t.id, t.slug);

    t.posts.forEach((p) => {
      const art = document.createElement("article");
      const isSolved = p.id === t.solvedPostId;
      if (isSolved) art.classList.add("post--accepted");
      const badge = isSolved
        ? `<span class="badge badge--solved" role="status">Accepted answer</span>`
        : "";
      art.innerHTML = `<div class="post-head">${badge}<span>${esc(p.author)}</span><time datetime="${esc(p.createdAt)}">${esc(new Date(p.createdAt).toLocaleString())}</time></div><div class="cooked">${p.cookedHtml}</div>`;
      postsEl.appendChild(art);
    });
  } catch (err) {
    console.error(err);
    hideTopicShareActions();
    postsEl.innerHTML =
      "<p class=\"meta\">This thread could not be loaded. It may be missing from the archive.</p>";
    $("topic-title").textContent = "Not found";
    document.title = `Not found — ${BASE_TITLE}`;
    renderTopicBreadcrumbs("Error", null);
    back.textContent = "← Back to home";
    back.onclick = () => navigate({ type: "home" });
  } finally {
    setLoadingVisible(loading, false);
  }
}

// ── Search (Lunr client-side) ─────────────────────────────────────────────────
async function runSearch(q) {
  showPanel("search");
  setActiveNav(null);
  const ul      = $("search-results");
  const empty   = $("search-empty");
  const meta    = $("search-query-meta");
  const loading = $("search-loading");
  const heading = $("search-results-heading");

  ul.innerHTML = "";
  empty.classList.add("hidden");
  meta.classList.remove("hidden");
  if (heading) heading.textContent = `Results for \u201c${q}\u201d`;
  meta.textContent = "Loading search index…";
  setLoadingVisible(loading, true);

  try {
    const ready = await ensureSearchIndex();
    if (!ready) {
      meta.textContent = "Search index unavailable.";
      empty.classList.remove("hidden");
      return;
    }

    meta.textContent = "Searching…";

    // Try exact query first; if it throws (e.g. special chars), fall back to
    // individual terms with optional fuzzy matching (~1)
    let hits;
    try {
      hits = searchIndex.search(q);
    } catch {
      const terms = q.trim().split(/\s+/).filter(Boolean);
      const fuzzyQuery = terms.map(t => `${t}~1`).join(" ");
      try {
        hits = searchIndex.search(fuzzyQuery);
      } catch {
        hits = [];
      }
    }

    // Lunr returns results sorted by score — cap at SEARCH_LIMIT
    const topHits = hits.slice(0, SEARCH_LIMIT);
    const results = topHits.map(h => searchDocs[h.ref]).filter(Boolean);

    const n = results.length;
    meta.textContent = n === 0
      ? "No threads matched."
      : `${n.toLocaleString()} ${n === 1 ? "thread" : "threads"} found`;

    if (!results.length) {
      empty.classList.remove("hidden");
      return;
    }

    results.forEach((t) => {
      const li = document.createElement("li");
      li.appendChild(buildTopicRowButton(t));
      ul.appendChild(li);
    });
  } finally {
    setLoadingVisible(loading, false);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function syncSearchClear() {
  const input = $("search-input");
  const btn = $("search-clear-inline");
  if (!input || !btn) return;
  btn.classList.toggle("hidden", !input.value.trim());
}

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("search-input").value.trim();
  if (!q) return;
  navigate({ type: "search", q });
});

$("search-input")?.addEventListener("input", syncSearchClear);

$("search-clear-inline")?.addEventListener("click", () => {
  const input = $("search-input");
  if (input) {
    input.value = "";
    input.focus();
  }
  syncSearchClear();
  navigate({ type: "home" });
});

window.addEventListener("hashchange", () => {
  void applyRoute(parseHash());
});

function syncMobileCatPrompt() {
  const prompt = $("mobile-cat-prompt");
  const fold = $("cat-fold");
  if (!prompt || !fold || mqSidebar.matches) {
    prompt?.classList.add("hidden");
    return;
  }
  prompt.classList.toggle("hidden", fold.hasAttribute("open"));
}

$("cat-fold")?.addEventListener("toggle", syncMobileCatPrompt);

$("mobile-cat-btn")?.addEventListener("click", () => {
  const fold = $("cat-fold");
  if (fold) fold.setAttribute("open", "");
  syncMobileCatPrompt();
  fold?.scrollIntoView({ behavior: "smooth", block: "start" });
});

mqSidebar.addEventListener("change", () => {
  syncSidebarFold();
  syncMobileCatPrompt();
});

Promise.all([loadCategories(), loadArchiveMeta(), loadFeatured()])
  .then(() => {
    applyFooterFromMeta();
    syncSidebarFold();
    syncMobileCatPrompt();
    return applyRoute(parseHash());
  })
  .catch((err) => {
    console.error(err);
    $("content").innerHTML = `<p class="meta">Failed to load archive. Check server logs and configuration.</p><pre>${esc(String(err))}</pre>`;
  });
