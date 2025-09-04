## GPT Realtime Experiment

A minimal setup to run a backend (Node/Bun) and a simple frontend served via VS Code Live Server.

### Prerequisites
- **Node.js** (v18+ recommended)
- **Bun** installed (`curl -fsSL https://bun.sh/install | bash`) or see `https://bun.sh`
- **VS Code** with the **Live Server** extension (for the frontend)

### Project Structure
```
.
├── client/
│   ├── index.html
│   ├── app.js
│   └── package.json
└── src/
    ├── index.js
    └── package.json
```

### Backend
1) Open a terminal at the project root and navigate to `src/`:
```
cd src
```

2) Install dependencies (with Bun) or skip if already installed:
```
bun install
```

3) Start the backend:
```
node index.js
```

### Frontend
1) Open the project in VS Code.
2) Open `client/index.html`.
3) Start **Live Server** (right-click the `index.html` and choose "Open with Live Server").

The app should open in your browser. Make sure the backend is running first if the frontend relies on it.

### Notes
- If you prefer npm or pnpm instead of Bun in `src/`, you can run `npm install` or `pnpm install` there, then still start with `node index.js`.
- Ensure any backend URLs used in `client/app.js` match your local backend host/port.


