/* ============================================================
   app.js — Calendar Application + Supabase sync
   ============================================================ */
'use strict';

// ── Login diagnostics (helps when auth fails) ─────────────────────────────────
function _fmtErr(e){
  if(!e) return '';
  if(typeof e === 'string') return e;
  const parts = [];
  if(e.message) parts.push(e.message);
  if(e.status) parts.push(`status=${e.status}`);
  if(e.code) parts.push(`code=${e.code}`);
  if(e.details) parts.push(`details=${e.details}`);
  if(e.hint) parts.push(`hint=${e.hint}`);
  try{
    // Supabase errors sometimes include __isAuthError / name
    if(e.name && !parts.includes(e.name)) parts.push(`name=${e.name}`);
  }catch(_){}
  return parts.join(' / ');
}

function _envHints(){
  const hints = [];
  if (location.protocol === 'file:') {
    hints.push('いま file:// で開いています。Authのリダイレクトやセッション保存が不安定になるので、VSCode Live Server などで http://localhost で開いてください。');
  }
  hints.push(`origin=${location.origin}`);
  return hints.join('\n');
}

// 捕捉できない例外も画面に出す（ログイン押して無反応…を潰す）
window.addEventListener('error', (ev) => {
  const box = document.getElementById('js-auth-error');
  if(!box) return;
  box.style.display = 'block';
  box.textContent = `エラー: ${ev.message}\n${_envHints()}`;
});
window.addEventListener('unhandledrejection', (ev) => {
  const box = document.getElementById('js-auth-error');
  if(!box) return;
  box.style.display = 'block';
  box.textContent = `Promiseエラー: ${_fmtErr(ev.reason)}\n${_envHints()}`;
});


// ── Supabase ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://oungvayvmxkszsokxwxd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91bmd2YXl2bXhrc3pzb2t4d3hkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDEyODgsImV4cCI6MjA4NzA3NzI4OH0.pfwa_xQDlm6Mba3Rw4hx2V9LB1Qf__EioCW-NOGHenQ';

const _sb = window.supabase;
if (!_sb || typeof _sb.createClient !== 'function') {
  console.error('Supabase SDK not loaded. Check the <script> tag for @supabase/supabase-js.');
}
const { createClient } = _sb || {};
const db = createClient ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function ensureDb(){
  if(db) return true;
  showAuthMsg('Supabase SDK の読み込みに失敗しています。ネットワーク/拡張機能/HTMLの<script>読み込み順を確認してください。', true);
  return false;
}



// ── Constants ─────────────────────────────────────────────────────────────────

const MONTHS_EN = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];
const MONTHS_INIT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS_JA = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const DAYS_JA   = ['日','月','火','水','木','金','土'];

const PRESET_COLORS = [
  '#e03131','#c2255c','#9c36b5','#6741d9','#3b5bdb','#1971c2',
  '#0c8599','#087f5b','#2f9e44','#74b816','#e67700','#f76707',
  '#ff6b6b','#748ffc','#63e6be','#a9e34b','#ffd43b','#845ef7'
];

const DEFAULT_CATEGORIES = [
  { id:1, name:'仕事',   color:'#e67700', type:'normal',
    templates:[
      { label:'定例ミーティング', title:'定例ミーティング', start:'10:00', end:'11:00' },
      { label:'ランチ', title:'ランチ', start:'12:00', end:'13:00' }
    ]
  },
  { id:2, name:'個人',   color:'#845ef7', type:'normal' },
  { id:3, name:'健康',   color:'#2f9e44', type:'normal' },
  { id:4, name:'締切',   color:'#e03131', type:'normal' },
  { id:5, name:'バイト', color:'#1971c2', type:'shift', hourlyWage:1100,
    templates:[
      { label:'夕方', start:'17:00', end:'22:00', breakMin:60 },
      { label:'昼間', start:'10:00', end:'15:00', breakMin:45 }
    ]
  }
];

// ── State ─────────────────────────────────────────────────────────────────────

let categories     = [];
let events         = {};          // { dateKey: [ eventObj, … ] }
let curDate        = new Date();
let selectedKey    = null;
let selectedCatId  = null;
let editingCats    = [];
let colorTargetIdx = null;
let _colorMode     = 'calendar'; // 'calendar' | 'budget_exp' | 'budget_inc'
let isDark         = loadLocalJSON('cal_dark') ?? false;
let activeTab      = 'event';
let currentUser    = null;
let currentView    = 'month';  // 'month' | 'day'

// ── Japan Holidays ─────────────────────────────────────────────────────────────

const _holidays = {};  // { year: { 'YYYY-MM-DD': '祝日名' } }

async function fetchHolidays(year) {
  if (_holidays[year] !== undefined) return;
  _holidays[year] = {};  // mark in-progress to prevent duplicate requests
  try {
    const res = await fetch(`https://holidays-jp.github.io/api/v1/${year}/date.json`);
    if (!res.ok) return;
    _holidays[year] = await res.json();
  } catch(e) { console.warn('祝日取得失敗', e); }
}

function getHolidayName(key) {
  // key = 'YYYY-MM-DD'
  return (_holidays[+key.slice(0,4)] || {})[key] || '';
}

// ── Local helpers (theme / misc only — data lives in Supabase) ────────────────

function loadLocalJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveLocalJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function dateKey(y, m, d) {
  return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function getCat(id)   { return categories.find(c => c.id === id); }
function normalCats() { return categories.filter(c => c.type !== 'shift'); }
function shiftCats()  { return categories.filter(c => c.type === 'shift'); }
function isShift(id)  { return getCat(id)?.type === 'shift'; }

// スマホ縦幅のとき、月表示のセル内は省スペースのため「開始時刻だけ」を表示する
function isNarrowScreen() {
  return window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
}

function shortStartTime(rangeOrTime) {
  if (!rangeOrTime) return '';
  // "10:00–11:00" / "10:00-11:00" / "10:00" → "10:00"
  return String(rangeOrTime).split(/[–-]/)[0].trim();
}

function catCounts() {
  // カテゴリ別の「今月の予定数」を集計（サイドバー表示用）
  const y = curDate.getFullYear();
  const m = curDate.getMonth();
  const dim = new Date(y, m + 1, 0).getDate();
  const c = Object.fromEntries(categories.map(cat => [cat.id, 0]));
  for (let d = 1; d <= dim; d++) {
    const key = dateKey(y, m, d);
    (events[key] || []).forEach(ev => {
      if (c[ev.catId] !== undefined) c[ev.catId]++;
    });
  }
  return c;
}

// ── Push Notification ─────────────────────────────────────────────────────────

// VAPID public key（Edge Function の VAPID_PUBLIC_KEY と一致させること）
const VAPID_PUBLIC_KEY = 'BNbaJJlWNEwlkbRPPJjgU_NAtj-hUc_d8qksT3aoSlsBaxuCDwnMYYgeM0gzVcd6Qqd-J2xGJ4DzPX4FjCsrcug';

function _urlBase64ToUint8Array(base64String) {
  const pad = '='.repeat((4 - base64String.length % 4) % 4);
  const b64 = (base64String + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/** サーバー Push 購読を取得・保存する */
async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!currentUser || !db) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    const j = sub.toJSON();
    await db.from('push_subscriptions').upsert({
      user_id:  currentUser.id,
      endpoint: j.endpoint,
      p256dh:   j.keys.p256dh,
      auth:     j.keys.auth
    }, { onConflict: 'user_id,endpoint' });
  } catch (e) {
    console.warn('Push subscription failed:', e);
  }
}

const NOTIF_STORAGE_KEY = 'notified_keys_v1';

function _getNotifiedKeys() {
  try {
    const raw = localStorage.getItem(NOTIF_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // 今日の日付キーのみ保持（昨日以前は自動削除）
    const today = _todayStrLocal();
    if (parsed._date !== today) return {};
    return parsed;
  } catch { return {}; }
}

function _saveNotifiedKeys(keys) {
  keys._date = _todayStrLocal();
  localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(keys));
}

function _todayStrLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _addDaysToStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _diffDays(dateStr) {
  const today = new Date(_todayStrLocal() + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

async function _showNotif(title, body, tag) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body, tag, icon: '' });
  } catch {
    new Notification(title, { body, tag });
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// ログイン後に呼ぶ：通知許可を求め、Push 購読登録し、当日分チェック
async function initNotifications() {
  if (!('Notification' in window)) return;
  const granted = await requestNotificationPermission();
  checkAndSendNotifications();

  // アプリを開いていないときも通知が届くよう Web Push 購読を登録
  if (granted) subscribeToPush();

  // 次の00:00に再チェックをスケジュール
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1).getTime() - now.getTime();
  setTimeout(() => {
    checkAndSendNotifications();
    setInterval(checkAndSendNotifications, 86400000);
  }, msUntilMidnight);
}

function checkAndSendNotifications() {
  if (Notification.permission !== 'granted') return;
  const today = _todayStrLocal();
  const notified = _getNotifiedKeys();

  // ── タスク通知（4日前・2日前・当日）──
  const taskDays = [4, 2, 0];
  const allTasks = _taskState?.tasks ?? [];
  allTasks.forEach(task => {
    if (task.done || !task.dueDate) return;
    const diff = _diffDays(task.dueDate);
    if (!taskDays.includes(diff)) return;
    const key = `task_${task.id}_${today}_d${diff}`;
    if (notified[key]) return;
    notified[key] = 1;
    const label = diff === 0 ? '今日が期限' : `${diff}日後が期限`;
    _showNotif('📋 タスクのお知らせ', `「${task.title}」の${label}です`, key);
  });

  // ── イベント通知（前日・当日）──
  const eventDays = [1, 0];
  Object.entries(events ?? {}).forEach(([dateKey, evList]) => {
    if (!evList?.length) return;
    const diff = _diffDays(dateKey);
    if (!eventDays.includes(diff)) return;
    evList.forEach(ev => {
      if (!ev.title) return;
      const key = `event_${ev._dbId ?? dateKey}_${today}_d${diff}`;
      if (notified[key]) return;
      notified[key] = 1;
      const label = diff === 0 ? '今日' : '明日';
      const timeStr = ev.timeStart ? ` (${ev.timeStart}〜)` : '';
      _showNotif('📅 イベントのお知らせ', `${label}「${ev.title}」${timeStr}があります`, key);
    });
  });

  _saveNotifiedKeys(notified);
}

// ── Wage helpers ──────────────────────────────────────────────────────────────

function calcShift(ev) {
  if (!ev.shiftStart || !ev.shiftEnd)
    return { totalMinutes:0, breakMinutes:0, workMinutes:0, pay:0 };
  const [sh,sm] = ev.shiftStart.split(':').map(Number);
  const [eh,em] = ev.shiftEnd.split(':').map(Number);
  let total = (eh*60+em) - (sh*60+sm);
  if (total <= 0) total += 1440;
  const brk  = Math.max(0, ev.breakMinutes ?? 0);
  const work = Math.max(0, total - brk);
  const wage = getCat(ev.catId)?.hourlyWage ?? 0;
  return { totalMinutes:total, breakMinutes:brk, workMinutes:work, pay:Math.floor(work/60*wage) };
}

function fmtMin(m) { const h=Math.floor(m/60),r=m%60; return r?`${h}h${r}m`:`${h}h`; }
function fmtYen(n) { return '¥'+Math.round(n).toLocaleString('ja-JP'); }

function monthlySalary() {
  const y=curDate.getFullYear(), m=curDate.getMonth();
  const dim=new Date(y,m+1,0).getDate(), res={};
  for (let d=1;d<=dim;d++) {
    (events[dateKey(y,m,d)]||[]).filter(ev=>isShift(ev.catId)).forEach(ev=>{
      const {workMinutes,pay}=calcShift(ev);
      if (!res[ev.catId]) res[ev.catId]={workMinutes:0,pay:0};
      res[ev.catId].workMinutes+=workMinutes;
      res[ev.catId].pay+=pay;
    });
  }
  return res;
}

function monthlySalaryToDate() {
  const y=curDate.getFullYear(), m=curDate.getMonth();
  const today=new Date();
  const isCurrentMonth=(y===today.getFullYear()&&m===today.getMonth());
  const maxDay=isCurrentMonth?today.getDate():new Date(y,m+1,0).getDate();
  const res={};
  for (let d=1;d<=maxDay;d++) {
    (events[dateKey(y,m,d)]||[]).filter(ev=>isShift(ev.catId)).forEach(ev=>{
      const {workMinutes,pay}=calcShift(ev);
      if (!res[ev.catId]) res[ev.catId]={workMinutes:0,pay:0};
      res[ev.catId].workMinutes+=workMinutes;
      res[ev.catId].pay+=pay;
    });
  }
  return res;
}

// ── Sync indicator ────────────────────────────────────────────────────────────

function setSyncStatus(status) { // 'syncing' | 'synced' | 'error'
  const el = document.getElementById('js-sync-indicator');
  if (el) {
    el.className = 'sync-indicator ' + status;
    el.title = status === 'syncing' ? '同期中...' : status === 'synced' ? '同期済み' : '同期エラー';
  }
  const elStatus = document.getElementById('js-status-sync');
  if (elStatus) {
    elStatus.textContent = status === 'syncing' ? '⟳ 同期中' : status === 'synced' ? '✓ 同期済み' : '✕ エラー';
    elStatus.style.color = status === 'error' ? 'var(--color-danger)' : status === 'synced' ? 'var(--color-positive)' : '';
  }
}

// ── Supabase: load data ───────────────────────────────────────────────────────

async function loadFromSupabase() {
  setSyncStatus('syncing');
  try {
    const uid = currentUser.id;

    // Load categories
    const { data: cats, error: cErr } = await db
      .from('categories')
      .select('*')
      .eq('user_id', uid)
      .order('sort_order');

    if (cErr) throw cErr;

    if (cats && cats.length > 0) {
      categories = cats.map(r => ({
        id:          r.cat_id,
        name:        r.name,
        color:       r.color,
        type:        r.type,
        hourlyWage:  r.hourly_wage ?? undefined,
        templates:   r.templates ?? []
      }));
    } else {
      // First login: seed defaults
      categories = deepClone(DEFAULT_CATEGORIES);
      await saveCategoriesToSupabase();
    }

    // Load events
    const { data: evs, error: eErr } = await db
      .from('events')
      .select('*')
      .eq('user_id', uid);

    if (eErr) throw eErr;

    events = {};
    (evs || []).forEach(r => {
      const key = r.date_key ?? r.dateKey ?? r.date;
      if (!events[key]) events[key] = [];
      // カラム名を複数パターンで対応（テーブルごとの命名揺れに対応）
      const timeEnd      = r.time_end      ?? r.timeEnd      ?? r.time_end_col ?? '';
      const shiftStart   = r.shift_start   ?? r.shiftStart   ?? r.start        ?? '';
      const shiftEnd     = r.shift_end     ?? r.shiftEnd     ?? r.end          ?? '';
      const breakMinutes = r.break_minutes ?? r.breakMinutes ?? r.break        ?? 0;
      const catId        = r.cat_id        ?? r.catId        ?? r.category_id  ?? 0;
      const dateKey2     = r.date_key      ?? r.dateKey      ?? r.date         ?? key;
      events[key].push({
        _dbId:        r.id,
        catId,
        title:        r.title ?? '',
        time:         r.time  ?? '',
        timeEnd,
        shiftStart,
        shiftEnd,
        breakMinutes
      });
    });

    selectedCatId = normalCats()[0]?.id ?? categories[0]?.id;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Load error:', e);
    setSyncStatus('error');
    alert('データの読み込みに失敗しました。\n' + (e.message || JSON.stringify(e)));
  }
}

// ── Supabase: save categories ─────────────────────────────────────────────────

async function saveCategoriesToSupabase() {
  setSyncStatus('syncing');
  try {
    const uid = currentUser.id;
    // Upsert all categories
    const rows = categories.map((cat, i) => ({
      user_id:     uid,
      cat_id:      cat.id,
      name:        cat.name,
      color:       cat.color,
      type:        cat.type,
      hourly_wage: cat.hourlyWage ?? null,
      templates:   cat.templates  ?? [],
      sort_order:  i
    }));

    const { error } = await db
      .from('categories')
      .upsert(rows, { onConflict: 'user_id,cat_id' });

    if (error) throw error;

    // Delete removed categories
    const validIds = categories.map(c => c.id);
    await db.from('categories')
      .delete()
      .eq('user_id', uid)
      .not('cat_id', 'in', `(${validIds.join(',')})`);

    setSyncStatus('synced');
  } catch (e) {
    console.error('Save cats error:', e);
    setSyncStatus('error');
  }
}

// ── Supabase: add event ───────────────────────────────────────────────────────

// カラム名マッピング — Supabaseの実際のカラム名に合わせて自動検出する
let _evColMap = null;  // null = 未検出, object = 検出済み

async function detectEventColumns() {
  if (_evColMap) return _evColMap;
  // テーブルから1行取得してカラム名を調べる
  const { data } = await db.from('events').select('*').limit(1);
  if (data && data.length > 0) {
    const cols = Object.keys(data[0]);
    console.log('events カラム名:', cols);
    _evColMap = {
      timeEnd:      cols.find(c => /time.?end|endtime|end.?time/i.test(c)) ?? 'time_end',
      shiftStart:   cols.find(c => /shift.?start|start.?shift/i.test(c))  ?? 'shift_start',
      shiftEnd:     cols.find(c => /shift.?end|end.?shift/i.test(c))      ?? 'shift_end',
      breakMinutes: cols.find(c => /break/i.test(c))                       ?? 'break_minutes',
      dateKey:      cols.find(c => /date.?key|key.?date/i.test(c))         ?? 'date_key',
      catId:        cols.find(c => /cat.?id|category.?id/i.test(c))        ?? 'cat_id',
      userId:       cols.find(c => /user.?id/i.test(c))                    ?? 'user_id',
    };
  } else {
    // テーブルが空の場合はデフォルトを使う
    _evColMap = {
      timeEnd: 'time_end', shiftStart: 'shift_start', shiftEnd: 'shift_end',
      breakMinutes: 'break_minutes', dateKey: 'date_key', catId: 'cat_id', userId: 'user_id'
    };
  }
  return _evColMap;
}

async function addEventToSupabase(key, ev) {
  setSyncStatus('syncing');
  try {
    const m = await detectEventColumns();
    const row = {
      [m.userId]:       currentUser.id,
      [m.dateKey]:      key,
      [m.catId]:        ev.catId,
      title:            ev.title        ?? '',
      time:             ev.time         || null,
      [m.timeEnd]:      ev.timeEnd      || null,
      [m.shiftStart]:   ev.shiftStart   || null,
      [m.shiftEnd]:     ev.shiftEnd     || null,
      [m.breakMinutes]: ev.breakMinutes ?? 0
    };
    const { data, error } = await db.from('events').insert(row).select().single();
    if (error) throw error;
    ev._dbId = data.id;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Add event error:', e);
    setSyncStatus('error');
    alert('予定の保存に失敗しました。\n\nエラー: ' + (e.message || JSON.stringify(e)) + '\n\n実際のカラム名: ' + JSON.stringify(_evColMap));
  }
}

// ── Supabase: delete event ────────────────────────────────────────────────────

async function deleteEventFromSupabase(ev) {
  if (!ev._dbId) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('events').delete().eq('id', ev._dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Delete event error:', e);
    setSyncStatus('error');
    alert('予定の削除に失敗しました。\n' + (e.message || JSON.stringify(e)));
  }
}

// ── Supabase: update event ────────────────────────────────────────────────────

async function updateEventInSupabase(ev) {
  if (!ev._dbId) return;
  setSyncStatus('syncing');
  try {
    const m = await detectEventColumns();
    const { error } = await db.from('events').update({
      [m.catId]:        ev.catId,
      title:            ev.title        ?? '',
      time:             ev.time         || null,
      [m.timeEnd]:      ev.timeEnd      || null,
      [m.shiftStart]:   ev.shiftStart   || null,
      [m.shiftEnd]:     ev.shiftEnd     || null,
      [m.breakMinutes]: ev.breakMinutes ?? 0
    }).eq('id', ev._dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Update event error:', e);
    setSyncStatus('error');
    alert('予定の更新に失敗しました。\n' + (e.message || JSON.stringify(e)));
  }
}

// ── Supabase: move event to another date ──────────────────────────────────────

async function updateEventDateInSupabase(dbId, newKey) {
  if (!dbId) return;
  setSyncStatus('syncing');
  try {
    const m = await detectEventColumns();
    const { error } = await db.from('events').update({
      [m.dateKey]: newKey
    }).eq('id', dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch(e) {
    console.error('Move event error:', e);
    setSyncStatus('error');
    alert('予定の移動に失敗しました。\n' + (e.message || JSON.stringify(e)));
  }
}

async function moveEventToDate(dbId, srcKey, destKey) {
  if (!dbId || srcKey === destKey) return;
  const srcEvs = events[srcKey] || [];
  const idx = srcEvs.findIndex(ev => String(ev._dbId) === String(dbId));
  if (idx === -1) return;
  const ev = srcEvs.splice(idx, 1)[0];
  if (!srcEvs.length) delete events[srcKey]; else events[srcKey] = srcEvs;
  if (!events[destKey]) events[destKey] = [];
  events[destKey].push(ev);
  renderMain();
  renderMini();
  renderSalarySummary();
  await updateEventDateInSupabase(dbId, destKey);
}

function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
function toggleTheme() {
  isDark = !isDark; applyTheme(isDark); saveLocalJSON('cal_dark', isDark);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function showAuthScreen() {
  document.getElementById('js-auth-screen').style.display = '';
  document.getElementById('js-app').style.display = 'none';
}

async function showApp(user) {
  currentUser = user;
  document.getElementById('js-auth-screen').style.display = 'none';
  document.getElementById('js-app').style.display = '';
  document.getElementById('js-user-email').textContent = user.email ?? user.user_metadata?.full_name ?? '';

  initTaskPanel(user);
  initBudgetPanel(user);
  initBottomPanelTabs();
  initBottomPanelSwipe();
  initBottomPanelResize();

  await loadFromSupabase();
  // 祝日データをフェッチ（今年・来年）してから再描画
  const _cy = new Date().getFullYear();
  Promise.all([fetchHolidays(_cy), fetchHolidays(_cy + 1)]).then(() => renderAll());
  renderAll();

  // 通知の初期化（許可取得 + 当日分チェック）
  initNotifications();
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function showAuthMsg(text, isError = true, raw = null) {
  const el = document.getElementById('js-auth-error');
  if (!el) return;
  let msg = text || '';
  if (isError) {
    const env = _envHints();
    if (env) msg += (msg ? '\n\n' : '') + env;
    const rawMsg = _fmtErr(raw);
    if (rawMsg) msg += (msg ? '\n\n' : '') + '詳細: ' + rawMsg;
  }
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
  el.style.color = isError ? '' : 'var(--color-positive)';
  el.style.background = isError ? '' : 'var(--color-positive-bg)';
  el.style.border = isError ? '' : '1px solid var(--color-positive-border)';
}



function setAuthLoading(loading) {
  const submitBtn  = document.getElementById('js-auth-submit');
  const googleBtn  = document.getElementById('js-auth-google');
  const loadEl     = document.getElementById('js-auth-loading');
  submitBtn.disabled = loading;
  googleBtn.disabled = loading;
  loadEl.style.display = loading ? '' : 'none';
}

function translateAuthError(msg) {
  if (!msg) return '不明なエラーが発生しました';
  if (msg.includes('Invalid login credentials'))   return 'メールアドレスまたはパスワードが正しくありません';
  if (msg.includes('Email not confirmed'))          return 'メールアドレスが確認されていません。確認メールのリンクをクリックしてください';
  if (msg.includes('User already registered'))      return 'このメールアドレスはすでに登録されています。ログインしてください';
  if (msg.includes('Password should be at least'))  return 'パスワードは6文字以上で設定してください';
  if (msg.includes('Unable to validate email'))     return '有効なメールアドレスを入力してください';
  if (msg.includes('Email rate limit exceeded'))    return 'しばらく時間をおいてから再度お試しください';
  if (msg.includes('network'))                      return 'ネットワークエラーが発生しました。接続を確認してください';
  return msg;
}

// Auth tab switch
document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('is-active', b === btn));
    const isLogin = btn.dataset.tab === 'login';
    document.getElementById('js-auth-submit').textContent = isLogin ? 'ログイン' : '新規登録';
    document.getElementById('js-auth-password').autocomplete = isLogin ? 'current-password' : 'new-password';
    showAuthMsg('');
  });
});

// Enter key on inputs
['js-auth-email', 'js-auth-password'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('js-auth-submit').click();
  });
});

// Email/password submit
document.getElementById('js-auth-submit').addEventListener('click', async () => {
  const email    = document.getElementById('js-auth-email').value.trim();
  const password = document.getElementById('js-auth-password').value;
  const isLogin  = document.querySelector('.auth-tab.is-active').dataset.tab === 'login';

  showAuthMsg('');

  if (!email)    { showAuthMsg('メールアドレスを入力してください'); return; }
  if (!password) { showAuthMsg('パスワードを入力してください'); return; }
  if (!isLogin && password.length < 6) { showAuthMsg('パスワードは6文字以上で設定してください'); return; }

  if(!ensureDb()) return;
  setAuthLoading(true);
  try {
    let result;
    if (isLogin) {
      result = await db.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      // onAuthStateChange → showApp() が自動で呼ばれる
    } else {
      result = await db.auth.signUp({ email, password });
      if (result.error) throw result.error;

      if (!result.data.session) {
        // メール確認が必要なケース
        showAuthMsg(
          '確認メールを送信しました📧\n' +
          email + ' の受信ボックスを確認し、メール内のリンクをクリックしてからログインしてください。\n' +
          '（迷惑メールフォルダも確認してください）',
          false
        );
      }
      // session ありなら onAuthStateChange が showApp() を呼ぶ
    }
  } catch (e) {
    showAuthMsg(translateAuthError(e?.message || String(e)), true, e);
  } finally {
    setAuthLoading(false);
  }
});

// Google OAuth — Supabase側でGoogleが有効かチェックしてからボタン表示
(async () => {
  try {
    const res  = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_KEY }
    });
    const json = await res.json();
    const googleEnabled = json?.external?.google === true;
    const googleBtn = document.getElementById('js-auth-google');
    const divider   = document.getElementById('js-auth-divider');
    if (!googleEnabled) {
      // Googleが無効なら非表示
      googleBtn.style.display = 'none';
      if (divider) divider.style.display = 'none';
    }
  } catch { /* ネットワーク失敗時はそのまま表示 */ }
})();

document.getElementById('js-auth-google').addEventListener('click', async () => {
  setAuthLoading(true);
  showAuthMsg('');
  try {
    const { error } = await db.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { access_type: 'offline', prompt: 'consent' }
      }
    });
    if (error) throw error;
    // ブラウザがGoogleにリダイレクトするのでローディングはそのまま
  } catch (e) {
    showAuthMsg(translateAuthError(e?.message || String(e)), true, e);
    setAuthLoading(false);
  }
});

// Logout
document.getElementById('js-logout').addEventListener('click', async () => {
  if(!ensureDb()) return;
  await db.auth.signOut();
  currentUser = null; categories = []; events = {};
  showAuthScreen();
});

// Auth state listener
let _appInitialized = false;

if (db) db.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    if (!_appInitialized || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      _appInitialized = true;
      showApp(session.user);
    }
  } else {
    _appInitialized = false;
    showAuthScreen();
  }
});

// ── Salary summary ────────────────────────────────────────────────────────────

function renderSalarySummary() {
  const box     = document.getElementById('js-salary-summary');
  const summary = monthlySalary();
  const today   = new Date();
  const isCurrentMonth = curDate.getFullYear()===today.getFullYear() &&
                         curDate.getMonth()===today.getMonth();
  box.innerHTML = '';

  const active = shiftCats().filter(c => summary[c.id]);
  if (!active.length) {
    box.innerHTML = '<div class="salary-empty">シフトの記録がありません</div>';
    return;
  }

  let total = 0;
  active.forEach(cat => {
    const { workMinutes, pay } = summary[cat.id];
    total += pay;
    const row = document.createElement('div');
    row.className = 'salary-job-row';
    row.innerHTML = `
      <span class="salary-job-dot" style="background:${cat.color}"></span>
      <span class="salary-job-name">${escHtml(cat.name)}</span>
      <span class="salary-job-hours">${fmtMin(workMinutes)}</span>
      <span class="salary-job-amount">${fmtYen(pay)}</span>`;
    box.appendChild(row);
  });

  box.insertAdjacentHTML('beforeend','<div class="salary-divider"></div>');

  if (isCurrentMonth) {
    const toDateSummary = monthlySalaryToDate();
    let totalToDate = 0;
    Object.values(toDateSummary).forEach(v => { totalToDate += v.pay; });

    const todayRow = document.createElement('div');
    todayRow.className = 'salary-today-row';
    todayRow.innerHTML = `<span class="salary-today-label">今日まで</span>
                          <span class="salary-today-amount">${fmtYen(totalToDate)}</span>`;
    box.appendChild(todayRow);
  }

  const tot = document.createElement('div');
  tot.className = 'salary-total-row';
  tot.style.marginTop = '3px';
  tot.innerHTML = `<span class="salary-total-label">${isCurrentMonth ? '今月' : '合計'}</span>
                   <span class="salary-total-amount">${fmtYen(total)}</span>`;
  box.appendChild(tot);
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar() {
  const counts = catCounts();
  const list   = document.getElementById('js-category-list');
  list.innerHTML = '';

  categories.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'category-row';
    const tag = cat.type==='shift'
      ? ` <small style="font-size:9px;opacity:.5;font-weight:600">⏱ ${cat.hourlyWage?fmtYen(cat.hourlyWage)+'/h':''}</small>`
      : '';
    row.innerHTML = `
      <span class="cat-color-dot" style="background:${cat.color}"></span>
      <span class="cat-row-name">${escHtml(cat.name)}${tag}</span>
      <span class="cat-row-count">${counts[cat.id]||''}</span>
      <span class="cat-row-actions">
        <button class="cat-row-edit-btn" title="編集">•••</button>
      </span>`;
    row.querySelector('.cat-row-edit-btn').addEventListener('click', e => {
      e.stopPropagation(); openCatEditor();
    });
    list.appendChild(row);
  });

  renderSalarySummary();
  renderCleanCalendar();
}

// ── Mini calendar ─────────────────────────────────────────────────────────────

function renderMini() {
  const y=curDate.getFullYear(), m=curDate.getMonth(), today=new Date();
  document.getElementById('js-mini-month').textContent = `${MONTHS_INIT[m]} ${y}`;
  const grid=document.getElementById('js-mini-grid');
  grid.innerHTML='';
  const first=new Date(y,m,1).getDay(), dim=new Date(y,m+1,0).getDate(), prev=new Date(y,m,0).getDate();

  for (let i=first-1;i>=0;i--) grid.appendChild(mkMini(prev-i,true,false,false,false,false));
  for (let d=1;d<=dim;d++) {
    const dow=new Date(y,m,d).getDay();
    const k=dateKey(y,m,d);
    const isTd=y===today.getFullYear()&&m===today.getMonth()&&d===today.getDate();
    const hasGoalDone=(typeof currentUser!=='undefined'&&currentUser)?_isGoalAchieved(currentUser.id,k):false;
    const el=mkMini(d,false,isTd,!!(events[k]?.length),dow===0,dow===6,hasGoalDone);
    el.addEventListener('click',()=>openDayModal(y,m,d));
    grid.appendChild(el);
  }
  const rem=grid.children.length%7;
  if (rem) for (let d=1;d<=7-rem;d++) grid.appendChild(mkMini(d,true,false,false,false,false));
}

function mkMini(day,isOther,isToday,hasEv,isSun,isSat,hasGoalDone) {
  const el=document.createElement('div');
  el.className=['mini-day',isOther?'is-other':'',isToday?'is-today':'',
    hasEv?'has-events':'',isSun?'is-sun':'',isSat?'is-sat':'',
    hasGoalDone?'has-goal-done':''].filter(Boolean).join(' ');
  el.textContent=day;
  return el;
}

// ── Main calendar ─────────────────────────────────────────────────────────────

function renderMain() {
  const y=curDate.getFullYear(), m=curDate.getMonth(), today=new Date();
  document.getElementById('js-topbar-title').textContent=`${MONTHS_INIT[m]} ${y}`;
  document.getElementById('js-topbar-sub').textContent='';

  const grid=document.getElementById('js-cal-grid');
  grid.innerHTML='';
  const first=new Date(y,m,1).getDay(), dim=new Date(y,m+1,0).getDate(), prev=new Date(y,m,0).getDate();

  for (let i=first-1;i>=0;i--) {
    const dt=new Date(y,m-1,prev-i);
    grid.appendChild(buildCell(dt.getFullYear(),dt.getMonth(),dt.getDate(),true,false));
  }
  for (let d=1;d<=dim;d++) {
    const isTd=y===today.getFullYear()&&m===today.getMonth()&&d===today.getDate();
    grid.appendChild(buildCell(y,m,d,false,isTd));
  }
  const rem=grid.children.length%7;
  if (rem) for (let d=1;d<=7-rem;d++) {
    const dt=new Date(y,m+1,d);
    grid.appendChild(buildCell(dt.getFullYear(),dt.getMonth(),d,true,false));
  }
}

function sortEvs(arr) {
  return [...arr].sort((a,b)=>(a.shiftStart||a.time||'99:99').localeCompare(b.shiftStart||b.time||'99:99'));
}

function buildCell(y,m,d,isOther,isToday) {
  const dow=new Date(y,m,d).getDay(), key=dateKey(y,m,d), dayEvs=sortEvs(events[key]||[]);
  const cell=document.createElement('div');
  cell.className=['day-cell',isOther?'is-other-month':'',isToday?'is-today':'',
    dow===0?'is-sun':'',dow===6?'is-sat':''].filter(Boolean).join(' ');
  cell.dataset.dateKey = key;
  cell.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect='move'; cell.classList.add('is-drag-over'); });
  cell.addEventListener('dragleave', e => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('is-drag-over'); });
  cell.addEventListener('drop', async e => {
    e.preventDefault(); cell.classList.remove('is-drag-over');
    let data; try { data=JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    await moveEventToDate(data.dbId, data.srcKey, key);
  });

  const numEl=document.createElement('div');
  numEl.className='day-num'; numEl.textContent=d;
  cell.appendChild(numEl);

  const _hName = getHolidayName(key);
  if (_hName) {
    const hEl = document.createElement('div');
    hEl.className = 'day-holiday';
    hEl.textContent = _hName;
    cell.appendChild(hEl);
  }



  // Day wage badge
  const shifts=dayEvs.filter(ev=>isShift(ev.catId));
  if (shifts.length) {
    const dayPay=shifts.reduce((s,ev)=>s+calcShift(ev).pay,0);
    const dayWork=shifts.reduce((s,ev)=>s+calcShift(ev).workMinutes,0);
    const badge=document.createElement('div');
    badge.className='day-wage-badge';
    badge.textContent=fmtYen(dayPay);
    badge.title=`勤務 ${fmtMin(dayWork)}`;
    cell.appendChild(badge);
  }

  if (dayEvs.length) {
    const evList=document.createElement('div');
    evList.className='day-events';
    dayEvs.slice(0,3).forEach(ev=>{
      const cat=getCat(ev.catId)||{color:'#888'};
      const pill=document.createElement('div');
      pill.className='event-pill'+(isShift(ev.catId)?' is-shift':'');
      pill.style.background=cat.color;
      if (isShift(ev.catId)&&ev.shiftStart) {
        const t = isNarrowScreen() ? shortStartTime(ev.shiftStart) : `${ev.shiftStart}–${ev.shiftEnd}`;
        pill.innerHTML=`<span class="event-pill-time">${t}</span>
                        <span class="event-pill-name">${escHtml(cat.name)}</span>`;
      } else {
        const pillTime = ev.time
          ? (ev.timeEnd ? `${ev.time}–${ev.timeEnd}` : ev.time)
          : '';
        const t = isNarrowScreen() ? shortStartTime(pillTime) : pillTime;
        pill.innerHTML=t
          ?`<span class="event-pill-time">${t}</span><span class="event-pill-name">${escHtml(ev.title)}</span>`
          :`<span class="event-pill-dot"></span><span class="event-pill-name">${escHtml(ev.title)}</span>`;
      }
      pill.addEventListener('click',e=>{e.stopPropagation();openDayModal(y,m,d);});
      if (ev._dbId) {
        pill.draggable = true;
        pill.addEventListener('dragstart', e => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', JSON.stringify({ dbId: ev._dbId, srcKey: key }));
          setTimeout(() => pill.classList.add('is-dragging'), 0);
        });
        pill.addEventListener('dragend', () => pill.classList.remove('is-dragging'));
      }
      evList.appendChild(pill);
    });
    if (dayEvs.length>3) {
      const more=document.createElement('div');
      more.className='more-badge'; more.textContent=`+${dayEvs.length-3} 件`;
      evList.appendChild(more);
    }
    cell.appendChild(evList);
  }
  // Tasks with due date on this day
  {
    const dayTasks = (_taskState?.tasks || [])
      .filter(t => !t.done && t.dueDate === key);
    if (dayTasks.length) {
      const taskList = document.createElement('div');
      taskList.className = 'day-tasks';
      const MAX = 2;
      dayTasks.slice(0, MAX).forEach(t => {
        const pill = document.createElement('div');
        pill.className = 'task-cal-pill is-' + (t.priority || 'medium');
        pill.title = t.title + (t.priority === 'high' ? '（重要）' : t.priority === 'low' ? '（低）' : '');
        pill.innerHTML =
          '<span class="task-cal-dot"></span>' +
          '<span class="task-cal-name">' + escHtml(t.title) + '</span>';
        taskList.appendChild(pill);
      });
      if (dayTasks.length > MAX) {
        const more = document.createElement('div');
        more.className = 'more-badge';
        more.textContent = '+' + (dayTasks.length - MAX) + ' 件';
        taskList.appendChild(more);
      }
      cell.appendChild(taskList);
    }
  }


  // 目標達成バッジ
  if ((typeof currentUser!=='undefined'&&currentUser)&&_isGoalAchieved(currentUser.id,key)) {
    cell.classList.add('has-goal-done');
    const badge=document.createElement('span');
    badge.className='goal-done-badge';
    badge.title='目標達成';
    numEl.appendChild(badge);
  }

  cell.addEventListener('click',()=>{
    openDayModal(y,m,d);
  });
  return cell;
}

// ── Day modal ─────────────────────────────────────────────────────────────────

function openDayModal(y,m,d) {
  selectedKey=dateKey(y,m,d);
  const dow=new Date(y,m,d).getDay();
  document.getElementById('js-day-modal-title').textContent=`${MONTHS_INIT[m]} ${d}, ${y}`;
  document.getElementById('js-day-modal-sub').textContent=DAYS_EN[dow];

  document.getElementById('js-ev-title').value='';
  document.getElementById('js-ev-time-start').value='';
  document.getElementById('js-ev-time-end').value='';
  if (!getCat(selectedCatId)) selectedCatId=normalCats()[0]?.id??categories[0]?.id;

  document.getElementById('js-shift-start').value='';
  document.getElementById('js-shift-end').value='';
  document.getElementById('js-shift-break').value='';
  updateWagePreview();

  renderExistingEvents();
  renderCatChips();
  renderTemplateChips();
  renderEventTemplateChips();
  updateShiftTabVisibility();
  switchTab(activeTab);
  openOverlay('js-day-overlay');
  setTimeout(()=>{
    (activeTab==='shift'
      ?document.getElementById('js-shift-start')
      :document.getElementById('js-ev-title'))?.focus();
  },80);
}

document.querySelectorAll('.form-tab').forEach(btn=>{
  btn.addEventListener('click',()=>switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  activeTab=tab;
  document.querySelectorAll('.form-tab').forEach(b=>b.classList.toggle('is-active',b.dataset.tab===tab));
  document.getElementById('js-tab-event').style.display=tab==='event'?'':'none';
  document.getElementById('js-tab-shift').style.display=tab==='shift'?'':'none';
}

function updateShiftTabVisibility() {
  const has=shiftCats().length>0;
  document.getElementById('js-no-shift-warning').style.display=has?'none':'';
  document.getElementById('js-add-shift-btn').style.display=has?'':'none';
  document.getElementById('js-wage-preview').style.display=has?'':'none';
}

document.getElementById('js-go-to-cat-editor').addEventListener('click',()=>{
  closeOverlay('js-day-overlay'); openCatEditor();
});

// ── Template chips ────────────────────────────────────────────────────────────

function renderTemplateChips() {
  const row=document.getElementById('js-template-row');
  const list=document.getElementById('js-template-chip-list');
  list.innerHTML='';
  const all=[];
  shiftCats().forEach(cat=>(cat.templates||[]).forEach(tpl=>all.push({cat,tpl})));
  if (!all.length){row.style.display='none';return;}
  row.style.display='';
  all.forEach(({cat,tpl})=>{
    const chip=document.createElement('button');
    chip.className='template-chip';
    const mock={shiftStart:tpl.start,shiftEnd:tpl.end,breakMinutes:tpl.breakMin,catId:cat.id};
    const {pay}=calcShift(mock);
    const payStr=cat.hourlyWage?`　${fmtYen(pay)}`:'';
    chip.innerHTML=`
      <span class="template-chip-dot" style="background:${cat.color}"></span>
      <span>${escHtml(tpl.label||`${tpl.start}–${tpl.end}`)}</span>
      <span style="opacity:.5;font-size:10px">${tpl.start}–${tpl.end}${payStr}</span>`;
    chip.addEventListener('click',()=>{
      document.getElementById('js-shift-start').value=tpl.start;
      document.getElementById('js-shift-end').value=tpl.end;
      document.getElementById('js-shift-break').value=tpl.breakMin??0;
      updateWagePreview();
      switchTab('shift');
    });
    list.appendChild(chip);
  });
}

// ── Event template chips (normal categories) ─────────────────────────────────

function renderEventTemplateChips() {
  const row=document.getElementById('js-ev-template-row');
  const list=document.getElementById('js-ev-template-chip-list');
  list.innerHTML='';
  const all=[];
  normalCats().forEach(cat=>(cat.templates||[]).forEach(tpl=>all.push({cat,tpl})));
  if (!all.length){row.style.display='none';return;}
  row.style.display='';
  all.forEach(({cat,tpl})=>{
    const chip=document.createElement('button');
    chip.className='template-chip';
    const timeStr=(tpl.start&&tpl.end)?`${tpl.start}–${tpl.end}`:(tpl.start||'');
    chip.innerHTML=`
      <span class="template-chip-dot" style="background:${cat.color}"></span>
      <span>${escHtml(tpl.title||tpl.label||'テンプレート')}</span>
      ${timeStr?`<span style="opacity:.5;font-size:10px">${timeStr}</span>`:''}`;
    chip.addEventListener('click',()=>{
      document.getElementById('js-ev-title').value=tpl.title||tpl.label||'';
      document.getElementById('js-ev-time-start').value=tpl.start||'';
      document.getElementById('js-ev-time-end').value=tpl.end||'';
      // テンプレートのカテゴリを選択状態にする
      selectedCatId=cat.id;
      renderCatChips();
      switchTab('event');
    });
    list.appendChild(chip);
  });
}

// ── Existing events list ──────────────────────────────────────────────────────

function renderExistingEvents() {
  const container=document.getElementById('js-existing-events');
  container.innerHTML='';
  const dayEvs=sortEvs(events[selectedKey]||[]);
  if (!dayEvs.length){container.innerHTML='<div class="empty-state">まだ予定はありません</div>';return;}

  dayEvs.forEach(ev=>{
    const cat=getCat(ev.catId)||{color:'#888',name:'?'};
    const row=document.createElement('div');
    row.className='event-list-row';
    let titleHtml,metaHtml;
    if (isShift(ev.catId)&&ev.shiftStart) {
      const {workMinutes,breakMinutes,pay}=calcShift(ev);
      const brk=breakMinutes>0?`休憩${breakMinutes}分　`:'';
      titleHtml=`<span class="ev-cat-chip" style="background:${cat.color}">${escHtml(cat.name)}</span>`;
      metaHtml=`<span class="ev-shift-time">${ev.shiftStart} – ${ev.shiftEnd}</span>
                <span>${brk}勤務 ${fmtMin(workMinutes)}</span>
                <span class="ev-shift-pay">${fmtYen(pay)}</span>`;
    } else {
      titleHtml=escHtml(ev.title);
      const tRange = ev.time
        ? (ev.timeEnd ? `${ev.time} – ${ev.timeEnd}` : ev.time)
        : '';
      metaHtml=(tRange?`<span>${tRange}</span>`:'')+
               `<span class="ev-cat-chip" style="background:${cat.color}">${escHtml(cat.name)}</span>`;
    }
    // ── DOM要素を個別生成（innerHTML経由のリスナーより確実） ──
    const dot = document.createElement('span');
    dot.className = 'ev-color-dot';
    dot.style.background = cat.color;

    const info = document.createElement('div');
    info.className = 'ev-info ev-info--tappable';
    info.innerHTML = `<div class="ev-title">${titleHtml}</div><div class="ev-meta">${metaHtml}</div>`;
    info.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev); });

    const editBtn = document.createElement('button');
    editBtn.className = 'ev-edit-btn';
    editBtn.title = '編集';
    editBtn.textContent = '✏️';
    editBtn.type = 'button';
    editBtn.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev); });

    const delBtn = document.createElement('button');
    delBtn.className = 'ev-delete-btn';
    delBtn.title = '削除';
    delBtn.textContent = '✕';
    delBtn.type = 'button';
    delBtn.addEventListener('click', async e => {
      e.stopPropagation();
      e.preventDefault();
      if (!confirm('この予定を削除しますか？')) return;
      const arr = events[selectedKey];
      const idx = arr.indexOf(ev);
      if (idx !== -1) {
        await deleteEventFromSupabase(ev);
        arr.splice(idx, 1);
        if (!arr.length) delete events[selectedKey];
        renderExistingEvents();
        renderAll();
      }
    });

    const actions = document.createElement('div');
    actions.className = 'ev-actions';
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

// ── Edit event modal ──────────────────────────────────────────────────────────

let editingEv = null;  // reference to the event object being edited
let editingCatId = null;

function openEditModal(ev) {
  editingEv    = ev;
  editingCatId = ev.catId;
  const isS    = isShift(ev.catId);

  // Header
  const [y,m,d] = selectedKey.split('-').map(Number);
  document.getElementById('js-edit-modal-title').textContent = isS ? 'シフトを編集' : '予定を編集';
  document.getElementById('js-edit-modal-sub').textContent =
    `${MONTHS_INIT[m-1]} ${d}, ${y} (${DAYS_EN[new Date(y,m-1,d).getDay()]})`;

  // Show the right form
  document.getElementById('js-edit-tab-event').style.display = isS ? 'none' : '';
  document.getElementById('js-edit-tab-shift').style.display = isS ? ''     : 'none';

  if (isS) {
    document.getElementById('js-edit-shift-start').value = ev.shiftStart || '';
    document.getElementById('js-edit-shift-end').value   = ev.shiftEnd   || '';
    document.getElementById('js-edit-shift-break').value = ev.breakMinutes ?? 0;
    updateEditWagePreview();
  } else {
    document.getElementById('js-edit-ev-title').value       = ev.title   || '';
    document.getElementById('js-edit-ev-time-start').value = ev.time    || '';
    document.getElementById('js-edit-ev-time-end').value   = ev.timeEnd || '';
    renderEditCatChips();
  }

  openOverlay('js-edit-overlay');
  setTimeout(()=>{
    (isS
      ? document.getElementById('js-edit-shift-start')
      : document.getElementById('js-edit-ev-title'))?.focus();
  }, 80);
}

function renderEditCatChips() {
  const list = document.getElementById('js-edit-cat-chip-list');
  list.innerHTML = '';
  normalCats().forEach(cat => {
    const sel = cat.id === editingCatId;
    const chip = document.createElement('div');
    chip.className = 'cat-chip' + (sel ? ' is-selected' : '');
    if (sel) chip.style.background = cat.color;
    chip.innerHTML = `<span class="cat-chip-dot" style="background:${sel?'rgba(255,255,255,.7)':cat.color}"></span>${escHtml(cat.name)}`;
    chip.addEventListener('click', () => { editingCatId = cat.id; renderEditCatChips(); });
    list.appendChild(chip);
  });
}

function updateEditWagePreview() {
  const start = document.getElementById('js-edit-shift-start').value;
  const end   = document.getElementById('js-edit-shift-end').value;
  const brk   = parseInt(document.getElementById('js-edit-shift-break').value) || 0;
  const cat   = getCat(editingEv?.catId) ?? shiftCats()[0];
  const hEl   = document.getElementById('js-edit-preview-hours');
  const bEl   = document.getElementById('js-edit-preview-break');
  const pEl   = document.getElementById('js-edit-preview-pay');
  if (!start || !end || !cat) { hEl.textContent='—'; bEl.textContent='—'; pEl.textContent='—'; return; }
  const {totalMinutes,workMinutes,pay} = calcShift({shiftStart:start,shiftEnd:end,breakMinutes:brk,catId:cat.id});
  hEl.textContent = `${fmtMin(totalMinutes)}（実働 ${fmtMin(workMinutes)}）`;
  bEl.textContent = brk > 0 ? `${brk}分` : 'なし';
  pEl.textContent = fmtYen(pay);
}

['js-edit-shift-start','js-edit-shift-end','js-edit-shift-break'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateEditWagePreview);
});

document.getElementById('js-edit-save-btn').addEventListener('click', async () => {
  if (!editingEv) return;
  const isS = isShift(editingEv.catId);

  if (isS) {
    const start = document.getElementById('js-edit-shift-start').value;
    const end   = document.getElementById('js-edit-shift-end').value;
    const brk   = parseInt(document.getElementById('js-edit-shift-break').value) || 0;
    if (!start || !end) { document.getElementById('js-edit-shift-start').focus(); return; }
    editingEv.shiftStart   = start;
    editingEv.shiftEnd     = end;
    editingEv.breakMinutes = brk;
  } else {
    const title = document.getElementById('js-edit-ev-title').value.trim();
    if (!title) { document.getElementById('js-edit-ev-title').focus(); return; }
    editingEv.title   = title;
    editingEv.time    = document.getElementById('js-edit-ev-time-start').value;
    editingEv.timeEnd = document.getElementById('js-edit-ev-time-end').value;
    editingEv.catId   = editingCatId;
  }

  await updateEventInSupabase(editingEv);
  closeOverlay('js-edit-overlay');
  closeOverlay('js-day-overlay');  // day overlay も閉じる
  renderExistingEvents();
  renderAll();
});

function closeEditModal() {
  closeOverlay('js-edit-overlay');
  editingEv = null;
}

document.getElementById('js-edit-modal-close').addEventListener('click', closeEditModal);
document.getElementById('js-edit-cancel-btn').addEventListener('click',  closeEditModal);
document.getElementById('js-edit-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('js-edit-overlay')) closeEditModal();
});

// Also close edit modal on Escape (extend existing keydown handler below)

// ── Cat chips ─────────────────────────────────────────────────────────────────

function renderCatChips() {
  const list=document.getElementById('js-cat-chip-list');
  list.innerHTML='';
  normalCats().forEach(cat=>{
    const sel=cat.id===selectedCatId;
    const chip=document.createElement('div');
    chip.className='cat-chip'+(sel?' is-selected':'');
    if (sel) chip.style.background=cat.color;
    chip.innerHTML=`<span class="cat-chip-dot" style="background:${sel?'rgba(255,255,255,.7)':cat.color}"></span>${escHtml(cat.name)}`;
    chip.addEventListener('click',()=>{selectedCatId=cat.id;renderCatChips();});
    list.appendChild(chip);
  });
}

// ── Add normal event ──────────────────────────────────────────────────────────

document.getElementById('js-add-event-btn').addEventListener('click',addEvent);
document.getElementById('js-ev-title').addEventListener('keydown',e=>{if(e.key==='Enter')addEvent();});

async function addEvent() {
  const title=document.getElementById('js-ev-title').value.trim();
  if (!title){document.getElementById('js-ev-title').focus();return;}
  const time=document.getElementById('js-ev-time-start').value;
  const timeEnd=document.getElementById('js-ev-time-end').value;
  const ev={title,time,timeEnd,catId:selectedCatId};
  if (!events[selectedKey]) events[selectedKey]=[];
  events[selectedKey].push(ev);
  await addEventToSupabase(selectedKey,ev);
  document.getElementById('js-ev-title').value='';
  document.getElementById('js-ev-time-start').value='';
  document.getElementById('js-ev-time-end').value='';
  renderExistingEvents();
  renderAll();
}

// ── Shift wage preview ────────────────────────────────────────────────────────

['js-shift-start','js-shift-end','js-shift-break'].forEach(id=>{
  document.getElementById(id).addEventListener('input',updateWagePreview);
});

function updateWagePreview() {
  const start=document.getElementById('js-shift-start').value;
  const end=document.getElementById('js-shift-end').value;
  const brk=parseInt(document.getElementById('js-shift-break').value)||0;
  const cat=shiftCats()[0];
  const hEl=document.getElementById('js-preview-hours');
  const bEl=document.getElementById('js-preview-break');
  const pEl=document.getElementById('js-preview-pay');
  if (!start||!end||!cat){hEl.textContent='—';bEl.textContent='—';pEl.textContent='—';return;}
  const {totalMinutes,workMinutes,pay}=calcShift({shiftStart:start,shiftEnd:end,breakMinutes:brk,catId:cat.id});
  hEl.textContent=`${fmtMin(totalMinutes)}（実働 ${fmtMin(workMinutes)}）`;
  bEl.textContent=brk>0?`${brk}分`:'なし';
  pEl.textContent=fmtYen(pay);
}

// ── Add shift ─────────────────────────────────────────────────────────────────

document.getElementById('js-add-shift-btn').addEventListener('click',addShift);

async function addShift() {
  const start=document.getElementById('js-shift-start').value;
  const end=document.getElementById('js-shift-end').value;
  const brk=parseInt(document.getElementById('js-shift-break').value)||0;
  const cat=shiftCats()[0];
  if (!start||!end){document.getElementById('js-shift-start').focus();return;}
  if (!cat) return;
  const ev={title:'',catId:cat.id,shiftStart:start,shiftEnd:end,breakMinutes:brk};
  if (!events[selectedKey]) events[selectedKey]=[];
  events[selectedKey].push(ev);
  await addEventToSupabase(selectedKey,ev);
  document.getElementById('js-shift-start').value='';
  document.getElementById('js-shift-end').value='';
  document.getElementById('js-shift-break').value='';
  updateWagePreview();
  renderExistingEvents();
  renderAll();
}

// ── Category editor ───────────────────────────────────────────────────────────

function openCatEditor() {
  editingCats=deepClone(categories);
  renderCatEditorList();
  openOverlay('js-cat-overlay');
}

function renderCatEditorList() {
  const list=document.getElementById('js-cat-editor-list');
  list.innerHTML='';
  editingCats.forEach((cat,idx)=>{
    const isS=cat.type==='shift';
    const wrap=document.createElement('div');

    const row=document.createElement('div');
    row.className='cat-editor-row';
    row.innerHTML=`
      <button class="cat-color-swatch" style="background:${cat.color}" title="色を変更"></button>
      <input  class="cat-name-field" type="text" value="${escHtml(cat.name)}" placeholder="カテゴリ名" />
      <div class="cat-type-toggle">
        <button class="cat-type-btn ${!isS?'is-active':''}" data-type="normal">予定</button>
        <button class="cat-type-btn ${isS?'is-active':''}" data-type="shift">バイト</button>
      </div>
      <button class="cat-delete-btn" title="削除">🗑</button>`;

    const wageRow=document.createElement('div');
    wageRow.className='cat-wage-row'+(isS?' is-visible':'');
    wageRow.innerHTML=`
      <span class="cat-wage-label">時給</span>
      <input class="cat-wage-input" type="number" value="${cat.hourlyWage||''}" placeholder="1000" min="0" />
      <span class="cat-wage-unit">円 / h</span>`;

    // テンプレートセクション（shift・normalどちらも表示）
    const tplSection=document.createElement('div');
    tplSection.className='tpl-section is-visible';

    function rebuildTpls() {
      tplSection.innerHTML='';
      const tpls=cat.templates||[];
      if (tpls.length){
        const lbl=document.createElement('div');
        lbl.className='tpl-section-label';
        lbl.textContent=isS?'シフトテンプレート':'予定テンプレート';
        tplSection.appendChild(lbl);
      }
      tpls.forEach((tpl,ti)=>{
        const trow=document.createElement('div'); trow.className='tpl-row';
        if (isS) {
          // シフトテンプレート（従来通り：ラベル＋時刻＋休憩）
          trow.innerHTML=`
            <input class="tpl-input" type="text"   placeholder="名前"     value="${escHtml(tpl.label||'')}"  data-field="label" />
            <input class="tpl-input" type="time"   value="${tpl.start||''}" data-field="start" />
            <span  class="tpl-sep">〜</span>
            <input class="tpl-input" type="time"   value="${tpl.end||''}"   data-field="end"   />
            <input class="tpl-input tpl-break-input" type="number" value="${tpl.breakMin??''}" placeholder="休憩(分)" min="0" data-field="breakMin" />
            <button class="tpl-delete-btn" title="削除">✕</button>`;
        } else {
          // 予定テンプレート（タイトル＋開始/終了時刻）
          trow.innerHTML=`
            <input class="tpl-input tpl-title-input" type="text"  placeholder="タイトル" value="${escHtml(tpl.title||tpl.label||'')}" data-field="title" />
            <input class="tpl-input" type="time"  value="${tpl.start||''}" data-field="start" />
            <span  class="tpl-sep">〜</span>
            <input class="tpl-input" type="time"  value="${tpl.end||''}"   data-field="end"   />
            <button class="tpl-delete-btn" title="削除">✕</button>`;
        }
        trow.querySelectorAll('.tpl-input').forEach(inp=>{
          inp.addEventListener('input',e=>{
            const f=e.target.dataset.field;
            if (f==='breakMin') {
              editingCats[idx].templates[ti][f]=parseInt(e.target.value)||0;
            } else {
              editingCats[idx].templates[ti][f]=e.target.value;
              // normalの場合、titleをlabelにも同期（チップ表示用）
              if (f==='title') editingCats[idx].templates[ti].label=e.target.value;
            }
          });
        });
        trow.querySelector('.tpl-delete-btn').addEventListener('click',()=>{
          editingCats[idx].templates.splice(ti,1); rebuildTpls();
        });
        tplSection.appendChild(trow);
      });
      const addBtn=document.createElement('button');
      addBtn.className='add-tpl-btn';
      addBtn.textContent=isS?'＋ テンプレートを追加':'＋ 予定テンプレートを追加';
      addBtn.addEventListener('click',()=>{
        if (!editingCats[idx].templates) editingCats[idx].templates=[];
        if (isS) {
          editingCats[idx].templates.push({label:'',start:'',end:'',breakMin:0});
        } else {
          editingCats[idx].templates.push({label:'',title:'',start:'',end:''});
        }
        rebuildTpls();
        requestAnimationFrame(()=>{
          const fieldSel=isS?'.tpl-input[data-field="label"]':'.tpl-input[data-field="title"]';
          const ins=tplSection.querySelectorAll(fieldSel);
          ins[ins.length-1]?.focus();
        });
      });
      tplSection.appendChild(addBtn);
    }
    rebuildTpls();

    row.querySelector('.cat-color-swatch').addEventListener('click',e=>openColorPopup(e.currentTarget,idx));
    row.querySelector('.cat-name-field').addEventListener('input',e=>{editingCats[idx].name=e.target.value;});
    row.querySelectorAll('.cat-type-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        editingCats[idx].type=btn.dataset.type;
        if (btn.dataset.type!=='shift'){delete editingCats[idx].hourlyWage;}
        // テンプレートはタイプ切替時にクリアせず保持する
        renderCatEditorList();
      });
    });
    wageRow.querySelector('.cat-wage-input').addEventListener('input',e=>{
      editingCats[idx].hourlyWage=parseInt(e.target.value)||0;
    });
    row.querySelector('.cat-delete-btn').addEventListener('click',()=>{
      editingCats.splice(idx,1); renderCatEditorList();
    });

    wrap.appendChild(row); wrap.appendChild(wageRow); wrap.appendChild(tplSection);
    list.appendChild(wrap);
  });
}

document.getElementById('js-add-cat-row').addEventListener('click',()=>{
  const used=new Set(editingCats.map(c=>c.color));
  const color=PRESET_COLORS.find(c=>!used.has(c))??PRESET_COLORS[editingCats.length%PRESET_COLORS.length];
  const maxId=editingCats.reduce((mx,c)=>Math.max(mx,c.id),0);
  editingCats.push({id:maxId+1,name:'新カテゴリ',color,type:'normal'});
  renderCatEditorList();
  requestAnimationFrame(()=>{
    const ins=document.querySelectorAll('.cat-name-field');
    if (ins.length){ins[ins.length-1].focus();ins[ins.length-1].select();}
  });
});

document.getElementById('js-cat-save-btn').addEventListener('click',async()=>{
  categories=editingCats.filter(c=>c.name.trim());
  const valid=new Set(categories.map(c=>c.id));
  // Remove events with deleted cat ids (from Supabase too)
  for (const key of Object.keys(events)) {
    const toDelete=events[key].filter(ev=>!valid.has(ev.catId));
    for (const ev of toDelete) await deleteEventFromSupabase(ev);
    events[key]=events[key].filter(ev=>valid.has(ev.catId));
    if (!events[key].length) delete events[key];
  }
  if (!getCat(selectedCatId)) selectedCatId=normalCats()[0]?.id??categories[0]?.id;
  await saveCategoriesToSupabase();
  closeOverlay('js-cat-overlay');
  closeColorPopup();
  renderAll();
});

['js-cat-cancel-btn','js-cat-modal-close'].forEach(id=>{
  document.getElementById(id).addEventListener('click',()=>{closeOverlay('js-cat-overlay');closeColorPopup();});
});
document.getElementById('js-cat-overlay').addEventListener('click',e=>{
  if (e.target===document.getElementById('js-cat-overlay')){closeOverlay('js-cat-overlay');closeColorPopup();}
});

// ── Color picker ──────────────────────────────────────────────────────────────

const colorPopup=document.getElementById('js-color-popup');

PRESET_COLORS.forEach(color=>{
  const sw=document.createElement('div');
  sw.className='color-swatch'; sw.style.background=color;
  sw.addEventListener('click',()=>{
    if (colorTargetIdx!==null){
      if (_colorMode==='budget_exp'){_budgetEditingExpCats[colorTargetIdx].color=color;renderBudgetCatEditorList();}
      else if (_colorMode==='budget_inc'){_budgetEditingIncCats[colorTargetIdx].color=color;renderBudgetCatEditorList();}
      else{editingCats[colorTargetIdx].color=color;renderCatEditorList();}
      closeColorPopup();
    }
  });
  document.getElementById('js-color-swatch-grid').appendChild(sw);
});

document.getElementById('js-custom-color-input').addEventListener('input',e=>{
  if (colorTargetIdx!==null){
    if (_colorMode==='budget_exp'){_budgetEditingExpCats[colorTargetIdx].color=e.target.value;renderBudgetCatEditorList();}
    else if (_colorMode==='budget_inc'){_budgetEditingIncCats[colorTargetIdx].color=e.target.value;renderBudgetCatEditorList();}
    else{editingCats[colorTargetIdx].color=e.target.value;renderCatEditorList();}
  }
});

function openColorPopup(el,idx,mode='calendar') {
  colorTargetIdx=idx;
  _colorMode=mode;
  const arr=mode==='budget_exp'?_budgetEditingExpCats:mode==='budget_inc'?_budgetEditingIncCats:editingCats;
  document.getElementById('js-custom-color-input').value=arr[idx].color;
  const rect=el.getBoundingClientRect(), popW=196;
  let left=rect.left;
  if (left+popW>window.innerWidth-10) left=window.innerWidth-popW-10;
  colorPopup.style.top=`${rect.bottom+6}px`;
  colorPopup.style.left=`${left}px`;
  colorPopup.classList.add('is-open');
}

function closeColorPopup(){colorPopup.classList.remove('is-open');colorTargetIdx=null;}

document.addEventListener('click',e=>{
  if (colorPopup.classList.contains('is-open')&&!colorPopup.contains(e.target)&&!e.target.classList.contains('cat-color-swatch')&&!e.target.classList.contains('bcat-color-swatch'))
    closeColorPopup();
});

// ── Overlay helpers ───────────────────────────────────────────────────────────

function openOverlay(id){document.getElementById(id).classList.add('is-open');}
function closeOverlay(id){document.getElementById(id).classList.remove('is-open');}

document.getElementById('js-day-modal-close').addEventListener('click',()=>{
  closeOverlay('js-edit-overlay');
  closeOverlay('js-day-overlay');
});
document.getElementById('js-day-overlay').addEventListener('click',e=>{
  if (e.target===document.getElementById('js-day-overlay')){
    closeOverlay('js-edit-overlay');
    closeOverlay('js-day-overlay');
  }
});

// ── Navigation ────────────────────────────────────────────────────────────────

document.getElementById('js-prev-month').addEventListener('click',()=>{curDate.setMonth(curDate.getMonth()-1);renderAll();});
document.getElementById('js-next-month').addEventListener('click',()=>{curDate.setMonth(curDate.getMonth()+1);renderAll();});

// ── Swipe navigation (month view) ──────────────────────────────────────────────
(function() {
  const el = document.getElementById('js-month-view');
  let startX = 0, startY = 0, tracking = false, swiped = false;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
    swiped = false;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (!tracking || swiped) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    // 横方向が十分で、縦方向より大きいとき
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      tracking = false;
      e.preventDefault();
      if (dx < 0) {
        curDate.setMonth(curDate.getMonth() + 1);
      } else {
        curDate.setMonth(curDate.getMonth() - 1);
      }
      renderAll();
    }
  }, { passive: false });
  el.addEventListener('touchend', () => { tracking = false; }, { passive: true });
})();

document.getElementById('js-today').addEventListener('click',()=>{curDate=new Date();renderAll();});
document.getElementById('js-mini-prev').addEventListener('click',()=>{curDate.setMonth(curDate.getMonth()-1);renderAll();});
document.getElementById('js-mini-next').addEventListener('click',()=>{curDate.setMonth(curDate.getMonth()+1);renderAll();});
document.getElementById('js-open-cat-editor').addEventListener('click',openCatEditor);
document.getElementById('js-theme-toggle').addEventListener('click',toggleTheme);

// ── Budget category editor ─────────────────────────────────────────────────

let _budgetEditingExpCats = [];
let _budgetEditingIncCats = [];
let _budgetCatTab = 'expense'; // 'expense' | 'income'

function openBudgetCatEditor() {
  _budgetEditingExpCats = budgetExpenseCats.map(c=>({...c}));
  _budgetEditingIncCats = budgetIncomeCats.map(c=>({...c}));
  _budgetCatTab = 'expense';
  renderBudgetCatEditorList();
  document.querySelectorAll('.budget-cat-tab').forEach(b=>
    b.classList.toggle('is-active', b.dataset.bcatTab===_budgetCatTab));
  openOverlay('js-budget-cat-overlay');
}

function renderBudgetCatEditorList() {
  const list = document.getElementById('js-budget-cat-editor-list');
  if (!list) return;
  const cats = _budgetCatTab==='expense' ? _budgetEditingExpCats : _budgetEditingIncCats;
  list.innerHTML = '';
  cats.forEach((cat,idx)=>{
    const row = document.createElement('div');
    row.className = 'cat-editor-row';
    row.innerHTML = `
      <button class="cat-color-swatch bcat-color-swatch" style="background:${cat.color}" title="色を変更"></button>
      <input class="bcat-icon-field" type="text" value="${escHtml(cat.icon)}" placeholder="🏷" maxlength="2" />
      <input class="cat-name-field" type="text" value="${escHtml(cat.name)}" placeholder="カテゴリ名" />
      <button class="cat-delete-btn" title="削除">🗑</button>`;
    row.querySelector('.bcat-color-swatch').addEventListener('click',e=>{
      openColorPopup(e.currentTarget, idx, _budgetCatTab==='expense'?'budget_exp':'budget_inc');
    });
    row.querySelector('.bcat-icon-field').addEventListener('input',e=>{
      (_budgetCatTab==='expense'?_budgetEditingExpCats:_budgetEditingIncCats)[idx].icon = e.target.value||'?';
    });
    row.querySelector('.cat-name-field').addEventListener('input',e=>{
      (_budgetCatTab==='expense'?_budgetEditingExpCats:_budgetEditingIncCats)[idx].name = e.target.value;
    });
    row.querySelector('.cat-delete-btn').addEventListener('click',()=>{
      if (_budgetCatTab==='expense') _budgetEditingExpCats.splice(idx,1);
      else _budgetEditingIncCats.splice(idx,1);
      renderBudgetCatEditorList();
    });
    list.appendChild(row);
  });
}

document.getElementById('js-add-budget-cat-row').addEventListener('click',()=>{
  const arr = _budgetCatTab==='expense' ? _budgetEditingExpCats : _budgetEditingIncCats;
  const used = new Set(arr.map(c=>c.color));
  const color = PRESET_COLORS.find(c=>!used.has(c))??PRESET_COLORS[arr.length%PRESET_COLORS.length];
  const prefix = _budgetCatTab==='expense'?'exp':'inc';
  arr.push({id:`${prefix}_${Date.now()}`, name:'新カテゴリ', icon:'🏷', color});
  renderBudgetCatEditorList();
  requestAnimationFrame(()=>{
    const fields = document.querySelectorAll('#js-budget-cat-editor-list .cat-name-field');
    fields[fields.length-1]?.focus();
    fields[fields.length-1]?.select();
  });
});

document.querySelectorAll('.budget-cat-tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    _budgetCatTab = btn.dataset.bcatTab;
    document.querySelectorAll('.budget-cat-tab').forEach(b=>b.classList.toggle('is-active',b===btn));
    renderBudgetCatEditorList();
  });
});

document.getElementById('js-budget-cat-save-btn').addEventListener('click',()=>{
  budgetExpenseCats = _budgetEditingExpCats.map(c=>({...c}));
  budgetIncomeCats  = _budgetEditingIncCats.map(c=>({...c}));
  _saveBudgetCats();
  _updateBudgetCatOptions();
  if (_budgetState) renderBudgetPanel();
  closeOverlay('js-budget-cat-overlay');
});

document.getElementById('js-budget-cat-cancel-btn').addEventListener('click',()=>closeOverlay('js-budget-cat-overlay'));
document.getElementById('js-budget-cat-modal-close').addEventListener('click',()=>closeOverlay('js-budget-cat-overlay'));
document.getElementById('js-budget-cat-overlay').addEventListener('click',e=>{
  if (e.target===document.getElementById('js-budget-cat-overlay')) closeOverlay('js-budget-cat-overlay');
});
document.getElementById('js-open-budget-cat-editor').addEventListener('click',openBudgetCatEditor);

document.addEventListener('keydown',e=>{
  // Escapeキーはinput内でもモーダルを閉じられるようにする
  if (e.key==='Escape'){
    closeOverlay('js-day-overlay');closeOverlay('js-cat-overlay');closeOverlay('js-budget-cat-overlay');closeEditModal();closeColorPopup();closeOverlay('js-receipt-overlay');closeOverlay('js-apikey-overlay');
    if (document.activeElement) document.activeElement.blur();
    return;
  }
  if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key==='ArrowLeft'){curDate.setMonth(curDate.getMonth()-1);renderAll();}
  if (e.key==='ArrowRight'){curDate.setMonth(curDate.getMonth()+1);renderAll();}
  if (e.key.toLowerCase()==='t'){curDate=new Date();renderAll();}
});

// ── XSS guard ─────────────────────────────────────────────────────────────────

function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Status Bar ────────────────────────────────────────────────────────────────

const VIEW_LABELS = { month: 'Month', week: 'Week', day: 'Day' };

function updateStatusBar() {
  const elView   = document.getElementById('js-status-view');
  const elDate   = document.getElementById('js-status-date');
  const elEvents = document.getElementById('js-status-events');
  if (!elView) return;

  elView.textContent = VIEW_LABELS[currentView] || currentView;

  const y = curDate.getFullYear(), m = curDate.getMonth();
  const monthStr = `${MONTHS_INIT[m]} ${y}`;
  elDate.textContent = monthStr;

  // Count events in current month
  const dim = new Date(y, m + 1, 0).getDate();
  let totalEv = 0;
  for (let d = 1; d <= dim; d++) {
    const k = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    totalEv += (events[k] || []).length;
  }
  elEvents.textContent = `${totalEv} 件のイベント`;
}

// ── Render all ────────────────────────────────────────────────────────────────

function renderAll(){
  renderMain();
  renderMini();
  renderSidebar();
  if (currentView === 'day')  renderDayView();
  if (currentView === 'week') renderWeekView();
  updateStatusBar();

  // Keep Task panel in sync
  if (typeof _taskState !== 'undefined' && _taskState) {
    renderTaskPanel();
  }
  // Keep Budget panel in sync (async — fires Supabase load if month changed)
  if (typeof _budgetState !== 'undefined' && _budgetState) {
    _syncBudgetMonth().then(function() { renderBudgetPanel(); });
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

applyTheme(isDark);
// Auth state change will trigger showApp() → loadFromSupabase() → renderAll()

// ── Mobile sidebar hamburger toggle ──────────────────────────────────────────
(function initSidebarToggle() {
  const btn = document.getElementById('js-sidebar-toggle');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('js-sidebar-overlay');
  if (!btn || !sidebar) return;

  function open()  { sidebar.classList.add('is-open'); if (overlay) overlay.classList.add('is-visible'); }
  function close() { sidebar.classList.remove('is-open'); if (overlay) overlay.classList.remove('is-visible'); }

  btn.addEventListener('click', () => sidebar.classList.contains('is-open') ? close() : open());
  if (overlay) overlay.addEventListener('click', close);
})();

// ── Sidebar section toggle (Blender-style collapsible panels) ────────────────
document.querySelectorAll('.sidebar-section-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const body = btn.nextElementSibling;
    const chevron = btn.querySelector('.section-chevron');
    if (!body) return;
    const isCollapsed = body.classList.toggle('is-collapsed');
    if (chevron) {
      chevron.classList.toggle('is-open', !isCollapsed);
    }
  });
});

// ════════════════════════════════════════════════════════════
//  DAY VIEW
// ════════════════════════════════════════════════════════════

let dvDate = new Date();    // the date shown in day view

const HOUR_H = 64;          // px per hour slot
const DAY_START = 0;        // 0:00
const DAY_END   = 24;       // 24:00

// ── View tab switching ────────────────────────────────────

function switchView(view) {
  currentView = view;
  document.getElementById('js-month-view').style.display = view === 'month' ? '' : 'none';
  document.getElementById('js-week-view').style.display  = view === 'week'  ? '' : 'none';
  document.getElementById('js-day-view').style.display   = view === 'day'   ? '' : 'none';
  document.querySelectorAll('.workspace-tab').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  updateStatusBar();
  if (view === 'day') {
    dvDate = new Date(curDate);
    renderDayView();
  }
  if (view === 'week') {
    wvDate = new Date(curDate);
    renderWeekView();
  }
}

document.getElementById('js-tab-month').addEventListener('click', () => switchView('month'));
document.getElementById('js-tab-week').addEventListener('click',  () => switchView('week'));
document.getElementById('js-tab-day').addEventListener('click',   () => switchView('day'));

// ── Day view navigation ───────────────────────────────────

document.getElementById('js-dv-prev').addEventListener('click', () => {
  dvDate.setDate(dvDate.getDate() - 1); renderDayView();
});
document.getElementById('js-dv-next').addEventListener('click', () => {
  dvDate.setDate(dvDate.getDate() + 1); renderDayView();
});
document.getElementById('js-dv-today').addEventListener('click', () => {
  dvDate = new Date(); renderDayView();
});
document.getElementById('js-dv-add').addEventListener('click', () => {
  // open the existing day modal for the currently viewed day
  openDayModal(dvDate.getFullYear(), dvDate.getMonth(), dvDate.getDate());
});

// ── Swipe navigation (day view) ───────────────────────────────────────────────
(function() {
  const el = document.getElementById('js-day-view');
  let startX = 0, startY = 0, tracking = false, swiped = false;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
    swiped = false;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (!tracking || swiped) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      tracking = false;
      e.preventDefault();
      if (dx < 0) {
        dvDate.setDate(dvDate.getDate() + 1);
      } else {
        dvDate.setDate(dvDate.getDate() - 1);
      }
      renderDayView();
    }
  }, { passive: false });
  el.addEventListener('touchend', () => { tracking = false; }, { passive: true });
})();

// ── Helpers ───────────────────────────────────────────────

function timeStrToMin(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minToY(min) {
  return ((min - DAY_START * 60) / 60) * HOUR_H;
}

function minToTimeStr(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ── Render day view ───────────────────────────────────────

function renderDayView() {
  const y = dvDate.getFullYear(), m = dvDate.getMonth(), d = dvDate.getDate();
  const dow = dvDate.getDay();
  const today = new Date();
  const isToday = y === today.getFullYear() && m === today.getMonth() && d === today.getDate();
  const key = dateKey(y, m, d);
  const DAYS = ['日','月','火','水','木','金','土'];

  // Header date
  const dateEl = document.getElementById('js-dv-date');
  const _dvHoliday = getHolidayName(key);
  dateEl.innerHTML = `
    <span class="dv-date-num ${isToday ? 'is-today' : ''} ${dow===0?'is-sun':dow===6?'is-sat':''}">${d}</span>
    <span class="dv-date-label">${MONTHS_INIT[m]} ${y} &nbsp;${DAYS_EN[dow]}</span>
    ${_dvHoliday ? `<span class="dv-holiday-badge">${escHtml(_dvHoliday)}</span>` : ''}`;

  // Time column
  const timeCol = document.getElementById('js-dv-time-col');
  timeCol.innerHTML = '';
  for (let h = DAY_START; h <= DAY_END; h++) {
    const el = document.createElement('div');
    el.className = 'dv-hour-label';
    el.style.top = `${(h - DAY_START) * HOUR_H}px`;
    el.textContent = h < 24 ? `${String(h).padStart(2,'0')}:00` : '';
    timeCol.appendChild(el);
  }

  // Events column
  const evCol = document.getElementById('js-dv-events-col');
  evCol.innerHTML = '';
  evCol.style.height = `${(DAY_END - DAY_START) * HOUR_H}px`;

  // Hour lines
  for (let h = DAY_START; h <= DAY_END; h++) {
    const line = document.createElement('div');
    line.className = 'dv-hour-line' + (h === 0 ? ' is-first' : '');
    line.style.top = `${(h - DAY_START) * HOUR_H}px`;
    evCol.appendChild(line);
  }

  // Half-hour lines
  for (let h = DAY_START; h < DAY_END; h++) {
    const line = document.createElement('div');
    line.className = 'dv-half-line';
    line.style.top = `${(h - DAY_START) * HOUR_H + HOUR_H / 2}px`;
    evCol.appendChild(line);
  }

  // Events
  const dayEvs = sortEvs(events[key] || []);
  const allDayEvs = [];
  const timedEvs  = [];

  dayEvs.forEach(ev => {
    const startMin = isShift(ev.catId)
      ? timeStrToMin(ev.shiftStart)
      : timeStrToMin(ev.time);
    if (startMin === null) {
      allDayEvs.push(ev);
    } else {
      timedEvs.push({ ev, startMin });
    }
  });

  // All-day events (no time)
  const allDayBar = document.getElementById('js-dv-allday') ||
    (() => { const el = document.createElement('div'); el.id='js-dv-allday'; return el; })();
  allDayBar.className = 'dv-allday-bar';
  allDayBar.innerHTML = '';
  if (allDayEvs.length) {
    allDayEvs.forEach(ev => {
      const cat = getCat(ev.catId) || { color: '#888', name: '?' };
      const chip = document.createElement('div');
      chip.className = 'dv-allday-chip';
      chip.style.background = cat.color;
      chip.textContent = ev.title || cat.name;
      chip.addEventListener('click', () => openEditModal(ev));
      allDayBar.appendChild(chip);
    });
    const body = document.querySelector('.day-view-body');
    body.insertAdjacentElement('beforebegin', allDayBar);
  } else {
    allDayBar.remove();
  }

  // Layout timed events (simple overlap detection)
  // Group overlapping events into columns
  const placed = timedEvs.map(item => {
    const cat = getCat(item.ev.catId) || { color: '#888', name: '?' };
    const endMin = isShift(item.ev.catId)
      ? timeStrToMin(item.ev.shiftEnd)
      : (timeStrToMin(item.ev.timeEnd) ?? item.startMin + 60);
    return { ...item, endMin, cat, col: 0, totalCols: 1 };
  });

  // Assign columns for overlapping events
  for (let i = 0; i < placed.length; i++) {
    const cols = []; // which cols are occupied by events overlapping with i
    for (let j = 0; j < i; j++) {
      if (placed[j].endMin > placed[i].startMin && placed[j].startMin < placed[i].endMin) {
        cols.push(placed[j].col);
      }
    }
    let c = 0;
    while (cols.includes(c)) c++;
    placed[i].col = c;
  }
  // Count total cols per overlap group
  for (let i = 0; i < placed.length; i++) {
    let max = placed[i].col;
    for (let j = 0; j < placed.length; j++) {
      if (j !== i && placed[j].endMin > placed[i].startMin && placed[j].startMin < placed[i].endMin) {
        max = Math.max(max, placed[j].col);
      }
    }
    placed[i].totalCols = max + 1;
  }

  placed.forEach(({ ev, startMin, endMin, cat, col, totalCols }) => {
    const durationMin = Math.max(endMin - startMin, 30); // min 30min height
    const top    = minToY(startMin);
    const height = (durationMin / 60) * HOUR_H;
    const width  = `calc((100% - 4px) / ${totalCols} - 3px)`;
    const left   = `calc((100% - 4px) / ${totalCols} * ${col} + ${col > 0 ? 3 : 0}px)`;

    const block = document.createElement('div');
    block.className = 'dv-event-block';
    block.style.cssText = `
      top:${top}px; height:${Math.max(height,22)}px;
      width:${width}; left:${left};
      background:${cat.color};`;

    const timeStr = isShift(ev.catId)
      ? `${ev.shiftStart} – ${ev.shiftEnd}`
      : (ev.timeEnd ? `${ev.time} – ${ev.timeEnd}` : minToTimeStr(startMin));

    const { pay, workMinutes } = isShift(ev.catId) ? calcShift(ev) : { pay:0, workMinutes:0 };
    const payLabel = isShift(ev.catId) && pay > 0
      ? `<span class="dv-block-pay">${fmtYen(pay)}</span>`
      : '';
    const titleText = isShift(ev.catId) ? cat.name : (ev.title || cat.name);

    block.innerHTML = `
      <span class="dv-block-time">${escHtml(timeStr)}</span>
      <span class="dv-block-title">${escHtml(titleText)}</span>
      ${payLabel}`;

    block.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev); });
    evCol.appendChild(block);
  });

  // Current time line
  const nowLine = document.getElementById('js-dv-now-line');
  if (isToday) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    nowLine.style.top = `${minToY(nowMin)}px`;
    nowLine.style.display = '';
  } else {
    nowLine.style.display = 'none';
  }

  // Scroll to 7:00 or first event on load
  setTimeout(() => {
    const body = document.querySelector('.day-view-body');
    if (!body) return;
    const firstMin = timedEvs[0]?.startMin ?? 7 * 60;
    const scrollTo = Math.max(0, minToY(firstMin) - 40);
    body.scrollTop = scrollTo;
  }, 50);
}

// Re-render day view is already handled inside renderAll() above.


// ════════════════════════════════════════════════════════════
//  WEEK VIEW
// ════════════════════════════════════════════════════════════

let wvDate = new Date();

function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay()); // go to Sunday
  d.setHours(0, 0, 0, 0);
  return d;
}

function renderWeekView() {
  const weekStart = getWeekStart(wvDate);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // Date range label
  const wEnd = new Date(weekStart); wEnd.setDate(wEnd.getDate() + 6);
  const rangeEl = document.getElementById('js-wv-range');
  if (weekStart.getMonth() === wEnd.getMonth()) {
    rangeEl.textContent = `${MONTHS_INIT[weekStart.getMonth()]} ${weekStart.getDate()} – ${wEnd.getDate()}, ${weekStart.getFullYear()}`;
  } else {
    rangeEl.textContent = `${MONTHS_INIT[weekStart.getMonth()]} ${weekStart.getDate()} – ${MONTHS_INIT[wEnd.getMonth()]} ${wEnd.getDate()}, ${wEnd.getFullYear()}`;
  }

  // Build 7 date objects (Sun–Sat)
  const days = Array.from({length: 7}, (_, i) => {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); return d;
  });

  // Ensure holidays are loaded for all years in this week
  [...new Set(days.map(d => d.getFullYear()))].forEach(y => {
    if (!_holidays[y]) fetchHolidays(y).then(() => { if (currentView === 'week') renderWeekView(); });
  });

  // ── Column headers ──────────────────────────────────────
  const headsEl = document.getElementById('js-wv-col-heads');
  headsEl.innerHTML = '';
  const gutter = document.createElement('div'); gutter.className = 'wv-gutter';
  headsEl.appendChild(gutter);

  days.forEach(d => {
    const dow = d.getDay();
    const isToday = d.getTime() === today.getTime();
    const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
    const holidayName = getHolidayName(key);
    const head = document.createElement('div');
    head.className = ['wv-col-head', isToday ? 'is-today' : '', dow===0 ? 'is-sun' : '', dow===6 ? 'is-sat' : ''].filter(Boolean).join(' ');
    head.innerHTML =
      `<span class="wv-head-dow">${DAYS_EN[dow]}</span>` +
      `<span class="wv-head-num${isToday ? ' is-today' : ''}">${d.getDate()}</span>` +
      (holidayName ? `<span class="wv-head-holiday">${escHtml(holidayName)}</span>` : '');
    head.addEventListener('click', () => { dvDate = new Date(d); switchView('day'); });
    headsEl.appendChild(head);
  });

  // ── All-day events row ──────────────────────────────────
  const alldayArea = document.getElementById('js-wv-allday-area');
  const alldayCols = document.getElementById('js-wv-allday-cols');
  alldayCols.innerHTML = '';
  let hasAnyAllday = false;
  days.forEach(d => {
    const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
    const allDayEvs = (events[key] || []).filter(ev => {
      const s = isShift(ev.catId) ? timeStrToMin(ev.shiftStart) : timeStrToMin(ev.time);
      return s === null;
    });
    const col = document.createElement('div');
    col.className = 'wv-allday-col';
    allDayEvs.forEach(ev => {
      const cat = getCat(ev.catId) || { color: '#888', name: '?' };
      const chip = document.createElement('div');
      chip.className = 'wv-allday-chip';
      chip.style.background = cat.color;
      chip.textContent = ev.title || cat.name;
      chip.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev); });
      col.appendChild(chip);
      hasAnyAllday = true;
    });
    alldayCols.appendChild(col);
  });
  alldayArea.style.display = hasAnyAllday ? '' : 'none';

  // ── Time column ─────────────────────────────────────────
  const timeCol = document.getElementById('js-wv-time-col');
  timeCol.innerHTML = '';
  for (let h = DAY_START; h <= DAY_END; h++) {
    const el = document.createElement('div');
    el.className = 'dv-hour-label';
    el.style.top = `${(h - DAY_START) * HOUR_H}px`;
    el.textContent = h < 24 ? `${String(h).padStart(2,'0')}:00` : '';
    timeCol.appendChild(el);
  }

  // ── Day columns (timed events) ──────────────────────────
  const daysEl = document.getElementById('js-wv-days');
  daysEl.innerHTML = '';
  daysEl.style.height = `${(DAY_END - DAY_START) * HOUR_H}px`;

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

  days.forEach(d => {
    const dow = d.getDay();
    const isToday = d.getTime() === today.getTime();
    const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
    const dayEvs = sortEvs(events[key] || []);

    const col = document.createElement('div');
    col.className = ['wv-day-col', isToday ? 'is-today' : '', dow===0 ? 'is-sun' : '', dow===6 ? 'is-sat' : ''].filter(Boolean).join(' ');

    // Grid lines
    for (let h = DAY_START; h <= DAY_END; h++) {
      const line = document.createElement('div');
      line.className = 'dv-hour-line' + (h === 0 ? ' is-first' : '');
      line.style.top = `${(h - DAY_START) * HOUR_H}px`;
      col.appendChild(line);
    }
    for (let h = DAY_START; h < DAY_END; h++) {
      const line = document.createElement('div');
      line.className = 'dv-half-line';
      line.style.top = `${(h - DAY_START) * HOUR_H + HOUR_H / 2}px`;
      col.appendChild(line);
    }

    // Timed events with overlap layout
    const timedEvs = [];
    dayEvs.forEach(ev => {
      const startMin = isShift(ev.catId) ? timeStrToMin(ev.shiftStart) : timeStrToMin(ev.time);
      if (startMin !== null) timedEvs.push({ ev, startMin });
    });
    const placed = timedEvs.map(item => {
      const cat = getCat(item.ev.catId) || { color: '#888', name: '?' };
      const endMin = isShift(item.ev.catId)
        ? timeStrToMin(item.ev.shiftEnd)
        : (timeStrToMin(item.ev.timeEnd) ?? item.startMin + 60);
      return { ...item, endMin, cat, col: 0, totalCols: 1 };
    });
    for (let i = 0; i < placed.length; i++) {
      const cols = [];
      for (let j = 0; j < i; j++) {
        if (placed[j].endMin > placed[i].startMin && placed[j].startMin < placed[i].endMin) cols.push(placed[j].col);
      }
      let c = 0; while (cols.includes(c)) c++;
      placed[i].col = c;
    }
    for (let i = 0; i < placed.length; i++) {
      let max = placed[i].col;
      for (let j = 0; j < placed.length; j++) {
        if (j !== i && placed[j].endMin > placed[i].startMin && placed[j].startMin < placed[i].endMin) max = Math.max(max, placed[j].col);
      }
      placed[i].totalCols = max + 1;
    }
    placed.forEach(({ ev, startMin, endMin, cat, col: evCol, totalCols }) => {
      const top    = minToY(startMin);
      const height = (Math.max(endMin - startMin, 30) / 60) * HOUR_H;
      const width  = `calc((100% - 2px) / ${totalCols} - 2px)`;
      const left   = `calc((100% - 2px) / ${totalCols} * ${evCol} + ${evCol > 0 ? 2 : 0}px)`;
      const block  = document.createElement('div');
      block.className = 'dv-event-block';
      block.style.cssText = `top:${top}px;height:${Math.max(height,22)}px;width:${width};left:${left};background:${cat.color};`;
      const timeStr   = isShift(ev.catId) ? `${ev.shiftStart}–${ev.shiftEnd}` : (ev.timeEnd ? `${ev.time}–${ev.timeEnd}` : minToTimeStr(startMin));
      const titleText = isShift(ev.catId) ? cat.name : (ev.title || cat.name);
      const { pay }   = isShift(ev.catId) ? calcShift(ev) : { pay: 0 };
      const payLabel  = isShift(ev.catId) && pay > 0 ? `<span class="dv-block-pay">${fmtYen(pay)}</span>` : '';
      block.innerHTML = `<span class="dv-block-time">${escHtml(timeStr)}</span><span class="dv-block-title">${escHtml(titleText)}</span>${payLabel}`;
      block.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev); });
      col.appendChild(block);
    });

    // Now-line for today
    if (isToday) {
      const nl = document.createElement('div');
      nl.className = 'dv-now-line'; nl.style.top = `${minToY(nowMin)}px`;
      col.appendChild(nl);
    }

    // Click to add event
    col.addEventListener('click', () => openDayModal(d.getFullYear(), d.getMonth(), d.getDate()));
    daysEl.appendChild(col);
  });

  // Scroll to 7:00
  setTimeout(() => {
    const scroll = document.getElementById('js-wv-scroll');
    if (scroll) scroll.scrollTop = Math.max(0, minToY(7 * 60) - 40);
  }, 50);
}

// ── Week view navigation ──────────────────────────────────

document.getElementById('js-wv-prev').addEventListener('click', () => {
  wvDate.setDate(wvDate.getDate() - 7); renderWeekView();
});
document.getElementById('js-wv-next').addEventListener('click', () => {
  wvDate.setDate(wvDate.getDate() + 7); renderWeekView();
});
document.getElementById('js-wv-today').addEventListener('click', () => {
  wvDate = new Date(); renderWeekView();
});
document.getElementById('js-wv-add').addEventListener('click', () => {
  openDayModal(wvDate.getFullYear(), wvDate.getMonth(), wvDate.getDate());
});

// ── Swipe navigation (week view) ──────────────────────────────────────────────
(function() {
  const el = document.getElementById('js-week-view');
  let startX = 0, startY = 0, tracking = false, swiped = false;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
    swiped = false;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (!tracking || swiped) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      tracking = false;
      e.preventDefault();
      if (dx < 0) {
        wvDate.setDate(wvDate.getDate() + 7);
      } else {
        wvDate.setDate(wvDate.getDate() - 7);
      }
      renderWeekView();
    }
  }, { passive: false });
  el.addEventListener('touchend', () => { tracking = false; }, { passive: true });
})();


function _pad2(n){ return String(n).padStart(2,'0'); }

function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function formatYMD(d){
  return `${d.getFullYear()}-${_pad2(d.getMonth()+1)}-${_pad2(d.getDate())}`;
}
function formatYM(d){
  return `${d.getFullYear()}-${_pad2(d.getMonth()+1)}`;
}
function formatMD(d){
  return `${_pad2(d.getMonth()+1)}/${_pad2(d.getDate())}`;
}
function formatYMDSlash(d){
  return `${d.getFullYear()}/${_pad2(d.getMonth()+1)}/${_pad2(d.getDate())}`;
}

function getMonday(date = new Date()){
  const d = new Date(date);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0) ? -6 : (1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0,0,0,0);
  return d;
}

function getWeekKeyFromDate(date){
  return formatYMD(getMonday(date));
}

// ════════════════════════════════════════════════════════════
//  BOTTOM PANEL TABS
// ════════════════════════════════════════════════════════════

function initBottomPanelTabs() {
  const tabs = document.querySelectorAll('.bp-tab');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.bp;
      tabs.forEach(b => b.classList.toggle('is-active', b === btn));
      document.getElementById('js-bp-task').style.display   = target === 'task'   ? '' : 'none';
      document.getElementById('js-bp-budget').style.display = target === 'budget' ? '' : 'none';
      document.getElementById('js-bp-goal').style.display   = target === 'goal'   ? '' : 'none';
      if (target === 'budget') renderBudgetPanel();
    });
  });
}

// ════════════════════════════════════════════════════════════
//  BOTTOM PANEL SWIPE (mobile)
// ════════════════════════════════════════════════════════════

function initBottomPanelSwipe() {
  const panel = document.querySelector('.bottom-panel');
  const handle = document.querySelector('.bp-swipe-handle');
  if (!panel || !handle) return;

  let startY = 0;
  let dragging = false;

  handle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    dragging = true;
    panel.style.transition = 'none';
  }, { passive: true });

  handle.addEventListener('touchmove', e => {
    if (!dragging) return;
    e.preventDefault();
    const dy = startY - e.touches[0].clientY;
    const isExpanded = panel.classList.contains('is-expanded');

    if (isExpanded) {
      // 展開時: 下にドラッグで閉じるプレビュー
      const top = Math.max(0, -dy);
      panel.style.transform = `translateY(${top}px)`;
    } else {
      // 縮小時: 上にドラッグで展開プレビュー
      const lift = Math.max(0, dy);
      panel.style.height = `${180 + lift}px`;
    }
  }, { passive: false });

  handle.addEventListener('touchend', e => {
    if (!dragging) return;
    dragging = false;
    const dy = startY - e.changedTouches[0].clientY;
    const isExpanded = panel.classList.contains('is-expanded');

    panel.style.transition = '';
    panel.style.transform = '';

    if (isExpanded) {
      // 展開中に下スワイプ → 閉じる
      if (dy < -80) {
        panel.classList.remove('is-expanded');
        panel.style.height = '';
      }
    } else {
      // 縮小中に上スワイプ → 展開
      panel.style.height = '';
      if (dy > 80) {
        panel.classList.add('is-expanded');
      }
    }
  }, { passive: true });
}

/* ── Desktop: free-drag vertical resize ── */
function initBottomPanelResize() {
  const panel = document.querySelector('.bottom-panel');
  if (!panel) return;

  let dragging = false;
  let startY = 0;
  let startH = 0;
  const MIN_H = 100;

  panel.addEventListener('mousedown', e => {
    const rect = panel.getBoundingClientRect();
    if (e.clientY - rect.top > 6) return;
    dragging = true;
    startY = e.clientY;
    startH = panel.offsetHeight;
    panel.classList.add('is-resizing');
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const maxH = window.innerHeight * 0.8;
    const dy = startY - e.clientY;
    const newH = Math.min(maxH, Math.max(MIN_H, startH + dy));
    panel.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('is-resizing');
  });
}


// ════════════════════════════════════════════════════════════
//  CLEAN CALENDAR (ごみ収集カレンダー)
// ════════════════════════════════════════════════════════════

const CLEAN_SCHEDULE = {
  // key = JS dayOfWeek (0=Sun … 6=Sat)
  2: [{ type: 'もやすごみ', color: '#e06050' }, { type: '生ごみ', color: '#4caf50' }],
  3: [{ type: 'プラマークごみ', color: '#ff9800' }],
  4: [{ type: 'びん・カン', color: '#42a5f5' }],
  5: [{ type: 'もやすごみ', color: '#e06050' }, { type: '生ごみ', color: '#4caf50' }],
};

const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function renderCleanCalendar() {
  const box = document.getElementById('js-clean-cal');
  if (!box) return;
  box.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let shown = 0;

  for (let i = 0; i < 7 && shown < 4; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dow = d.getDay();
    const items = CLEAN_SCHEDULE[dow];
    if (!items) continue;

    shown++;
    const row = document.createElement('div');
    row.className = 'clean-day' + (i === 0 ? ' is-today' : '');

    const label = i === 0 ? '今日' : i === 1 ? '明日' : `${d.getMonth() + 1}/${d.getDate()}(${DAY_LABELS[dow]})`;

    let typesHtml = items.map(t =>
      `<span class="clean-type"><span class="clean-type-dot" style="background:${t.color}"></span><span class="clean-type-name">${escHtml(t.type)}</span></span>`
    ).join('');

    row.innerHTML = `<span class="clean-day-label">${label}</span><span class="clean-types">${typesHtml}</span>`;
    box.appendChild(row);
  }

  if (!shown) {
    box.innerHTML = '<div class="clean-none">今週の収集はありません</div>';
  }
}

// ════════════════════════════════════════════════════════════
//  TASK MANAGEMENT
// ════════════════════════════════════════════════════════════

const TASK_STORAGE_KEY = 'tasks_v1';
const GOAL_STORAGE_KEY = 'daily_goal_v1';

let _taskState = null;

// ── Goal Panel (目標) helpers ──
// goals[userId][dateStr] = [{id, text, done}, ...]

function _loadGoal(userId) {
  try {
    const root = JSON.parse(localStorage.getItem(GOAL_STORAGE_KEY) || '{}');
    return root[userId] || {};
  } catch(_) { return {}; }
}
function _persistGoal(userId, goals) {
  try {
    const root = JSON.parse(localStorage.getItem(GOAL_STORAGE_KEY) || '{}');
    root[userId] = goals;
    localStorage.setItem(GOAL_STORAGE_KEY, JSON.stringify(root));
  } catch(_) {}
}

// 指定日に全ての目標（テキストあり）が達成済みか判定
function _isGoalAchieved(userId, dateStr) {
  try {
    const root = JSON.parse(localStorage.getItem(GOAL_STORAGE_KEY) || '{}');
    const ug = root[userId] || {};
    const tmpl = ug['_template'];
    const ds = ug[dateStr];
    if (!tmpl || !ds) return false;
    const hasAny = tmpl.main.text || tmpl.subs.some(s => s.text);
    if (!hasAny) return false;
    if (tmpl.main.text && !ds.main?.done) return false;
    for (const s of tmpl.subs) {
      if (s.text) {
        const st = ds.subs?.find(x => x.id === s.id);
        if (!st?.done) return false;
      }
    }
    return true;
  } catch(_) { return false; }
}

function _dateAddDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function _formatGoalDate(dateStr) {
  const today    = _todayStr();
  const tomorrow = _dateAddDays(today, 1);
  const [, m, d] = dateStr.split('-');
  const base = `${MONTHS_INIT[parseInt(m)-1]} ${parseInt(d)}`;
  if (dateStr === today)    return `Today (${base})`;
  if (dateStr === tomorrow) return `Tomorrow (${base})`;
  return base;
}

function initGoalPanel(userId) {
  const listEl   = document.getElementById('js-goal-list');
  const display  = document.getElementById('js-goal-date-display');
  const formEl   = document.getElementById('js-goal-add-form');
  const inputEl  = document.getElementById('js-goal-input');
  const prevBtn  = document.getElementById('js-goal-prev');
  const nextBtn  = document.getElementById('js-goal-next');
  const todayBtn = document.getElementById('js-goal-today');
  if (!listEl || !display) return;

  // デフォルトは明日（前日に翌日の目標を設定できる）
  let currentDate = _dateAddDays(_todayStr(), 1);
  const allGoals = _loadGoal(userId);

  // ── 旧形式（日付ごとにテキスト+done）→ 新形式（テンプレート分離）への移行 ──
  if (!allGoals['_template']) {
    const dateKeys = Object.keys(allGoals)
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort().reverse();
    let src = null;
    for (const k of dateKeys) {
      const e = allGoals[k];
      if (e && !Array.isArray(e) && (e.main?.text || e.subs?.some(s => s.text))) {
        src = e; break;
      }
    }
    if (src) {
      allGoals['_template'] = {
        main: { text: src.main?.text || '' },
        subs: (src.subs || []).map(s => ({ id: s.id, text: s.text || '', required: !!s.required }))
      };
      for (const k of dateKeys) {
        const e = allGoals[k];
        if (e && !Array.isArray(e)) {
          allGoals[k] = {
            main: { done: !!e.main?.done },
            subs: (e.subs || []).map(s => ({ id: s.id, done: !!s.done }))
          };
        }
      }
    } else {
      allGoals['_template'] = {
        main: { text: '' },
        subs: [
          { id: 'sub-0', text: '', required: true },
          { id: 'sub-1', text: '', required: true },
        ]
      };
    }
    _persistGoal(userId, allGoals);
  }

  // テンプレートの required サブが2つ未満なら補完
  const tmpl = allGoals['_template'];
  if (!tmpl.subs) tmpl.subs = [];
  const _reqCount = tmpl.subs.filter(s => s.required).length;
  for (let i = _reqCount; i < 2; i++) {
    tmpl.subs.splice(i, 0, { id: `sub-${i}`, text: '', required: true });
  }

  // テンプレートテキスト + 日付ごとの done 状態をマージして返す
  function getData() {
    if (!allGoals[currentDate] || Array.isArray(allGoals[currentDate])) {
      allGoals[currentDate] = {
        main: { done: false },
        subs: tmpl.subs.map(s => ({ id: s.id, done: false }))
      };
    }
    const ds = allGoals[currentDate];
    if (!ds.subs) ds.subs = [];
    for (const ts of tmpl.subs) {
      if (!ds.subs.find(s => s.id === ts.id)) {
        ds.subs.push({ id: ts.id, done: false });
      }
    }
    return {
      main: { text: tmpl.main.text, done: !!ds.main?.done },
      subs: tmpl.subs.map(s => {
        const st = ds.subs.find(x => x.id === s.id);
        return { id: s.id, text: s.text, done: !!st?.done, required: s.required };
      })
    };
  }

  const SVG_CHECK = '<svg viewBox="0 0 12 9" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 4L4.5 7.5L11 1" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function goalItemHtml(id, type, done, text, placeholder, deletable) {
    return `
      <div class="goal-item goal-item-${type} ${done ? 'is-done' : ''}" data-goal-id="${id}" data-goal-type="${type}">
        <button class="goal-check" type="button" aria-label="達成切替">${done ? SVG_CHECK : ''}</button>
        <span class="goal-badge is-${type}">${type === 'main' ? '最重要' : type === 'sub' ? 'サブ' : '+α'}</span>
        <span class="goal-item-text ${!text ? 'is-placeholder' : ''}">${text ? escapeHtml(text) : placeholder}</span>
        ${deletable ? '<button class="goal-del" type="button" aria-label="削除">✕</button>' : ''}
      </div>`;
  }

  function renderGoalList() {
    display.textContent = _formatGoalDate(currentDate);
    const { main, subs } = getData();
    const reqSubs   = subs.filter(s => s.required);
    const extraSubs = subs.filter(s => !s.required);

    listEl.innerHTML =
      goalItemHtml('main', 'main', main.done, main.text, '最重要の目標…', false) +
      reqSubs.map((s, i) => goalItemHtml(s.id, 'sub', s.done, s.text, `サブ目標 ${i + 1}…`, false)).join('') +
      extraSubs.map(s    => goalItemHtml(s.id, 'extra', s.done, s.text, '追加目標…', true)).join('');
  }

  // イベント委譲
  listEl.addEventListener('click', e => {
    const row = e.target.closest('[data-goal-id]');
    if (!row) return;
    const id   = row.dataset.goalId;
    const type = row.dataset.goalType;

    // 削除（+α のみ）— テンプレートと全日付ステートから削除
    if (e.target.closest('.goal-del')) {
      tmpl.subs = tmpl.subs.filter(s => s.id !== id);
      for (const k of Object.keys(allGoals)) {
        if (k !== '_template' && allGoals[k]?.subs) {
          allGoals[k].subs = allGoals[k].subs.filter(s => s.id !== id);
        }
      }
      _persistGoal(userId, allGoals); renderGoalList(); return;
    }

    // チェック切替 — 日付ステートのみ更新
    if (e.target.closest('.goal-check')) {
      if (!allGoals[currentDate] || Array.isArray(allGoals[currentDate])) {
        allGoals[currentDate] = { main: { done: false }, subs: tmpl.subs.map(s => ({ id: s.id, done: false })) };
      }
      const ds = allGoals[currentDate];
      if (!ds.subs) ds.subs = [];
      if (type === 'main') {
        if (!ds.main) ds.main = {};
        ds.main.done = !ds.main.done;
      } else {
        let subState = ds.subs.find(s => s.id === id);
        if (!subState) { subState = { id, done: false }; ds.subs.push(subState); }
        subState.done = !subState.done;
      }
      _persistGoal(userId, allGoals);
      renderGoalList();
      renderMini();
      if (typeof currentView !== 'undefined' && currentView === 'month') renderMain();
      return;
    }

    // テキストをクリックしてインライン編集 — テンプレートを更新
    if (e.target.closest('.goal-item-text')) {
      const merged = getData();
      const textEl = e.target.closest('.goal-item-text');
      const current = type === 'main' ? merged.main.text : (merged.subs.find(s => s.id === id)?.text || '');
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'goal-inline-input';
      inp.value = current;
      inp.maxLength = 100;
      textEl.replaceWith(inp);
      inp.focus(); inp.select();
      const commit = () => {
        const val = inp.value.trim();
        if (type === 'main') { tmpl.main.text = val; }
        else { const item = tmpl.subs.find(s => s.id === id); if (item) item.text = val; }
        _persistGoal(userId, allGoals); renderGoalList();
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter')  { ev.preventDefault(); inp.blur(); }
        if (ev.key === 'Escape') { renderGoalList(); }
      });
    }
  });

  // +α 目標を追加 — テンプレートに追加
  formEl.addEventListener('submit', e => {
    e.preventDefault();
    const text = (inputEl.value || '').trim();
    if (!text) return;
    tmpl.subs.push({ id: `g_${Date.now()}`, text, required: false });
    inputEl.value = '';
    _persistGoal(userId, allGoals); renderGoalList();
  });

  // チェックをリセット（テキストは保持）
  document.getElementById('js-goal-reset')?.addEventListener('click', () => {
    if (!allGoals[currentDate]) return;
    const ds = allGoals[currentDate];
    if (ds.main) ds.main.done = false;
    (ds.subs || []).forEach(s => { s.done = false; });
    _persistGoal(userId, allGoals);
    renderGoalList();
    renderMini();
    if (typeof currentView !== 'undefined' && currentView === 'month') renderMain();
  });

  prevBtn.addEventListener('click',  () => { currentDate = _dateAddDays(currentDate, -1); renderGoalList(); });
  nextBtn.addEventListener('click',  () => { currentDate = _dateAddDays(currentDate,  1); renderGoalList(); });
  todayBtn.addEventListener('click', () => { currentDate = _todayStr(); renderGoalList(); });

  renderGoalList();
}

function _readTaskRoot() {
  try { return JSON.parse(localStorage.getItem(TASK_STORAGE_KEY) || '{}'); }
  catch(_) { return {}; }
}
function _writeTaskRoot(root) {
  localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(root));
}

function loadTasks(userId) {
  const root = _readTaskRoot();
  const list = root[userId] || [];
  return Array.isArray(list) ? list.filter(t => t && typeof t.title === 'string') : [];
}

function saveTasks(userId, tasks) {
  const root = _readTaskRoot();
  root[userId] = tasks;
  _writeTaskRoot(root);
}

// ── Supabase Task CRUD ──

async function loadTasksFromSupabase(userId) {
  setSyncStatus('syncing');
  try {
    const { data, error } = await db
      .from('tasks')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    setSyncStatus('synced');
    return (data || []).map(r => ({
      id: r.task_id, _dbId: r.id,
      title: r.title, done: r.done,
      dueDate: r.due_date || '', priority: r.priority || 'medium',
      createdAt: new Date(r.created_at).getTime()
    }));
  } catch (e) {
    console.error('Task load error:', e);
    setSyncStatus('error');
    return null;
  }
}

async function addTaskToSupabase(task) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { data, error } = await db.from('tasks').insert({
      user_id: currentUser.id, task_id: task.id,
      title: task.title, done: task.done,
      due_date: task.dueDate || '', priority: task.priority || 'medium'
    }).select().single();
    if (error) throw error;
    task._dbId = data.id;
    setSyncStatus('synced');
  } catch (e) { console.error('Task add error:', e); setSyncStatus('error'); }
}

async function updateTaskInSupabase(task) {
  if (!currentUser || !task._dbId) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('tasks').update({
      done: task.done,
      title: task.title,
      due_date: task.dueDate || '',
      priority: task.priority || 'medium'
    }).eq('id', task._dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) { console.error('Task update error:', e); setSyncStatus('error'); }
}

async function deleteTaskFromSupabase(taskId) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('tasks').delete()
      .eq('user_id', currentUser.id).eq('task_id', taskId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) { console.error('Task delete error:', e); setSyncStatus('error'); }
}

async function initTaskPanel(user) {
  const listEl     = document.getElementById('js-task-list');
  const formEl     = document.getElementById('js-task-add-form');
  const inputEl    = document.getElementById('js-task-input');
  const dateEl     = document.getElementById('js-task-date');
  const priorityEl = document.getElementById('js-task-priority');
  const progressEl = document.getElementById('js-task-progress');

  if (!listEl || !formEl || !inputEl) return;

  const userId = user?.id || 'anon';
  let tasks;
  if (userId !== 'anon') {
    tasks = await loadTasksFromSupabase(userId) ?? loadTasks(userId);
  } else {
    tasks = loadTasks(userId);
  }

  _taskState = {
    userId, tasks, filter: 'all',
    els: { listEl, formEl, inputEl, dateEl, priorityEl, progressEl }
  };

  renderTaskPanel();
  renderMain(); // タスクの期限をカレンダーに反映
  initGoalPanel(userId);

  // Add task
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!_taskState) return;
    const title = (inputEl.value || '').trim();
    if (!title) return;
    const id = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const dueDate  = dateEl?.value || '';
    const priority = priorityEl?.value || 'medium';
    const task = { id, title, dueDate, priority, done: false, createdAt: Date.now() };
    _taskState.tasks.unshift(task);
    inputEl.value = '';
    if (dateEl) dateEl.value = '';
    if (priorityEl) priorityEl.value = 'medium';
    _persistTasks();
    renderTaskPanel();
    if (dueDate) renderMain(); // 期限ありの場合のみカレンダー再描画
    await addTaskToSupabase(task);
  });

  // Toggle / Delete
  listEl.addEventListener('click', async (e) => {
    if (!_taskState) return;
    const row = e.target.closest?.('[data-task-id]');
    if (!row) return;
    const id = row.getAttribute('data-task-id');
    if (e.target.closest?.('.task-del')) {
      const removed = _taskState.tasks.find(t => t.id === id);
      _taskState.tasks = _taskState.tasks.filter(t => t.id !== id);
      _persistTasks();
      renderTaskPanel();
      if (removed?.dueDate) renderMain();
      await deleteTaskFromSupabase(id);
      return;
    }
    // 編集ボタン → インライン編集フォームを開く
    if (e.target.closest?.('.task-edit-btn')) {
      const t = _taskState.tasks.find(t => t.id === id);
      if (!t) return;
      _openTaskEditForm(row, t);
      return;
    }
    // 保存ボタン
    if (e.target.closest?.('.task-edit-save')) {
      const t = _taskState.tasks.find(t => t.id === id);
      if (!t) return;
      const newTitle = row.querySelector('.task-edit-title')?.value.trim();
      if (!newTitle) { row.querySelector('.task-edit-title')?.focus(); return; }
      const oldDueDate = t.dueDate;
      t.title    = newTitle;
      t.dueDate  = row.querySelector('.task-edit-date')?.value || '';
      t.priority = row.querySelector('.task-edit-priority')?.value || 'medium';
      _persistTasks();
      renderTaskPanel();
      if (oldDueDate || t.dueDate) renderMain();
      await updateTaskInSupabase(t);
      return;
    }
    // キャンセルボタン
    if (e.target.closest?.('.task-edit-cancel')) {
      renderTaskPanel();
      return;
    }
    const t = _taskState.tasks.find(t => t.id === id);
    if (!t) return;
    // 編集中の行はチェック操作を無視
    if (row.classList.contains('is-editing')) return;
    t.done = !t.done;
    _persistTasks();
    renderTaskPanel();
    if (t.dueDate) renderMain(); // 期限ありのタスクのみカレンダー再描画
    await updateTaskInSupabase(t);
  });

  // Filter buttons
  document.querySelectorAll('.task-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!_taskState) return;
      _taskState.filter = btn.dataset.filter;
      document.querySelectorAll('.task-filter').forEach(b =>
        b.classList.toggle('is-active', b === btn));
      renderTaskPanel();
    });
  });
}

function _persistTasks() {
  if (!_taskState) return;
  saveTasks(_taskState.userId, _taskState.tasks);
}

function _todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${_pad2(d.getMonth()+1)}-${_pad2(d.getDate())}`;
}

function renderTaskPanel() {
  if (!_taskState) return;
  const { tasks, filter, els } = _taskState;

  // Sort: undone first (high > medium > low, then by due date), done last
  const sorted = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const pOrder = { high: 0, medium: 1, low: 2 };
    const pa = pOrder[a.priority] ?? 1;
    const pb = pOrder[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return b.createdAt - a.createdAt;
  });

  const filtered = sorted.filter(t => {
    if (filter === 'active') return !t.done;
    if (filter === 'done')   return t.done;
    return true;
  });

  // Progress
  const done  = tasks.filter(t => t.done).length;
  const total = tasks.length;
  const pText = total === 0 ? '0/0' : `${done}/${total}`;
  els.progressEl.textContent = (total > 0 && done === total) ? `🎉 ${pText}` : pText;

  const today = _todayStr();

  if (filtered.length === 0) {
    const emptyMsg = filter === 'done'
      ? '完了したタスクはありません'
      : filter === 'active'
        ? 'すべてのタスクが完了しています！'
        : 'タスクを追加して、期限と優先度で管理できます';
    els.listEl.innerHTML = `<div class="task-empty">${emptyMsg}</div>`;
    return;
  }

  els.listEl.innerHTML = filtered.map(t => {
    const pClass = `is-${t.priority || 'medium'}`;
    const pLabel = t.priority === 'high' ? '高' : t.priority === 'low' ? '低' : '中';

    let dueMeta = '';
    if (t.dueDate) {
      const isPast  = !t.done && t.dueDate < today;
      const isToday = t.dueDate === today;
      const dueClass = isPast ? 'is-past' : isToday ? 'is-today' : '';
      const parts = t.dueDate.split('-');
      const dueLabel = isToday ? '今日' : isPast ? `${parts[1]}/${parts[2]} (期限切れ)` : `${parts[1]}/${parts[2]}`;
      dueMeta = `<span class="task-due ${dueClass}">${dueLabel}</span>`;
    }

    return `
      <div class="task-item ${t.done ? 'done' : ''}" data-task-id="${t.id}">
        <span class="task-priority-dot ${pClass}"></span>
        <div class="task-check"></div>
        <div class="task-body">
          <div class="task-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
          <div class="task-meta">
            ${dueMeta}
            <span class="task-priority-label ${pClass}">${pLabel}</span>
          </div>
        </div>
        <button class="task-edit-btn" type="button" title="編集" aria-label="編集">✏</button>
        <button class="task-del" type="button" title="削除" aria-label="削除">✕</button>
      </div>`;
  }).join('');
}

// タスク行をインライン編集フォームに置き換える
function _openTaskEditForm(row, task) {
  row.classList.add('is-editing');
  const pOpts = ['high','medium','low'].map(v =>
    `<option value="${v}" ${(task.priority||'medium')===v?'selected':''}>${v==='high'?'高':v==='low'?'低':'中'}</option>`
  ).join('');
  row.innerHTML =
    `<div class="task-edit-form">` +
    `<input class="task-edit-title" type="text" value="${escapeHtml(task.title)}" placeholder="タスク名" maxlength="100">` +
    `<div class="task-edit-row">` +
    `<input class="task-edit-date" type="date" value="${task.dueDate||''}">` +
    `<select class="task-edit-priority">${pOpts}</select>` +
    `</div>` +
    `<div class="task-edit-actions">` +
    `<button class="task-edit-save" type="button">保存</button>` +
    `<button class="task-edit-cancel" type="button">キャンセル</button>` +
    `</div></div>`;
  const titleInput = row.querySelector('.task-edit-title');
  titleInput?.focus();
  titleInput?.select();
  // Enter キーで保存
  titleInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); row.querySelector('.task-edit-save')?.click(); }
    if (e.key === 'Escape') row.querySelector('.task-edit-cancel')?.click();
  });
}


// ════════════════════════════════════════════════════════════
//  BUDGET (家計簿)
// ════════════════════════════════════════════════════════════

// (BUDGET_STORAGE_KEY removed — data lives in Supabase budget_entries table)

const _BUDGET_EXP_CATS_DEFAULT = [
  { id:'food',       name:'食費',   icon:'🍙', color:'#e67700' },
  { id:'transport',  name:'交通費', icon:'🚃', color:'#1971c2' },
  { id:'housing',    name:'住居費', icon:'🏠', color:'#6741d9' },
  { id:'utility',    name:'光熱費', icon:'💡', color:'#f76707' },
  { id:'telecom',    name:'通信費', icon:'📱', color:'#3b5bdb' },
  { id:'entertain',  name:'娯楽費', icon:'🎮', color:'#c2255c' },
  { id:'medical',    name:'医療費', icon:'🏥', color:'#e03131' },
  { id:'clothing',   name:'衣服費', icon:'👕', color:'#9c36b5' },
  { id:'daily',      name:'日用品', icon:'🧴', color:'#0c8599' },
  { id:'education',  name:'教育費', icon:'📚', color:'#087f5b' },
  { id:'other_exp',  name:'その他', icon:'📦', color:'#888' },
];

const _BUDGET_INC_CATS_DEFAULT = [
  { id:'salary',     name:'給料',   icon:'💰', color:'#2f9e44' },
  { id:'bonus',      name:'賞与',   icon:'🎁', color:'#74b816' },
  { id:'sidejob',    name:'副業',   icon:'💼', color:'#0c8599' },
  { id:'other_inc',  name:'その他', icon:'📥', color:'#888' },
];

function _loadBudgetCats(key, defaults) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : defaults.map(c => ({...c}));
  } catch { return defaults.map(c => ({...c})); }
}

function _saveBudgetCats() {
  localStorage.setItem('kuro_budget_exp_cats', JSON.stringify(budgetExpenseCats));
  localStorage.setItem('kuro_budget_inc_cats', JSON.stringify(budgetIncomeCats));
}

let budgetExpenseCats = _loadBudgetCats('kuro_budget_exp_cats', _BUDGET_EXP_CATS_DEFAULT);
let budgetIncomeCats  = _loadBudgetCats('kuro_budget_inc_cats', _BUDGET_INC_CATS_DEFAULT);

let _budgetState = null;

// ── Supabase budget CRUD ──

async function loadBudgetFromSupabase(userId, monthKey) {
  setSyncStatus('syncing');
  try {
    const { data, error } = await db
      .from('budget_entries')
      .select('*')
      .eq('user_id', userId)
      .eq('month_key', monthKey)
      .order('date', { ascending: false });
    if (error) throw error;
    setSyncStatus('synced');
    return (data || []).map(r => ({
      id:        r.entry_id,
      _dbId:     r.id,
      type:      r.type,
      catId:     r.cat_id,
      amount:    r.amount,
      memo:      r.memo || '',
      date:      r.date,
      createdAt: new Date(r.created_at).getTime()
    }));
  } catch (e) {
    console.error('Budget load error:', e);
    setSyncStatus('error');
    return [];
  }
}

async function addBudgetToSupabase(entry) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { data, error } = await db.from('budget_entries').insert({
      user_id:   currentUser.id,
      month_key: _budgetMonthKey(),
      entry_id:  entry.id,
      type:      entry.type,
      cat_id:    entry.catId,
      amount:    entry.amount,
      memo:      entry.memo || '',
      date:      entry.date
    }).select().single();
    if (error) throw error;
    entry._dbId = data.id;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Budget add error:', e);
    setSyncStatus('error');
  }
}

async function deleteBudgetFromSupabase(entryId) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('budget_entries')
      .delete()
      .eq('user_id', currentUser.id)
      .eq('entry_id', entryId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Budget delete error:', e);
    setSyncStatus('error');
  }
}

function _budgetMonthKey() {
  const y = curDate.getFullYear();
  const m = curDate.getMonth();
  return `${y}-${_pad2(m + 1)}`;
}

async function _fetchPrevMonthData(userId, y, m) {
  const empty = { balance: 0, expCatSums: {}, incCatSums: {}, totalIncome: 0, totalExpense: 0 };
  if (!userId || userId === 'anon') return empty;
  let prevY = y, prevM = m - 1;
  if (prevM === 0) { prevM = 12; prevY--; }
  const prevKey = `${prevY}-${_pad2(prevM)}`;
  try {
    const entries = await loadBudgetFromSupabase(userId, prevKey);
    const shift = _collectPrevMonthShifts(prevY, prevM);
    let totalIncome = shift.totalShiftPay, totalExpense = 0;
    const expCatSums = {}, incCatSums = {};
    entries.forEach(en => {
      if (en.type === 'income') {
        totalIncome += en.amount;
        incCatSums[en.catId] = (incCatSums[en.catId] || 0) + en.amount;
      } else {
        totalExpense += en.amount;
        expCatSums[en.catId] = (expCatSums[en.catId] || 0) + en.amount;
      }
    });
    return { balance: totalIncome - totalExpense, expCatSums, incCatSums, totalIncome, totalExpense };
  } catch (e) {
    return empty;
  }
}

async function _syncBudgetMonth() {
  if (!_budgetState) return;
  const mk = _budgetMonthKey();
  if (_budgetState.monthKey !== mk) {
    _budgetState.monthKey = mk;
    const parts0 = mk.split('-');
    _budgetState.entries = await loadBudgetFromSupabase(_budgetState.userId, mk);
    const pmd = await _fetchPrevMonthData(_budgetState.userId, +parts0[0], +parts0[1]);
    _budgetState.prevMonthBalance = pmd.balance;
    _budgetState.prevMonthData = pmd;
  }
}

function getBudgetCat(catId) {
  return budgetExpenseCats.find(c => c.id === catId)
      || budgetIncomeCats.find(c => c.id === catId)
      || { id: catId, name: catId, icon: '?', color: '#888' };
}

async function initBudgetPanel(user) {
  const listEl    = document.getElementById('js-budget-list');
  const formEl    = document.getElementById('js-budget-form');
  const amountEl  = document.getElementById('js-budget-amount');
  const memoEl    = document.getElementById('js-budget-memo');
  const typeEl    = document.getElementById('js-budget-type');
  const catEl     = document.getElementById('js-budget-cat');
  const dateEl    = document.getElementById('js-budget-date');
  const summaryEl = document.getElementById('js-budget-summary');

  if (!listEl || !formEl) return;

  const userId = user?.id || 'anon';
  const mk = _budgetMonthKey();
  const mkParts = mk.split('-');
  const prevMonthData = await _fetchPrevMonthData(userId, +mkParts[0], +mkParts[1]);

  _budgetState = {
    userId,
    monthKey: mk,
    entries: await loadBudgetFromSupabase(userId, mk),
    prevMonthBalance: prevMonthData.balance,
    prevMonthData,
    filter: 'all', // 'all' | 'expense' | 'income'
    els: { listEl, formEl, amountEl, memoEl, typeEl, catEl, dateEl, summaryEl }
  };

  // Populate category dropdown
  _updateBudgetCatOptions();

  // Default date = today
  if (dateEl) {
    const td = new Date();
    dateEl.value = `${td.getFullYear()}-${_pad2(td.getMonth()+1)}-${_pad2(td.getDate())}`;
  }

  renderBudgetPanel();

  // Type toggle → update cat options
  typeEl?.addEventListener('change', () => _updateBudgetCatOptions());

  // Submit
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!_budgetState) return;
    const amount = parseInt(amountEl.value) || 0;
    if (amount <= 0) { amountEl.focus(); return; }
    const type = typeEl?.value || 'expense';
    const catId = catEl?.value || (type === 'expense' ? 'food' : 'salary');
    const memo = (memoEl?.value || '').trim();
    const date = dateEl?.value || _todayStr();
    const id = `b_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const entry = { id, type, catId, amount, memo, date, createdAt: Date.now() };
    _budgetState.entries.push(entry);
    amountEl.value = '';
    memoEl.value = '';
    renderBudgetPanel();
    await addBudgetToSupabase(entry);
  });

  // Delete entry
  listEl.addEventListener('click', async (e) => {
    if (!_budgetState) return;
    const delBtn = e.target.closest?.('.budget-entry-del');
    if (!delBtn) return;
    const row = delBtn.closest('[data-budget-id]');
    if (!row) return;
    const id = row.getAttribute('data-budget-id');
    _budgetState.entries = _budgetState.entries.filter(en => en.id !== id);
    renderBudgetPanel();
    await deleteBudgetFromSupabase(id);
  });

  // Filter tabs
  document.querySelectorAll('.budget-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!_budgetState) return;
      _budgetState.filter = btn.dataset.filter;
      document.querySelectorAll('.budget-filter').forEach(b =>
        b.classList.toggle('is-active', b === btn));
      renderBudgetPanel();
    });
  });
}

function _updateBudgetCatOptions() {
  if (!_budgetState) return;
  const catEl  = _budgetState.els.catEl;
  const typeEl = _budgetState.els.typeEl;
  if (!catEl || !typeEl) return;
  const type = typeEl.value;
  const cats = type === 'income' ? budgetIncomeCats : budgetExpenseCats;
  catEl.innerHTML = cats.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
}

function _collectPrevMonthShifts(y, m) {
  // y, m are 1-based (from monthKey). Collect shifts from the PREVIOUS month.
  var prevDate = new Date(y, m - 2, 1); // m-1 = current 0-based, m-2 = prev 0-based
  var pY = prevDate.getFullYear(), pM = prevDate.getMonth(); // 0-based month
  var dim = new Date(pY, pM + 1, 0).getDate();
  var shiftEntries = [];
  var totalShiftPay = 0;
  var perCat = {}; // catId -> { workMinutes, pay }

  for (var d = 1; d <= dim; d++) {
    var key = dateKey(pY, pM, d);
    var dayEvs = events[key] || [];
    for (var i = 0; i < dayEvs.length; i++) {
      var ev = dayEvs[i];
      if (!isShift(ev.catId)) continue;
      var sc = calcShift(ev);
      if (sc.pay <= 0) continue;
      var sCat = getCat(ev.catId);
      totalShiftPay += sc.pay;
      if (!perCat[ev.catId]) perCat[ev.catId] = { workMinutes: 0, pay: 0 };
      perCat[ev.catId].workMinutes += sc.workMinutes;
      perCat[ev.catId].pay += sc.pay;
      shiftEntries.push({
        id: '_shift_' + key + '_' + (ev._dbId || Math.random()),
        type: 'income',
        catId: '_shift',
        amount: sc.pay,
        memo: (sCat ? sCat.name : 'バイト') + '\u3000' + ev.shiftStart + '\u2013' + ev.shiftEnd + '\uFF08' + fmtMin(sc.workMinutes) + '\uFF09',
        date: key,
        createdAt: 0,
        _isShift: true
      });
    }
  }
  return { shiftEntries: shiftEntries, totalShiftPay: totalShiftPay, perCat: perCat,
           prevYear: pY, prevMonth: pM };
}

function renderBudgetPanel() {
  if (!_budgetState) return;
  var bs = _budgetState;
  var entries = bs.entries, filter = bs.filter, monthKey = bs.monthKey, els = bs.els;

  var parts0 = monthKey.split('-');
  var y = +parts0[0], m = +parts0[1]; // 1-based

  var monthLabel = document.getElementById('js-budget-month-label');
  if (monthLabel) monthLabel.textContent = MONTHS_INIT[m - 1] + ' ' + y;

  // ── Collect shift earnings from the PREVIOUS month ──
  var shift = _collectPrevMonthShifts(y, m);
  var shiftEntries = shift.shiftEntries;
  var totalShiftPay = shift.totalShiftPay;

  // ── Carryover from previous month ──
  var prevMonthBalance = bs.prevMonthBalance || 0;
  var carryoverEntry = null;
  if (prevMonthBalance > 0) {
    var pmY = m === 1 ? y - 1 : y, pmM = m === 1 ? 12 : m - 1;
    carryoverEntry = {
      id: '_carryover',
      type: 'income',
      catId: '_carryover',
      amount: prevMonthBalance,
      memo: pmY + '\u5E74' + pmM + '\u6708\u306E\u7E70\u8D8A',
      date: monthKey + '-01',
      _isCarryover: true
    };
  }

  // ── Merge manual entries + shift entries + carryover ──
  var allEntries = entries.concat(shiftEntries);
  if (carryoverEntry) allEntries.push(carryoverEntry);

  var sorted = allEntries.slice().sort(function(a, b) {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  var filtered = sorted.filter(function(en) {
    if (filter === 'expense') return en.type === 'expense';
    if (filter === 'income')  return en.type === 'income';
    return true;
  });

  // Summary
  var totalIncome  = totalShiftPay + (prevMonthBalance > 0 ? prevMonthBalance : 0);
  var totalExpense = 0;
  var catSums = {};

  entries.forEach(function(en) {
    if (en.type === 'income') {
      totalIncome += en.amount;
    } else {
      totalExpense += en.amount;
      if (!catSums[en.catId]) catSums[en.catId] = 0;
      catSums[en.catId] += en.amount;
    }
  });

  var balance = totalIncome - totalExpense;
  var prevData = bs.prevMonthData || { expCatSums: {}, incCatSums: {}, totalIncome: 0, totalExpense: 0, balance: 0 };
  var hasPrev = prevData.totalIncome > 0 || prevData.totalExpense > 0;

  // Helper: render a vs-先月 diff badge
  function _vsBadge(cur, prev, goodDir) {
    // goodDir: 'up' means increase is good (income), 'down' means decrease is good (expense)
    if (!hasPrev) return '';
    var d = cur - prev;
    if (d === 0) return '<span class="budget-vs-badge">\u2014</span>';
    var arrow = d > 0 ? '\u25B2' : '\u25BC';
    var cls = (d > 0) === (goodDir === 'up') ? 'is-good' : 'is-bad';
    return '<span class="budget-vs-badge ' + cls + '">' + arrow + fmtYen(Math.abs(d)) + '</span>';
  }

  if (els.summaryEl) {
    var topCats = Object.entries(catSums)
      .sort(function(a, b) { return b[1] - a[1]; })
      .slice(0, 5);

    var catBreakdown = '';
    if (topCats.length) {
      catBreakdown = '<div class="budget-cat-breakdown">';
      for (var ci = 0; ci < topCats.length; ci++) {
        var catId = topCats[ci][0], sum = topCats[ci][1];
        var bcat = getBudgetCat(catId);
        var pct = totalExpense > 0 ? Math.round(sum / totalExpense * 100) : 0;
        var prevCatSum = prevData.expCatSums[catId] || 0;
        var catDiff = sum - prevCatSum;
        var catDiffHtml;
        if (!hasPrev || prevCatSum === 0) {
          catDiffHtml = '<span class="budget-cat-diff is-new">NEW</span>';
        } else {
          var catArrow = catDiff > 0 ? '\u25B2' : '\u25BC';
          var catCls = catDiff > 0 ? 'is-bad' : 'is-good'; // expense: up=bad, down=good
          catDiffHtml = '<span class="budget-cat-diff ' + catCls + '">' + catArrow + fmtYen(Math.abs(catDiff)) + '</span>';
        }
        catBreakdown +=
          '<div class="budget-cat-row">' +
          '<span class="budget-cat-icon">' + bcat.icon + '</span>' +
          '<span class="budget-cat-name">' + bcat.name + '</span>' +
          '<span class="budget-cat-bar-wrap"><span class="budget-cat-bar" style="width:' + pct + '%;background:' + bcat.color + '"></span></span>' +
          '<span class="budget-cat-amount">' + fmtYen(sum) + '</span>' +
          catDiffHtml + '</div>';
      }
      catBreakdown += '</div>';
    }

    // Shift earnings detail card
    var shiftDetail = '';
    if (totalShiftPay > 0) {
      var prevMLabel = (shift.prevMonth + 1) + '\u6708';
      var shiftLines = '';
      var sCats = shiftCats();
      for (var si = 0; si < sCats.length; si++) {
        var sc2 = sCats[si];
        var inf = shift.perCat[sc2.id];
        if (!inf) continue;
        shiftLines +=
          '<div class="budget-shift-row">' +
          '<span class="budget-shift-dot" style="background:' + sc2.color + '"></span>' +
          '<span class="budget-shift-name">' + escHtml(sc2.name) + '</span>' +
          '<span class="budget-shift-hours">' + fmtMin(inf.workMinutes) + '</span>' +
          '<span class="budget-shift-amount">' + fmtYen(inf.pay) + '</span></div>';
      }
      shiftDetail =
        '<div class="budget-shift-summary">' +
        '<div class="budget-shift-header">' +
        '<span class="budget-shift-icon">\u23F1</span>' +
        '<span class="budget-shift-label">\u30A2\u30EB\u30D0\u30A4\u30C8\u53CE\u5165\uFF08' + prevMLabel + '\u5206\uFF09</span>' +
        '<span class="budget-shift-total">' + fmtYen(totalShiftPay) + '</span></div>' +
        shiftLines + '</div>';
    }

    els.summaryEl.innerHTML =
      '<div class="budget-summary-grid">' +
      '<div class="budget-summary-card is-income"><div class="budget-summary-label">\u53CE\u5165</div><div class="budget-summary-value">' + fmtYen(totalIncome) + '</div>' + _vsBadge(totalIncome, prevData.totalIncome, 'up') + '</div>' +
      '<div class="budget-summary-card is-expense"><div class="budget-summary-label">\u652F\u51FA</div><div class="budget-summary-value">' + fmtYen(totalExpense) + '</div>' + _vsBadge(totalExpense, prevData.totalExpense, 'down') + '</div>' +
      '<div class="budget-summary-card is-balance ' + (balance >= 0 ? 'is-positive' : 'is-negative') + '"><div class="budget-summary-label">\u53CE\u652F</div><div class="budget-summary-value">' + (balance >= 0 ? '+' : '') + fmtYen(balance) + '</div>' + _vsBadge(balance, prevData.balance, 'up') + '</div>' +
      '</div>' + shiftDetail + catBreakdown;
  }

  // Render list
  if (filtered.length === 0) {
    var emptyMsg = filter === 'income' ? '\u53CE\u5165\u306E\u8A18\u9332\u306F\u3042\u308A\u307E\u305B\u3093'
                 : filter === 'expense' ? '\u652F\u51FA\u306E\u8A18\u9332\u306F\u3042\u308A\u307E\u305B\u3093'
                 : '\u8A18\u9332\u3092\u8FFD\u52A0\u3057\u3066\u5BB6\u8A08\u3092\u7BA1\u7406\u3057\u307E\u3057\u3087\u3046';
    els.listEl.innerHTML = '<div class="budget-empty">' + emptyMsg + '</div>';
    return;
  }

  // Group by date
  var groups = {};
  filtered.forEach(function(en) {
    if (!groups[en.date]) groups[en.date] = [];
    groups[en.date].push(en);
  });

  var DOWS = ['\u65E5','\u6708','\u706B','\u6C34','\u6728','\u91D1','\u571F'];
  var html = '';
  var gKeys = Object.keys(groups).sort(function(a, b) { return b.localeCompare(a); });
  for (var gi = 0; gi < gKeys.length; gi++) {
    var gDate = gKeys[gi], gItems = groups[gDate];
    var gParts = gDate.split('-');
    var gd = new Date(+gParts[0], +gParts[1] - 1, +gParts[2]);
    var gdow = DOWS[gd.getDay()];
    var dayTotal = 0;
    for (var di2 = 0; di2 < gItems.length; di2++) {
      dayTotal += gItems[di2].type === 'expense' ? -gItems[di2].amount : gItems[di2].amount;
    }

    html += '<div class="budget-date-group"><div class="budget-date-header">' +
      '<span class="budget-date-label">' + (+gParts[1]) + '/' + (+gParts[2]) + '\uFF08' + gdow + '\uFF09</span>' +
      '<span class="budget-date-total ' + (dayTotal >= 0 ? 'is-pos' : 'is-neg') + '">' + (dayTotal >= 0 ? '+' : '') + fmtYen(dayTotal) + '</span></div>';

    for (var ii = 0; ii < gItems.length; ii++) {
      var gen = gItems[ii];
      var isShiftEntry = gen._isShift;
      var isCarryover = gen._isCarryover;
      var isAuto = isShiftEntry || isCarryover;
      var isInc = gen.type === 'income';
      var gIcon, gCatName;
      if (isShiftEntry) {
        gIcon = '\u23F1'; gCatName = '\u30D0\u30A4\u30C8';
      } else if (isCarryover) {
        gIcon = '\u21A9'; gCatName = '\u5148\u6708\u7E70\u8D8A';
      } else {
        var gCat = getBudgetCat(gen.catId);
        gIcon = gCat.icon; gCatName = gCat.name;
      }
      var autoBadge = isShiftEntry ? '\u81EA\u52D5' : isCarryover ? '\u7E70\u8D8A' : '';
      html += '<div class="budget-entry ' + (isInc ? 'is-income' : 'is-expense') + (isAuto ? ' is-auto' : '') + '" data-budget-id="' + gen.id + '">' +
        '<span class="budget-entry-icon' + (isAuto ? ' is-shift-icon' : '') + '">' + gIcon + '</span>' +
        '<div class="budget-entry-body"><span class="budget-entry-cat">' + gCatName + (isAuto ? '<span class="budget-auto-badge">' + autoBadge + '</span>' : '') + '</span>' +
        (gen.memo ? '<span class="budget-entry-memo">' + escapeHtml(gen.memo) + '</span>' : '') +
        '</div>' +
        '<span class="budget-entry-amount ' + (isInc ? 'is-income' : 'is-expense') + '">' + (isInc ? '+' : '-') + fmtYen(gen.amount) + '</span>' +
        (isAuto ? '' : '<button class="budget-entry-del" type="button" title="\u524A\u9664" aria-label="\u524A\u9664">\u2715</button>') +
        '</div>';
    }
    html += '</div>';
  }

  els.listEl.innerHTML = html;
}


// ════════════════════════════════════════════════════════════
//  RECEIPT SCANNING (レシート読取)
// ════════════════════════════════════════════════════════════

const RECEIPT_APIKEY_STORAGE = 'kuro_claude_key';
let _receiptBase64 = null;
let _receiptMediaType = null;
let _receiptParsed = null;

// ── API Key management ──

function getReceiptApiKey() {
  return localStorage.getItem(RECEIPT_APIKEY_STORAGE) || '';
}
function setReceiptApiKey(key) {
  localStorage.setItem(RECEIPT_APIKEY_STORAGE, key);
}

// ── API Key modal ──

document.getElementById('js-receipt-key-btn').addEventListener('click', function() {
  document.getElementById('js-apikey-input').value = getReceiptApiKey();
  openOverlay('js-apikey-overlay');
});

document.getElementById('js-apikey-save').addEventListener('click', function() {
  var key = document.getElementById('js-apikey-input').value.trim();
  setReceiptApiKey(key);
  closeOverlay('js-apikey-overlay');
});

document.getElementById('js-apikey-cancel').addEventListener('click', function() {
  closeOverlay('js-apikey-overlay');
});
document.getElementById('js-apikey-modal-close').addEventListener('click', function() {
  closeOverlay('js-apikey-overlay');
});
document.getElementById('js-apikey-overlay').addEventListener('click', function(e) {
  if (e.target === document.getElementById('js-apikey-overlay')) closeOverlay('js-apikey-overlay');
});

// ── Receipt modal ──

function openReceiptModal() {
  var apiKey = getReceiptApiKey();
  if (!apiKey) {
    // Prompt for API key first
    document.getElementById('js-apikey-input').value = '';
    openOverlay('js-apikey-overlay');
    return;
  }
  _receiptBase64 = null;
  _receiptMediaType = null;
  _receiptParsed = null;
  _showReceiptStep('upload');
  document.getElementById('js-receipt-preview').style.display = 'none';
  document.getElementById('js-receipt-analyze').style.display = 'none';
  document.getElementById('js-receipt-drop').style.display = '';
  openOverlay('js-receipt-overlay');
}

function _showReceiptStep(step) {
  document.getElementById('js-receipt-step-upload').style.display  = step === 'upload'  ? '' : 'none';
  document.getElementById('js-receipt-step-loading').style.display = step === 'loading' ? '' : 'none';
  document.getElementById('js-receipt-step-result').style.display  = step === 'result'  ? '' : 'none';
  document.getElementById('js-receipt-step-error').style.display   = step === 'error'   ? '' : 'none';
}

document.getElementById('js-receipt-btn').addEventListener('click', openReceiptModal);

document.getElementById('js-receipt-modal-close').addEventListener('click', function() {
  closeOverlay('js-receipt-overlay');
});
document.getElementById('js-receipt-overlay').addEventListener('click', function(e) {
  if (e.target === document.getElementById('js-receipt-overlay')) closeOverlay('js-receipt-overlay');
});

// ── File input / drop zone ──

var receiptFileInput = document.getElementById('js-receipt-file');
var receiptDropZone  = document.getElementById('js-receipt-drop');

receiptDropZone.addEventListener('click', function() {
  receiptFileInput.click();
});

receiptFileInput.addEventListener('change', function(e) {
  var file = e.target.files[0];
  if (file) _handleReceiptFile(file);
  receiptFileInput.value = '';
});

// Drag and drop
receiptDropZone.addEventListener('dragover', function(e) {
  e.preventDefault();
  receiptDropZone.classList.add('is-dragover');
});
receiptDropZone.addEventListener('dragleave', function() {
  receiptDropZone.classList.remove('is-dragover');
});
receiptDropZone.addEventListener('drop', function(e) {
  e.preventDefault();
  receiptDropZone.classList.remove('is-dragover');
  var file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) _handleReceiptFile(file);
});

function _handleReceiptFile(file) {
  if (!file.type.startsWith('image/')) return;

  // Determine media type
  _receiptMediaType = file.type;

  var reader = new FileReader();
  reader.onload = function(e) {
    var dataUrl = e.target.result;
    _receiptBase64 = dataUrl.split(',')[1];

    // Show preview
    document.getElementById('js-receipt-preview-img').src = dataUrl;
    document.getElementById('js-receipt-preview').style.display = '';
    document.getElementById('js-receipt-drop').style.display = 'none';
    document.getElementById('js-receipt-analyze').style.display = '';
  };
  reader.readAsDataURL(file);
}

document.getElementById('js-receipt-clear').addEventListener('click', function() {
  _receiptBase64 = null;
  document.getElementById('js-receipt-preview').style.display = 'none';
  document.getElementById('js-receipt-drop').style.display = '';
  document.getElementById('js-receipt-analyze').style.display = 'none';
});

// ── Analyze receipt (Claude Haiku API) ──

document.getElementById('js-receipt-analyze').addEventListener('click', async function() {
  if (!_receiptBase64) return;
  var apiKey = getReceiptApiKey();
  if (!apiKey) { openReceiptModal(); return; }

  _showReceiptStep('loading');

  // カテゴリ一覧をプロンプトに動的反映
  var catList = budgetExpenseCats.map(function(c) { return '- ' + c.id + ': ' + c.name; }).join('\n');

  try {
    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: _receiptMediaType || 'image/jpeg',
                data: _receiptBase64
              }
            },
            {
              type: 'text',
              text: 'このレシートの内容を解析して、以下のJSON形式だけを返してください。JSON以外は絶対に出力しないでください。\n\n```\n{\n  "store": "店舗名",\n  "date": "YYYY-MM-DD",\n  "items": [\n    { "name": "商品名", "amount": 金額(整数), "category": "カテゴリID" }\n  ],\n  "total": 合計金額(整数)\n}\n```\n\ncategoryは以下から最も適切なものを選んでください:\n' + catList + '\n\n日付が読み取れない場合は "date": null としてください。金額は税込の数値（整数）にしてください。'
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      var errBody = await response.text();
      var apiMsg = '';
      try { apiMsg = JSON.parse(errBody)?.error?.message || ''; } catch {}
      throw new Error('API error ' + response.status + ': ' + (apiMsg || errBody));
    }

    var data = await response.json();
    var text = '';
    for (var i = 0; i < data.content.length; i++) {
      if (data.content[i].type === 'text') text += data.content[i].text;
    }
    if (!text) throw new Error('レスポンスが空でした。もう一度試してください。');

    var jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    _receiptParsed = JSON.parse(jsonStr);

    _renderReceiptResult();
    _showReceiptStep('result');

  } catch (err) {
    console.error('Receipt scan error:', err);
    var errMsg = err.message || 'エラーが発生しました。';
    if (errMsg.includes('401')) {
      errMsg = 'APIキーが無効です。⚙ボタンからAnthropicのAPIキーを設定してください。';
    } else if (errMsg.includes('credit balance') || errMsg.includes('too low')) {
      errMsg = 'APIのクレジット残高が不足しています。console.anthropic.com でクレジットを追加してください。';
    } else if (errMsg.includes('400')) {
      errMsg = 'リクエストエラー（400）: ' + errMsg.replace(/^API error \d+: /, '');
    } else if (errMsg.includes('429')) {
      errMsg = 'レート制限に達しました。少し待ってから再試行してください。';
    } else if (errMsg.includes('529') || errMsg.includes('overloaded')) {
      errMsg = 'APIが混雑しています。しばらく待ってから再試行してください。';
    } else if (errMsg.includes('Failed to fetch') || errMsg.includes('network')) {
      errMsg = 'ネットワークエラーです。接続を確認してください。';
    }
    document.getElementById('js-receipt-error-msg').textContent = errMsg;
    _showReceiptStep('error');
  }
});

// ── Render results ──

function _renderReceiptResult() {
  if (!_receiptParsed) return;
  var p = _receiptParsed;

  document.getElementById('js-receipt-store').textContent = p.store || '(店舗名不明)';
  document.getElementById('js-receipt-date').textContent = p.date || '(日付不明)';

  var items = p.items || [];
  var listEl = document.getElementById('js-receipt-items');
  listEl.innerHTML = '';

  items.forEach(function(item, idx) {
    var cat = getBudgetCat(item.category || 'other_exp');
    var row = document.createElement('div');
    row.className = 'receipt-item-row';
    row.setAttribute('data-idx', idx);
    row.innerHTML =
      '<span class="receipt-item-icon">' + cat.icon + '</span>' +
      '<div class="receipt-item-body">' +
        '<input class="receipt-item-name-input" type="text" value="' + escHtml(item.name) + '" data-field="name" />' +
        '<select class="receipt-item-cat-select" data-field="category">' +
          budgetExpenseCats.map(function(c) {
            return '<option value="' + c.id + '"' + (c.id === item.category ? ' selected' : '') + '>' + c.icon + ' ' + c.name + '</option>';
          }).join('') +
        '</select>' +
      '</div>' +
      '<input class="receipt-item-amount-input" type="number" value="' + (item.amount || 0) + '" data-field="amount" min="0" />' +
      '<button class="receipt-item-del" type="button" title="除外">\u2715</button>';

    // Edit handlers
    row.querySelector('[data-field="name"]').addEventListener('input', function(e) {
      _receiptParsed.items[idx].name = e.target.value;
    });
    row.querySelector('[data-field="category"]').addEventListener('change', function(e) {
      _receiptParsed.items[idx].category = e.target.value;
      var newCat = getBudgetCat(e.target.value);
      row.querySelector('.receipt-item-icon').textContent = newCat.icon;
    });
    row.querySelector('[data-field="amount"]').addEventListener('input', function(e) {
      _receiptParsed.items[idx].amount = parseInt(e.target.value) || 0;
      _updateReceiptTotal();
    });
    row.querySelector('.receipt-item-del').addEventListener('click', function() {
      _receiptParsed.items.splice(idx, 1);
      _renderReceiptResult();
    });

    listEl.appendChild(row);
  });

  _updateReceiptTotal();
}

function _updateReceiptTotal() {
  if (!_receiptParsed) return;
  var total = 0;
  (_receiptParsed.items || []).forEach(function(it) { total += (it.amount || 0); });
  _receiptParsed.total = total;
  document.getElementById('js-receipt-total').textContent = fmtYen(total);
}

// ── Save results to budget ──

document.getElementById('js-receipt-save').addEventListener('click', async function() {
  if (!_receiptParsed || !_budgetState) return;
  var p = _receiptParsed;
  var date = p.date || _todayStr();
  var store = p.store || '';

  var newEntries = [];
  (p.items || []).forEach(function(item) {
    if (!item.amount || item.amount <= 0) return;
    var id = 'b_' + Date.now() + '_' + Math.random().toString(16).slice(2);
    var entry = {
      id: id,
      type: 'expense',
      catId: item.category || 'other_exp',
      amount: item.amount,
      memo: (store ? store + ' - ' : '') + (item.name || ''),
      date: date,
      createdAt: Date.now()
    };
    _budgetState.entries.push(entry);
    newEntries.push(entry);
  });

  renderBudgetPanel();
  closeOverlay('js-receipt-overlay');
  for (var i = 0; i < newEntries.length; i++) {
    await addBudgetToSupabase(newEntries[i]);
  }
});

// ── Retry / error retry ──

document.getElementById('js-receipt-retry').addEventListener('click', function() {
  _receiptBase64 = null;
  _receiptParsed = null;
  _showReceiptStep('upload');
  document.getElementById('js-receipt-preview').style.display = 'none';
  document.getElementById('js-receipt-drop').style.display = '';
  document.getElementById('js-receipt-analyze').style.display = 'none';
});

document.getElementById('js-receipt-error-retry').addEventListener('click', function() {
  _showReceiptStep('upload');
});


// ════════════════════════════════════════════════════════════
//  DAILY PLAN MODAL (明日のタスク計画)
// ════════════════════════════════════════════════════════════

function _tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${_pad2(d.getMonth()+1)}-${_pad2(d.getDate())}`;
}

function openDailyPlanModal() {
  const tomorrow = _tomorrowStr();
  const dateEl = document.getElementById('js-daily-plan-date');
  dateEl.value = tomorrow;
  _updateDailyPlanLabel();

  document.getElementById('js-daily-plan-main').value = '';
  document.getElementById('js-daily-plan-sub1').value = '';
  document.getElementById('js-daily-plan-sub2').value = '';

  openOverlay('js-daily-plan-overlay');
  setTimeout(() => document.getElementById('js-daily-plan-main').focus(), 80);
}

function _updateDailyPlanLabel() {
  const val = document.getElementById('js-daily-plan-date').value;
  if (!val) return;
  const d = new Date(val + 'T00:00:00');
  const label = document.getElementById('js-daily-plan-date-label');
  label.textContent = `${MONTHS_INIT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} (${DAYS_EN[d.getDay()]})`;
}

document.getElementById('js-daily-plan-date').addEventListener('change', _updateDailyPlanLabel);

document.getElementById('js-daily-plan-btn').addEventListener('click', openDailyPlanModal);

document.getElementById('js-daily-plan-close').addEventListener('click', () => closeOverlay('js-daily-plan-overlay'));
document.getElementById('js-daily-plan-cancel').addEventListener('click', () => closeOverlay('js-daily-plan-overlay'));
document.getElementById('js-daily-plan-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('js-daily-plan-overlay')) closeOverlay('js-daily-plan-overlay');
});

document.getElementById('js-daily-plan-save').addEventListener('click', async () => {
  if (!_taskState) return;

  const dueDate = document.getElementById('js-daily-plan-date').value;
  const mainTitle = document.getElementById('js-daily-plan-main').value.trim();
  const sub1Title = document.getElementById('js-daily-plan-sub1').value.trim();
  const sub2Title = document.getElementById('js-daily-plan-sub2').value.trim();

  if (!mainTitle) {
    document.getElementById('js-daily-plan-main').focus();
    return;
  }

  const newTasks = [];

  // Main task (high priority)
  newTasks.push({ priority: 'high', title: mainTitle });
  if (sub1Title) newTasks.push({ priority: 'medium', title: sub1Title });
  if (sub2Title) newTasks.push({ priority: 'medium', title: sub2Title });

  for (const spec of newTasks) {
    const id = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const task = { id, title: spec.title, dueDate, priority: spec.priority, done: false, createdAt: Date.now() };
    _taskState.tasks.unshift(task);
    _persistTasks();
    await addTaskToSupabase(task);
  }

  renderTaskPanel();
  renderMain();
  closeOverlay('js-daily-plan-overlay');
});
