// Rappels d'échéance — Budget du Foyer
//
// Lancé chaque matin par GitHub Actions (.github/workflows/rappels.yml), sans clé :
// l'accès à Firestore passe par la fédération d'identité GitHub → Google Cloud.
//
// Pour chaque compte qui a activé les rappels sur au moins un appareil :
//   - « le jour même » : paiements dont l'échéance est aujourd'hui
//   - « 3 jours avant » : paiements dont l'échéance tombe dans 3 jours
//   - option « rentrées » : mêmes règles pour les revenus attendus
// Une seule notification groupée par compte et par jour, envoyée à tous ses appareils.
//
// Options : --dry-run (affiche sans envoyer ni écrire), --force (renvoie même si déjà fait aujourd'hui)

import { Firestore, FieldValue } from '@google-cloud/firestore';
import webpush from 'web-push';

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const TZ = 'Europe/Brussels';
const APP_URL = 'https://qtheun27.github.io/Budget/';

// Identifiants par défaut de Google Cloud : en GitHub Actions, ce sont ceux de la fédération
// d'identité (type « external_account »), que la bibliothèque Firestore gère nativement.
const db = new Firestore({ projectId: 'budget-foyer-qt' });

/* ---------- dates (jours calendaires, fuseau de Bruxelles) ---------- */
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
const addMonths = (d, k) => {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1));
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(d.getUTCDate(), last));
  return r;
};
const MONTHS = { monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, annual: 12 };
const dayIn = (y, m, day) => new Date(Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())));
/** Prélèvements d'une ligne « plusieurs fois par mois » tombant le jour `d`. */
function partsOn(l, d) {
  const end = l.end ? parse(l.end) : null; if (end && d > end) return [];
  return (Array.isArray(l.parts) ? l.parts : []).filter(p => +p.day >= 1 && +p.amount > 0 && iso(dayIn(d.getUTCFullYear(), d.getUTCMonth(), +p.day)) === iso(d));
}

/** Prochaine échéance d'une ligne à partir de `from` (même logique que l'appli). */
function nextDue(l, from) {
  if (!l.due) return null;
  const d = parse(l.due);
  if (l.freq === 'once') return d >= from ? d : null;
  const end = l.end ? parse(l.end) : null;
  let r = d;
  if (l.freq === 'weekly') { while (r < from) r = addDays(r, 7); }
  else {
    const k = MONTHS[l.freq]; if (!k) return null;
    let i = 0; while (r < from && i++ < 1200) r = addMonths(d, k * i);
  }
  return end && r > end ? null : r;
}

const eurRaw = n => new Intl.NumberFormat('fr-BE', { style: 'currency', currency: 'EUR', maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n);
const eur = (n, approx) => (approx ? '≈ ' : '') + eurRaw(n);
const list = items => items.map(i => `${i.label} ${eur(i.amount, i.approx)}`).join(' · ');

function compose(today, soon) {
  const all = [...today, ...soon];
  if (!all.length) return null;
  const pay = all.filter(i => i.kind === 'expense'), inc = all.filter(i => i.kind === 'income');
  if (all.length === 1) {
    const i = all[0], when = today.length ? "aujourd'hui" : 'dans 3 jours';
    return {
      title: `${today.length ? "Aujourd'hui" : 'Dans 3 jours'} · ${i.label}`,
      body: i.kind === 'income' ? `Rentrée attendue ${when} : ${eur(i.amount, i.approx)}.` : `${eur(i.amount, i.approx)} à payer ${when}.`,
    };
  }
  const lines = [];
  if (today.length) lines.push(`Aujourd'hui : ${list(today)}`);
  if (soon.length) lines.push(`Dans 3 jours : ${list(soon)}`);
  const title = pay.length && inc.length ? `${pay.length} paiement${pay.length > 1 ? 's' : ''} et ${inc.length} rentrée${inc.length > 1 ? 's' : ''}`
    : pay.length ? `${pay.length} paiements à venir` : `${inc.length} rentrées attendues`;
  return { title, body: lines.join('\n') };
}

async function main() {
  const tISO = todayISO(), t = parse(tISO), t3 = addDays(t, 3);
  const runRef = db.doc(`server/run-${tISO}`);
  if (!FORCE && !DRY && (await runRef.get()).exists) { console.log(`Déjà envoyé aujourd'hui (${tISO}).`); return; }

  const vapid = (await db.doc('server/vapid').get()).data();
  if (!vapid?.privateKey) throw new Error('Clé VAPID absente (server/vapid).');
  webpush.setVapidDetails(vapid.subject || APP_URL, vapid.publicKey, vapid.privateKey);

  const devicesSnap = await db.collectionGroup('devices').get();
  const byUser = new Map();
  devicesSnap.forEach(d => { const uid = d.ref.parent.parent.id; if (!byUser.has(uid)) byUser.set(uid, []); byUser.get(uid).push(d); });
  console.log(`${tISO} · ${byUser.size} compte(s) avec rappels, ${devicesSnap.size} appareil(s).`);

  const linesCache = new Map();
  let sent = 0, removed = 0, accounts = 0;
  for (const [uid, devices] of byUser) {
    const user = (await db.doc(`users/${uid}`).get()).data();
    if (!user?.householdId) continue;
    const prefs = { before3: true, sameDay: true, income: false, ...(user.notify || {}) };
    if (!linesCache.has(user.householdId)) {
      const ls = await db.collection(`households/${user.householdId}/lines`).get();
      linesCache.set(user.householdId, ls.docs.map(d => d.data()));
    }
    const today = [], soon = [];
    for (const l of linesCache.get(user.householdId)) {
      if (l.kind === 'income' && !prefs.income) continue;
      if (l.freq === 'multi') {
        const mk = p => ({ label: p.label ? `${l.label} (${p.label})` : l.label, amount: +p.amount, kind: l.kind, approx: !!l.variable });
        if (prefs.sameDay) partsOn(l, t).forEach(p => today.push(mk(p)));
        if (prefs.before3) partsOn(l, t3).forEach(p => soon.push(mk(p)));
        continue;
      }
      const n = nextDue(l, t); if (!n) continue;
      const item = { label: l.label, amount: +l.amount || 0, kind: l.kind, approx: !!l.variable };
      if (prefs.sameDay && iso(n) === tISO) today.push(item);
      else if (prefs.before3 && iso(n) === iso(t3)) soon.push(item);
    }
    const msg = compose(today, soon);
    if (!msg) continue;
    accounts++;
    const payload = JSON.stringify({ ...msg, url: APP_URL + '#echeancier', tag: `rappel-${tISO}` });
    if (DRY) { console.log(`[essai] ${uid.slice(0, 6)}… → ${msg.title} | ${msg.body.replace(/\n/g, ' / ')}`); continue; }
    for (const d of devices) {
      const sub = d.data();
      try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 20 * 3600, urgency: 'normal' }); sent++; }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await d.ref.delete(); removed++; }   // abonnement expiré ou retiré
        else console.error(`Échec d'envoi (${e.statusCode || e.message})`);
      }
    }
  }
  if (!DRY) await runRef.set({ at: FieldValue.serverTimestamp(), accounts, sent, removed });
  console.log(`${accounts} compte(s) concerné(s), ${sent} notification(s) envoyée(s), ${removed} abonnement(s) expiré(s) retiré(s).`);
}

main().catch(e => {
  console.error(e);
  // Annotation visible directement dans le résumé du workflow GitHub.
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Rappels non envoyés::${String(e && (e.details || e.message) || e).replace(/\r?\n/g, ' ').slice(0, 900)}`);
  process.exit(1);
});
