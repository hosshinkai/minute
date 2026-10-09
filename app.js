// Minute — 録音・取り込み → Googleドライブへ送信 → 事務所PCで自動の文字起こし・要約
const TYPES = { oneonone: "面談", interview: "面接", meeting: "打合せ", gathering: "寄合" };
const STATUS = { recorded: "送信待ち", queued: "処理待ち", transcribing: "文字起こし中", waiting: "要約中", summarized: "完了", error: "エラー" };
const FROM_SHEET = { "録音済み": "queued", "処理待ち": "queued", "文字起こし中": "transcribing", "文字起こし済み": "waiting", "要約待ち": "waiting", "要約中": "waiting", "要約済み": "summarized", "エラー": "error" };
const CHUNK = 4 * 1024 * 1024; // upload unit (a multiple of 256 KiB, as Drive requires)

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 16);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const hms = (sec) => { sec = Math.max(0, Math.floor(sec)); return [sec / 3600, (sec % 3600) / 60, sec % 60].map(n => String(Math.floor(n)).padStart(2, "0")).join(":"); };
const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + "MB";

/* ---------------- settings ---------------- */
const cfg = Object.assign({ gasUrl: "", gasKey: "", lastType: "oneonone" },
  (() => { try { return JSON.parse(localStorage.getItem("minute.cfg") || "{}"); } catch { return {}; } })());
const saveCfg = () => { try { localStorage.setItem("minute.cfg", JSON.stringify(cfg)); } catch {} };
const driveOn = () => !!(cfg.gasUrl && cfg.gasKey);

// A setup link (#setup=...) carries the Drive connection to another device
(function readSetupLink() {
  const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)/);
  if (!m) return;
  try {
    const j = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")))));
    if (j.u && j.k) { cfg.gasUrl = j.u; cfg.gasKey = j.k; saveCfg(); setTimeout(() => toast("Googleドライブ連携を設定しました"), 600); }
  } catch {}
  history.replaceState(null, "", location.pathname);
})();

/* ---------------- IndexedDB ---------------- */
const idb = (() => {
  let p;
  const open = () => p ??= new Promise((res, rej) => {
    const r = indexedDB.open("minute", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("records", { keyPath: "id" });
      d.createObjectStore("audio");
      d.createObjectStore("chunks");
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store);
      let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    all: (st) => tx(st, "readonly", s => s.getAll()),
    keys: (st) => tx(st, "readonly", s => s.getAllKeys()),
    get: (st, k) => tx(st, "readonly", s => s.get(k)),
    put: (st, v, k) => tx(st, "readwrite", s => k === undefined ? s.put(v) : s.put(v, k)),
    del: (st, k) => tx(st, "readwrite", s => s.delete(k)),
  };
})();

/* ---------------- state ---------------- */
let records = [];
let selected = null;
let syncing = 0;
const transfers = {};   // id -> {done, total}

async function saveRec(r) { r.updatedAt = Date.now(); await idb.put("records", structuredClone(r)); }
const byId = (id) => records.find(r => r.id === id);

/* ---------------- Google Drive (Apps Script) ---------------- */
async function gas(action, payload = {}) {
  const res = await fetch(cfg.gasUrl, { method: "POST", body: JSON.stringify({ key: cfg.gasKey, action, ...payload }) });
  let j; try { j = await res.json(); } catch { throw new Error("連携用URLから正しい応答がありません"); }
  if (!j.ok) throw new Error(j.error === "unauthorized" ? "合言葉が違います" : j.error || "エラー");
  return j;
}
const metaOf = (r) => ({ id: r.id, title: r.title, type: r.type, date: r.date, participants: r.participants,
  duration: r.duration || 0, audioMime: r.audioMime || "", audioSize: r.audioSize || 0 });

function setPill() {
  const p = $("#syncPill"); const s = p.querySelector("span");
  p.className = "pill" + (driveOn() ? (syncing ? " busy" : " ok") : "");
  s.textContent = !driveOn() ? "ドライブ未連携" : syncing ? "ドライブと同期中" : "ドライブ連携中";
}
async function withSync(fn) { syncing++; setPill(); try { return await fn(); } finally { syncing--; setPill(); } }

function applyRemote(r, rem) {
  r.remote = { folderUrl: rem.folderUrl, audioId: rem.audioId, hasTranscript: rem.hasTranscript,
    transcriptDocUrl: rem.transcriptDocUrl, summaryDocUrl: rem.summaryDocUrl, slidesUrl: rem.slidesUrl };
  const st = FROM_SHEET[rem.status];
  if (st && r.status !== "recorded") r.status = st;
}

// Send a new recording to Drive: details → audio → hand it to the PC for processing
async function pushRecord(r) {
  if (!driveOn()) return;
  r.pending ??= { meta: true, audio: r.status === "recorded" };
  await withSync(async () => {
    if (r.pending.meta) {
      const j = await gas("upsert", { record: metaOf(r), transcript: null });
      r.remote = { ...(r.remote || {}), folderUrl: j.record.folderUrl };
      r.pending.meta = false; await saveRec(r); render();
    }
    if (r.pending.audio) {
      await uploadAudio(r);
      await gas("setStatus", { id: r.id, status: "処理待ち" });
      r.pending.audio = false; r.status = "queued";
      await saveRec(r); render();
    }
  });
}
async function pushAll() {
  for (const r of records) {
    if (r.pending && (r.pending.meta || r.pending.audio)) {
      try { await pushRecord(r); } catch (e) { console.warn(e); }
    }
  }
}
function markDirty(r, what) { r.pending ??= { meta: false, audio: false }; r.pending[what] = true; }

const blobToB64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = rej; fr.readAsDataURL(blob); });

async function uploadAudio(r) {
  const blob = await idb.get("audio", r.id); if (!blob) throw new Error("この端末に音声がありません");
  const ext = (blob.type || r.audioMime || "").includes("mp4") ? "m4a" : "webm";
  const name = r.audioName || `録音_${r.date}_${(r.title || "").replace(/[\\/:*?"<>|]/g, "").slice(0, 30)}.${ext}`;
  const { token } = await gas("uploadInit", { id: r.id, mime: blob.type || r.audioMime || "audio/webm", size: blob.size, name });
  transfers[r.id] = { done: 0, total: blob.size }; render();
  try {
    let off = 0, res;
    while (off < blob.size) {
      const part = blob.slice(off, off + CHUNK);
      res = await gas("uploadChunk", { token, offset: off, total: blob.size, data: await blobToB64(part) });
      off += part.size; transfers[r.id].done = off; renderTransfer(r.id);
    }
    if (res?.fileId) { r.remote ??= {}; r.remote.audioId = res.fileId; }
  } finally { delete transfers[r.id]; }
}

async function pullList() {
  if (!driveOn()) return;
  try {
    const { records: rem } = await withSync(() => gas("list"));
    for (const x of rem) {
      let r = byId(x.id);
      if (!r) {
        r = { id: x.id, title: x.title, type: x.type, date: x.date, participants: x.participants, createdAt: x.updatedAt || Date.now(),
          duration: x.duration, audioMime: x.audioMime, audioSize: x.audioSize, hasAudio: false, transcript: "", status: "queued", bookmarks: [] };
        records.push(r);
      } else if (!r.pending?.meta) {
        Object.assign(r, { title: x.title, type: x.type, date: x.date, participants: x.participants, duration: x.duration || r.duration });
      }
      applyRemote(r, x);
      await saveRec(r);
    }
    render();
  } catch (e) { toast("ドライブに接続できません：" + e.message); }
}

async function fetchTranscript(r) {
  const { text } = await withSync(() => gas("transcript", { id: r.id }));
  r.transcript = text; await saveRec(r); render();
}

/* ---------------- recorder ---------------- */
const rec = { mr: null, stream: null, id: null, chunks: [], n: 0, startedAt: 0, acc: 0, paused: false, marks: [], raf: 0, analyser: null, ctx: null, wake: null, type: cfg.lastType };

function pickMime() {
  const c = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm"];
  return c.find(m => window.MediaRecorder?.isTypeSupported?.(m)) || "";
}
const elapsed = () => rec.acc + (rec.paused || !rec.startedAt ? 0 : (performance.now() - rec.startedAt) / 1000);

async function wake() { try { rec.wake = await navigator.wakeLock?.request("screen"); } catch {} }
document.addEventListener("visibilitychange", () => { if (rec.mr && document.visibilityState === "visible") wake(); });

const canCaptureMeeting = () => !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Web meeting: the meeting's sound (shared tab/screen audio) mixed with this PC's microphone
async function meetingStream() {
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include", selfBrowserSurface: "exclude", surfaceSwitching: "include",
    });
  } catch { toast("画面の共有が取り消されました"); return null; }
  if (!display.getAudioTracks().length) {
    display.getTracks().forEach(t => t.stop());
    toast("会議の音声が共有されていません。共有の画面で「音声も共有する」をオンにしてください");
    return null;
  }
  let mic = null;
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch { toast("マイクを使えないため、相手側の音声だけを録音します"); }
  const ctx = new AudioContext(), dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(dest);
  if (mic) ctx.createMediaStreamSource(mic).connect(dest);
  // stop recording when the person ends screen sharing
  display.getTracks().forEach(t => t.addEventListener("ended", () => stopRec()));
  rec.extra = [display, mic].filter(Boolean);
  rec.mixCtx = ctx;
  return dest.stream;
}

async function startRec(mode) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("このブラウザは録音に対応していません"); return; }
  rec.mode = mode === "meeting" ? "meeting" : "mic";
  rec.extra = []; rec.mixCtx = null;
  if (rec.mode === "meeting") {
    rec.stream = await meetingStream();
    if (!rec.stream) return;
  } else {
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch { toast("マイクを使えません。ブラウザでマイクの使用を許可してください"); return; }
  }
  const mime = pickMime();
  rec.mr = new MediaRecorder(rec.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
  rec.id = uid(); rec.chunks = []; rec.n = 0; rec.acc = 0; rec.marks = []; rec.paused = false;
  rec.mr.ondataavailable = async (e) => {
    if (!e.data?.size) return;
    rec.chunks.push(e.data);
    const n = rec.n++;
    try { await idb.put("chunks", { blob: e.data, type: rec.mr?.mimeType || mime, rtype: rec.type }, rec.id + ":" + String(n).padStart(6, "0")); } catch {}
  };
  rec.mr.onstop = finishRec;
  rec.mr.start(5000);
  rec.startedAt = performance.now();
  try {
    rec.ctx = new AudioContext(); const src = rec.ctx.createMediaStreamSource(rec.stream);
    rec.analyser = rec.ctx.createAnalyser(); rec.analyser.fftSize = 1024; src.connect(rec.analyser);
  } catch {}
  levels.length = 0;
  wake(); recUI(); tick();
}

function pauseRec() {
  if (!rec.mr) return;
  if (rec.paused) { rec.mr.resume(); rec.paused = false; rec.startedAt = performance.now(); }
  else { rec.mr.pause(); rec.acc = elapsed(); rec.paused = true; }
  recUI();
}
function markRec() { if (!rec.mr) return; rec.marks.push(elapsed()); recUI(); toast("しおりを付けました（" + hms(elapsed()) + "）"); }
function stopRec() { if (!rec.mr || rec.mr.state === "inactive") return; rec.acc = elapsed(); rec.paused = true; rec.mr.stop(); }

async function finishRec() {
  cancelAnimationFrame(rec.raf);
  rec.stream?.getTracks().forEach(t => t.stop());
  (rec.extra || []).forEach(s => s.getTracks().forEach(t => t.stop()));
  try { rec.ctx?.close(); } catch {}
  try { rec.mixCtx?.close(); } catch {}
  try { rec.wake?.release(); } catch {}
  const type = rec.mr?.mimeType || pickMime() || "audio/webm";
  const blob = new Blob(rec.chunks, { type });
  const r = {
    id: rec.id, title: `${rec.mode === "meeting" ? "Web会議・" : ""}${TYPES[rec.type]} ${today().slice(5).replace("-", "/")} ${new Date().toTimeString().slice(0, 5)}`,
    type: rec.type, date: today(), participants: "", createdAt: Date.now(), duration: rec.acc,
    audioMime: type, audioSize: blob.size, hasAudio: true, transcript: "", status: "recorded", bookmarks: rec.marks.slice(),
  };
  await idb.put("audio", blob, r.id);
  await saveRec(r);
  const n = rec.n;
  for (let i = 0; i < n; i++) { try { await idb.del("chunks", r.id + ":" + String(i).padStart(6, "0")); } catch {} }
  records.push(r);
  rec.mr = null; rec.stream = null; rec.startedAt = 0; rec.paused = false;
  recUI(); select(r.id);
  toast("録音を保存しました");
  markDirty(r, "meta"); markDirty(r, "audio");
  pushRecord(r).catch(e => toast("ドライブに送れませんでした：" + e.message));
}

// If the page closed mid-recording, rebuild the recording from the 5-second pieces
async function recoverChunks() {
  const keys = (await idb.keys("chunks")) || [];
  if (!keys.length) return;
  const groups = {};
  for (const k of keys) { const [id] = String(k).split(":"); (groups[id] ??= []).push(k); }
  for (const [id, ks] of Object.entries(groups)) {
    ks.sort();
    if (!byId(id)) {
      const parts = []; let type = "audio/webm", t = "oneonone";
      for (const k of ks) { const c = await idb.get("chunks", k); if (c) { parts.push(c.blob); type = c.type || type; t = c.rtype || t; } }
      const blob = new Blob(parts, { type });
      const r = { id, title: "復元された録音 " + today(), type: t, date: today(), participants: "", createdAt: Date.now(), duration: ks.length * 5,
        audioMime: type, audioSize: blob.size, hasAudio: true, transcript: "", status: "recorded", bookmarks: [] };
      await idb.put("audio", blob, id); await saveRec(r); records.push(r);
      markDirty(r, "meta"); markDirty(r, "audio");
      toast("前回途中で止まった録音を復元しました");
    }
    for (const k of ks) await idb.del("chunks", k);
  }
}

const levels = [];
function tick() {
  $("#recTime").textContent = hms(elapsed());
  const cv = $("#level"), g = cv.getContext("2d");
  if (rec.analyser && !rec.paused) {
    const a = new Uint8Array(rec.analyser.fftSize); rec.analyser.getByteTimeDomainData(a);
    let s = 0; for (const v of a) s += ((v - 128) / 128) ** 2;
    levels.push(Math.min(1, Math.sqrt(s / a.length) * 4));
    if (levels.length > 120) levels.shift();
  }
  const css = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, cv.width, cv.height);
  const w = cv.width / 120, mid = cv.height / 2;
  g.fillStyle = css.getPropertyValue(rec.paused ? "--line" : "--rec").trim() || "#cf4426";
  levels.forEach((v, i) => { const h = Math.max(3, v * cv.height * .9); g.fillRect(i * w + 1, mid - h / 2, Math.max(2, w - 2), h); });
  if (rec.mr) rec.raf = requestAnimationFrame(tick);
}

function recUI() {
  const box = $("#rec"), on = !!rec.mr;
  box.classList.toggle("on", on && !rec.paused);
  box.classList.toggle("paused", on && rec.paused);
  $("#recCtrl").hidden = !on;
  $("#meetBtn").hidden = on || !canCaptureMeeting();
  $("#recHint").textContent = on && rec.mode === "meeting"
    ? "会議が終わったら停止ボタンを押してください。画面の共有を止めても録音は終わります。"
    : canCaptureMeeting()
      ? "ウェブ会議は「ウェブ会議を録音」から。共有する画面で、Meetなら会議のタブ、Zoom・Teamsのアプリなら「画面全体」を選び、「音声も共有する」をオンにしてください。録音は相手の同意を得てから行ってください。"
      : "録音中は画面を開いたままにしてください。スマホで別のアプリに切り替えると録音が止まることがあります。";
  $("#recBtn").setAttribute("aria-label", on ? "録音を終了" : "録音開始");
  $("#pauseBtn").textContent = rec.paused ? "再開" : "一時停止";
  $("#recState span").textContent = !on ? "録音を始めるにはボタンを押してください" : rec.paused ? "一時停止中" : rec.mode === "meeting" ? "Web会議を録音中（会議の音声＋マイク）" : "録音中";
  $("#marks").textContent = rec.marks.length ? "★ " + rec.marks.map(hms).join("　★ ") : "";
  document.querySelectorAll("#recType button").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.type === rec.type)); b.disabled = on; });
  if (!on) { $("#recTime").textContent = "00:00:00"; levels.length = 0; tick(); }
}

/* ---------------- import ---------------- */
async function importFiles(files) {
  let last = null;
  for (const f of files) {
    if (!/^audio\/|^video\/mp4/.test(f.type) && !/\.(m4a|mp3|wav|aac|ogg|webm|wma|amr|flac)$/i.test(f.name)) { toast(f.name + " は音声ファイルではありません"); continue; }
    const d = new Date(f.lastModified || Date.now());
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const r = { id: uid(), title: f.name.replace(/\.[^.]+$/, ""), type: rec.type || cfg.lastType || "oneonone", date, participants: "", createdAt: Date.now(),
      duration: 0, audioMime: f.type || "audio/mpeg", audioName: f.name, audioSize: f.size, hasAudio: true, transcript: "", status: "recorded", bookmarks: [] };
    await idb.put("audio", f.slice(0, f.size, r.audioMime), r.id);
    await saveRec(r); records.push(r); last = r;
    markDirty(r, "meta"); markDirty(r, "audio");
    pushRecord(r).catch(e => toast("ドライブに送れませんでした：" + e.message));
  }
  if (last) { select(last.id); toast("取り込みました。ドライブに送ると、PCで自動処理されます"); }
}

/* ---------------- rendering ---------------- */
const cloudSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 12.5h7a3 3 0 0 0 .4-6 4 4 0 0 0-7.7 1A2.5 2.5 0 0 0 4.5 12.5z"/></svg>`;
const extSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9 3h4v4M13 3L7 9M11 9.5V13H3V5h3.5"/></svg>`;

function statusChip(r) {
  const k = r.status || "recorded";
  const cls = k === "summarized" ? "s-sum" : k === "error" ? "s-err" : k === "recorded" ? "" : "s-work";
  return `<span class="chip ${cls}">${STATUS[k]}</span>`;
}

function render() { renderList(); renderDetail(); setPill(); }

function renderList() {
  const ul = $("#list");
  const sorted = records.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
  if (!sorted.length) {
    ul.innerHTML = `<li class="empty">まだ記録はありません。<br>録音ボタンを押すか、音声ファイルを取り込んでください。</li>`;
    return;
  }
  ul.innerHTML = sorted.map(r => `<li><button type="button" class="item${r.id === selected ? " on" : ""}" data-id="${esc(r.id)}">
    <span class="t">${esc(r.title || "無題")}</span>
    <span class="st">${statusChip(r)}${r.remote?.folderUrl ? `<span class="cloud">${cloudSvg}ドライブ</span>` : ""}</span>
    <span class="m"><span>${esc((r.date || "").replace(/-/g, "."))}</span><span>${esc(TYPES[r.type] || "")}</span>${r.duration ? `<span>${hms(r.duration)}</span>` : ""}</span>
  </button></li>`).join("");
}

function select(id) {
  selected = id; confirmDel = false;
  $("#layout").classList.toggle("detail-open", !!id);
  render();
  if (id && innerWidth <= 900) scrollTo({ top: 0 });
}

const STEP_OF = { recorded: 0, queued: 1, transcribing: 1, waiting: 2, summarized: 3, error: 1 };
function statusText(r) {
  if (!driveOn()) return "設定からGoogleドライブ連携を行うと、ドライブに送って自動で文字起こし・要約できます。";
  return {
    recorded: r.pending?.audio ? "ドライブに送信しています。通信できないときは、つながったときに自動で送ります。" : "ドライブへの送信を待っています。",
    queued: "ドライブに届きました。事務所のPCが文字起こしの順番を待っています。",
    transcribing: "事務所のPCで文字起こし中です。1時間の録音で20〜40分ほどかかります。",
    waiting: "文字起こしが終わりました。Claudeが要約と資料を作っています。",
    summarized: "完了しました。要約ドキュメントと報告スライドをドライブに作りました。",
    error: "処理できませんでした。音声ファイルが壊れていないか確認してください。ドライブのフォルダから音声を「受付」に入れ直すと、もう一度処理します。",
  }[r.status || "recorded"];
}

let confirmDel = false;
function renderDetail() {
  const box = $("#detail");
  const r = selected && byId(selected);
  if (!r) {
    box.innerHTML = `<div class="panel placeholder"><div>
      <h2>音声を入れるだけで、要約と資料まで</h2>
      <div class="steps" style="margin-top:18px;text-align:left">
        <div class="step"><span class="n">STEP 1</span><b>録音・取り込み</b><span class="hint">左で録音、またはボイスレコーダーの音声を取り込み。ドライブの「受付」フォルダに直接入れても大丈夫です</span></div>
        <div class="step"><span class="n">STEP 2</span><b>文字起こし</b><span class="hint">事務所のPCが自動で処理します。音声は外部のAIサービスに送りません</span></div>
        <div class="step"><span class="n">STEP 3</span><b>要約・資料</b><span class="hint">Claudeが種類に合わせて要約し、ドキュメントとスライドをドライブに作ります</span></div>
      </div>
      ${driveOn() ? "" : `<p class="hint" style="margin-top:18px">はじめに、右上の設定からGoogleドライブ連携を行ってください。</p>`}
    </div></div>`;
    return;
  }
  const rem = r.remote || {};
  const step = STEP_OF[r.status || "recorded"];
  const editable = r.status === "recorded" || r.status === "queued" || r.status === "transcribing";
  box.innerHTML = `<div class="panel pad stack">
    <div class="d-head">
      <button class="icon-btn" id="backBtn" type="button" aria-label="一覧に戻る" style="${innerWidth > 900 ? "display:none" : ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg></button>
      <div class="ti"><input class="title-in" id="dTitle" value="${esc(r.title)}" aria-label="タイトル"></div>
    </div>
    <div class="row">
      <div class="seg" role="group" aria-label="種類" id="dType">${Object.entries(TYPES).map(([k, v]) => `<button type="button" data-type="${k}" aria-pressed="${r.type === k}" ${editable ? "" : "disabled"}>${v}</button>`).join("")}</div>
    </div>
    <div class="grid2">
      <div class="field"><label for="dDate">日付</label><input id="dDate" type="date" value="${esc(r.date)}"></div>
      <div class="field"><label for="dPeople">参加者</label><input id="dPeople" value="${esc(r.participants)}" placeholder="例：人事 山本、候補者 A様"></div>
    </div>
    ${editable ? `<p class="hint">種類と参加者は要約に使われます。要約ができる前に入れておくと、より正確になります。</p>` : ""}

    <div class="steps">
      ${["送信", "文字起こし", "要約・資料"].map((s, i) => `<div class="step${step > i ? " done" : step === i + 1 && r.status !== "error" ? " now" : ""}"><span class="n">STEP ${i + 1}</span><b>${s}</b></div>`).join("")}
    </div>
    <div class="${r.status === "error" ? "notice" : "work"}"><div class="l"><b>${esc(statusText(r))}</b></div></div>
    <div id="xfer">${transferHtml(r.id)}</div>

    ${rem.summaryDocUrl || rem.slidesUrl || rem.folderUrl ? `<div class="links">
      ${rem.summaryDocUrl ? `<a class="big" href="${esc(rem.summaryDocUrl)}" target="_blank" rel="noopener">${extSvg}要約（Googleドキュメント）</a>` : ""}
      ${rem.slidesUrl ? `<a class="big" href="${esc(rem.slidesUrl)}" target="_blank" rel="noopener">${extSvg}報告スライド（Googleスライド）</a>` : ""}
      ${rem.transcriptDocUrl ? `<a href="${esc(rem.transcriptDocUrl)}" target="_blank" rel="noopener">${extSvg}文字起こし（ドキュメント）</a>` : ""}
      ${rem.folderUrl ? `<a href="${esc(rem.folderUrl)}" target="_blank" rel="noopener">${extSvg}ドライブのフォルダ</a>` : ""}
    </div>` : ""}

    ${r.hasAudio ? `<audio id="player" controls preload="metadata"></audio>` : ""}

    ${rem.hasTranscript ? (r.transcript ? `<div class="stack" style="gap:8px">
      <div class="row" style="justify-content:space-between"><p class="eyebrow">文字起こし</p><span class="hint">${r.transcript.length.toLocaleString()} 文字</span></div>
      <textarea class="transcript" id="transcript" readonly>${esc(r.transcript)}</textarea>
      <p class="hint">誤変換を直すときは、ドライブの「文字起こし」ドキュメントを編集してください。</p>
    </div>` : `<div class="row"><button class="btn" id="getTr" type="button">文字起こしを表示</button></div>`) : ""}

    <div class="row" style="justify-content:flex-end;border-top:1px solid var(--line);padding-top:12px">
      ${confirmDel ? `<span class="hint">この端末の一覧から消しますか？（ドライブのファイルは残ります）</span><button class="btn" id="delYes" type="button" style="color:var(--rec)">消す</button><button class="btn ghost" id="delNo" type="button">やめる</button>`
        : `<button class="btn ghost small" id="delBtn" type="button">この端末の一覧から消す</button>`}
    </div>
  </div>`;
  bindDetail(r);
}

function transferHtml(id) {
  const t = transfers[id]; if (!t) return "";
  const pct = t.total ? Math.round(t.done / t.total * 100) : 0;
  return `<div class="work"><div class="l"><b>ドライブに音声を送信中</b><span>${mb(t.done)} / ${mb(t.total)}</span></div><div class="progress"><i style="width:${pct}%"></i></div>
    <span class="hint">送信が終わるまでこの画面を開いたままにしてください。</span></div>`;
}
function renderTransfer(id) { if (id === selected) { const x = $("#xfer"); if (x) x.innerHTML = transferHtml(id); } }

let editTimer = 0;
function bindDetail(r) {
  const on = (s, ev, f) => { const el = $(s); if (el) el.addEventListener(ev, f); };
  on("#backBtn", "click", () => select(null));
  const metaChanged = async () => { await saveRec(r); renderList(); markDirty(r, "meta"); clearTimeout(editTimer); editTimer = setTimeout(() => pushRecord(r).catch(() => {}), 1200); };
  on("#dTitle", "change", e => { r.title = e.target.value.trim() || "無題"; metaChanged(); });
  on("#dDate", "change", e => { r.date = e.target.value; metaChanged(); });
  on("#dPeople", "change", e => { r.participants = e.target.value; metaChanged(); });
  document.querySelectorAll("#dType button").forEach(b => b.onclick = () => { r.type = b.dataset.type; metaChanged(); renderDetail(); });
  on("#getTr", "click", () => fetchTranscript(r).catch(e => toast("読み込めませんでした：" + e.message)));
  on("#delBtn", "click", () => { confirmDel = true; renderDetail(); });
  on("#delNo", "click", () => { confirmDel = false; renderDetail(); });
  on("#delYes", "click", async () => {
    await idb.del("records", r.id); await idb.del("audio", r.id);
    records = records.filter(x => x.id !== r.id); select(null); toast("この端末の一覧から消しました");
  });
  if (r.hasAudio) {
    idb.get("audio", r.id).then(b => {
      const p = $("#player"); if (!p || !b) return;
      const u = URL.createObjectURL(b); p.src = u;
    });
  }
}

/* ---------------- settings dialog ---------------- */
function openSettings() {
  $("#sUrl").value = cfg.gasUrl; $("#sKey").value = cfg.gasKey; $("#sTestOut").textContent = "";
  $("#settings").showModal();
}
$("#settingsBtn").onclick = openSettings;
$("#sTest").onclick = async () => {
  const out = $("#sTestOut"); out.textContent = "確認しています…";
  const keep = { u: cfg.gasUrl, k: cfg.gasKey };
  cfg.gasUrl = $("#sUrl").value.trim(); cfg.gasKey = $("#sKey").value.trim();
  try { const j = await gas("ping"); out.innerHTML = `接続できました。<a href="${esc(j.folderUrl)}" target="_blank" rel="noopener">保存フォルダを開く</a>`; }
  catch (e) { out.textContent = "接続できません：" + e.message; }
  finally { cfg.gasUrl = keep.u; cfg.gasKey = keep.k; }
};
$("#sSave").onclick = async () => {
  cfg.gasUrl = $("#sUrl").value.trim(); cfg.gasKey = $("#sKey").value.trim();
  saveCfg(); $("#settings").close(); toast("保存しました"); render();
  if (driveOn()) {
    for (const r of records) if (r.status === "recorded") { markDirty(r, "meta"); markDirty(r, "audio"); }
    await pullList(); pushAll();
  }
};
$("#sLink").onclick = async () => {
  const u = $("#sUrl").value.trim(), k = $("#sKey").value.trim();
  if (!u || !k) { $("#sTestOut").textContent = "連携用URLと合言葉を入力してください"; return; }
  const b = btoa(unescape(encodeURIComponent(JSON.stringify({ u, k })))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const link = location.origin + location.pathname + "#setup=" + b;
  try { await navigator.clipboard.writeText(link); toast("セットアップリンクをコピーしました"); }
  catch { $("#sTestOut").textContent = link; }
};

/* ---------------- wiring ---------------- */
$("#recBtn").onclick = () => rec.mr ? stopRec() : startRec("mic");
$("#meetBtn").onclick = () => { if (!rec.mr) startRec("meeting"); };
$("#pauseBtn").onclick = pauseRec;
$("#markBtn").onclick = markRec;
document.querySelectorAll("#recType button").forEach(b => b.onclick = () => { rec.type = b.dataset.type; cfg.lastType = rec.type; saveCfg(); recUI(); });
const zone = $("#importZone");
$("#importFile").onchange = (e) => { importFiles([...e.target.files]); e.target.value = ""; };
zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("over"); };
zone.ondragleave = () => zone.classList.remove("over");
zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove("over"); importFiles([...e.dataTransfer.files]); };
$("#list").onclick = (e) => { const b = e.target.closest(".item"); if (b) select(b.dataset.id); };
$("#refreshBtn").onclick = async () => { if (!driveOn()) { toast("Googleドライブ連携は設定から行えます"); return; } await pullList(); pushAll(); toast("最新の状態にしました"); };
addEventListener("beforeunload", (e) => { if (rec.mr || Object.keys(transfers).length) { e.preventDefault(); e.returnValue = ""; } });
addEventListener("online", () => pushAll());
addEventListener("resize", () => { const b = $("#backBtn"); if (b) b.style.display = innerWidth > 900 ? "none" : ""; });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && driveOn() && !rec.mr) pullList(); });
// while something is being processed on the PC, check back every minute
setInterval(() => {
  if (document.visibilityState === "visible" && driveOn() && !rec.mr && records.some(r => ["queued", "transcribing", "waiting"].includes(r.status))) pullList();
}, 60000);

/* ---------------- boot ---------------- */
(async function boot() {
  try { await navigator.storage?.persist?.(); } catch {}
  records = (await idb.all("records")) || [];
  await recoverChunks();
  rec.type = cfg.lastType || "oneonone";
  recUI(); render();
  if (driveOn()) { await pullList(); pushAll(); }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();

let tt = 0;
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 3600); }
