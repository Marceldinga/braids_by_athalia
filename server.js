import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = express();

const port = Number(process.env.PORT) || 8080;
const databaseUrl = process.env.DATABASE_URL;
const adminPin = String(process.env.ADMIN_PIN || "4729").trim();
const cookieSecret = String(
  process.env.COOKIE_SECRET || "development-only-change-me"
).trim();

const resendApiKey = String(process.env.RESEND_API_KEY || "").trim();

const emailFrom =
  process.env.EMAIL_FROM ||
  "Braids by Athalia <appointments@updates.braidsbyathalia.com>";

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

const publicDirectory = fileURLToPath(
  new URL("./public", import.meta.url)
);

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
app.use(express.static(publicDirectory));

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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatBookingDate(date) {
  if (!date) {
    return "";
  }

  const parsedDate = new Date(date);

  if (Number.isNaN(parsedDate.getTime())) {
    return String(date);
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parsedDate);
}

function formatBookingTime(time) {
  if (!time) {
    return "";
  }

  const timeParts = String(time).split(":");
  let hour = Number(timeParts[0]);
  const minute = timeParts[1] || "00";

  if (Number.isNaN(hour)) {
    return String(time);
  }

  const period = hour >= 12 ? "PM" : "AM";
  hour %= 12;

  if (hour === 0) {
    hour = 12;
  }

  return `${hour}:${minute} ${period}`;
}

async function sendEmail({ to, subject, text }) {
  if (!to || !isValidEmail(to)) {
    console.log("Email skipped because customer email is missing or invalid.");
    return {
      sent: false,
      reason: "invalid-email",
    };
  }

  if (!resendApiKey) {
    console.log("Email skipped because RESEND_API_KEY is missing.");
    return {
      sent: false,
      reason: "missing-api-key",
    };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [to],
        subject,
        text,
      }),
    });

    const responseData = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Resend email error:", response.status, responseData);

      return {
        sent: false,
        reason: "resend-error",
      };
    }

    console.log("Customer email sent:", responseData.id);

    return {
      sent: true,
      id: responseData.id,
    };
  } catch (error) {
    console.error("Email delivery failed:", error);

    return {
      sent: false,
      reason: "network-error",
    };
  }
}

function createBookingReceivedEmail(booking) {
  return `
Hello ${booking.name},

Thank you for choosing Braids by Athalia.

We received your booking request with the following information:

Braid size: ${booking.braidSize}
Braid length: ${booking.braidLength}
Finish: ${booking.finish}
Preferred date: ${formatBookingDate(booking.preferredDate)}
Preferred time: ${formatBookingTime(booking.preferredTime)}

Your booking is currently Pending.

Please remember that this is a booking request. Athalia will review it and send you another email when it is confirmed or cancelled.

Braids by Athalia
Maryland
https://braidsbyathalia.com
`.trim();
}

function createStatusEmail(booking) {
  const messages = {
    Pending:
      "Your appointment request is still pending and is being reviewed.",

    Confirmed:
      "Great news! Your appointment has been confirmed. Please arrive on time and contact Braids by Athalia if you need to make any changes.",

    Completed:
      "Your appointment has been marked as completed. Thank you for choosing Braids by Athalia.",

    Cancelled:
      "Unfortunately, your appointment request has been cancelled. Please visit the website if you would like to submit another booking request.",
  };

  return `
Hello ${booking.name},

Your Braids by Athalia booking status has been updated.

New status: ${booking.status}

${messages[booking.status] || ""}

Booking information:

Braid size: ${booking.braid_size}
Braid length: ${booking.braid_length}
Finish: ${booking.finish}
Preferred date: ${formatBookingDate(booking.preferred_date)}
Preferred time: ${formatBookingTime(booking.preferred_time)}

Braids by Athalia
Maryland
https://braidsbyathalia.com
`.trim();
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.json({
      status: "ok",
      database: "connected",
      emailConfigured: Boolean(resendApiKey),
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

    const cleanName = String(name).trim();
    const cleanPhone = String(phone).trim();
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    const cleanBraidSize = String(braidSize).trim();
    const cleanBraidLength = String(braidLength).trim();
    const cleanFinish = String(finish).trim();
    const cleanNotes = notes ? String(notes).trim() : null;

    if (cleanEmail && !isValidEmail(cleanEmail)) {
      return res.status(400).json({
        error: "Please enter a valid email address.",
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
        cleanName,
        cleanPhone,
        cleanEmail,
        cleanBraidSize,
        cleanBraidLength,
        cleanFinish,
        preferredDate,
        preferredTime,
        cleanNotes,
      ]
    );

    const emailResult = await sendEmail({
      to: cleanEmail,
      subject: "We received your Braids by Athalia booking request",
      text: createBookingReceivedEmail({
        name: cleanName,
        braidSize: cleanBraidSize,
        braidLength: cleanBraidLength,
        finish: cleanFinish,
        preferredDate,
        preferredTime,
      }),
    });

    return res.status(201).json({
      message: emailResult.sent
        ? "Booking request received. Please check your email."
        : "Booking request received.",
      id,
      emailSent: emailResult.sent,
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
  });
});

app.post("/api/admin/logout", (_req, res) => {
  res.clearCookie("owner_session", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });

  return res.json({
    ok: true,
  });
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
        RETURNING
          id,
          name,
          phone,
          email,
          braid_size,
          braid_length,
          finish,
          preferred_date,
          preferred_time,
          notes,
          status,
          created_at
      `,
      [status, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Booking not found.",
      });
    }

    const booking = result.rows[0];

    const emailResult = await sendEmail({
      to: booking.email,
      subject: `Your booking is ${booking.status}`,
      text: createStatusEmail(booking),
    });

    return res.json({
      ...booking,
      emailSent: emailResult.sent,
    });
  } catch (error) {
    console.error("Booking update failed:", error);

    return res.status(500).json({
      error: "Could not update booking.",
    });
  }
});

app.get("/owner", (_req, res) => {
  return res.sendFile(path.join(publicDirectory, "owner.html"));
});

app.use((req, res) => {
  return res.status(404).json({
    error: "Page not found.",
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
