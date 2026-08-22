# Braids by Athalia — Railway Website

Production-ready business website with a customer booking form, PostgreSQL storage, and a PIN-protected owner dashboard.

## Deploy with GitHub and Railway

1. Upload this project to a new GitHub repository.
2. In Railway, create a new project and choose **Deploy from GitHub repo**.
3. Add a Railway **PostgreSQL** service to the project.
4. In the website service, add these variables:
   - `DATABASE_URL` — use the PostgreSQL service reference `${{Postgres.DATABASE_URL}}`
   - `ADMIN_PIN` — choose a private owner PIN
   - `COOKIE_SECRET` — use a long random secret
   - `NODE_ENV=production`
5. Deploy. Railway will run `npm start` and provide a public domain.

The database table is created automatically when the app starts. Customers book at `/`; the owner manages bookings at `/owner`.

## Local development

Copy `.env.example` to `.env`, supply a PostgreSQL URL, then run:

```bash
npm install
npm run dev
```
