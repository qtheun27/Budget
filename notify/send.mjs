// Rappels d'échéance — Budget du Foyer (secours GitHub Actions)
//
// L'envoi principal est fait chaque matin à 8 h par la fonction Firebase planifiée (functions/index.mjs).
// Ce script, lancé plus tard par .github/workflows/rappels.yml, ne renvoie rien si le passage du jour a déjà eu lieu :
// il ne sert qu'en cas de panne. Connexion à Firestore sans clé (fédération d'identité GitHub → Google Cloud).
//
// Options : --dry-run (affiche sans envoyer ni écrire), --force (renvoie même si déjà fait aujourd'hui)

import { Firestore, FieldValue } from '@google-cloud/firestore';
import webpush from 'web-push';
import { runReminders } from '../functions/lib/notify.mjs';

const db = new Firestore({ projectId: 'budget-foyer-qt' });

runReminders({ db, webpush, FieldValue, dry: process.argv.includes('--dry-run'), force: process.argv.includes('--force') }).catch(e => {
  console.error(e);
  // Annotation visible directement dans le résumé du workflow GitHub.
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Rappels non envoyés::${String(e && (e.details || e.message) || e).replace(/\r?\n/g, ' ').slice(0, 900)}`);
  process.exit(1);
});
