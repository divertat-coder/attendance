// Service worker: кэширует всё приложение, чтобы оно работало без интернета.
const CACHE = 'attend-v6';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'lib/face-api.js',
  'models/tiny_face_detector_model-weights_manifest.json', 'models/tiny_face_detector_model.bin',
  'models/face_landmark_68_tiny_model-weights_manifest.json', 'models/face_landmark_68_tiny_model.bin',
  'models/face_recognition_model-weights_manifest.json', 'models/face_recognition_model.bin'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // запросы к Google Apps Script не трогаем
  // сначала кэш, фоном обновляем (новая версия подхватится при следующем запуске)
  e.respondWith(
    caches.match(req, {ignoreSearch: true}).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
