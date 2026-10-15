# Changelog

## 0.3.0

- Réglages dans l'appli (⌘,), enregistrés aussitôt : démarrage avec la session, compteur de la barre des menus, badge du Dock, notifications avec ou sans son, mises à jour, commandes de session, police et affichage du terminal.
- Raccourcis modifiables (clic puis la combinaison, doublons signalés) et raccourci global pour afficher Claude Deck depuis n'importe quelle appli.
- Onglet Autorisations : état des accès macOS (dossiers protégés, accès complet au disque, micro, contrôle de Terminal, notifications), demandes en un clic et ouverture de la bonne page des Réglages système.

## 0.2.0

- Jauge de contexte sur chaque session : part de la fenêtre utilisée (orange dès 70 %, rouge dès 90 %), dans la liste et l'en-tête.
- Ce que Claude fait en ce moment sous chaque session en cours (« Bash · npm test », « Edit · main.js »), avec la durée et le nombre d'actions du tour.
- Branche git de la session.
- Forfait Claude en bas de la barre latérale : session de 5 h et semaine, comme /usage, avec l'heure de remise à zéro.
- Barre d'état « pont » (à activer) : pourcentages en direct après chaque réponse de Claude, et ligne « Contexte · Session · Semaine » dans tes terminaux.
- Vue Statistiques (⇧⌘U) : rythme de consommation, historique des pourcentages, activité sur 30 jours, répartition par dossier.
- Signature avec une identité stable : macOS garde les autorisations de l'appli d'une mise à jour à l'autre (après une dernière demande avec cette version), et les mises à jour doivent porter cette même signature.

## 0.1.2

- Un clic sur une session « terminée » la marque comme lue, y compris pour les sessions qui tournent dans Terminal (plus besoin de « Marquer comme lue »).
- Une session affichée à l'écran au moment où elle termine est directement considérée comme lue.

## 0.1.1

- Plus de demande d'accès au trousseau au lancement : l'option de chiffrement des cookies est retirée (l'appli n'en utilise aucun, et la demande serait revenue après chaque mise à jour).
- La copie de travail produite par `npm run package` n'apparaît plus dans Spotlight ni le Launchpad, pour ne pas lancer la mauvaise copie.

## 0.1.0

Première version publique.

- Toutes les sessions Claude Code de la machine dans une seule fenêtre, avec leur statut en couleur : en attente de toi, terminée, en cours, au repos, fermée.
- Terminaux intégrés (xterm.js + node-pty) qui lancent ta commande habituelle dans un zsh de login.
- Sessions lancées dans Terminal.app ou iTerm2 : affichage du bon onglet, ou rapatriement dans l'appli.
- Conversations passées : aperçu des échanges, reprise en un clic (ou en copie avec `--fork-session`).
- Recherche dans les titres, les prompts et les réponses de Claude ; archivage avec annulation.
- Notifications, badge du Dock et compteur dans la barre des menus.
- Défilement à la molette comme Terminal.app ; rendu classique de Claude en option (historique et barre de défilement).
- Mises à jour automatiques signées depuis les releases GitHub.
