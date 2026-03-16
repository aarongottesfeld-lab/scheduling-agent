importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

// Firebase config — these are public client-side keys (same values baked into the React bundle).
// Service workers cannot access process.env or build-time variables, so the config is inline.
firebase.initializeApp({
  apiKey:            'AIzaSyBHRoNPynlf4iAgt_u45CZZGbAzsAZak5U',
  authDomain:        'rendezvous-15ac6.firebaseapp.com',
  projectId:         'rendezvous-15ac6',
  storageBucket:     'rendezvous-15ac6.firebasestorage.app',
  messagingSenderId: '790661908618',
  appId:             '1:790661908618:web:1ed42cc7b2015476da0573',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  const actionUrl = payload.data?.actionUrl || '/';
  self.registration.showNotification(title || 'Rendezvous', {
    body: body || '',
    icon: '/logo192.png',
    data: { actionUrl },
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.actionUrl || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
