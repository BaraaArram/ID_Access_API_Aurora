# Access API

Minimal, production-ready Node.js API to expose user data from an Access or Postgres backend.

Summary
- Express-based API that supports both Microsoft Access (Windows) and PostgreSQL (Linux/Fly).

Quickstart
1. Copy `.env.example` → `.env` and edit values (`ACCESS_API_KEY`, `DB_PROVIDER`, `DATABASE_URL` or `ACCESS_DB_PATH`).
2. Install dependencies:

```powershell
npm install
```

3. Start the service:

```powershell
npm start
```

Development
- Run `npm run dev` to start in development mode.

Notes
- This cleaned repo is a fresh import (no prior git history in this remote).
- Large local files (.accdb, .csv, .laccdb) are intentionally excluded from the repository via `.gitignore`.

Support
- See the `scripts/` folder for CSV migration helpers and `DEPLOY_*.md` files for deployment tips.

License
- Check repository license or project owner for usage terms.
