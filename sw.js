// My Calendar - Service Worker
const CACHE_NAME = 'my-calendar-v8';

// インストール時：基本ファイルをキャッシュ
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/', '/index.html', '/app.js', '/style.css'])
        .catch(() => {}) // キャッシュ失敗は無視
    )
  );
});

// アクティベート時：古いキャッシュ削除
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// フェッチ：ネットワーク優先、失敗時キャッシュ
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// プッシュ通知受信（サーバーから送られる Web Push）
self.addEventListener('push', e => {
  let data = { title: '📅 My Calendar', body: '新しいお知らせがあります' };
  if (e.data) {
    try { data = { ...data, ...e.data.json() }; } catch { data.body = e.data.text() || data.body; }
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon  ?? '/icon-192.png',
      badge:   data.badge ?? '/icon-192.png',
      tag:     data.tag   ?? 'my-calendar-push',
      renotify: true,
      data:    { url: data.url ?? '/' }
    })
  );
});

// 通知クリック時：アプリを前面に表示（なければ新規タブで開く）
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url ?? '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => new URL(c.url).origin === self.location.origin);
      if (existing) { existing.navigate(url); return existing.focus(); }
      return self.clients.openWindow(url);
    })
  );
});
