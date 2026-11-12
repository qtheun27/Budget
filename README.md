# Bud Jet · Budget du foyer

Appli web installable (PWA) de budget familial. On encode chaque revenu ou dépense **à sa vraie fréquence**
(hebdo, mensuelle, bimestrielle, trimestrielle, semestrielle, annuelle, ponctuelle) et l'appli la ramène
à la **semaine, au mois, au trimestre ou à l'année** d'un seul geste.

## Écrans
- **Accueil** : disponible après dépenses et épargne, répartition par catégorie, prochaines échéances, aperçu 12 mois.
- **Budget** : revenus et dépenses groupés par catégorie, montant d'origine et montant lissé.
- **Échéancier** : rentrées et sorties réelles des 12 prochains mois, solde de chaque mois, pics repérés.
- **Provisions** : pour chaque dépense irrégulière, combien mettre de côté par mois pour être prêt à l'échéance.
- **Pro / privé** : chaque ligne est privée, pro ou mixte (part pro en %). Vue Tout / Privé / Pro et carte « Activité complémentaire ».
- **Foyer** : membres avec prénom et photo (photo Google reprise automatiquement, ou photo choisie, réduite à 192 px).

## Structure
- `src/app.html` : source unique de l'appli (HTML, CSS, JS sans dépendance).
- `build.sh` : génère `index.html` (document complet + balises PWA) à partir de la source.
- `manifest.webmanifest`, `sw.js`, `icons/` : installation sur l'écran d'accueil et usage hors ligne.

## Développer
```bash
./build.sh && python3 -m http.server 8000
```

## Publier (GitHub Pages)
Settings → Pages → Deploy from a branch → `main` / racine. L'appli est alors installable depuis Safari
(Partager → « Sur l'écran d'accueil ») ou Chrome.

## Données et partage (V2)
- **Firebase** (projet `budget-foyer-qt`, plan gratuit) : comptes e-mail + mot de passe, Firestore en **europe-west1 (Belgique)**
  avec cache hors ligne. Chaque compte appartient à un **foyer** ; on invite son ou sa partenaire avec un code
  à usage unique valable 7 jours (écran **Foyer**).
- Structure : `households/{id}` (nom, membres), `households/{id}/lines/{id}` (lignes de budget), `users/{uid}`, `invites/{code}`.
- Sécurité : `firestore.rules`. Seuls les membres d'un foyer lisent et écrivent ses données ; on ne rejoint un foyer
  qu'en consommant un code valide dans la même écriture. Les lignes sont validées champ par champ.
- Si Firebase est injoignable au premier lancement, l'appli bascule sur un stockage local.

## Tester les règles de sécurité
```bash
npm --prefix tests install
firebase emulators:exec --only firestore --project budget-foyer-test "npm --prefix tests test"
```

## Déployer les règles
```bash
firebase deploy --only firestore:rules,firestore:indexes
```
