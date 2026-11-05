// Fonctions serveur — Budget du Foyer (Firebase, région europe-west1, comme la base)
//
// rappelsDuMatin : chaque jour à 8 h (heure de Bruxelles), rappels d'échéance groupés par compte.
// messageSupport : à chaque message du centre d'aide, notification immédiate
//                  - message d'un utilisateur → l'administrateur
//                  - réponse de l'administrateur → l'utilisateur concerné
// La clé VAPID privée reste dans Firestore (server/vapid), jamais dans le code.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { setGlobalOptions, logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import webpush from 'web-push';
import { runReminders, setupPush, pushToUser, APP_URL } from './lib/notify.mjs';

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: 'europe-west1', maxInstances: 2, memory: '256MiB' });

const ADMIN_EMAIL = 'q.theuninck@gmail.com';
const TOPICS = { question: 'Question', bug: 'Bug', idea: 'Idée' };
const log = (...a) => logger.info(a.join(' '));

export const rappelsDuMatin = onSchedule({ schedule: '0 8 * * *', timeZone: 'Europe/Brussels', retryCount: 2, timeoutSeconds: 300 },
  () => runReminders({ db, webpush, FieldValue, log }));

export const messageSupport = onDocumentCreated({ document: 'support/{uid}/messages/{mid}', timeoutSeconds: 60 }, async event => {
  const m = event.data && event.data.data(); if (!m) return;
  const uid = event.params.uid;
  const thread = (await db.doc(`support/${uid}`).get()).data() || {};
  await setupPush(db, webpush);
  const text = String(m.text || '').replace(/\s+/g, ' ').slice(0, 180);
  if (m.from === 'user') {
    let admin;
    try { admin = await getAuth().getUserByEmail(ADMIN_EMAIL); } catch { log('Compte administrateur introuvable'); return; }
    if (admin.uid === uid) return;   // l'administrateur s'écrit à lui-même : rien à notifier
    const who = thread.name || thread.email || 'Un utilisateur';
    log(`Message de ${uid.slice(0, 6)}… → administrateur`);
    await pushToUser({ db, webpush, uid: admin.uid, log, payload: {
      title: `${who} · ${TOPICS[thread.topic] || 'Message'}`, body: text, url: `${APP_URL}#support/${uid}`, tag: `support-${uid}` } });
  } else if (m.from === 'admin') {
    log(`Réponse → ${uid.slice(0, 6)}…`);
    await pushToUser({ db, webpush, uid, log, payload: {
      title: 'Réponse du centre d\'aide', body: text, url: `${APP_URL}#aide`, tag: 'support-reponse' } });
  }
});
