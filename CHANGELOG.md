# Changelog

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
