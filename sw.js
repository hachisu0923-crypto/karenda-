// My Calendar - Service Worker
const CACHE_NAME = 'my-calendar-v4';

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

// プッシュ通知受信（将来のサーバーサイドプッシュ対応）
self.addEventListener('push', e => {
  const data = e.data?.json() ?? { title: 'My Calendar', body: '新しい通知があります' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon ?? '/icon-192.png',
      badge: data.badge ?? '/icon-192.png',
      tag: data.tag ?? 'my-calendar',
      data: data.url ? { url: data.url } : {}
    })
  );
});

// 通知クリック時：アプリを前面に
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url ?? '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
