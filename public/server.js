import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import pg from "pg";

const app = express();
const port = Number(process.env.PORT) || 8080;

const databaseUrl = process.env.DATABASE_URL;
const adminPin = String(process.env.ADMIN_PIN || "739184").trim();
const cookieSecret = String(
  process.env.COOKIE_SECRET || "development-only-change-me"
).trim();

if (!databaseUrl) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
      },
    },
  })
);

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser(cookieSecret));
app.use(express.static("public"));

async function initialize() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id UUID PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      phone VARCHAR(40) NOT NULL,
      email VARCHAR(180),
      braid_size VARCHAR(40) NOT NULL,
      braid_length VARCHAR(40) NOT NULL,
      finish VARCHAR(30) NOT NULL DEFAULT 'Standard',
      preferred_date DATE NOT NULL,
      preferred_time TIME NOT NULL,
      notes TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS bookings_created_at_idx
    ON bookings(created_at DESC)
  `);
}

function createAdminToken() {
  return crypto
    .createHmac("sha256", cookieSecret)
    .update(adminPin)
    .digest("hex");
}

function isAdmin(req) {
  const session = req.signedCookies?.owner_session;

  if (!session) {
    return false;
  }

  const expectedToken = createAdminToken();

  if (session.length !== expectedToken.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(session),
    Buffer.from(expectedToken)
  );
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.json({
      status: "ok",
      database: "connected",
      port,
    });
  } catch (error) {
    console.error("Health check failed:", error);

    return res.status(500).json({
      status: "error",
      database: "disconnected",
    });
  }
});

app.post("/api/bookings", async (req, res) => {
  try {
    const {
      name,
      phone,
      email,
      braidSize,
      braidLength,
      finish,
      preferredDate,
      preferredTime,
      notes,
    } = req.body || {};

    if (
      !name ||
      !phone ||
      !braidSize ||
      !braidLength ||
      !finish ||
      !preferredDate ||
      !preferredTime
    ) {
      return res.status(400).json({
        error: "Please complete all required fields.",
      });
    }

    const id = crypto.randomUUID();

    await pool.query(
      `
        INSERT INTO bookings (
          id,
          name,
          phone,
          email,
          braid_size,
          braid_length,
          finish,
          preferred_date,
          preferred_time,
          notes
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      [
        id,
        String(name).trim(),
        String(phone).trim(),
        email ? String(email).trim() : null,
        String(braidSize).trim(),
        String(braidLength).trim(),
        String(finish).trim(),
        preferredDate,
        preferredTime,
        notes ? String(notes).trim() : null,
      ]
    );

    return res.status(201).json({
      message: "Booking request received.",
      id,
    });
  } catch (error) {
    console.error("Booking creation failed:", error);

    return res.status(500).json({
      error: "The booking could not be saved.",
    });
  }
});

app.post("/api/admin/login", (req, res) => {
  const submittedPin = String(req.body?.pin || "").trim();

  if (!submittedPin || submittedPin !== adminPin) {
    return res.status(401).json({
      error: "Incorrect owner PIN.",
    });
  }

  res.cookie("owner_session", createAdminToken(), {
    signed: true,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });

  return res.json({
    ok: true,
    message: "Owner login successful.",
  });
});

app.post("/api/admin/logout", (_req, res) => {
  res.clearCookie("owner_session", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });

  return res.json({ ok: true });
});

app.get("/api/admin/bookings", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({
      error: "Owner login required.",
    });
  }

  try {
    const result = await pool.query(`
      SELECT *
      FROM bookings
      ORDER BY created_at DESC
    `);

    return res.json({
      bookings: result.rows,
    });
  } catch (error) {
    console.error("Booking retrieval failed:", error);

    return res.status(500).json({
      error: "Could not load bookings.",
    });
  }
});

app.patch("/api/admin/bookings/:id", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({
      error: "Owner login required.",
    });
  }

  const allowedStatuses = [
    "Pending",
    "Confirmed",
    "Completed",
    "Cancelled",
  ];

  const status = String(req.body?.status || "").trim();

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: "Invalid status.",
    });
  }

  try {
    const result = await pool.query(
      `
        UPDATE bookings
        SET status = $1
        WHERE id = $2
        RETURNING id, status
      `,
      [status, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Booking not found.",
      });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error("Booking update failed:", error);

    return res.status(500).json({
      error: "Could not update booking.",
    });
  }
});

app.get("/owner", (_req, res) => {
  return res.sendFile("owner.html", {
    root: new URL("./public", import.meta.url).pathname,
  });
});

async function startServer() {
  try {
    await initialize();

    app.listen(port, "0.0.0.0", () => {
      console.log(`Braids by Athalia running on port ${port}`);
    });
  } catch (error) {
    console.error("Database initialization failed:", error);
    process.exit(1);
  }
}

startServer();
