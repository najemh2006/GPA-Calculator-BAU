'use strict';

/*
 * Service Worker — يتيح عمل الحاسبة دون إنترنت.
 * الاستراتيجية: يُعرض المحفوظ فوراً ثم يُحدَّث في الخلفية (stale-while-revalidate).
 * عند تعديل أي ملف غيّر رقم CACHE ليصل التحديث للمستخدمين.
 */
const CACHE = 'gpa-calculator-v1';

// ملفات التطبيق الأساسية (مسارات نسبية لمكان sw.js)
const CORE = [
    './',
    'index.html',
    'css/style.css',
    'js/script.js',
    'manifest.webmanifest'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => Promise.allSettled(CORE.map((url) => cache.add(url))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || !req.url.startsWith('http')) return;

    event.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req)
                .then((res) => {
                    // يُخزَّن الناجح والمعتم (opaque) لملفات CDN والخطوط
                    if (res && (res.ok || res.type === 'opaque')) {
                        const copy = res.clone();
                        caches.open(CACHE).then((cache) => cache.put(req, copy));
                    }
                    return res;
                })
                .catch(() => cached);
            return cached || network;
        })
    );
});
