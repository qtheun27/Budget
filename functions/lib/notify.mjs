// Logique partagée des notifications — Budget du Foyer
// Utilisée par la fonction Firebase planifiée (functions/index.mjs) et, en secours, par GitHub Actions (notify/send.mjs).
// Aucune dépendance : la base, web-push et FieldValue sont fournis par l'appelant.

const TZ = 'Europe/Brussels';
export const APP_URL = 'https://qtheun27.github.io/Budget/';

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
  return (Array.isArray(l.parts) ? l.parts : []).filter(p => +p.day >= 1 && +p.amount > 0 && (!p.end || parse(p.end) >= d) && iso(dayIn(d.getUTCFullYear(), d.getUTCMonth(), +p.day)) === iso(d));
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

/** Comptages pour la console d'administration (aucun contenu de budget). */
async function writeStats(db, FieldValue, log, run) {
  const count = async q => (await q.count().get()).data().count;
  const [users, households, lines, devices] = await Promise.all([
    count(db.collection('users')), count(db.collection('households')), count(db.collectionGroup('lines')), count(db.collectionGroup('devices')),
  ]);
  await db.doc('admin/stats').set({ at: FieldValue.serverTimestamp(), users, households, lines, devices, run });
  log(`Statistiques : ${users} compte(s), ${households} foyer(s), ${lines} ligne(s), ${devices} appareil(s).`);
}

/** Rappels du jour : une notification groupée par compte. */
export async function runReminders({ db, webpush, FieldValue, dry = false, force = false, log = console.log }) {
  const DRY = dry, FORCE = force;
  const tISO = todayISO(), t = parse(tISO), t3 = addDays(t, 3);
  const runRef = db.doc(`server/run-${tISO}`);
  // Réservation atomique du passage du jour : la fonction planifiée et le secours GitHub ne peuvent pas envoyer deux fois.
  if (!DRY) {
    try { FORCE ? await runRef.set({ at: FieldValue.serverTimestamp(), status: 'running' }) : await runRef.create({ at: FieldValue.serverTimestamp(), status: 'running' }); }
    catch (e) { if (e.code === 6 || /already exists/i.test(e.message)) { log(`Déjà envoyé aujourd'hui (${tISO}).`); return; } throw e; }
  }
  try { await sendDay({ db, webpush, FieldValue, DRY, FORCE, tISO, t, t3, runRef, log }); }
  catch (e) { if (!DRY) await runRef.delete().catch(() => {}); throw e; }   // échec : le passage suivant pourra réessayer
}

async function sendDay({ db, webpush, FieldValue, DRY, FORCE, tISO, t, t3, runRef, log }) {
  const config = (await db.doc('config/app').get()).data() || {};
  if (config.reminders === false && !FORCE) {
    log("Rappels suspendus depuis la console d'administration.");
    if (!DRY) { await runRef.set({ at: FieldValue.serverTimestamp(), suspended: true }); await writeStats(db, FieldValue, log, { date: tISO, suspended: true }); }
    return;
  }

  await setupPush(db, webpush);

  const devicesSnap = await db.collectionGroup('devices').get();
  const byUser = new Map();
  devicesSnap.forEach(d => { const uid = d.ref.parent.parent.id; if (!byUser.has(uid)) byUser.set(uid, []); byUser.get(uid).push(d); });
  log(`${tISO} · ${byUser.size} compte(s) avec rappels, ${devicesSnap.size} appareil(s).`);

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
      if (l.who && l.who !== uid) continue;   // ligne personnelle d'un autre membre : pas de rappel pour moi
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
    if (DRY) { log(`[essai] ${uid.slice(0, 6)}… → ${msg.title} | ${msg.body.replace(/\n/g, ' / ')}`); continue; }
    const r = await sendToDevices(devices, payload, webpush, log); sent += r.sent; removed += r.removed;
  }
  if (!DRY) { await runRef.set({ at: FieldValue.serverTimestamp(), accounts, sent, removed }); await writeStats(db, FieldValue, log, { date: tISO, accounts, sent, removed }); }
  log(`${accounts} compte(s) concerné(s), ${sent} notification(s) envoyée(s), ${removed} abonnement(s) expiré(s) retiré(s).`);
}


/** Envoie une notification à une liste d'appareils ; retire les abonnements expirés. */
async function sendToDevices(devices, payload, webpush, log = console.log) {
  let sent = 0, removed = 0;
  for (const d of devices) {
    const sub = d.data();
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 20 * 3600, urgency: 'normal' }); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { await d.ref.delete(); removed++; }   // abonnement expiré ou retiré
      else log(`Échec d'envoi (${e.statusCode || e.message})`);
    }
  }
  return { sent, removed };
}

/** Prépare web-push avec la clé VAPID gardée côté serveur (server/vapid). */
export async function setupPush(db, webpush) {
  const vapid = (await db.doc('server/vapid').get()).data();
  if (!vapid?.privateKey) throw new Error('Clé VAPID absente (server/vapid).');
  webpush.setVapidDetails(vapid.subject || APP_URL, vapid.publicKey, vapid.privateKey);
}

/** Notification immédiate à tous les appareils d'un compte (messages du centre d'aide). */
export async function pushToUser({ db, webpush, uid, payload, log = console.log }) {
  const devices = (await db.collection(`users/${uid}/devices`).get()).docs;
  if (!devices.length) { log(`Aucun appareil abonné pour ${uid.slice(0, 6)}…`); return { sent: 0, removed: 0 }; }
  const r = await sendToDevices(devices, JSON.stringify(payload), webpush, log);
  log(`${r.sent} notification(s) envoyée(s) sur ${devices.length} appareil(s).`);
  return r;
}
