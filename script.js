/* OneTap Player
  - local: sample.mp3 + file import (IndexedDB保存)
  - direct: mp3/m4a/wav等の直リンク
  - youtube: IFrame Player API埋め込み再生
*/

const APP_VERSION = "1.0.0";

// ====== DOM ======
const el = {
  playBtn: document.getElementById("playBtn"),
  playIcon: document.getElementById("playIcon"),
  playLabel: document.getElementById("playLabel"),
  playHint: document.getElementById("playHint"),
  nowTag: document.getElementById("nowTag"),
  nowUrl: document.getElementById("nowUrl"),
  nowNote: document.getElementById("nowNote"),
  typeBadge: document.getElementById("typeBadge"),
  msg: document.getElementById("msg"),

  tagInput: document.getElementById("tagInput"),
  urlInput: document.getElementById("urlInput"),
  addUrlBtn: document.getElementById("addUrlBtn"),
  fileInput: document.getElementById("fileInput"),

  list: document.getElementById("list"),
  resetBtn: document.getElementById("resetBtn"),

  netBadge: document.getElementById("netBadge"),
  swBadge: document.getElementById("swBadge"),
};

// ====== Audio (local/direct) ======
const audio = new Audio();
audio.preload = "auto";
audio.playsInline = true; // iOS向け
audio.crossOrigin = "anonymous"; // 直リンクが許可してる場合のみ効く

let isPlaying = false;
let activeObjectUrl = null;

// ====== YouTube Player ======
let ytReady = false;
let ytPlayer = null;
let ytLoading = false;

// ====== Storage Keys ======
const LS_KEY = "otp_state_v1";

// ====== IndexedDB (for imported local files) ======
const IDB_DB = "otp_files_v1";
const IDB_STORE = "files";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ====== App State ======
/**
 * item: {
 *  id: string,
 *  tag: string,
 *  sourceType: "local"|"direct"|"youtube",
 *  url?: string,            // direct/youtube
 *  videoId?: string,        // youtube
 *  fileKey?: string,        // local imported file key in IDB
 *  fileName?: string,       // local imported file name
 *  createdAt: number
 * }
 */
let state = {
  version: APP_VERSION,
  selectedId: "sample",
  items: [
    {
      id: "sample",
      tag: "サンプル（オフラインOK）",
      sourceType: "local",
      url: "./assets/sample.mp3",
      createdAt: Date.now(),
    },
  ],
};

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}
function loadState() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) {
      state = parsed;
      // sampleが消されてたら復元
      if (!state.items.some(i => i.id === "sample")) {
        state.items.unshift({
          id: "sample",
          tag: "サンプル（オフラインOK）",
          sourceType: "local",
          url: "./assets/sample.mp3",
          createdAt: Date.now(),
        });
      }
      if (!state.selectedId || !state.items.some(i => i.id === state.selectedId)) {
        state.selectedId = "sample";
      }
    }
  } catch {
    // ignore
  }
}

function setMessage(text, type = "") {
  el.msg.textContent = text || "";
  el.msg.className = "msg" + (type ? ` ${type}` : "");
}

function shortUrl(s) {
  if (!s) return "";
  const max = 46;
  return s.length > max ? s.slice(0, 26) + "…" + s.slice(-16) : s;
}

// ====== Network Badge ======
function updateNetBadge() {
  const online = navigator.onLine;
  if (online) {
    el.netBadge.textContent = "オンライン";
    el.netBadge.className = "badge good";
  } else {
    el.netBadge.textContent = "オフライン";
    el.netBadge.className = "badge warn";
  }
}

// ====== YouTube helpers ======
function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace("www.", "");
    // youtu.be/<id>
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id || null;
    }
    // youtube.com/watch?v=<id>
    if (host === "youtube.com" || host === "m.youtube.com") {
      if (u.pathname.startsWith("/watch")) {
        return u.searchParams.get("v");
      }
      // youtube.com/shorts/<id>
      if (u.pathname.startsWith("/shorts/")) {
        const id = u.pathname.split("/")[2];
        return id || null;
      }
      // youtube.com/embed/<id>
      if (u.pathname.startsWith("/embed/")) {
        const id = u.pathname.split("/")[2];
        return id || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isDirectAudioUrl(url) {
  // 拡張子でざっくり判定（クエリが付いててもOK）
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    return (
      p.endsWith(".mp3") ||
      p.endsWith(".m4a") ||
      p.endsWith(".wav") ||
      p.endsWith(".ogg") ||
      p.endsWith(".aac")
    );
  } catch {
    return false;
  }
}

function ensureYouTubeApiLoaded() {
  if (ytReady || ytLoading) return;
  ytLoading = true;

  // IFrame API script
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  s.async = true;
  document.head.appendChild(s);
}

window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
  ytLoading = false;

  ytPlayer = new YT.Player("ytPlayer", {
    height: "90",
    width: "160",
    videoId: "", // 初期空
    playerVars: {
      playsinline: 1,
      controls: 0,
      rel: 0,
      modestbranding: 1,
      fs: 0,
      iv_load_policy: 3,
      disablekb: 1,
      origin: location.origin,
    },
    events: {
      onReady: () => {
        // ready
      },
      onStateChange: (e) => {
        // 1: playing, 2: paused, 0: ended
        if (e.data === 1) {
          isPlaying = true;
          syncPlayUi();
        } else if (e.data === 2 || e.data === 0) {
          isPlaying = false;
          syncPlayUi();
        }
      },
      onError: () => {
        setMessage("YouTubeの再生でエラーが発生しました。", "bad");
        isPlaying = false;
        syncPlayUi();
      }
    }
  });
};

// ====== Selection / UI ======
function getSelectedItem() {
  return state.items.find(i => i.id === state.selectedId) || state.items[0];
}

function setSelected(id) {
  state.selectedId = id;
  saveState();
  render();
}

function typePill(type) {
  el.typeBadge.className = "pill " + type;
  if (type === "local") el.typeBadge.textContent = "LOCAL";
  if (type === "direct") el.typeBadge.textContent = "URL";
  if (type === "youtube") el.typeBadge.textContent = "YT";
}

function renderNow() {
  const item = getSelectedItem();
  el.nowTag.textContent = item.tag || "(無名)";
  if (item.sourceType === "local") {
    typePill("local");
    el.nowUrl.textContent = item.fileName ? `ローカル: ${item.fileName}` : (item.url || "");
    el.nowNote.style.display = "block";
    el.nowNote.textContent = "LOCALは機内モードでも再生できます。YouTubeはオンライン専用＆バックグラウンドで止まる場合があります。";
  } else if (item.sourceType === "direct") {
    typePill("direct");
    el.nowUrl.textContent = shortUrl(item.url || "");
    el.nowNote.style.display = "block";
    el.nowNote.textContent = "URL直リンクはオンライン推奨。相手サーバ/CORSにより再生できない場合があります。";
  } else {
    typePill("youtube");
    el.nowUrl.textContent = `YouTube: ${item.videoId || "?"}`;
    el.nowNote.style.display = "block";
    el.nowNote.textContent = "YouTubeはオンライン専用。iOSの制約でバックグラウンド再生が止まる場合があります。";
  }
}

function renderList() {
  el.list.innerHTML = "";
  const itemsSorted = [...state.items].sort((a,b) => (a.createdAt||0) - (b.createdAt||0));

  for (const item of itemsSorted) {
    const wrap = document.createElement("div");
    wrap.className = "item";

    const main = document.createElement("div");
    main.className = "itemMain";

    const top = document.createElement("div");
    top.className = "itemTop";

    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = item.tag || "(無名)";

    const type = document.createElement("div");
    type.className = "type " + item.sourceType;
    type.textContent = item.sourceType === "local" ? "LOCAL" : (item.sourceType === "direct" ? "URL" : "YT");

    top.appendChild(tag);
    top.appendChild(type);

    const urlMini = document.createElement("div");
    urlMini.className = "urlMini";
    if (item.sourceType === "local") {
      urlMini.textContent = item.fileName ? `ローカル: ${item.fileName}` : (item.url || "");
    } else if (item.sourceType === "direct") {
      urlMini.textContent = shortUrl(item.url || "");
    } else {
      urlMini.textContent = `YouTube: ${item.videoId || "?"}`;
    }

    main.appendChild(top);
    main.appendChild(urlMini);

    const actions = document.createElement("div");
    actions.className = "itemActions";

    const row = document.createElement("div");
    row.className = "rowActions";

    const toggle = document.createElement("button");
    toggle.className = "toggle" + (state.selectedId === item.id ? " on" : "");
    toggle.setAttribute("aria-label", "選択トグル");
    toggle.innerHTML = `<span class="knob"></span>`;
    toggle.addEventListener("click", () => {
      // 単一選択：これをONにする＝selectedIdを切り替える
      setSelected(item.id);
      setMessage(`「${item.tag}」を選択しました。`, "ok");
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "iconBtn";
    copyBtn.title = "コピー";
    copyBtn.textContent = "⧉";
    copyBtn.addEventListener("click", async () => {
      const text = item.sourceType === "local"
        ? (item.fileName ? `ローカル: ${item.fileName}` : (item.url || ""))
        : (item.sourceType === "youtube" ? (item.url || "") : (item.url || ""));
      try {
        await navigator.clipboard.writeText(text);
        setMessage("コピーしました。", "ok");
      } catch {
        setMessage("コピーに失敗しました。", "bad");
      }
    });

    const delBtn = document.createElement("button");
    delBtn.className = "iconBtn danger";
    delBtn.title = "削除";
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", async () => {
      await removeItem(item.id);
    });

    row.appendChild(toggle);
    row.appendChild(copyBtn);
    row.appendChild(delBtn);

    actions.appendChild(row);

    wrap.appendChild(main);
    wrap.appendChild(actions);

    el.list.appendChild(wrap);
  }
}

function render() {
  renderNow();
  renderList();
  syncPlayUi();
}

// ====== Playback ======
function syncPlayUi() {
  if (isPlaying) {
    el.playIcon.textContent = "⏸";
    el.playLabel.textContent = "停止";
    el.playHint.textContent = "再生中";
  } else {
    el.playIcon.textContent = "▶";
    el.playLabel.textContent = "再生";
    el.playHint.textContent = "ワンタップで開始";
  }
}

function stopAll() {
  // stop audio
  try {
    audio.pause();
  } catch {}
  // stop youtube
  try {
    if (ytPlayer && ytReady) ytPlayer.stopVideo();
  } catch {}
  isPlaying = false;
  syncPlayUi();
}

async function playSelected() {
  const item = getSelectedItem();

  // オフライン時のガード
  if (!navigator.onLine && (item.sourceType === "direct" || item.sourceType === "youtube")) {
    setMessage("オフラインのため、このソースは再生できません（LOCALならOK）。", "warn");
    return;
  }

  // いったん全部止める（単一プレイヤー体験）
  stopAll();

  if (item.sourceType === "youtube") {
    ensureYouTubeApiLoaded();
    const vid = item.videoId || extractYouTubeVideoId(item.url || "");
    if (!vid) {
      setMessage("YouTube URLから動画IDを取得できませんでした。", "bad");
      return;
    }
    // APIがreadyになるまで待つ（短く）
    await waitForYouTubeReady(3000);
    if (!ytPlayer || !ytReady) {
      setMessage("YouTubeプレイヤーの準備が間に合いませんでした。通信状況を確認して再試行してください。", "warn");
      return;
    }
    try {
      // load & play
      ytPlayer.loadVideoById(vid);
      ytPlayer.playVideo();
      isPlaying = true;
      syncPlayUi();
      setMessage("YouTubeを再生します（オンライン専用）。", "ok");
    } catch {
      setMessage("YouTubeの再生開始に失敗しました。", "bad");
    }
    return;
  }

  // local/direct => audio
  try {
    if (activeObjectUrl) {
      // 前のBlob URLがあれば解放
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }

    if (item.sourceType === "local") {
      // imported file?
      if (item.fileKey) {
        const blob = await idbGet(item.fileKey);
        if (!blob) {
          setMessage("ローカル音源が見つかりません（保存が消えた可能性）。", "bad");
          return;
        }
        activeObjectUrl = URL.createObjectURL(blob);
        audio.src = activeObjectUrl;
      } else {
        // built-in sample
        audio.src = item.url || "./assets/sample.mp3";
      }
    } else {
      // direct url
      audio.src = item.url || "";
    }

    audio.load();
    await audio.play(); // iOS: ユーザー操作（Playボタン）から呼ばれる前提
    isPlaying = true;
    syncPlayUi();
    setMessage("再生開始。", "ok");
  } catch (e) {
    // 再生不可（CORS / フォーマット / iOS制約など）
    isPlaying = false;
    syncPlayUi();
    const t = (item.sourceType === "direct")
      ? "このURLは再生できません（CORS/形式/サーバ都合の可能性）。mp3直リンク推奨。"
      : "再生できませんでした。";
    setMessage(t, "bad");
  }
}

function waitForYouTubeReady(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (ytReady && ytPlayer) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

// audio events
audio.addEventListener("ended", () => {
  isPlaying = false;
  syncPlayUi();
});
audio.addEventListener("pause", () => {
  // 手動停止以外でもpauseされるので、playing状態は軽く同期
  if (isPlaying) {
    isPlaying = false;
    syncPlayUi();
  }
});

// ====== Add Items ======
function newId(prefix="id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function normalizeTag(tag) {
  const t = (tag || "").trim();
  return t || "無題";
}

async function addUrlItem() {
  const tag = normalizeTag(el.tagInput.value);
  const url = (el.urlInput.value || "").trim();

  if (!url) {
    setMessage("URLを入力してください。", "warn");
    return;
  }

  // 判定
  const vid = extractYouTubeVideoId(url);
  if (vid) {
    const item = {
      id: newId("yt"),
      tag,
      sourceType: "youtube",
      url,
      videoId: vid,
      createdAt: Date.now(),
    };
    state.items.push(item);
    state.selectedId = item.id;
    saveState();
    render();
    setMessage("YouTubeを追加しました（オンライン専用）。", "ok");
    ensureYouTubeApiLoaded(); // 速くしたいので先読み
    el.urlInput.value = "";
    return;
  }

  if (isDirectAudioUrl(url)) {
    const item = {
      id: newId("url"),
      tag,
      sourceType: "direct",
      url,
      createdAt: Date.now(),
    };
    state.items.push(item);
    state.selectedId = item.id;
    saveState();
    render();
    setMessage("URL音源を追加しました。", "ok");
    el.urlInput.value = "";
    return;
  }

  setMessage("このURLは未対応です。mp3直リンク または YouTube URL を入れてください。", "bad");
}

async function addFileItem(file) {
  if (!file) return;

  const tag = normalizeTag(el.tagInput.value || file.name);
  const key = newId("file");

  try {
    // BlobをIDBへ保存（オフラインOK）
    await idbPut(key, file);

    const item = {
      id: newId("local"),
      tag,
      sourceType: "local",
      fileKey: key,
      fileName: file.name,
      createdAt: Date.now(),
    };
    state.items.push(item);
    state.selectedId = item.id;
    saveState();
    render();
    setMessage("ローカル音源を追加しました（オフラインOK）。", "ok");
  } catch {
    setMessage("ローカル音源の保存に失敗しました。", "bad");
  }
}

// ====== Remove / Reset ======
async function removeItem(id) {
  // sampleは削除不可にして安全運用
  if (id === "sample") {
    setMessage("サンプルは削除できません。", "warn");
    return;
  }

  const item = state.items.find(i => i.id === id);
  if (!item) return;

  // 削除対象が選択中なら、sampleへ戻す
  if (state.selectedId === id) {
    stopAll();
    state.selectedId = "sample";
  }

  // local imported fileならIDBも消す
  if (item.sourceType === "local" && item.fileKey) {
    try { await idbDel(item.fileKey); } catch {}
  }

  state.items = state.items.filter(i => i.id !== id);
  saveState();
  render();
  setMessage("削除しました。", "ok");
}

function resetAll() {
  stopAll();
  localStorage.removeItem(LS_KEY);
  // IDBは全消ししない（安全）。必要なら拡張で消してもOK
  state = {
    version: APP_VERSION,
    selectedId: "sample",
    items: [
      {
        id: "sample",
        tag: "サンプル（オフラインOK）",
        sourceType: "local",
        url: "./assets/sample.mp3",
        createdAt: Date.now(),
      },
    ],
  };
  saveState();
  render();
  setMessage("初期化しました。", "ok");
}

// ====== Service Worker ======
async function registerSW() {
  if (!("serviceWorker" in navigator)) {
    el.swBadge.textContent = "SW: 非対応";
    el.swBadge.className = "badge bad";
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
    el.swBadge.textContent = "SW: 登録済み";
    el.swBadge.className = "badge good";

    // update check
    reg.update?.();
  } catch {
    el.swBadge.textContent = "SW: 失敗";
    el.swBadge.className = "badge bad";
  }
}

// ====== Events ======
el.playBtn.addEventListener("click", async () => {
  // ユーザー操作の瞬間をトリガーに最速再生
  if (isPlaying) {
    stopAll();
    setMessage("停止しました。", "ok");
  } else {
    await playSelected();
  }
});

el.addUrlBtn.addEventListener("click", addUrlItem);
el.urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addUrlItem();
});

el.fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  await addFileItem(file);
  el.fileInput.value = "";
});

el.resetBtn.addEventListener("click", () => {
  const ok = confirm("初期化しますか？（URL/タグ一覧がリセットされます）");
  if (ok) resetAll();
});

window.addEventListener("online", updateNetBadge);
window.addEventListener("offline", updateNetBadge);

// ====== Init ======
(function init() {
  loadState();
  saveState(); // 正規化
  updateNetBadge();
  registerSW();
  render();

  // YouTubeをよく使うなら起動時に先読み（体感速い）
  // ※必要ないならコメントアウトしてOK
  ensureYouTubeApiLoaded();

  setMessage("準備OK。再生ボタンを押してください。", "ok");
})();
