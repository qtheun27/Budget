// Tests des règles Firestore (émulateur). Lancer depuis la racine : npm --prefix tests test
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, writeBatch, arrayUnion, serverTimestamp, Timestamp } from 'firebase/firestore';

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
test('supprimer un foyer est refusé', async () => {
  await assertFails(deleteDoc(doc(as('A'), 'households/h1')));
});
