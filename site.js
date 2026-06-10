
const SB  = "https://cvrkvxmhsdzweikvrnxo.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2cmt2eG1oc2R6d2Vpa3ZybnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwOTA2MjAsImV4cCI6MjA5NjY2NjYyMH0._opqu4NE_5Wx0C4IK4czHrVRcZJ7wWhX2aOurkOtYOc";

async function api(p) {
  const r = await fetch(SB + "/rest/v1" + p, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
  if (!r.ok) throw new Error("API error " + r.status);
  return r.json();
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c) n.append(c);
  return n;
}
const txt = (s) => document.createTextNode(s);

function ago(iso) {
  const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 2592000) return Math.floor(s / 86400) + "d ago";
  return new Date(iso).toLocaleDateString();
}

const app = document.getElementById("app");
const loading = () => app.replaceChildren(el("div", { class: "empty", text: "Loading…" }));

function commentCard(c, { showPage = true, reply = false } = {}) {
  const pl = el("div", { class: "pl" }, el("span", { class: "score", text: (c.score > 0 ? "+" : "") + c.score }));
  if (showPage && c.page_url) {
    pl.append(
      txt("on "),
      el("a", { href: c.page_url, target: "_blank", rel: "noopener", text: (c.page_title || c.page_domain || c.page_url).slice(0, 90) }),
      txt(" · "),
      el("a", { href: "#/p/" + c.page_id, text: "view thread" })
    );
  }
  return el("div", { class: "card" + (reply ? " reply" : "") },
    el("div", { class: "meta" },
      el("a", { class: "u", href: "#/u/" + encodeURIComponent(c.username), text: c.display_name || c.username }),
      c.is_supporter ? el("span", { class: "star", text: " ⭐", title: "Supporter" }) : null,
      txt(" @" + c.username + " · " + ago(c.created_at))
    ),
    el("div", { class: "cbody" + (c.is_deleted ? " del" : ""), text: c.body }),
    pl
  );
}

// ---------- views ----------

async function home() {
  loading();
  const [pages, feed] = await Promise.all([
    api("/pages?select=id,url,title,domain,comments(count)&order=created_at.desc&limit=8"),
    api("/comment_feed?is_deleted=eq.false&select=*&order=created_at.desc&limit=50")
  ]);
  app.replaceChildren();
  app.append(el("div", { class: "note", text: "This is the public window into SPEECH — what people are really saying about pages all over the web. Install the browser extension to join in." }));
  if (pages.length) {
    app.append(el("h2", { text: "Recently discussed" }));
    for (const p of pages) {
      const n = p.comments?.[0]?.count ?? 0;
      app.append(el("div", { class: "card" },
        el("div", { class: "pgtitle" }, el("a", { href: "#/p/" + p.id, text: (p.title || p.url).slice(0, 110) })),
        el("div", { class: "domain", text: (p.domain || "") + " · " + n + " comment" + (n === 1 ? "" : "s") })
      ));
    }
  }
  app.append(el("h2", { text: "Latest comments" }));
  if (!feed.length) app.append(el("div", { class: "empty", text: "Nothing here yet. Open any website with the extension and say something." }));
  for (const c of feed) app.append(commentCard(c));
}

async function profile(uname) {
  loading();
  const rows = await api("/profiles?username=eq." + encodeURIComponent(uname.toLowerCase()) + "&select=*");
  if (!rows[0]) { app.replaceChildren(el("div", { class: "empty", text: "No such user." })); return; }
  const p = rows[0];
  const comments = await api("/comment_feed?user_id=eq." + p.id + "&is_deleted=eq.false&select=*&order=created_at.desc&limit=100");
  app.replaceChildren(
    el("div", { class: "crumb" }, el("a", { href: "#/", text: "← Home" })),
    el("div", { class: "card prof" },
      el("div", { class: "ava", text: (p.display_name || p.username).slice(0, 1).toUpperCase() }),
      el("div", {},
        el("div", { class: "pname", text: p.display_name || p.username }),
        el("div", { class: "puser", text: "@" + p.username }),
        p.is_supporter ? el("div", {}, el("span", { class: "supchip", text: "⭐ Supporter" })) : null,
        p.bio ? el("div", { class: "bio", text: p.bio }) : null,
        el("div", { class: "stats", text: comments.length + (comments.length === 100 ? "+" : "") + " comment" + (comments.length === 1 ? "" : "s") + " · joined " + new Date(p.created_at).toLocaleDateString() })
      )
    ),
    el("h2", { text: "Comments" })
  );
  if (!comments.length) app.append(el("div", { class: "empty", text: "No comments yet." }));
  for (const c of comments) app.append(commentCard(c));
}

async function thread(pid) {
  loading();
  const [pages, comments] = await Promise.all([
    api("/pages?id=eq." + pid + "&select=*"),
    api("/comment_feed?page_id=eq." + pid + "&select=*&order=created_at.asc&limit=500")
  ]);
  if (!pages[0]) { app.replaceChildren(el("div", { class: "empty", text: "Page not found." })); return; }
  const pg = pages[0];
  app.replaceChildren(
    el("div", { class: "crumb" }, el("a", { href: "#/", text: "← Home" })),
    el("div", { class: "card" },
      el("div", { class: "pgtitle" }, el("a", { href: pg.url, target: "_blank", rel: "noopener", text: pg.title || pg.url })),
      el("div", { class: "domain", text: (pg.domain || "") + " · " + comments.length + " comment" + (comments.length === 1 ? "" : "s") + " · " }, el("a", { href: pg.url, target: "_blank", rel: "noopener", text: "open page ↗", style: "font-size:12px" }))
    ),
    el("h2", { text: "Thread" })
  );
  if (!comments.length) app.append(el("div", { class: "empty", text: "No comments on this page yet." }));
  const top = comments.filter(c => !c.parent_id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const replies = (id) => comments.filter(c => c.parent_id === id);
  for (const c of top) {
    app.append(commentCard(c, { showPage: false }));
    for (const r of replies(c.id)) app.append(commentCard(r, { showPage: false, reply: true }));
  }
}

// ---------- install & privacy ----------

const ZIP_URL = "https://github.com/apexjabroni1337/speech-extension/archive/refs/heads/main.zip";

async function installPage() {
  app.replaceChildren(
    el("div", { class: "crumb" }, el("a", { href: "#/", text: "← Home" })),
    el("h2", { text: "Get the SPEECH extension" }),
    el("div", { class: "card" },
      el("div", { class: "pgtitle", text: "1 · Download" }),
      el("div", { class: "domain", text: "Download the zip and extract it somewhere permanent (Chrome loads it from that folder)." }),
      el("div", { style: "margin-top:12px" }, el("a", { class: "dlbtn", href: ZIP_URL, text: "⬇ Download SPEECH (.zip)" }))),
    el("div", { class: "card" },
      el("div", { class: "pgtitle", text: "2 · Turn on Developer mode" }),
      el("div", { class: "domain", text: "In Chrome, Edge or Brave: open chrome://extensions and flip the Developer mode switch (top right)." })),
    el("div", { class: "card" },
      el("div", { class: "pgtitle", text: "3 · Load it" }),
      el("div", { class: "domain", text: "Click “Load unpacked” and select the extracted speech-extension-main folder. Then visit any website and hit the 💬 Speech button to join the conversation." })),
    el("div", { class: "note", text: "This is the alpha. The Chrome Web Store version is coming — until then this sideload is the way in." })
  );
}

async function privacyPage() {
  const P = (t) => el("p", { text: t });
  app.replaceChildren(
    el("div", { class: "crumb" }, el("a", { href: "#/", text: "← Home" })),
    el("h2", { text: "Privacy policy" }),
    el("div", { class: "card legal" },
      P("SPEECH is an open comment layer for the web. This is what we store and why."),
      P("Account data: your email address and a hashed password, used only for signing in. Your username, display name and bio are public."),
      P("Content: comments, votes, friend connections, group memberships, interest tags, and reports you submit are stored in our database. Comments, votes, profiles and groups are public — that is the point of the product."),
      P("Page addresses: when someone comments on a page, we store that page's address and title so others can find the thread. To show comment counts, the extension checks the current page's address against our database; addresses are only stored permanently when a page has been commented on."),
      P("We do not sell or share personal data, run ads, or use third-party trackers or analytics. Data lives in our database hosted by Supabase."),
      P("Deletion: you can delete your own comments in the extension. For full account deletion, contact us via the email on our store listing and we will remove your account and personal data."),
      P("Changes to this policy will be posted on this page."))
  );
}

// ---------- user search ----------

const q = document.getElementById("q");
const sres = document.getElementById("sres");
let timer;
q.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const term = q.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (term.length < 2) { sres.style.display = "none"; return; }
    try {
      const users = await api("/profiles?username=ilike.*" + term + "*&select=username,display_name&limit=8");
      sres.replaceChildren();
      if (!users.length) sres.append(el("a", { href: "#", text: "No matches" }));
      for (const u of users) {
        sres.append(el("a", { href: "#/u/" + encodeURIComponent(u.username), onclick: () => { sres.style.display = "none"; q.value = ""; } },
          txt(u.display_name || u.username + " "), el("span", { class: "su", text: " @" + u.username })));
      }
      sres.style.display = "block";
    } catch {}
  }, 250);
});
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) sres.style.display = "none"; });

// ---------- router ----------

function router() {
  const h = location.hash || "#/";
  const mu = h.match(/^#\/u\/(.+)$/);
  const mp = h.match(/^#\/p\/(\d+)$/);
  const run = mu ? () => profile(decodeURIComponent(mu[1]))
    : mp ? () => thread(mp[1])
    : h === "#/install" ? installPage
    : h === "#/privacy" ? privacyPage
    : home;
  run().catch(err => app.replaceChildren(el("div", { class: "empty", text: "Something went wrong: " + err.message })));
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", router);
router();
