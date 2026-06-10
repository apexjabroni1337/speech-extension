// SPEECH — content script. Injects a floating button + comment sidebar
// on every page, isolated inside a shadow root.

(() => {
  if (window.top !== window) return; // skip iframes
  if (document.documentElement.dataset.speechInjected) return;
  document.documentElement.dataset.speechInjected = "1";

  // ---------- messaging ----------
  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(res || { error: "No response" });
        });
      } catch (e) {
        resolve({ error: e.message });
      }
    });
  }

  // ---------- tiny DOM helper ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 2592000) return `${Math.floor(s / 86400)}d`;
    return new Date(iso).toLocaleDateString();
  }

  // ---------- state ----------
  const state = {
    open: false,
    auth: { signedIn: false },
    page: null,
    comments: [],
    myVotes: {},
    myId: null,
    count: 0,
    href: location.href,
    loading: false,
    websiteUrl: "",
    muted: new Set()
  };

  async function loadMuted() {
    try {
      const { mutedUsers = [] } = await chrome.storage.local.get("mutedUsers");
      state.muted = new Set(mutedUsers);
    } catch {}
  }
  function saveMuted() {
    chrome.storage.local.set({ mutedUsers: [...state.muted] });
  }

  // ---------- shadow root ----------
  const host = document.createElement("div");
  host.id = "speech-root-host";
  host.style.cssText = "all:initial; position:fixed; z-index:2147483647;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .fab {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
      display: flex; align-items: center; gap: 7px;
      background: #4f46e5; color: #fff; border: none; border-radius: 999px;
      padding: 10px 16px; font-size: 14px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.25);
    }
    .fab:hover { background: #4338ca; }
    .fab .cnt { background: rgba(255,255,255,.25); border-radius: 999px; padding: 1px 8px; font-size: 12px; }
    .panel {
      position: fixed; top: 0; right: 0; height: 100vh; width: 390px; max-width: 95vw;
      background: #ffffff; color: #111827; z-index: 2147483647;
      box-shadow: -6px 0 24px rgba(0,0,0,.2);
      display: flex; flex-direction: column; font-size: 14px;
    }
    .hdr { padding: 14px 16px; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; gap: 10px; }
    .hdr .brand { font-weight: 800; font-size: 16px; color: #4f46e5; letter-spacing: .3px; }
    .hdr .dom { color: #6b7280; font-size: 12px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .x { background: none; border: none; font-size: 18px; cursor: pointer; color: #6b7280; padding: 4px; }
    .x:hover { color: #111827; }
    .body { flex: 1; overflow-y: auto; padding: 12px 16px; }
    .composer { border-top: 1px solid #e5e7eb; padding: 12px 16px; }
    textarea {
      width: 100%; min-height: 64px; resize: vertical; border: 1px solid #d1d5db;
      border-radius: 10px; padding: 9px 11px; font-size: 14px; color: #111827; background: #fff;
    }
    textarea:focus, input:focus { outline: 2px solid #c7d2fe; border-color: #4f46e5; }
    input[type=text], input[type=email], input[type=password] {
      width: 100%; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 10px; font-size: 14px;
      color: #111827; background: #fff; margin-bottom: 8px;
    }
    .btn {
      background: #4f46e5; color: #fff; border: none; border-radius: 8px;
      padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .btn:hover { background: #4338ca; }
    .btn.ghost { background: #eef2ff; color: #4f46e5; }
    .btn:disabled { opacity: .5; cursor: default; }
    .row { display: flex; gap: 8px; align-items: center; }
    .muted { color: #6b7280; font-size: 12px; }
    .err { color: #b91c1c; font-size: 12px; margin-top: 6px; white-space: pre-wrap; }
    .notice { background: #f3f4f6; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
    .c { padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
    .c.reply { margin-left: 26px; }
    .c .meta { display: flex; gap: 8px; align-items: baseline; margin-bottom: 3px; }
    .c .u { font-weight: 700; font-size: 13px; color: #111827; }
    .c .t { color: #9ca3af; font-size: 11px; }
    .c .b { white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; }
    .c .b.del { color: #9ca3af; font-style: italic; }
    .acts { display: flex; gap: 12px; margin-top: 6px; align-items: center; }
    .vote { display: flex; gap: 4px; align-items: center; }
    .va { background: none; border: none; cursor: pointer; font-size: 13px; color: #9ca3af; padding: 2px 3px; }
    .va.on-up { color: #16a34a; } .va.on-dn { color: #dc2626; }
    .score { font-size: 12px; font-weight: 700; color: #374151; min-width: 14px; text-align: center; }
    .lnk { background: none; border: none; cursor: pointer; font-size: 12px; color: #6b7280; padding: 0; }
    .lnk:hover { color: #4f46e5; }
    .empty { text-align: center; color: #9ca3af; padding: 30px 10px; }
    .tabs { display:flex; gap:6px; margin-bottom:10px; }
    .tabs button { flex:1; }
    h3 { margin: 0 0 10px; font-size: 15px; }
    .u.clickable { cursor: pointer; }
    .u.clickable:hover { color: #4f46e5; text-decoration: underline; }
    .pp-wrap { position: absolute; inset: 0; background: rgba(17,24,39,.45); display: flex; align-items: center; justify-content: center; z-index: 10; }
    .pp { background: #fff; border-radius: 14px; padding: 20px; width: 300px; max-width: 86%; position: relative; box-shadow: 0 12px 40px rgba(0,0,0,.25); text-align: center; }
    .pp-x { position: absolute; top: 8px; right: 8px; }
    .pp-ava { width: 56px; height: 56px; border-radius: 50%; background: #4f46e5; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 800; margin: 0 auto 8px; }
    .pp-name { font-weight: 800; font-size: 16px; color: #111827; }
    .pp-user { color: #6b7280; font-size: 12px; margin-bottom: 6px; }
    .pp-bio { font-size: 13px; color: #374151; margin: 6px 0; max-height: 80px; overflow: hidden; white-space: pre-wrap; }
    .pp-meta { color: #9ca3af; font-size: 11px; margin-bottom: 12px; }
    a.btn { text-decoration: none; display: inline-block; }
    .star { font-size: 11px; cursor: default; }
    .supchip { display: inline-block; background: #fef3c7; color: #92400e; border: 1px solid #fcd34d;
      border-radius: 999px; padding: 1px 9px; font-size: 11px; font-weight: 700; margin: 4px 0 2px; }
  `;
  shadow.appendChild(style);

  const fab = el("button", { class: "fab", onclick: () => togglePanel() });
  shadow.appendChild(fab);

  let panel = null;

  function renderFab() {
    const kids = [el("span", { text: "💬 Speech" })];
    if (state.count > 0) kids.push(el("span", { class: "cnt", text: String(state.count) }));
    fab.replaceChildren(...kids);
  }

  // ---------- panel ----------

  async function togglePanel() {
    state.open = !state.open;
    if (state.open) {
      await refreshAll();
      renderPanel();
    } else if (panel) {
      panel.remove();
      panel = null;
    }
  }

  async function refreshAll() {
    state.loading = true;
    await loadMuted();
    const [auth, data] = await Promise.all([send("GET_STATE"), send("GET_PAGE_DATA", { url: location.href })]);
    state.auth = auth.error ? { signedIn: false, error: auth.error } : auth;
    if (auth.websiteUrl) state.websiteUrl = auth.websiteUrl;
    if (!data.error) {
      state.page = data.page;
      state.comments = data.comments || [];
      state.myVotes = data.myVotes || {};
      state.myId = data.myId || null;
      state.count = state.comments.length;
    } else {
      state.pageError = data.error;
    }
    state.loading = false;
    renderFab();
  }

  function renderPanel() {
    if (panel) panel.remove();
    panel = el("div", { class: "panel" });

    panel.append(
      el("div", { class: "hdr" },
        el("span", { class: "brand", text: "SPEECH" }),
        el("span", { class: "dom", text: location.hostname.replace(/^www\./, "") }),
        el("button", { class: "x", text: "✕", onclick: () => togglePanel() })
      )
    );

    const body = el("div", { class: "body" });
    panel.append(body);

    if (state.pageError) {
      body.append(el("div", { class: "notice", text: state.pageError }));
      state.pageError = null;
    }

    if (!state.auth.signedIn) body.append(authBox());

    // comments
    const top = state.comments.filter((c) => !c.parent_id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const replies = (id) => state.comments.filter((c) => c.parent_id === id);

    if (!top.length) {
      body.append(el("div", { class: "empty", text: "No comments here yet. Be the first to say something." }));
    }
    for (const c of top) {
      body.append(commentNode(c));
      for (const r of replies(c.id)) body.append(commentNode(r, true));
    }

    // composer
    const composer = el("div", { class: "composer" });
    const ta = el("textarea", { placeholder: state.auth.signedIn ? "Say what you actually think…" : "Sign in above to comment" });
    const errBox = el("div", { class: "err" });
    const postBtn = el("button", {
      class: "btn", text: "Post comment",
      onclick: async () => {
        postBtn.disabled = true; errBox.textContent = "";
        const res = await send("POST_COMMENT", { url: location.href, title: document.title, body: ta.value });
        postBtn.disabled = false;
        if (res.error) { errBox.textContent = res.error; return; }
        ta.value = "";
        state.comments.push(res.comment);
        state.count = state.comments.length;
        renderFab(); renderPanel();
      }
    });
    if (!state.auth.signedIn) { ta.disabled = true; postBtn.disabled = true; }
    composer.append(ta, el("div", { class: "row", style: "margin-top:8px; justify-content:space-between;" },
      el("span", { class: "muted", text: state.auth.signedIn ? `@${state.auth.profile?.username || ""}` : "" }),
      postBtn
    ), errBox);
    panel.append(composer);

    shadow.appendChild(panel);
  }

  // ---------- auth box ----------

  function authBox() {
    let mode = "signin";
    const box = el("div", { class: "notice" });

    function draw() {
      box.replaceChildren();
      box.append(el("div", { style: "font-weight:700; margin-bottom:8px;", text: mode === "signin" ? "Sign in" : "Create account" }));
      const email = el("input", { type: "email", placeholder: "Email" });
      const uname = el("input", { type: "text", placeholder: "Username (a-z, 0-9, _)" });
      const pw = el("input", { type: "password", placeholder: "Password (min 6 chars)" });
      const err = el("div", { class: "err" });
      const go = el("button", {
        class: "btn", text: mode === "signin" ? "Sign in" : "Sign up",
        onclick: async () => {
          go.disabled = true; err.textContent = "";
          const res = mode === "signin"
            ? await send("SIGN_IN", { email: email.value.trim(), password: pw.value })
            : await send("SIGN_UP", { email: email.value.trim(), password: pw.value, username: uname.value.trim() });
          go.disabled = false;
          if (res.error) { err.textContent = res.error; return; }
          if (res.needsConfirmation) { err.textContent = "Check your email to confirm your account, then sign in."; return; }
          await refreshAll(); renderPanel();
        }
      });
      const swap = el("button", {
        class: "lnk", text: mode === "signin" ? "New here? Create an account" : "Have an account? Sign in",
        onclick: () => { mode = mode === "signin" ? "signup" : "signin"; draw(); }
      });
      box.append(email);
      if (mode === "signup") box.append(uname);
      box.append(pw, el("div", { class: "row", style: "justify-content:space-between;" }, swap, go), err);
    }
    draw();
    return box;
  }

  // ---------- comment node ----------

  function commentNode(c, isReply = false) {
    if (state.muted.has(c.user_id)) {
      return el("div", { class: "c" + (isReply ? " reply" : "") },
        el("span", { class: "t", text: "Muted @" + (c.username || "user") + " · " }),
        el("button", {
          class: "lnk", text: "Unmute",
          onclick: () => { state.muted.delete(c.user_id); saveMuted(); renderPanel(); }
        })
      );
    }
    const node = el("div", { class: "c" + (isReply ? " reply" : "") });
    node.append(
      el("div", { class: "meta" },
        el("span", {
          class: "u clickable",
          text: c.display_name || c.username || "user",
          onclick: () => showProfile(c.user_id)
        }),
        c.is_supporter ? el("span", { class: "star", text: "⭐", title: "Supporter" }) : null,
        el("span", { class: "t", text: "@" + (c.username || "") + " · " + timeAgo(c.created_at) })
      ),
      el("div", { class: "b" + (c.is_deleted ? " del" : ""), text: c.body })
    );

    const my = state.myVotes[c.id] || 0;
    const score = el("span", { class: "score", text: String(c.score ?? 0) });
    const up = el("button", { class: "va" + (my === 1 ? " on-up" : ""), text: "▲", onclick: () => vote(c, 1) });
    const dn = el("button", { class: "va" + (my === -1 ? " on-dn" : ""), text: "▼", onclick: () => vote(c, -1) });

    const acts = el("div", { class: "acts" }, el("span", { class: "vote" }, up, score, dn));

    if (!isReply && state.auth.signedIn) {
      acts.append(el("button", { class: "lnk", text: "Reply", onclick: () => toggleReplyBox(node, c) }));
    }
    if (state.auth.signedIn && state.myId === c.user_id && !c.is_deleted) {
      acts.append(el("button", {
        class: "lnk", text: "Delete",
        onclick: async () => {
          const res = await send("DELETE_COMMENT", { commentId: c.id });
          if (!res.error) { c.is_deleted = true; c.body = "[deleted]"; renderPanel(); }
        }
      }));
    }
    if (state.page && state.websiteUrl) {
      const shareBtn = el("button", {
        class: "lnk", text: "Share",
        onclick: () => {
          const link = state.websiteUrl + "#/p/" + state.page.id;
          navigator.clipboard.writeText(link).then(() => {
            shareBtn.textContent = "Copied ✓";
            setTimeout(() => { shareBtn.textContent = "Share"; }, 1500);
          }).catch(() => { prompt("Copy this thread link:", link); });
        }
      });
      acts.append(shareBtn);
    }
    if (state.myId !== c.user_id) {
      acts.append(el("button", {
        class: "lnk", text: "Mute",
        onclick: () => { state.muted.add(c.user_id); saveMuted(); renderPanel(); }
      }));
    }
    if (state.auth.signedIn && state.myId !== c.user_id) {
      acts.append(el("button", {
        class: "lnk", text: "Report",
        onclick: async () => {
          const reason = prompt("Reason for report (spam, illegal content, etc.):");
          if (reason === null) return;
          const res = await send("REPORT_COMMENT", { commentId: c.id, reason });
          alert(res.error ? res.error : "Reported. Thanks.");
        }
      }));
    }
    node.append(acts);

    async function vote(comment, dir) {
      if (!state.auth.signedIn) return;
      const current = state.myVotes[comment.id] || 0;
      const next = current === dir ? 0 : dir;
      const res = await send("VOTE", { commentId: comment.id, value: next });
      if (res.error) return;
      state.myVotes[comment.id] = next;
      comment.score = res.score;
      score.textContent = String(res.score);
      up.className = "va" + (next === 1 ? " on-up" : "");
      dn.className = "va" + (next === -1 ? " on-dn" : "");
    }

    return node;
  }

  // ---------- mini profile popover ----------

  let ppEl = null;
  function closeProfile() {
    if (ppEl) { ppEl.remove(); ppEl = null; }
  }

  async function showProfile(userId) {
    closeProfile();
    if (!panel) return;
    const res = await send("GET_PROFILE", { userId });
    if (res.error || !res.profile) return;
    const p = res.profile;
    const site = res.websiteUrl || state.websiteUrl || "";
    const card = el("div", { class: "pp" },
      el("button", { class: "x pp-x", text: "✕", onclick: closeProfile }),
      el("div", { class: "pp-ava", text: (p.display_name || p.username || "?").slice(0, 1).toUpperCase() }),
      el("div", { class: "pp-name", text: p.display_name || p.username }),
      el("div", { class: "pp-user", text: "@" + p.username }),
      p.is_supporter ? el("div", {}, el("span", { class: "supchip", text: "⭐ Supporter" })) : null,
      p.bio ? el("div", { class: "pp-bio", text: p.bio }) : null,
      el("div", {
        class: "pp-meta",
        text: `${res.commentCount} comment${res.commentCount === 1 ? "" : "s"} · joined ${new Date(p.created_at).toLocaleDateString()}`
      }),
      el("button", {
        class: "btn",
        text: "Open full profile ↗",
        onclick: () => send("OPEN_URL", { url: site + "#/u/" + encodeURIComponent(p.username) })
      })
    );
    ppEl = el("div", { class: "pp-wrap", onclick: (e) => { if (e.target === ppEl) closeProfile(); } }, card);
    panel.append(ppEl);
  }

  function toggleReplyBox(node, c) {
    const existing = node.querySelector(".replybox");
    if (existing) { existing.remove(); return; }
    const ta = el("textarea", { placeholder: "Write a reply…", style: "min-height:48px; margin-top:8px;" });
    const err = el("div", { class: "err" });
    const btn = el("button", {
      class: "btn ghost", text: "Reply", style: "margin-top:6px;",
      onclick: async () => {
        btn.disabled = true; err.textContent = "";
        const res = await send("POST_COMMENT", { url: location.href, title: document.title, body: ta.value, parentId: c.id });
        btn.disabled = false;
        if (res.error) { err.textContent = res.error; return; }
        state.comments.push(res.comment);
        state.count = state.comments.length;
        renderFab(); renderPanel();
      }
    });
    const wrap = el("div", { class: "replybox" }, ta, btn, err);
    node.append(wrap);
    ta.focus();
  }

  // ---------- init + SPA navigation ----------

  async function initCount() {
    const res = await send("GET_COMMENT_COUNT", { url: location.href });
    if (!res.error) state.count = res.count;
    renderFab();
  }

  renderFab();
  initCount();

  setInterval(async () => {
    if (location.href !== state.href) {
      state.href = location.href;
      state.page = null; state.comments = []; state.myVotes = {};
      await initCount();
      if (state.open) { await refreshAll(); renderPanel(); }
    }
  }, 1500);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "AUTH_CHANGED" && state.open) {
      refreshAll().then(renderPanel);
    }
  });
})();
