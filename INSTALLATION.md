# 🏗️ CSE Connect — Guide d'installation

## Prérequis

- **Node.js** v18 ou supérieur → https://nodejs.org
- **npm** (inclus avec Node.js)

---

## 📁 Structure du projet

```
cse-connect/
├── backend/              ← Ce dossier (serveur Node.js)
│   ├── server.js         ← Point d'entrée
│   ├── db.js             ← Connexion SQLite
│   ├── middleware/
│   │   └── auth.js       ← Authentification JWT
│   ├── routes/
│   │   ├── auth.js       ← Login, utilisateurs
│   │   ├── messages.js   ← Messagerie
│   │   ├── notes.js      ← Notes & idées
│   │   ├── meetings.js   ← Réunions
│   │   └── documents.js  ← Fichiers
│   ├── scripts/
│   │   └── initDb.js     ← Initialisation BDD
│   ├── data/             ← Créé automatiquement (cse.db)
│   ├── uploads/          ← Créé automatiquement (fichiers)
│   └── package.json
│
└── frontend/             ← Application React (Vite)
    └── src/
        └── App.jsx       ← Le fichier cse-app.jsx
```

---

## ⚙️ Installation du Backend

### 1. Copier les fichiers

Placez tous les fichiers backend dans un dossier `cse-connect/backend/`.

### 2. Installer les dépendances

```bash
cd cse-connect/backend
npm install
```

### 3. Initialiser la base de données

```bash
npm run init-db
```

Cela crée `data/cse.db` avec les données de démonstration.

### 4. Démarrer le serveur

```bash
# Mode production
npm start

# Mode développement (redémarre automatiquement)
npm run dev
```

Le serveur tourne sur **http://localhost:3001**

---

## ⚛️ Installation du Frontend (React avec Vite)

### 1. Créer le projet React

```bash
cd cse-connect
npm create vite@latest frontend -- --template react
cd frontend
npm install
npm install socket.io-client axios
```

### 2. Remplacer le fichier App.jsx

Copiez le contenu de `cse-app.jsx` dans `frontend/src/App.jsx`.

### 3. Connecter le frontend au backend

Créez `frontend/src/api.js` :

```js
import axios from "axios";

const api = axios.create({ baseURL: "http://localhost:3001/api" });

// Ajouter le token JWT à chaque requête
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default api;
```

### 4. Démarrer le frontend

```bash
npm run dev
```

L'application est disponible sur **http://localhost:3000**

---

## 👤 Comptes de démonstration

| Email         | Mot de passe | Rôle       |
| ------------- | ------------ | ---------- |
| marie@cse.fr  | motdepasse   | Secrétaire |
| pierre@cse.fr | motdepasse   | Trésorier  |
| sophie@cse.fr | motdepasse   | Membre     |
| lucas@cse.fr  | motdepasse   | Président  |

---

## 🔌 API — Exemples d'utilisation

### Connexion

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"marie@cse.fr","password":"motdepasse"}'
```

Réponse : `{ "token": "eyJ...", "user": { ... } }`

### Récupérer les notes

```bash
curl http://localhost:3001/api/notes \
  -H "Authorization: Bearer <TOKEN>"
```

### Créer une note

```bash
curl -X POST http://localhost:3001/api/notes \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Ma note","content":"Contenu...","status":"idee","theme":"RH"}'
```

### Uploader un document

```bash
curl -X POST http://localhost:3001/api/documents \
  -H "Authorization: Bearer <TOKEN>" \
  -F "file=@monFichier.pdf" \
  -F "category=PV"
```

### Messagerie WebSocket (Socket.io)

```js
import { io } from "socket.io-client";

const socket = io("http://localhost:3001", {
  auth: { token: localStorage.getItem("token") },
});

// Rejoindre un canal
socket.emit("join_channel", "general");

// Envoyer un message
socket.emit("send_message", { channelName: "general", text: "Bonjour !" });

// Recevoir les messages
socket.on("new_message", ({ channelName, message }) => {
  console.log(`[#${channelName}] ${message.user.name}: ${message.text}`);
});
```

---

## 🔒 Sécurité en production

1. **Changer la clé secrète JWT** dans `server.js` :

   ```js
   const SECRET = process.env.JWT_SECRET; // Utiliser une variable d'environnement
   ```

2. **Fichier `.env`** à la racine du backend :

   ```
   JWT_SECRET=une-clé-très-longue-et-aléatoire-ici
   PORT=3001
   FRONTEND_URL=https://votre-domaine.fr
   ```

3. **HTTPS** : Mettre un reverse proxy nginx devant Node.js en production.

4. **Sauvegardes** : Sauvegardez régulièrement le fichier `data/cse.db` et le dossier `uploads/`.

---

## 🚀 Déploiement (optionnel)

Pour héberger l'application sur un serveur :

```bash
# Installer PM2 pour garder le serveur actif
npm install -g pm2
pm2 start server.js --name cse-backend
pm2 save
pm2 startup
```

---

## ❓ Problèmes fréquents

| Problème                           | Solution                                                      |
| ---------------------------------- | ------------------------------------------------------------- |
| `better-sqlite3` ne s'installe pas | Installer les build tools : `npm install -g node-gyp`         |
| Port 3001 déjà utilisé             | Changer dans `.env` : `PORT=3002`                             |
| Erreur CORS                        | Vérifier `FRONTEND_URL` dans le serveur                       |
| Upload échoue                      | Vérifier que le dossier `uploads/` est accessible en écriture |
