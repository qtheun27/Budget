# Budget du Foyer

Appli web installable (PWA) de budget familial. On encode chaque revenu ou dépense **à sa vraie fréquence**
(hebdo, mensuelle, bimestrielle, trimestrielle, semestrielle, annuelle, ponctuelle) et l'appli la ramène
à la **semaine, au mois, au trimestre ou à l'année** d'un seul geste.

## Écrans
- **Accueil** : disponible après dépenses et épargne, répartition par catégorie, prochaines échéances, aperçu 12 mois.
- **Budget** : revenus et dépenses groupés par catégorie, montant d'origine et montant lissé.
- **Échéancier** : sorties réelles des 12 prochains mois, pics repérés par rapport à la moyenne lissée.
- **Provisions** : pour chaque dépense irrégulière, combien mettre de côté par mois pour être prêt à l'échéance.

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

## Données
Version GitHub Pages : stockées sur l'appareil (localStorage). La synchronisation à plusieurs est prévue en V2.
