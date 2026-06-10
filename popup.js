// SPEECH — popup: account, feed, friends, groups, interests.

const app = document.getElementById("app");
const who = document.getElementById("who");
let auth = { signedIn: false };
let tab = "feed";

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(res || { error: "No response" });
    });
  });
}

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
  return `${Math.floor(s / 86400)}d`;
}

function profileUrl(username) {
  return (auth.websiteUrl || "") + "#/u/" + encodeURIComponent(username || "");
}

function openUrl(url) {
  chrome.tabs.create({ url });
}

// ---------- boot ----------

async function boot() {
  auth = await send("GET_STATE");
  render();
}
boot();

function render() {
  who.textContent = auth.signedIn ? "@" + (auth.profile?.username || "") : "";
  app.replaceChildren();
  if (auth.error) {
    app.append(el("div", { class: "pad" }, el("div", { class: "err", text: auth.error })));
    if (String(auth.error).includes("config.js")) return;
  }
  if (!auth.signedIn) { renderAuth(); return; }

  const tabs = el("div", { class: "tabs" });
  for (const [id, label] of [["feed", "Feed"], ["alerts", "Alerts"], ["friends", "Friends"], ["groups", "Groups"], ["interests", "Tags"], ["me", "Me"]]) {
    tabs.append(el("button", { class: tab === id ? "on" : "", text: label, onclick: () => { tab = id; render(); } }));
  }
  app.append(tabs);
  const pane = el("div", { class: "pad" });
  app.append(pane);
  ({ feed: renderFeed, alerts: renderAlerts, friends: renderFriends, groups: renderGroups, interests: renderInterests, me: renderMe })[tab](pane);
}

function star(it) {
  return it.is_supporter ? el("span", { class: "star", text: " ⭐", title: "Supporter" }) : null;
}

// ---------- auth ----------

function renderAuth() {
  let mode = "signin";
  const pane = el("div", { class: "pad" });
  app.append(pane);

  function draw() {
    pane.replaceChildren();
    pane.append(el("div", { style: "font-weight:700; font-size:14px; margin-bottom:8px;", text: mode === "signin" ? "Sign in" : "Create your account" }));
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
        auth = res; render();
      }
    });
    pane.append(email);
    if (mode === "signup") pane.append(uname);
    pane.append(pw,
      el("div", { class: "row sb" },
        el("button", { class: "lnk", text: mode === "signin" ? "New here? Create an account" : "Have an account? Sign in", onclick: () => { mode = mode === "signin" ? "signup" : "signin"; draw(); } }),
        go),
      err,
      el("div", { class: "muted", style: "margin-top:12px;", text: "Comment on any page on the web — open a site and click the floating Speech button." })
    );
  }
  draw();
}

// ---------- feed ----------

async function renderFeed(pane) {
  pane.append(el("div", { class: "empty", text: "Loading…" }));
  const res = await send("FEED");
  pane.replaceChildren();
  if (res.error) { pane.append(el("div", { class: "err", text: res.error })); return; }
  if (!res.items.length) {
    pane.append(el("div", { class: "empty", text: "Nothing yet. Add friends to see what they're saying around the web." }));
    return;
  }
  for (const it of res.items) {
    pane.append(el("div", { class: "feeditem" },
      el("div", { class: "muted" },
        el("a", { class: "ulink", href: "#", onclick: (e) => { e.preventDefault(); openUrl(profileUrl(it.username)); }, text: it.display_name || it.username }),
        star(it),
        el("span", { text: ` @${it.username} · ${timeAgo(it.created_at)}` })),
      el("div", { class: "b", text: it.body }),
      el("a", { href: it.page_url, target: "_blank", text: `↗ ${it.page_title || it.page_domain || it.page_url}`.slice(0, 80) })
    ));
  }
}

// ---------- alerts (replies to you) ----------

async function renderAlerts(pane) {
  pane.append(el("div", { class: "empty", text: "Loading…" }));
  const res = await send("NOTIFICATIONS");
  send("NOTIFS_SEEN"); // mark read + clear toolbar badge
  pane.replaceChildren();
  if (res.error) { pane.append(el("div", { class: "err", text: res.error })); return; }
  if (!res.items.length) {
    pane.append(el("div", { class: "empty", text: "No replies yet. When someone replies to one of your comments, it shows up here." }));
    return;
  }
  for (const it of res.items) {
    pane.append(el("div", { class: "feeditem" },
      el("div", { class: "muted" },
        el("a", { class: "ulink", href: "#", onclick: (e) => { e.preventDefault(); openUrl(profileUrl(it.username)); }, text: it.display_name || it.username }),
        star(it),
        el("span", { text: ` replied · ${timeAgo(it.created_at)}` })),
      el("div", { class: "b", text: it.body }),
      el("div", { class: "muted", style: "font-size:11px;", text: "↳ your comment: " + (it.parent_body || "").slice(0, 70) }),
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); openUrl(it.page_url); }, text: `↗ ${it.page_title || it.page_domain || it.page_url}`.slice(0, 80) })
    ));
  }
}

// ---------- friends ----------

async function renderFriends(pane) {
  pane.append(el("div", { class: "empty", text: "Loading…" }));
  const res = await send("FRIENDS_STATE");
  pane.replaceChildren();
  if (res.error) { pane.append(el("div", { class: "err", text: res.error })); return; }

  // search/add
  const q = el("input", { type: "text", placeholder: "Find people by username…" });
  const results = el("div");
  let timer;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      results.replaceChildren();
      if (q.value.trim().length < 2) return;
      const r = await send("SEARCH_USERS", { q: q.value });
      if (r.error || !r.users) return;
      for (const u of r.users) {
        const btn = el("button", { class: "btn ghost", text: "Add", onclick: async () => {
          btn.disabled = true;
          const rr = await send("FRIEND_REQUEST", { userId: u.id });
          btn.textContent = rr.error ? "Error" : "Sent ✓";
        }});
        results.append(el("div", { class: "item row sb" },
          el("div", {}, el("div", { class: "name", text: u.display_name || u.username }), el("div", { class: "sub", text: "@" + u.username })),
          btn));
      }
    }, 300);
  });
  pane.append(q, results);

  if (res.incoming.length) {
    pane.append(el("h4", { text: "Requests" }));
    for (const f of res.incoming) {
      pane.append(el("div", { class: "item row sb" },
        el("div", {}, el("div", { class: "name", text: f.other?.display_name || f.other?.username || "user" }), el("div", { class: "sub", text: "@" + (f.other?.username || "") })),
        el("div", { class: "row" },
          el("button", { class: "btn", text: "Accept", onclick: async () => { await send("FRIEND_RESPOND", { friendshipId: f.id, accept: true }); render(); } }),
          el("button", { class: "btn ghost", text: "Decline", onclick: async () => { await send("FRIEND_RESPOND", { friendshipId: f.id, accept: false }); render(); } }))));
    }
  }

  pane.append(el("h4", { text: `Friends (${res.accepted.length})` }));
  if (!res.accepted.length) pane.append(el("div", { class: "muted", text: "No friends yet — search above to add people." }));
  for (const f of res.accepted) {
    pane.append(el("div", { class: "item row sb" },
      el("div", {}, el("div", { class: "name", text: f.other?.display_name || f.other?.username || "user" }), el("div", { class: "sub", text: "@" + (f.other?.username || "") })),
      el("button", { class: "lnk", text: "Remove", onclick: async () => { await send("UNFRIEND", { friendshipId: f.id }); render(); } })));
  }

  if (res.outgoing.length) {
    pane.append(el("h4", { text: "Sent" }));
    for (const f of res.outgoing) {
      pane.append(el("div", { class: "item row sb" },
        el("div", { class: "muted", text: "@" + (f.other?.username || "") + " (pending)" }),
        el("button", { class: "lnk", text: "Cancel", onclick: async () => { await send("UNFRIEND", { friendshipId: f.id }); render(); } })));
    }
  }
}

// ---------- groups ----------

async function renderGroups(pane) {
  pane.append(el("div", { class: "empty", text: "Loading…" }));
  const res = await send("GROUPS_STATE");
  pane.replaceChildren();
  if (res.error) { pane.append(el("div", { class: "err", text: res.error })); return; }

  // create
  const name = el("input", { type: "text", placeholder: "New group name…" });
  const desc = el("input", { type: "text", placeholder: "Short description (optional)" });
  const err = el("div", { class: "err" });
  const createBtn = el("button", { class: "btn", text: "Create group", onclick: async () => {
    createBtn.disabled = true; err.textContent = "";
    const r = await send("GROUP_CREATE", { name: name.value, description: desc.value });
    createBtn.disabled = false;
    if (r.error) { err.textContent = r.error; return; }
    render();
  }});
  pane.append(name, desc, el("div", { class: "row sb" }, el("span"), createBtn), err);

  const mine = new Set(res.mine || []);
  pane.append(el("h4", { text: "Groups" }));
  if (!res.groups.length) pane.append(el("div", { class: "muted", text: "No groups yet — create the first one." }));
  for (const g of res.groups) {
    const members = g.group_members?.[0]?.count ?? 0;
    const joined = mine.has(g.id);
    const btn = el("button", {
      class: joined ? "btn danger" : "btn ghost",
      text: joined ? "Leave" : "Join",
      onclick: async () => {
        btn.disabled = true;
        await send(joined ? "GROUP_LEAVE" : "GROUP_JOIN", { groupId: g.id });
        render();
      }
    });
    pane.append(el("div", { class: "item row sb" },
      el("div", {},
        el("div", { class: "name", text: g.name }),
        el("div", { class: "sub", text: `${members} member${members === 1 ? "" : "s"}${g.description ? " · " + g.description.slice(0, 60) : ""}` })),
      btn));
  }
}

// ---------- interests ----------

async function renderInterests(pane) {
  pane.append(el("div", { class: "empty", text: "Loading…" }));
  const res = await send("INTERESTS_STATE");
  pane.replaceChildren();
  if (res.error) { pane.append(el("div", { class: "err", text: res.error })); return; }

  const input = el("input", { type: "text", placeholder: "Add an interest (e.g. markets, ai, hockey)…" });
  const err = el("div", { class: "err" });
  const addBtn = el("button", { class: "btn", text: "Add", onclick: async () => {
    addBtn.disabled = true; err.textContent = "";
    const r = await send("INTEREST_ADD", { name: input.value });
    addBtn.disabled = false;
    if (r.error) { err.textContent = r.error; return; }
    render();
  }});
  pane.append(el("div", { class: "row" }, input, addBtn), err);

  const mine = new Set(res.mine || []);
  pane.append(el("h4", { text: "Tap to follow / unfollow" }));
  const chips = el("div", { class: "chips" });
  for (const it of res.interests) {
    const on = mine.has(it.id);
    const followers = it.user_interests?.[0]?.count ?? 0;
    chips.append(el("button", {
      class: "chip" + (on ? "" : " off"),
      text: `${it.name}${followers ? " · " + followers : ""}`,
      onclick: async (e) => {
        e.target.disabled = true;
        await send("INTEREST_TOGGLE", { interestId: it.id, on: !on });
        render();
      }
    }));
  }
  pane.append(chips);
}

// ---------- me ----------

function renderMe(pane) {
  const p = auth.profile || {};
  pane.append(el("div", { class: "item" },
    el("div", { class: "name" },
      el("span", { text: "@" + (p.username || "") }),
      star(p)),
    el("div", { class: "sub", text: auth.user?.email || "" }),
    auth.websiteUrl ? el("div", { class: "row", style: "gap:12px; margin-top:6px;" },
      el("a", { class: "weblink", href: "#", onclick: (e) => { e.preventDefault(); openUrl(profileUrl(p.username)); }, text: "View public profile ↗" }),
      el("a", { class: "weblink", href: "#", onclick: (e) => { e.preventDefault(); openUrl(auth.websiteUrl + "#/"); }, text: "SPEECH site ↗" })
    ) : null));

  // Supporter
  pane.append(el("h4", { text: "Supporter" }));
  if (p.is_supporter) {
    pane.append(el("div", { class: "supbox", text: "⭐ You're a Supporter — thank you for keeping SPEECH independent." }));
  } else {
    const note = el("div", { class: "muted", style: "margin-top:6px;" });
    pane.append(
      el("div", { class: "muted", text: "Supporters get a ⭐ badge next to their name everywhere and keep the platform running." }),
      el("button", {
        class: "btn", text: "Become a Supporter ⭐", style: "margin-top:8px;",
        onclick: async () => {
          const r = await send("GET_SUPPORT_URL");
          if (r.url) openUrl(r.url);
          else note.textContent = "Payments aren't wired up yet — coming soon.";
        }
      }),
      note
    );
  }

  pane.append(el("h4", { text: "Profile" }));
  const dn = el("input", { type: "text", placeholder: "Display name", value: p.display_name || "" });
  const bio = el("textarea", { placeholder: "Bio" });
  bio.value = p.bio || "";
  const err = el("div", { class: "err" });
  const save = el("button", { class: "btn", text: "Save", onclick: async () => {
    save.disabled = true; err.textContent = "";
    const r = await send("UPDATE_PROFILE", { display_name: dn.value, bio: bio.value });
    save.disabled = false;
    if (r.error) { err.textContent = r.error; return; }
    auth = r; render();
  }});
  pane.append(dn, bio, el("div", { class: "row sb" },
    el("button", { class: "lnk", text: "Sign out", onclick: async () => { auth = await send("SIGN_OUT"); render(); } }),
    save), err);
}
