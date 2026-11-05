// Tests des règles Firestore (émulateur). Lancer depuis la racine : npm --prefix tests test
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { query, orderBy, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, collectionGroup, getDocs, getCountFromServer, writeBatch, arrayUnion, serverTimestamp, Timestamp } from 'firebase/firestore';

let env;
const line = { kind: 'expense', label: 'Assurance auto', amount: 890, freq: 'annual', cat: 'assurances', due: '2027-03-01', saved: 0, createdAt: 1, updatedAt: 1 };
const inDays = d => Timestamp.fromMillis(Date.now() + d * 86400000);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'budget-foyer-test',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env.cleanup(); });

// Foyer h1 avec A comme seul membre, et des invitations prêtes.
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'households/h1'), { name: 'Notre foyer', owner: 'A', members: ['A'], memberEmails: { A: 'a@x.be' }, createdAt: Timestamp.now() });
    await setDoc(doc(db, 'users/A'), { householdId: 'h1' });
    await setDoc(doc(db, 'households/h1/lines/l1'), line);
    await setDoc(doc(db, 'invites/GOODCODE'), { hid: 'h1', createdBy: 'A', createdAt: Timestamp.now(), expiresAt: inDays(7), usedBy: null });
    await setDoc(doc(db, 'invites/USEDCODE'), { hid: 'h1', createdBy: 'A', createdAt: Timestamp.now(), expiresAt: inDays(7), usedBy: 'Z' });
    await setDoc(doc(db, 'invites/OLDCODE1'), { hid: 'h1', createdBy: 'A', createdAt: Timestamp.now(), expiresAt: inDays(-1), usedBy: null });
    await setDoc(doc(db, 'households/h2'), { name: 'Autre', owner: 'Q', members: ['Q'], memberEmails: { Q: 'q@x.be' }, createdAt: Timestamp.now() });
    await setDoc(doc(db, 'invites/H2CODE00'), { hid: 'h2', createdBy: 'Q', createdAt: Timestamp.now(), expiresAt: inDays(7), usedBy: null });
  });
});

const as = uid => env.authenticatedContext(uid, { email: uid.toLowerCase() + '@x.be' }).firestore();
const join = (db, uid, code, hid = 'h1') => {
  const b = writeBatch(db);
  b.update(doc(db, 'households', hid), { members: arrayUnion(uid), [`memberEmails.${uid}`]: uid.toLowerCase() + '@x.be', joinCode: code });
  b.update(doc(db, 'invites', code), { usedBy: uid });
  b.set(doc(db, 'users', uid), { householdId: hid });
  return b.commit();
};

// ---------- autorisé ----------
test('créer son foyer', async () => {
  const db = as('C'); const b = writeBatch(db);
  b.set(doc(db, 'households/hc'), { name: 'Foyer C', owner: 'C', members: ['C'], memberEmails: { C: 'c@x.be' }, createdAt: serverTimestamp() });
  b.set(doc(db, 'users/C'), { householdId: 'hc' });
  await assertSucceeds(b.commit());
});
test('un membre lit le foyer et ses lignes', async () => {
  const db = as('A');
  await assertSucceeds(getDoc(doc(db, 'households/h1')));
  await assertSucceeds(getDocs(collection(db, 'households/h1/lines')));
});
test('un membre ajoute, modifie, supprime une ligne', async () => {
  const db = as('A');
  await assertSucceeds(setDoc(doc(db, 'households/h1/lines/l2'), { ...line, label: 'Eau', freq: 'quarterly', amount: 185.5 }));
  await assertSucceeds(setDoc(doc(db, 'households/h1/lines/l1'), { ...line, saved: 120 }));
  await assertSucceeds(deleteDoc(doc(db, 'households/h1/lines/l2')));
});
test('un membre renomme le foyer', async () => {
  await assertSucceeds(updateDoc(doc(as('A'), 'households/h1'), { name: 'Les Dupont' }));
});
test('un membre crée une invitation', async () => {
  await assertSucceeds(setDoc(doc(as('A'), 'invites/NEWCODE1'), { hid: 'h1', createdBy: 'A', createdAt: serverTimestamp(), expiresAt: inDays(7), usedBy: null }));
});
test('rejoindre avec un code valide, puis lire et écrire', async () => {
  const db = as('B');
  await assertSucceeds(getDoc(doc(db, 'invites/GOODCODE')));
  await assertSucceeds(join(db, 'B', 'GOODCODE'));
  await assertSucceeds(getDocs(collection(db, 'households/h1/lines')));
  await assertSucceeds(setDoc(doc(db, 'households/h1/lines/lb'), { ...line, label: 'Courses', freq: 'weekly', amount: 175 }));
});

// ---------- refusé ----------
test("un non-membre ne lit ni le foyer ni les lignes", async () => {
  const db = as('C');
  await assertFails(getDoc(doc(db, 'households/h1')));
  await assertFails(getDocs(collection(db, 'households/h1/lines')));
  await assertFails(getDoc(doc(db, 'households/h1/lines/l1')));
});
test('un non-membre n\'écrit pas de ligne', async () => {
  await assertFails(setDoc(doc(as('C'), 'households/h1/lines/x'), line));
});
test('non connecté : rien', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'households/h1')));
  await assertFails(getDoc(doc(db, 'invites/GOODCODE')));
});
test('rejoindre sans code est refusé', async () => {
  await assertFails(updateDoc(doc(as('C'), 'households/h1'), { members: arrayUnion('C'), 'memberEmails.C': 'c@x.be' }));
});
test('rejoindre avec un code déjà utilisé est refusé', async () => {
  await assertFails(join(as('C'), 'C', 'USEDCODE'));
});
test('rejoindre avec un code expiré est refusé', async () => {
  await assertFails(join(as('C'), 'C', 'OLDCODE1'));
});
test("le code d'un autre foyer ne permet pas de rejoindre h1", async () => {
  await assertFails(join(as('C'), 'C', 'H2CODE00', 'h1'));
});
test('rejoindre sans consommer le code est refusé', async () => {
  const db = as('C'); const b = writeBatch(db);
  b.update(doc(db, 'households/h1'), { members: arrayUnion('C'), 'memberEmails.C': 'c@x.be', joinCode: 'GOODCODE' });
  await assertFails(b.commit());
});
test("ajouter quelqu'un d'autre que soi est refusé", async () => {
  const db = as('C'); const b = writeBatch(db);
  b.update(doc(db, 'households/h1'), { members: arrayUnion('C', 'D'), 'memberEmails.C': 'c@x.be', joinCode: 'GOODCODE' });
  b.update(doc(db, 'invites/GOODCODE'), { usedBy: 'C' });
  await assertFails(b.commit());
});
test("consommer un code sans devenir membre est refusé", async () => {
  await assertFails(updateDoc(doc(as('C'), 'invites/GOODCODE'), { usedBy: 'C' }));
});
test('lister les invitations est refusé', async () => {
  await assertFails(getDocs(collection(as('A'), 'invites')));
});
test("un non-membre ne crée pas d'invitation", async () => {
  await assertFails(setDoc(doc(as('C'), 'invites/HACKCODE'), { hid: 'h1', createdBy: 'C', createdAt: serverTimestamp(), expiresAt: inDays(7), usedBy: null }));
});
test('une invitation de plus de 8 jours est refusée', async () => {
  await assertFails(setDoc(doc(as('A'), 'invites/LONGCODE'), { hid: 'h1', createdBy: 'A', createdAt: serverTimestamp(), expiresAt: inDays(30), usedBy: null }));
});
test('créer un foyer en y mettant quelqu\'un d\'autre est refusé', async () => {
  await assertFails(setDoc(doc(as('C'), 'households/hx'), { name: 'X', owner: 'C', members: ['C', 'A'], memberEmails: { C: 'c@x.be' }, createdAt: serverTimestamp() }));
});
test("pointer son compte vers un foyer dont on n'est pas membre est refusé", async () => {
  await assertFails(setDoc(doc(as('C'), 'users/C'), { householdId: 'h1' }));
});
test("lire le compte de quelqu'un d'autre est refusé", async () => {
  await assertFails(getDoc(doc(as('C'), 'users/A')));
});
test('un membre ne change ni le propriétaire ni la liste des membres', async () => {
  await assertFails(updateDoc(doc(as('A'), 'households/h1'), { owner: 'B' }));
  await assertFails(updateDoc(doc(as('A'), 'households/h1'), { members: ['A', 'Z'] }));
});
test('une ligne invalide est refusée', async () => {
  const db = as('A');
  await assertFails(setDoc(doc(db, 'households/h1/lines/bad1'), { ...line, amount: -5 }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/bad2'), { ...line, freq: 'daily' }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/bad3'), { ...line, hack: true }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/bad4'), { ...line, label: '' }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/bad5'), { ...line, kind: 'transfer' }));
});
test('part professionnelle : 0 à 100 acceptée, hors limites refusée', async () => {
  const db = as('A');
  await assertSucceeds(setDoc(doc(db, 'households/h1/lines/p1'), { ...line, pro: 40 }));
  await assertSucceeds(setDoc(doc(db, 'households/h1/lines/p2'), { ...line, kind: 'income', cat: 'pro', pro: 100 }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/p3'), { ...line, pro: 140 }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/p4'), { ...line, pro: 'beaucoup' }));
});
test('ligne attribuée à un membre du foyer, pas à un étranger', async () => {
  const db = as('A');
  await assertSucceeds(setDoc(doc(db, 'households/h1/lines/w1'), { ...line, who: 'A' }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/w2'), { ...line, who: 'Q' }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/w3'), { ...line, who: 42 }));
});
test('date de fin des paiements acceptée, format invalide refusé', async () => {
  const db = as('A');
  await assertSucceeds(setDoc(doc(db, 'households/h1/lines/e1'), { ...line, freq: 'monthly', end: '2028-03-01' }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/e2'), { ...line, end: 20280301 }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/e3'), { ...line, end: 'x'.repeat(30) }));
});
test('plusieurs prélèvements par mois et montant variable', async () => {
  const db = as('A');
  const parts = [{ day: 28, amount: 512.4, label: 'Crédit 1' }, { day: 28, amount: 233.1, label: 'Crédit 2' }, { day: 3, amount: 180 }, { day: 6, amount: 95.5 }];
  await assertSucceeds(setDoc(doc(db, 'households/h1/lines/m1'), { ...line, freq: 'multi', amount: 1021, parts, variable: false }));
  await assertSucceeds(setDoc(doc(db, 'households/h1/lines/m2'), { ...line, freq: 'multi', amount: 240, parts: parts.slice(0, 2), variable: true }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/m3'), { ...line, freq: 'multi', parts: Array(13).fill({ day: 1, amount: 1 }) }));
  await assertFails(setDoc(doc(db, 'households/h1/lines/m4'), { ...line, variable: 'oui' }));
});
test('catégories du foyer : membres seulement, champs validés', async () => {
  const cat = { label: 'Animaux', color: '#FF9500', icon: 'paw', kind: 'expense', pro: false, kw: ['croquettes', 'vétérinaire'], hidden: false, order: 210, custom: true };
  await assertSucceeds(setDoc(doc(as('A'), 'households/h1/categories/c1'), cat));
  await assertSucceeds(setDoc(doc(as('A'), 'households/h1/categories/enfants'), { hidden: true, order: 50 }));
  await assertSucceeds(getDoc(doc(as('A'), 'households/h1/categories/c1')));
  await assertFails(getDoc(doc(as('C'), 'households/h1/categories/c1')));
  await assertFails(setDoc(doc(as('C'), 'households/h1/categories/c2'), cat));
  await assertFails(setDoc(doc(as('A'), 'households/h1/categories/c3'), { ...cat, color: 'red' }));
  await assertFails(setDoc(doc(as('A'), 'households/h1/categories/c4'), { ...cat, label: '' }));
  await assertFails(setDoc(doc(as('A'), 'households/h1/categories/c5'), { ...cat, hack: 1 }));
  await assertSucceeds(deleteDoc(doc(as('A'), 'households/h1/categories/c1')));
});
test('un membre modifie son profil (prénom, photo)', async () => {
  const db = as('A');
  await assertSucceeds(updateDoc(doc(db, 'households/h1'), { 'memberProfiles.A': { name: 'Quentin', photo: 'data:image/jpeg;base64,AAAA' } }));
  await assertSucceeds(updateDoc(doc(db, 'households/h1'), { 'memberProfiles.A': { name: 'Quentin', photo: 'https://lh3.googleusercontent.com/a/xyz' } }));
});
test("modifier le profil d'un autre membre est refusé", async () => {
  await env.withSecurityRulesDisabled(async ctx => { await updateDoc(doc(ctx.firestore(), 'households/h1'), { members: ['A', 'B'], 'memberEmails.B': 'b@x.be' }); });
  await assertFails(updateDoc(doc(as('A'), 'households/h1'), { 'memberProfiles.B': { name: 'Pirate' } }));
});
test('un profil invalide est refusé', async () => {
  const db = as('A');
  await assertFails(updateDoc(doc(db, 'households/h1'), { 'memberProfiles.A': { name: 'Q', photo: 'javascript:alert(1)' } }));
  await assertFails(updateDoc(doc(db, 'households/h1'), { 'memberProfiles.A': { name: 'Q', admin: true } }));
  await assertFails(updateDoc(doc(db, 'households/h1'), { 'memberProfiles.A': { photo: 'data:image/jpeg;base64,' + 'A'.repeat(90000) } }));
});
test('un non-membre ne modifie aucun profil', async () => {
  await assertFails(updateDoc(doc(as('C'), 'households/h1'), { 'memberProfiles.C': { name: 'C' } }));
});
test('réglages de rappels : chacun règle les siens', async () => {
  await assertSucceeds(updateDoc(doc(as('A'), 'users/A'), { notify: { before3: true, sameDay: false, income: true } }));
  await assertFails(updateDoc(doc(as('A'), 'users/A'), { notify: { before3: 'oui' } }));
  await assertFails(updateDoc(doc(as('A'), 'users/A'), { notify: { spam: true } }));
  await assertFails(updateDoc(doc(as('C'), 'users/A'), { notify: { before3: false } }));
});
test('appareils abonnés : privés à chaque compte', async () => {
  const dev = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'BPk', auth: 'xyz' }, ua: 'iPhone', createdAt: 1 };
  await assertSucceeds(setDoc(doc(as('A'), 'users/A/devices/d1'), dev));
  await assertSucceeds(getDoc(doc(as('A'), 'users/A/devices/d1')));
  await assertFails(getDoc(doc(as('B'), 'users/A/devices/d1')));
  await assertFails(setDoc(doc(as('B'), 'users/A/devices/d2'), dev));
  await assertFails(setDoc(doc(as('A'), 'users/A/devices/d3'), { ...dev, endpoint: 'http://evil.example' }));
});
test("la zone serveur (clés d'envoi) est inaccessible", async () => {
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), 'server/vapid'), { privateKey: 'secret' }); });
  await assertFails(getDoc(doc(as('A'), 'server/vapid')));
  await assertFails(setDoc(doc(as('A'), 'server/vapid'), { privateKey: 'x' }));
});
test('supprimer un foyer est refusé', async () => {
  await assertFails(deleteDoc(doc(as('A'), 'households/h1')));
});

/* ---------- administration ---------- */
const admin = (verified = true) => env.authenticatedContext('ADM', { email: 'q.theuninck@gmail.com', email_verified: verified }).firestore();
const cfg = (extra = {}) => ({ signups: true, reminders: true, banner: { on: true, text: 'Bienvenue', tone: 'info', id: 'm1' }, minBuild: 1, updatedAt: serverTimestamp(), updatedBy: 'q.theuninck@gmail.com', ...extra });

test("l'administrateur modifie les réglages, personne d'autre", async () => {
  await assertSucceeds(setDoc(doc(admin(), 'config/app'), cfg()));
  await assertFails(setDoc(doc(admin(false), 'config/app'), cfg()));   // adresse non vérifiée
  await assertFails(setDoc(doc(as('A'), 'config/app'), cfg({ updatedBy: 'a@x.be' })));
  await assertFails(setDoc(doc(admin(), 'config/autre'), cfg()));
  await assertFails(setDoc(doc(admin(), 'config/app'), cfg({ hack: 1 })));
  await assertFails(setDoc(doc(admin(), 'config/app'), cfg({ banner: { on: true, text: 'x'.repeat(300), tone: 'info', id: 'm2' } })));
});
test('tout le monde lit les réglages', async () => {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'config/app'), { signups: true }));
  await assertSucceeds(getDoc(doc(as('A'), 'config/app')));
  await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'config/app')));
});
test("l'administrateur compte les comptes et appareils ; un membre ne peut pas", async () => {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'users/A/devices/d1'), { endpoint: 'https://p', keys: { p256dh: 'x', auth: 'y' }, ua: 't', createdAt: 1 }));
  await assertSucceeds(getDocs(collection(admin(), 'users')));
  await assertSucceeds(getCountFromServer(collectionGroup(admin(), 'devices')));
  await assertFails(getDocs(collection(as('A'), 'users')));
  await assertFails(getCountFromServer(collectionGroup(as('A'), 'devices')));
  await assertFails(getDocs(collection(admin(false), 'users')));
});
test("l'administrateur ne lit pas le budget des foyers", async () => {
  await assertFails(getDoc(doc(admin(), 'households/h1')));
  await assertFails(getDocs(collection(admin(), 'households/h1/lines')));
});
test('statistiques : lecture admin, écriture serveur seulement', async () => {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'admin/stats'), { users: 2 }));
  await assertSucceeds(getDoc(doc(admin(), 'admin/stats')));
  await assertFails(getDoc(doc(as('A'), 'admin/stats')));
  await assertFails(setDoc(doc(admin(), 'admin/stats'), { users: 99 }));
});
test('inscriptions fermées : plus de nouveau foyer (sauf administrateur)', async () => {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'config/app'), { signups: false }));
  const mk = (db, uid, email) => setDoc(doc(db, 'households/n' + uid), { name: 'Nouveau', owner: uid, members: [uid], memberEmails: { [uid]: email }, createdAt: serverTimestamp() });
  await assertFails(mk(as('N'), 'N', 'n@x.be'));
  await assertSucceeds(mk(admin(), 'ADM', 'q.theuninck@gmail.com'));
});
test('dernier passage enregistré sur le compte', async () => {
  await assertSucceeds(updateDoc(doc(as('A'), 'users/A'), { seen: '2026-11-04' }));
  await assertFails(updateDoc(doc(as('A'), 'users/A'), { seen: 20261104 }));
});

/* ---------- centre d'aide ---------- */
const send = (db, uid, from, text, first = false) => {
  const b = writeBatch(db);
  const t = { lastAt: serverTimestamp(), lastFrom: from, lastText: text.slice(0, 140) };
  if (from === 'user') Object.assign(t, { email: uid.toLowerCase() + '@x.be', topic: 'question', status: 'open' });
  if (first) t.createdAt = serverTimestamp();
  b.set(doc(db, 'support', uid), t, { merge: true });
  b.set(doc(collection(db, 'support', uid, 'messages')), { from, text, at: serverTimestamp() });
  return b.commit();
};
test("un compte écrit au centre d'aide, l'administrateur répond", async () => {
  await assertSucceeds(send(as('A'), 'A', 'user', 'Bonjour, comment partager ?', true));
  await assertSucceeds(send(as('A'), 'A', 'user', 'Encore une question'));
  await assertSucceeds(send(admin(), 'A', 'admin', 'Depuis Foyer → Inviter.'));
  await assertSucceeds(getDocs(query(collection(as('A'), 'support/A/messages'), orderBy('at'))));
  await assertSucceeds(getDocs(collection(admin(), 'support')));
  await assertSucceeds(updateDoc(doc(admin(), 'support/A'), { status: 'resolved', adminReadAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as('A'), 'support/A'), { userReadAt: serverTimestamp() }));
});
test("personne d'autre ne lit ni n'écrit dans la conversation d'un compte", async () => {
  await assertSucceeds(send(as('A'), 'A', 'user', 'Message privé', true));
  await assertFails(getDoc(doc(as('Q'), 'support/A')));
  await assertFails(getDocs(collection(as('Q'), 'support/A/messages')));
  await assertFails(getDocs(collection(as('Q'), 'support')));
  await assertFails(send(as('Q'), 'A', 'user', 'Usurpation'));
  await assertFails(send(as('A'), 'A', 'admin', 'Je me fais passer pour le support'));
  await assertFails(send(admin(false), 'A', 'admin', 'Adresse non vérifiée'));
});
test("messages : texte borné, non modifiables, fil obligatoire", async () => {
  await assertFails(send(as('A'), 'A', 'user', 'x'.repeat(2001), true));
  await assertFails(setDoc(doc(as('A'), 'support/A/messages/m1'), { from: 'user', text: 'seul', at: serverTimestamp() }));   // sans mise à jour du fil
  await assertSucceeds(send(as('A'), 'A', 'user', 'ok', true));
  const m = (await getDocs(collection(as('A'), 'support/A/messages'))).docs[0];
  await assertFails(updateDoc(m.ref, { text: 'modifié' }));
  await assertFails(deleteDoc(m.ref));
  await assertFails(updateDoc(doc(as('A'), 'support/A'), { status: 'resolved' }));   // seul l'administrateur classe
});
