// SPEECH — background service worker.
// All network calls to Supabase happen here; the content script and
// popup talk to this worker via chrome.runtime messages.

importScripts("config.js");

const REST = (p) => `${CONFIG.SUPABASE_URL}/rest/v1${p}`;
const AUTH = (p) => `${CONFIG.SUPABASE_URL}/auth/v1${p}`;

// ---------- session storage ----------

async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  return session || null;
}
async function setSession(session) {
  if (session) await chrome.storage.local.set({ session });
  else await chrome.storage.local.remove("session");
}

async function freshToken() {
  let s = await getSession();
  if (!s) return null;
  if (Date.now() < s.expires_at - 60000) return s.access_token;
  // refresh
  try {
    const res = await fetch(AUTH("/token?grant_type=refresh_token"), {
      method: "POST",
      headers: { apikey: CONFIG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error(data.error_description || "refresh failed");
    s = sessionFromTokenResponse(data);
    await setSession(s);
    return s.access_token;
  } catch (e) {
    await setSession(null);
    return null;
  }
}

function sessionFromTokenResponse(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    user: data.user
  };
}

async function uid() {
  const s = await getSession();
  return s?.user?.id || null;
}

// ---------- fetch helpers ----------

async function rest(path, { method = "GET", body, prefer, count } = {}) {
  const token = (await freshToken()) || CONFIG.SUPABASE_ANON_KEY;
  const headers = {
    apikey: CONFIG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  if (prefer) headers.Prefer = prefer;
  if (count) headers.Prefer = (prefer ? prefer + "," : "") + "count=exact";
  const res = await fetch(REST(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const msg = data?.message || data?.error_description || data?.hint || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (count) {
    const range = res.headers.get("content-range") || "/0";
    return { data, total: parseInt(range.split("/")[1], 10) || 0 };
  }
  return data;
}

async function authPost(path, body) {
  const res = await fetch(AUTH(path), {
    method: "POST",
    headers: { apikey: CONFIG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.msg || data.error_description || data.message || `HTTP ${res.status}`);
  }
  return data;
}

// ---------- URL identity ----------

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref_url)$/i;

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.username = ""; u.password = "";
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith("/") && !u.search) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function findPage(rawUrl) {
  const norm = normalizeUrl(rawUrl);
  if (!norm) return { norm: null, page: null };
  const key = await sha256(norm);
  const rows = await rest(`/pages?url_key=eq.${key}&select=id,url,title,domain`);
  return { norm, key, page: rows[0] || null };
}

async function ensurePage(rawUrl, title) {
  const norm = normalizeUrl(rawUrl);
  if (!norm) throw new Error("This page type does not support comments.");
  const key = await sha256(norm);
  const domain = new URL(norm).hostname;
  const rows = await rest(`/pages?on_conflict=url_key`, {
    method: "POST",
    body: { url_key: key, url: norm, title: (title || "").slice(0, 300), domain },
    prefer: "resolution=merge-duplicates,return=representation"
  });
  return rows[0];
}

// ---------- state ----------

function siteUrl() {
  return CONFIG.WEBSITE_URL && CONFIG.WEBSITE_URL.startsWith("http")
    ? CONFIG.WEBSITE_URL
    : chrome.runtime.getURL("site.html");
}

async function getState() {
  const websiteUrl = siteUrl();
  const token = await freshToken();
  if (!token) return { signedIn: false, websiteUrl };
  const s = await getSession();
  const profiles = await rest(`/profiles?id=eq.${s.user.id}&select=*`);
  return { signedIn: true, user: { id: s.user.id, email: s.user.email }, profile: profiles[0] || null, websiteUrl };
}

async function broadcastAuthChange() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id) chrome.tabs.sendMessage(t.id, { type: "AUTH_CHANGED" }).catch(() => {});
    }
  } catch {}
}

// ---------- handlers ----------

const handlers = {

  async GET_STATE() {
    return getState();
  },

  async SIGN_UP({ email, password, username }) {
    const uname = (username || "").toLowerCase().trim();
    if (!/^[a-z0-9_]{3,24}$/.test(uname)) {
      throw new Error("Username must be 3-24 chars: lowercase letters, numbers, underscores.");
    }
    const data = await authPost("/signup", { email, password, data: { username: uname } });
    if (data.access_token) {
      await setSession(sessionFromTokenResponse(data));
      broadcastAuthChange();
      return { ...(await getState()), justSignedUp: true };
    }
    return { signedIn: false, needsConfirmation: true };
  },

  async SIGN_IN({ email, password }) {
    const data = await authPost("/token?grant_type=password", { email, password });
    await setSession(sessionFromTokenResponse(data));
    broadcastAuthChange();
    return getState();
  },

  async SIGN_OUT() {
    const s = await getSession();
    if (s) {
      fetch(AUTH("/logout"), {
        method: "POST",
        headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${s.access_token}` }
      }).catch(() => {});
    }
    await setSession(null);
    broadcastAuthChange();
    return { signedIn: false };
  },

  async UPDATE_PROFILE({ display_name, bio }) {
    const id = await uid();
    if (!id) throw new Error("Not signed in.");
    await rest(`/profiles?id=eq.${id}`, {
      method: "PATCH",
      body: { display_name: (display_name || "").slice(0, 60), bio: (bio || "").slice(0, 500) }
    });
    return getState();
  },

  // ----- pages & comments -----

  async GET_COMMENT_COUNT({ url }) {
    const { page } = await findPage(url);
    if (!page) return { count: 0 };
    const { total } = await rest(`/comments?page_id=eq.${page.id}&select=id&limit=1`, { count: true });
    return { count: total };
  },

  async GET_PAGE_DATA({ url }) {
    const { page } = await findPage(url);
    if (!page) return { page: null, comments: [], myVotes: {} };
    const comments = await rest(
      `/comment_feed?page_id=eq.${page.id}&select=id,parent_id,user_id,body,is_deleted,created_at,username,display_name,score,is_supporter&order=created_at.asc&limit=500`
    );
    const myVotes = {};
    const id = await uid();
    if (id && comments.length) {
      const ids = comments.map((c) => c.id).join(",");
      const votes = await rest(`/votes?user_id=eq.${id}&comment_id=in.(${ids})&select=comment_id,value`);
      for (const v of votes) myVotes[v.comment_id] = v.value;
    }
    return { page, comments, myVotes, myId: id };
  },

  async POST_COMMENT({ url, title, body, parentId }) {
    const id = await uid();
    if (!id) throw new Error("Sign in to comment.");
    const text = (body || "").trim();
    if (!text) throw new Error("Comment is empty.");
    if (text.length > 5000) throw new Error("Comment is too long (max 5000 chars).");
    const page = await ensurePage(url, title);
    const rows = await rest(`/comments`, {
      method: "POST",
      body: { page_id: page.id, parent_id: parentId || null, body: text },
      prefer: "return=representation"
    });
    const full = await rest(
      `/comment_feed?id=eq.${rows[0].id}&select=id,parent_id,user_id,body,is_deleted,created_at,username,display_name,score,is_supporter`
    );
    return { comment: full[0] };
  },

  async DELETE_COMMENT({ commentId }) {
    const id = await uid();
    if (!id) throw new Error("Not signed in.");
    await rest(`/comments?id=eq.${commentId}&user_id=eq.${id}`, {
      method: "PATCH",
      body: { is_deleted: true, body: "[deleted]" }
    });
    return { ok: true };
  },

  async VOTE({ commentId, value }) {
    const id = await uid();
    if (!id) throw new Error("Sign in to vote.");
    if (value === 0) {
      await rest(`/votes?comment_id=eq.${commentId}&user_id=eq.${id}`, { method: "DELETE" });
    } else {
      await rest(`/votes?on_conflict=comment_id,user_id`, {
        method: "POST",
        body: { comment_id: commentId, user_id: id, value },
        prefer: "resolution=merge-duplicates"
      });
    }
    const rows = await rest(`/comment_feed?id=eq.${commentId}&select=score`);
    return { score: rows[0]?.score ?? 0 };
  },

  async REPORT_COMMENT({ commentId, reason }) {
    const id = await uid();
    if (!id) throw new Error("Sign in to report.");
    await rest(`/reports`, {
      method: "POST",
      body: { comment_id: commentId, reporter_id: id, reason: (reason || "unspecified").slice(0, 500) }
    });
    return { ok: true };
  },

  async GET_PROFILE({ userId, username }) {
    const q = userId
      ? `id=eq.${userId}`
      : `username=eq.${encodeURIComponent((username || "").toLowerCase())}`;
    const rows = await rest(`/profiles?${q}&select=*`);
    if (!rows[0]) throw new Error("Profile not found.");
    const { total } = await rest(
      `/comments?user_id=eq.${rows[0].id}&is_deleted=eq.false&select=id&limit=1`,
      { count: true }
    );
    return { profile: rows[0], commentCount: total, websiteUrl: siteUrl() };
  },

  async GET_SUPPORT_URL() {
    return { url: CONFIG.SUPPORT_URL && CONFIG.SUPPORT_URL.startsWith("http") ? CONFIG.SUPPORT_URL : null };
  },

  async OPEN_URL({ url }) {
    if (!/^(https?:\/\/|chrome-extension:\/\/)/.test(url || "")) throw new Error("Bad URL.");
    await chrome.tabs.create({ url });
    return { ok: true };
  },

  // ----- friends -----

  async SEARCH_USERS({ q }) {
    const id = await uid();
    const safe = (q || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (safe.length < 2) return { users: [] };
    let users = await rest(`/profiles?username=ilike.*${safe}*&select=id,username,display_name&limit=10`);
    if (id) users = users.filter((u) => u.id !== id);
    return { users };
  },

  async FRIENDS_STATE() {
    const id = await uid();
    if (!id) throw new Error("Not signed in.");
    const rows = await rest(
      `/friendships?or=(requester_id.eq.${id},addressee_id.eq.${id})&select=id,requester_id,addressee_id,status`
    );
    const otherIds = [...new Set(rows.map((r) => (r.requester_id === id ? r.addressee_id : r.requester_id)))];
    let profiles = [];
    if (otherIds.length) {
      profiles = await rest(`/profiles?id=in.(${otherIds.join(",")})&select=id,username,display_name`);
    }
    const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
    const decorate = (r) => ({ ...r, other: byId[r.requester_id === id ? r.addressee_id : r.requester_id] || null });
    return {
      accepted: rows.filter((r) => r.status === "accepted").map(decorate),
      incoming: rows.filter((r) => r.status === "pending" && r.addressee_id === id).map(decorate),
      outgoing: rows.filter((r) => r.status === "pending" && r.requester_id === id).map(decorate)
    };
  },

  async FRIEND_REQUEST({ userId }) {
    const id = await uid();
    if (!id) throw new Error("Not signed in.");
    await rest(`/friendships`, { method: "POST", body: { requester_id: id, addressee_id: userId } });
    return { ok: true };
  },

  async FRIEND_RESPOND({ friendshipId, accept }) {
    if (accept) {
      await rest(`/friendships?id=eq.${friendshipId}`, { method: "PATCH", body: { status: "accepted" } });
    } else {
      await rest(`/friendships?id=eq.${friendshipId}`, { method: "DELETE" });
    }
    return { ok: true };
  },

  async UNFRIEND({ friendshipId }) {
    await rest(`/friendships?id=eq.${friendshipId}`, { method: "DELETE" });
    return { ok: true };
  },

  async FEED() {
    const id = await uid();
    if (!id) throw new Error("Not signed in.");
    const rows = await rest(
      `/friendships?or=(requester_id.eq.${id},addressee_id.eq.${id})&status=eq.accepted&select=requester_id,addressee_id`
    );
    const friendIds = [...new Set(rows.map((r) => (r.requester_id === id ? r.addressee_id : r.requester_id)))];
    if (!friendIds.length) return { items: [] };
    const items = await rest(
      `/comment_feed?user_id=in.(${friendIds.join(",")})&is_deleted=eq.false&select=id,body,created_at,username,display_name,score,page_url,page_title,page_domain,is_supporter&order=created_at.desc&limit=30`
    );
    return { items };
  },

  // ----- notifications (replies to me) -----

  async NOTIFICATIONS() {
    return fetchNotifications();
  },

  async NOTIFS_SEEN() {
    await chrome.storage.local.set({ notifLastSeen: Date.now() });
    await updateBadge(0);
    return { ok: true };
  },

  // ----- groups -----

  async GROUPS_STATE() {
    const id = await uid();
    const groups = await rest(`/groups?select=id,name,slug,description,owner_id,group_members(count)&order=created_at.desc&limit=100`);
    let mine = [];
    if (id) {
      const rows = await rest(`/group_members?user_id=eq.${id}&select=group_id`);
      mine = rows.map((r) => r.group_id);
    }
    return { groups, mine };
  },

  async GROUP_CREATE({ name, description }) {
    const id = await uid();
    if (!id) throw new Error("Not signed in.");
    const clean = (name || "").trim();
    if (clean.length < 3) throw new Error("Group name must be at least 3 characters.");
    const slug =
      clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) +
      "-" + Math.random().toString(36).slice(2, 6);
    const rows = await rest(`/groups`, {
      method: "POST",
      body: { name: clean.slice(0, 64), slug, description: (description || "").slice(0, 500), owner_id: id },
      prefer: "return=representation"
    });
    await rest(`/group_members`, { method: "POST", body: { group_id: rows[0].id, user_id: id, role: "owner" } });
    return { group: rows[0] };
  },

  async GROUP_JOIN({ groupId }) {
    const id = await uid();
    if (!id) throw new Error("Not signed in.");
    await rest(`/group_members?on_conflict=group_id,user_id`, {
      method: "POST",
      body: { group_id: groupId, user_id: id, role: "member" },
      prefer: "resolution=merge-duplicates"
    });
    return { ok: true };
  },

  async GROUP_LEAVE({ groupId }) {
    const id = await uid();
    if (!id) throw new Error("Not signed in.");
    await rest(`/group_members?group_id=eq.${groupId}&user_id=eq.${id}`, { method: "DELETE" });
    return { ok: true };
  },

  // ----- interests -----

  async INTERESTS_STATE() {
    const id = await uid();
    const interests = await rest(`/interests?select=id,name,user_interests(count)&order=name.asc&limit=200`);
    let mine = [];
    if (id) {
      const rows = await rest(`/user_interests?user_id=eq.${id}&select=interest_id`);
      mine = rows.map((r) => r.interest_id);
    }
    return { interests, mine };
  },

  async INTEREST_ADD({ name }) {
    const id = await uid();
    if (!id) throw new Error("Not signed in.");
    const clean = (name || "").toLowerCase().trim().replace(/\s+/g, " ").slice(0, 32);
    if (clean.length < 2) throw new Error("Interest must be at least 2 characters.");
    const rows = await rest(`/interests?on_conflict=name`, {
      method: "POST",
      body: { name: clean },
      prefer: "resolution=merge-duplicates,return=representation"
    });
    await rest(`/user_interests?on_conflict=user_id,interest_id`, {
      method: "POST",
      body: { user_id: id, interest_id: rows[0].id },
      prefer: "resolution=merge-duplicates"
    });
    return { ok: true };
  },

  async INTEREST_TOGGLE({ interestId, on }) {
    const id = await uid();
    if (!id) throw new Error("Not signed in.");
    if (on) {
      await rest(`/user_interests?on_conflict=user_id,interest_id`, {
        method: "POST",
        body: { user_id: id, interest_id: interestId },
        prefer: "resolution=merge-duplicates"
      });
    } else {
      await rest(`/user_interests?user_id=eq.${id}&interest_id=eq.${interestId}`, { method: "DELETE" });
    }
    return { ok: true };
  }
};

// ---------- notifications polling ----------

async function fetchNotifications() {
  const id = await uid();
  if (!id) return { items: [], unread: 0 };
  const items = await rest(
    `/reply_feed?parent_author_id=eq.${id}&user_id=neq.${id}&select=id,page_id,body,parent_body,created_at,username,display_name,is_supporter,page_url,page_title,page_domain&order=created_at.desc&limit=20`
  );
  const { notifLastSeen = 0 } = await chrome.storage.local.get("notifLastSeen");
  const unread = items.filter((i) => new Date(i.created_at).getTime() > notifLastSeen).length;
  return { items, unread };
}

async function updateBadge(unread) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    await chrome.action.setBadgeText({ text: unread > 0 ? String(unread) : "" });
  } catch {}
}

async function pollNotifications() {
  try {
    const { unread } = await fetchNotifications();
    await updateBadge(unread);
  } catch {}
}

chrome.alarms.create("speech-notifs", { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "speech-notifs") pollNotifications();
});
chrome.runtime.onStartup.addListener(pollNotifications);
chrome.runtime.onInstalled.addListener(pollNotifications);

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ error: `Unknown message: ${msg?.type}` });
    return false;
  }
  if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes("YOUR-PROJECT-REF")) {
    sendResponse({ error: "Setup needed: paste your Supabase URL and anon key into extension/config.js (see README)." });
    return false;
  }
  handler(msg)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((e) => sendResponse({ error: e.message || String(e) }));
  return true; // keep channel open for async response
});
