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

const adminPin = String(
  process.env.ADMIN_PIN || ""
).trim();

const cookieSecret = String(
  process.env.COOKIE_SECRET || ""
).trim();

const resendApiKey = String(
  process.env.RESEND_API_KEY || ""
).trim();

const emailFrom =
  process.env.EMAIL_FROM ||
  "Braids by Athalia <appointments@updates.braidsbyathalia.com>";


// ============================================================
// REQUIRED ENVIRONMENT VARIABLES
// ============================================================

if (!databaseUrl) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

if (!adminPin) {
  console.error("ADMIN_PIN is missing.");
  process.exit(1);
}

if (!cookieSecret) {
  console.error("COOKIE_SECRET is missing.");
  process.exit(1);
}


// ============================================================
// DATABASE
// ============================================================

const pool = new pg.Pool({
  connectionString: databaseUrl,

  ssl:
    process.env.NODE_ENV === "production"
      ? {
          rejectUnauthorized: false,
        }
      : false,
});


// ============================================================
// DIRECTORIES
// ============================================================

const publicDirectory = fileURLToPath(
  new URL("./public", import.meta.url)
);


// ============================================================
// RAILWAY
// ============================================================

app.set("trust proxy", 1);


// ============================================================
// SECURITY HEADERS
// ============================================================

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],

        imgSrc: [
          "'self'",
          "data:",
        ],

        styleSrc: [
          "'self'",
          "'unsafe-inline'",
        ],

        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
        ],

        connectSrc: [
          "'self'",
        ],
      },
    },
  })
);


// ============================================================
// BODY PARSING
// ============================================================

app.use(
  express.json({
    limit: "100kb",
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "100kb",
  })
);

app.use(
  cookieParser(cookieSecret)
);


// ============================================================
// DATABASE INITIALIZATION
// ============================================================

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


// ============================================================
// OWNER SECURITY
// ============================================================

function createAdminToken() {
  return crypto
    .createHmac(
      "sha256",
      cookieSecret
    )
    .update(adminPin)
    .digest("hex");
}


function safeCompare(firstValue, secondValue) {
  const first = Buffer.from(
    String(firstValue)
  );

  const second = Buffer.from(
    String(secondValue)
  );

  if (first.length !== second.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    first,
    second
  );
}


function isAdmin(req) {
  const session =
    req.signedCookies?.owner_session;

  if (!session) {
    return false;
  }

  const expectedToken =
    createAdminToken();

  return safeCompare(
    session,
    expectedToken
  );
}


function requireAdminApi(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({
      error: "Owner login required.",
    });
  }

  return next();
}


function requireAdminPage(req, res, next) {
  if (!isAdmin(req)) {
    return res.redirect(
      "/owner-login"
    );
  }

  return next();
}


// ============================================================
// SIMPLE OWNER LOGIN RATE LIMIT
// ============================================================

const loginAttempts = new Map();

const LOGIN_LIMIT = 5;

const LOGIN_WINDOW =
  15 * 60 * 1000;


function getClientIp(req) {
  return (
    req.ip ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}


function checkLoginLimit(req) {
  const ip = getClientIp(req);

  const now = Date.now();

  const record =
    loginAttempts.get(ip);

  if (
    !record ||
    now - record.start >
      LOGIN_WINDOW
  ) {
    loginAttempts.set(ip, {
      count: 1,
      start: now,
    });

    return {
      allowed: true,
      ip,
    };
  }

  if (
    record.count >=
    LOGIN_LIMIT
  ) {
    return {
      allowed: false,
      ip,
      retryAfter:
        LOGIN_WINDOW -
        (now - record.start),
    };
  }

  record.count += 1;

  loginAttempts.set(
    ip,
    record
  );

  return {
    allowed: true,
    ip,
  };
}


function clearLoginAttempts(req) {
  const ip = getClientIp(req);

  loginAttempts.delete(ip);
}


// ============================================================
// EMAIL HELPERS
// ============================================================

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email
  );
}


function formatBookingDate(date) {
  if (!date) {
    return "";
  }

  const parsedDate =
    new Date(date);

  if (
    Number.isNaN(
      parsedDate.getTime()
    )
  ) {
    return String(date);
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: "UTC",
      month: "long",
      day: "numeric",
      year: "numeric",
    }
  ).format(parsedDate);
}


function formatBookingTime(time) {
  if (!time) {
    return "";
  }

  const timeParts =
    String(time).split(":");

  let hour =
    Number(timeParts[0]);

  const minute =
    timeParts[1] || "00";

  if (Number.isNaN(hour)) {
    return String(time);
  }

  const period =
    hour >= 12
      ? "PM"
      : "AM";

  hour %= 12;

  if (hour === 0) {
    hour = 12;
  }

  return `${hour}:${minute} ${period}`;
}


// ============================================================
// SEND EMAIL
// ============================================================

async function sendEmail({
  to,
  subject,
  text,
}) {
  if (
    !to ||
    !isValidEmail(to)
  ) {
    console.log(
      "Email skipped because customer email is missing or invalid."
    );

    return {
      sent: false,
      reason: "invalid-email",
    };
  }

  if (!resendApiKey) {
    console.log(
      "Email skipped because RESEND_API_KEY is missing."
    );

    return {
      sent: false,
      reason: "missing-api-key",
    };
  }

  try {
    const response =
      await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${resendApiKey}`,

            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            from: emailFrom,
            to: [to],
            subject,
            text,
          }),
        }
      );

    const responseData =
      await response
        .json()
        .catch(() => ({}));

    if (!response.ok) {
      console.error(
        "Resend email error:",
        response.status,
        responseData
      );

      return {
        sent: false,
        reason:
          "resend-error",
      };
    }

    console.log(
      "Customer email sent:",
      responseData.id
    );

    return {
      sent: true,
      id: responseData.id,
    };
  } catch (error) {
    console.error(
      "Email delivery failed:",
      error
    );

    return {
      sent: false,
      reason:
        "network-error",
    };
  }
}


// ============================================================
// BOOKING RECEIVED EMAIL
// ============================================================

function createBookingReceivedEmail(
  booking
) {
  return `
Hello ${booking.name},

Thank you for choosing Braids by Athalia.

We received your booking request with the following information:

Braid size: ${booking.braidSize}
Braid length: ${booking.braidLength}
Finish: ${booking.finish}
Preferred date: ${formatBookingDate(
    booking.preferredDate
  )}
Preferred time: ${formatBookingTime(
    booking.preferredTime
  )}

Your booking is currently Pending.

Please remember that this is a booking request. Athalia will review it and send you another email when it is confirmed or cancelled.

Braids by Athalia
Maryland
https://braidsbyathalia.com
  `.trim();
}


// ============================================================
// STATUS EMAIL
// ============================================================

function createStatusEmail(
  booking
) {
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
Preferred date: ${formatBookingDate(
    booking.preferred_date
  )}
Preferred time: ${formatBookingTime(
    booking.preferred_time
  )}

Braids by Athalia
Maryland
https://braidsbyathalia.com
  `.trim();
}


// ============================================================
// BLOCK DIRECT ACCESS TO OWNER.HTML
//
// IMPORTANT:
// This MUST appear BEFORE express.static().
// ============================================================

app.get(
  "/owner.html",
  (req, res) => {
    if (isAdmin(req)) {
      return res.redirect(
        "/owner"
      );
    }

    return res.redirect(
      "/owner-login"
    );
  }
);


// ============================================================
// PUBLIC STATIC FILES
// ============================================================

app.use(
  express.static(
    publicDirectory,
    {
      index: "index.html",
    }
  )
);


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/api/health",

  async (_req, res) => {
    try {
      await pool.query(
        "SELECT 1"
      );

      return res.json({
        status: "ok",

        database:
          "connected",

        emailConfigured:
          Boolean(
            resendApiKey
          ),
      });
    } catch (error) {
      console.error(
        "Health check failed:",
        error
      );

      return res
        .status(500)
        .json({
          status: "error",

          database:
            "disconnected",
        });
    }
  }
);


// ============================================================
// PUBLIC BOOKING API
// ============================================================

app.post(
  "/api/bookings",

  async (req, res) => {
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
        return res
          .status(400)
          .json({
            error:
              "Please complete all required fields.",
          });
      }

      const cleanName =
        String(name).trim();

      const cleanPhone =
        String(phone).trim();

      const cleanEmail =
        email
          ? String(email)
              .trim()
              .toLowerCase()
          : null;

      const cleanBraidSize =
        String(
          braidSize
        ).trim();

      const cleanBraidLength =
        String(
          braidLength
        ).trim();

      const cleanFinish =
        String(
          finish
        ).trim();

      const cleanNotes =
        notes
          ? String(notes).trim()
          : null;

      if (
        cleanEmail &&
        !isValidEmail(
          cleanEmail
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Please enter a valid email address.",
          });
      }

      const id =
        crypto.randomUUID();

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

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10
        )
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

      const emailResult =
        await sendEmail({
          to: cleanEmail,

          subject:
            "We received your Braids by Athalia booking request",

          text:
            createBookingReceivedEmail(
              {
                name:
                  cleanName,

                braidSize:
                  cleanBraidSize,

                braidLength:
                  cleanBraidLength,

                finish:
                  cleanFinish,

                preferredDate,

                preferredTime,
              }
            ),
        });

      return res
        .status(201)
        .json({
          message:
            emailResult.sent
              ? "Booking request received. Please check your email."
              : "Booking request received.",

          id,

          emailSent:
            emailResult.sent,
        });
    } catch (error) {
      console.error(
        "Booking creation failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "The booking could not be saved.",
        });
    }
  }
);


// ============================================================
// OWNER LOGIN PAGE
// ============================================================

app.get(
  "/owner-login",

  (req, res) => {
    if (isAdmin(req)) {
      return res.redirect(
        "/owner"
      );
    }

    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.send(`
<!doctype html>

<html lang="en">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<meta
  name="robots"
  content="noindex,nofollow"
>

<title>
Owner Login | Braids by Athalia
</title>

<style>

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
}

body {
  min-height: 100vh;

  display: flex;

  align-items: center;

  justify-content: center;

  padding: 24px;

  font-family:
    Arial,
    Helvetica,
    sans-serif;

  background:
    radial-gradient(
      circle at top,
      #1765c1,
      #071f5c 48%,
      #010818
    );
}

.login-card {
  width: min(
    100%,
    430px
  );

  padding: 40px 30px;

  background: #ffffff;

  border-radius: 20px;

  border-top:
    7px solid #d6a62b;

  box-shadow:
    0 25px 70px
    rgba(
      0,
      0,
      0,
      0.4
    );
}

.logo {
  display: block;

  width: 100px;
  height: 100px;

  margin:
    0 auto 20px;

  object-fit: contain;

  border-radius: 50%;

  border:
    3px solid #d6a62b;

  background: #000;
}

h1 {
  margin:
    0 0 8px;

  color: #071f5c;

  text-align: center;
}

.subtitle {
  margin:
    0 0 28px;

  text-align: center;

  color: #64748b;
}

label {
  display: block;

  margin-bottom: 8px;

  color: #071f5c;

  font-weight: 800;
}

input {
  width: 100%;

  padding: 16px;

  border:
    2px solid #d9e1ef;

  border-radius: 10px;

  outline: none;

  font-size: 18px;

  text-align: center;

  letter-spacing:
    0.15em;
}

input:focus {
  border-color:
    #d6a62b;
}

button {
  width: 100%;

  margin-top: 18px;

  padding: 16px;

  border: none;

  border-radius: 10px;

  background:
    linear-gradient(
      110deg,
      #b67b08,
      #ffd85d,
      #d59a15
    );

  color: #071f5c;

  font-size: 16px;

  font-weight: 900;

  cursor: pointer;
}

button:disabled {
  opacity: 0.6;

  cursor:
    not-allowed;
}

.message {
  min-height: 24px;

  margin-top: 18px;

  text-align: center;

  font-weight: 700;
}

.error {
  color: #b91c1c;
}

.security {
  margin:
    25px 0 0;

  text-align: center;

  color: #64748b;

  font-size: 13px;

  line-height: 1.5;
}

.back {
  display: block;

  margin-top: 22px;

  color: #071f5c;

  text-align: center;
}

</style>

</head>

<body>

<div class="login-card">

<img
  class="logo"
  src="/athalia-logo.jpeg.jpeg"
  alt="Braids by Athalia"
>

<h1>
Owner Access
</h1>

<p class="subtitle">
Private owner dashboard
</p>


<form id="login-form">

<label for="pin">
Owner PIN
</label>

<input
  id="pin"
  type="password"
  inputmode="numeric"
  autocomplete="current-password"
  maxlength="20"
  required
  autofocus
  placeholder="••••"
>

<button
  id="login-button"
  type="submit"
>
Login
</button>

<p
  id="message"
  class="message"
></p>

</form>


<p class="security">
🔒 Only the business owner is authorized to access this dashboard.
</p>


<a
  class="back"
  href="/"
>
← Back to website
</a>

</div>


<script>

const form =
  document.getElementById(
    "login-form"
  );

const pin =
  document.getElementById(
    "pin"
  );

const message =
  document.getElementById(
    "message"
  );

const button =
  document.getElementById(
    "login-button"
  );


form.addEventListener(
  "submit",

  async (event) => {
    event.preventDefault();

    message.textContent =
      "";

    message.className =
      "message";

    button.disabled =
      true;

    button.textContent =
      "Checking...";

    try {
      const response =
        await fetch(
          "/api/admin/login",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            credentials:
              "same-origin",

            body:
              JSON.stringify({
                pin:
                  pin.value,
              }),
          }
        );

      const data =
        await response
          .json()
          .catch(
            () => ({})
          );

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Login failed."
        );
      }

      message.textContent =
        "Login successful.";

      window.location.replace(
        "/owner"
      );
    } catch (error) {
      message.className =
        "message error";

      message.textContent =
        error.message;

      pin.value = "";

      pin.focus();
    } finally {
      button.disabled =
        false;

      button.textContent =
        "Login";
    }
  }
);

</script>

</body>

</html>
    `);
  }
);


// ============================================================
// OWNER LOGIN API
// ============================================================

app.post(
  "/api/admin/login",

  (req, res) => {
    const limit =
      checkLoginLimit(req);

    if (!limit.allowed) {
      const seconds =
        Math.ceil(
          limit.retryAfter /
          1000
        );

      res.set(
        "Retry-After",
        String(seconds)
      );

      return res
        .status(429)
        .json({
          error:
            "Too many incorrect login attempts. Please wait 15 minutes and try again.",
        });
    }

    const submittedPin =
      String(
        req.body?.pin ||
        ""
      ).trim();

    if (!submittedPin) {
      return res
        .status(400)
        .json({
          error:
            "Enter the owner PIN.",
        });
    }

    if (
      !safeCompare(
        submittedPin,
        adminPin
      )
    ) {
      return res
        .status(401)
        .json({
          error:
            "Incorrect owner PIN.",
        });
    }

    clearLoginAttempts(req);

    res.cookie(
      "owner_session",
      createAdminToken(),
      {
        signed: true,

        httpOnly: true,

        secure:
          process.env.NODE_ENV ===
          "production",

        sameSite:
          "lax",

        // 30 MINUTES
        maxAge:
          30 *
          60 *
          1000,

        path: "/",
      }
    );

    return res.json({
      ok: true,
    });
  }
);


// ============================================================
// CHECK OWNER LOGIN
// ============================================================

app.get(
  "/api/admin/session",

  (req, res) => {
    return res.json({
      authenticated:
        isAdmin(req),
    });
  }
);


// ============================================================
// OWNER LOGOUT
// ============================================================

app.post(
  "/api/admin/logout",

  (req, res) => {
    res.clearCookie(
      "owner_session",
      {
        httpOnly: true,

        secure:
          process.env.NODE_ENV ===
          "production",

        sameSite:
          "lax",

        path: "/",
      }
    );

    return res.json({
      ok: true,
    });
  }
);


// ============================================================
// PROTECTED OWNER BOOKINGS
// ============================================================

app.get(
  "/api/admin/bookings",

  requireAdminApi,

  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT *
          FROM bookings
          ORDER BY created_at DESC
        `);

      return res.json({
        bookings:
          result.rows,
      });
    } catch (error) {
      console.error(
        "Booking retrieval failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Could not load bookings.",
        });
    }
  }
);


// ============================================================
// PROTECTED UPDATE BOOKING STATUS
// ============================================================

app.patch(
  "/api/admin/bookings/:id",

  requireAdminApi,

  async (req, res) => {
    const allowedStatuses = [
      "Pending",
      "Confirmed",
      "Completed",
      "Cancelled",
    ];

    const status =
      String(
        req.body?.status ||
        ""
      ).trim();

    if (
      !allowedStatuses.includes(
        status
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Invalid status.",
        });
    }

    try {
      const result =
        await pool.query(
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
          [
            status,
            req.params.id,
          ]
        );

      if (
        !result.rowCount
      ) {
        return res
          .status(404)
          .json({
            error:
              "Booking not found.",
          });
      }

      const booking =
        result.rows[0];

      const emailResult =
        await sendEmail({
          to:
            booking.email,

          subject:
            `Your booking is ${booking.status}`,

          text:
            createStatusEmail(
              booking
            ),
        });

      return res.json({
        ...booking,

        emailSent:
          emailResult.sent,
      });
    } catch (error) {
      console.error(
        "Booking update failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Could not update booking.",
        });
    }
  }
);


// ============================================================
// PROTECTED OWNER DASHBOARD
// ============================================================
//
// Nobody receives owner.html unless the signed owner cookie is valid.
// ============================================================

app.get(
  "/owner",

  requireAdminPage,

  (req, res) => {
    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, private"
    );

    res.set(
      "Pragma",
      "no-cache"
    );

    return res.sendFile(
      path.join(
        publicDirectory,
        "owner.html"
      )
    );
  }
);


// ============================================================
// PROTECT COMMON ADMIN ROUTES
// ============================================================

app.get(
  [
    "/admin",
    "/dashboard",
    "/owner-dashboard",
  ],

  (req, res) => {
    if (!isAdmin(req)) {
      return res.redirect(
        "/owner-login"
      );
    }

    return res.redirect(
      "/owner"
    );
  }
);


// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    return res
      .status(404)
      .json({
        error:
          "Page not found.",
      });
  }
);


// ============================================================
// START SERVER
// ============================================================

async function startServer() {
  try {
    await initialize();

    app.listen(
      port,
      "0.0.0.0",

      () => {
        console.log(
          `Braids by Athalia running on port ${port}`
        );

        console.log(
          "Owner dashboard protected 🔒"
        );

        console.log(
          "Owner session expires after 30 minutes."
        );
      }
    );
  } catch (error) {
    console.error(
      "Database initialization failed:",
      error
    );

    process.exit(1);
  }
}


startServer();
