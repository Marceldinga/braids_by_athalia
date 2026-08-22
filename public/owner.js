const loginPanel = document.querySelector("#login-panel");
const bookingPanel = document.querySelector("#booking-panel");
const bookingList = document.querySelector("#bookings");
const loginForm = const loginPanel = document.querySelector("#login-panel");
const bookingPanel = document.querySelector("#booking-panel");
const bookingList = document.querySelector("#bookings");
const loginForm = document.querySelector("#login-form");
const loginMessage = document.querySelector("#login-message");
const logoutButton = document.querySelector("#logout");
const filterButtons = document.querySelectorAll("[data-filter]");

let bookings = [];
let currentFilter = "All";

/*
  Prevent customer information from being interpreted as HTML.
*/
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/*
  Convert a phone number into a safe telephone link.
*/
function phoneLink(phone) {
  return String(phone ?? "").replace(/[^\d+]/g, "");
}

/*
  Format the preferred appointment date without changing it
  because of the customer's timezone.
*/
function formatDate(dateValue) {
  if (!dateValue) {
    return "Date not provided";
  }

  const datePart = String(dateValue).split("T")[0];
  const parts = datePart.split("-");

  if (parts.length !== 3) {
    return dateValue;
  }

  const [year, month, day] = parts;

  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day)
  );

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/*
  Convert 24-hour database time to a clearer display.
*/
function formatTime(timeValue) {
  if (!timeValue) {
    return "Time not provided";
  }

  const timeParts = String(timeValue).slice(0, 5).split(":");
  const hours = Number(timeParts[0]);
  const minutes = Number(timeParts[1]);

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes)
  ) {
    return String(timeValue);
  }

  const date = new Date();

  date.setHours(hours, minutes, 0, 0);

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/*
  Return a safe status value.
*/
function normalizeStatus(status) {
  const allowedStatuses = [
    "Pending",
    "Confirmed",
    "Completed",
    "Cancelled",
  ];

  return allowedStatuses.includes(status)
    ? status
    : "Pending";
}

/*
  Display messages on the login panel.
*/
function showLoginMessage(message, type = "error") {
  loginMessage.textContent = message;
  loginMessage.dataset.type = type;
}

/*
  Owner login.
*/
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const submitButton = loginForm.querySelector(
    'button[type="submit"]'
  );

  const pin = String(
    new FormData(loginForm).get("pin") || ""
  ).trim();

  if (!pin) {
    showLoginMessage("Please enter the owner PIN.");
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Checking PIN...";
  showLoginMessage("");

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ pin }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      showLoginMessage(
        data.error || "Incorrect owner PIN."
      );

      return;
    }

    loginForm.reset();

    await loadBookings();
  } catch (error) {
    console.error("Owner login failed:", error);

    showLoginMessage(
      "The dashboard could not connect. Please try again."
    );
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Open dashboard";
  }
});

/*
  Retrieve all bookings from PostgreSQL.
*/
async function loadBookings() {
  try {
    const response = await fetch("/api/admin/bookings", {
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    });

    if (response.status === 401) {
      loginPanel.hidden = false;
      bookingPanel.hidden = true;

      return false;
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error || "Could not load bookings."
      );
    }

    bookings = Array.isArray(data.bookings)
      ? data.bookings
      : [];

    loginPanel.hidden = true;
    bookingPanel.hidden = false;

    updateFilterCounts();
    renderBookings();

    return true;
  } catch (error) {
    console.error("Booking retrieval failed:", error);

    if (!bookingPanel.hidden) {
      bookingList.innerHTML = `
        <div class="empty">
          <strong>Bookings could not be loaded.</strong>
          <p>Please refresh the page and try again.</p>
        </div>
      `;
    }

    return false;
  }
}

/*
  Show the number of bookings beside every filter.
*/
function updateFilterCounts() {
  filterButtons.forEach((button) => {
    const buttonFilter = button.dataset.filter;

    const count =
      buttonFilter === "All"
        ? bookings.length
        : bookings.filter(
            (booking) =>
              normalizeStatus(booking.status) === buttonFilter
          ).length;

    button.textContent = `${buttonFilter} (${count})`;
  });
}

/*
  Create the status options for each booking.
*/
function createStatusOptions(currentStatus) {
  const statuses = [
    "Pending",
    "Confirmed",
    "Completed",
    "Cancelled",
  ];

  return statuses
    .map(
      (status) => `
        <option
          value="${status}"
          ${currentStatus === status ? "selected" : ""}
        >
          ${status}
        </option>
      `
    )
    .join("");
}

/*
  Display the booking cards.
*/
function renderBookings() {
  const visibleBookings =
    currentFilter === "All"
      ? bookings
      : bookings.filter(
          (booking) =>
            normalizeStatus(booking.status) === currentFilter
        );

  if (!visibleBookings.length) {
    bookingList.innerHTML = `
      <div class="empty">
        No ${escapeHtml(
          currentFilter === "All"
            ? ""
            : currentFilter.toLowerCase()
        )} booking requests found.
      </div>
    `;

    return;
  }

  bookingList.innerHTML = visibleBookings
    .map((booking) => {
      const status = normalizeStatus(booking.status);
      const safePhone = escapeHtml(booking.phone);
      const safeEmail = escapeHtml(booking.email);
      const telephone = phoneLink(booking.phone);

      return `
        <article
          class="booking-card"
          data-booking-card="${escapeHtml(booking.id)}"
        >
          <div class="customer-information">
            <span
              class="status status-badge ${status.toLowerCase()}"
            >
              ${escapeHtml(status)}
            </span>

            <h3>${escapeHtml(booking.name)}</h3>

            <div class="customer-contact">
              <a
                class="contact-button phone-button"
                href="tel:${escapeHtml(telephone)}"
              >
                <span aria-hidden="true">☎</span>
                ${safePhone}
              </a>

              ${
                booking.email
                  ? `
                    <a
                      class="contact-button email-button"
                      href="mailto:${safeEmail}"
                    >
                      <span aria-hidden="true">✉</span>
                      ${safeEmail}
                    </a>
                  `
                  : `
                    <span class="missing-email">
                      No email provided
                    </span>
                  `
              }
            </div>
          </div>

          <div class="appointment-information">
            <p class="appointment-label">
              Requested service
            </p>

            <h4>
              ${escapeHtml(booking.braid_size)}
              <span aria-hidden="true">·</span>
              ${escapeHtml(booking.braid_length)}
            </h4>

            <p class="finish">
              ${escapeHtml(booking.finish)} finish
            </p>

            <div class="appointment-time">
              <span aria-hidden="true">📅</span>

              <div>
                <strong>
                  ${escapeHtml(
                    formatDate(booking.preferred_date)
                  )}
                </strong>

                <span>
                  ${escapeHtml(
                    formatTime(booking.preferred_time)
                  )}
                </span>
              </div>
            </div>

            ${
              booking.notes
                ? `
                  <div class="booking-notes">
                    <strong>Customer notes</strong>
                    <p>${escapeHtml(booking.notes)}</p>
                  </div>
                `
                : ""
            }
          </div>

          <div class="status-control">
            <label for="status-${escapeHtml(booking.id)}">
              Appointment status
            </label>

            <select
              id="status-${escapeHtml(booking.id)}"
              data-id="${escapeHtml(booking.id)}"
              data-original-status="${escapeHtml(status)}"
              aria-label="Change status for ${escapeHtml(
                booking.name
              )}"
            >
              ${createStatusOptions(status)}
            </select>

            <p
              class="status-message"
              data-message-id="${escapeHtml(booking.id)}"
              aria-live="polite"
            ></p>
          </div>
        </article>
      `;
    })
    .join("");

  document
    .querySelectorAll("select[data-id]")
    .forEach((select) => {
      select.addEventListener("change", () => {
        updateBookingStatus(
          select.dataset.id,
          select.value,
          select
        );
      });
    });
}

/*
  Update a booking status in PostgreSQL.
  The backend can also send the customer notification email.
*/
async function updateBookingStatus(
  bookingId,
  status,
  selectElement
) {
  const originalStatus =
    selectElement.dataset.originalStatus;

  const statusMessage = document.querySelector(
    `[data-message-id="${CSS.escape(bookingId)}"]`
  );

  selectElement.disabled = true;

  if (statusMessage) {
    statusMessage.textContent = "Saving...";
  }

  try {
    const response = await fetch(
      `/api/admin/bookings/${encodeURIComponent(bookingId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status }),
      }
    );

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      loginPanel.hidden = false;
      bookingPanel.hidden = true;

      showLoginMessage(
        "Your session expired. Enter your PIN again."
      );

      return;
    }

    if (!response.ok) {
      throw new Error(
        data.error || "Could not update booking."
      );
    }

    selectElement.dataset.originalStatus = status;

    if (statusMessage) {
      statusMessage.textContent = "Status updated";
    }

    const booking = bookings.find(
      (item) => item.id === bookingId
    );

    if (booking) {
      booking.status = status;
    }

    updateFilterCounts();

    setTimeout(() => {
      renderBookings();
    }, 600);
  } catch (error) {
    console.error("Booking update failed:", error);

    selectElement.value = originalStatus;

    if (statusMessage) {
      statusMessage.textContent =
        "Update failed. Please try again.";
    }
  } finally {
    selectElement.disabled = false;
  }
}

/*
  Booking filter buttons.
*/
filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter || "All";

    filterButtons.forEach((item) => {
      item.classList.toggle(
        "active",
        item === button
      );
    });

    renderBookings();
  });
});

/*
  Log the owner out.
*/
logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  logoutButton.textContent = "Logging out...";

  try {
    await fetch("/api/admin/logout", {
      method: "POST",
    });
  } catch (error) {
    console.error("Logout failed:", error);
  } finally {
    bookings = [];
    currentFilter = "All";

    bookingList.innerHTML = "";
    bookingPanel.hidden = true;
    loginPanel.hidden = false;

    filterButtons.forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.filter === "All"
      );
    });

    logoutButton.disabled = false;
    logoutButton.textContent = "Log out";

    showLoginMessage("");
  }
});

/*
  If the owner still has a valid secure cookie,
  open the dashboard without requesting the PIN again.
*/
loadBookings();.querySelector("#logout");
const filterButtons = document.querySelectorAll("[data-filter]");

let bookings = [];
let currentFilter = "All";

/*
  Prevent customer information from being interpreted as HTML.
*/
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/*
  Convert a phone number into a safe telephone link.
*/
function phoneLink(phone) {
  return String(phone ?? "").replace(/[^\d+]/g, "");
}

/*
  Format the preferred appointment date without changing it
  because of the customer's timezone.
*/
function formatDate(dateValue) {
  if (!dateValue) {
    return "Date not provided";
  }

  const datePart = String(dateValue).split("T")[0];
  const parts = datePart.split("-");

  if (parts.length !== 3) {
    return dateValue;
  }

  const [year, month, day] = parts;

  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day)
  );

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/*
  Convert 24-hour database time to a clearer display.
*/
function formatTime(timeValue) {
  if (!timeValue) {
    return "Time not provided";
  }

  const timeParts = String(timeValue).slice(0, 5).split(":");
  const hours = Number(timeParts[0]);
  const minutes = Number(timeParts[1]);

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes)
  ) {
    return String(timeValue);
  }

  const date = new Date();

  date.setHours(hours, minutes, 0, 0);

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/*
  Return a safe status value.
*/
function normalizeStatus(status) {
  const allowedStatuses = [
    "Pending",
    "Confirmed",
    "Completed",
    "Cancelled",
  ];

  return allowedStatuses.includes(status)
    ? status
    : "Pending";
}

/*
  Display messages on the login panel.
*/
function showLoginMessage(message, type = "error") {
  loginMessage.textContent = message;
  loginMessage.dataset.type = type;
}

/*
  Owner login.
*/
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const submitButton = loginForm.querySelector(
    'button[type="submit"]'
  );

  const pin = String(
    new FormData(loginForm).get("pin") || ""
  ).trim();

  if (!pin) {
    showLoginMessage("Please enter the owner PIN.");
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Checking PIN...";
  showLoginMessage("");

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ pin }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      showLoginMessage(
        data.error || "Incorrect owner PIN."
      );

      return;
    }

    loginForm.reset();

    await loadBookings();
  } catch (error) {
    console.error("Owner login failed:", error);

    showLoginMessage(
      "The dashboard could not connect. Please try again."
    );
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Open dashboard";
  }
});

/*
  Retrieve all bookings from PostgreSQL.
*/
async function loadBookings() {
  try {
    const response = await fetch("/api/admin/bookings", {
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    });

    if (response.status === 401) {
      loginPanel.hidden = false;
      bookingPanel.hidden = true;

      return false;
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error || "Could not load bookings."
      );
    }

    bookings = Array.isArray(data.bookings)
      ? data.bookings
      : [];

    loginPanel.hidden = true;
    bookingPanel.hidden = false;

    updateFilterCounts();
    renderBookings();

    return true;
  } catch (error) {
    console.error("Booking retrieval failed:", error);

    if (!bookingPanel.hidden) {
      bookingList.innerHTML = `
        <div class="empty">
          <strong>Bookings could not be loaded.</strong>
          <p>Please refresh the page and try again.</p>
        </div>
      `;
    }

    return false;
  }
}

/*
  Show the number of bookings beside every filter.
*/
function updateFilterCounts() {
  filterButtons.forEach((button) => {
    const buttonFilter = button.dataset.filter;

    const count =
      buttonFilter === "All"
        ? bookings.length
        : bookings.filter(
            (booking) =>
              normalizeStatus(booking.status) === buttonFilter
          ).length;

    button.textContent = `${buttonFilter} (${count})`;
  });
}

/*
  Create the status options for each booking.
*/
function createStatusOptions(currentStatus) {
  const statuses = [
    "Pending",
    "Confirmed",
    "Completed",
    "Cancelled",
  ];

  return statuses
    .map(
      (status) => `
        <option
          value="${status}"
          ${currentStatus === status ? "selected" : ""}
        >
          ${status}
        </option>
      `
    )
    .join("");
}

/*
  Display the booking cards.
*/
function renderBookings() {
  const visibleBookings =
    currentFilter === "All"
      ? bookings
      : bookings.filter(
          (booking) =>
            normalizeStatus(booking.status) === currentFilter
        );

  if (!visibleBookings.length) {
    bookingList.innerHTML = `
      <div class="empty">
        No ${escapeHtml(
          currentFilter === "All"
            ? ""
            : currentFilter.toLowerCase()
        )} booking requests found.
      </div>
    `;

    return;
  }

  bookingList.innerHTML = visibleBookings
    .map((booking) => {
      const status = normalizeStatus(booking.status);
      const safePhone = escapeHtml(booking.phone);
      const safeEmail = escapeHtml(booking.email);
      const telephone = phoneLink(booking.phone);

      return `
        <article
          class="booking-card"
          data-booking-card="${escapeHtml(booking.id)}"
        >
          <div class="customer-information">
            <span
              class="status status-badge ${status.toLowerCase()}"
            >
              ${escapeHtml(status)}
            </span>

            <h3>${escapeHtml(booking.name)}</h3>

            <div class="customer-contact">
              <a
                class="contact-button phone-button"
                href="tel:${escapeHtml(telephone)}"
              >
                <span aria-hidden="true">☎</span>
                ${safePhone}
              </a>

              ${
                booking.email
                  ? `
                    <a
                      class="contact-button email-button"
                      href="mailto:${safeEmail}"
                    >
                      <span aria-hidden="true">✉</span>
                      ${safeEmail}
                    </a>
                  `
                  : `
                    <span class="missing-email">
                      No email provided
                    </span>
                  `
              }
            </div>
          </div>

          <div class="appointment-information">
            <p class="appointment-label">
              Requested service
            </p>

            <h4>
              ${escapeHtml(booking.braid_size)}
              <span aria-hidden="true">·</span>
              ${escapeHtml(booking.braid_length)}
            </h4>

            <p class="finish">
              ${escapeHtml(booking.finish)} finish
            </p>

            <div class="appointment-time">
              <span aria-hidden="true">📅</span>

              <div>
                <strong>
                  ${escapeHtml(
                    formatDate(booking.preferred_date)
                  )}
                </strong>

                <span>
                  ${escapeHtml(
                    formatTime(booking.preferred_time)
                  )}
                </span>
              </div>
            </div>

            ${
              booking.notes
                ? `
                  <div class="booking-notes">
                    <strong>Customer notes</strong>
                    <p>${escapeHtml(booking.notes)}</p>
                  </div>
                `
                : ""
            }
          </div>

          <div class="status-control">
            <label for="status-${escapeHtml(booking.id)}">
              Appointment status
            </label>

            <select
              id="status-${escapeHtml(booking.id)}"
              data-id="${escapeHtml(booking.id)}"
              data-original-status="${escapeHtml(status)}"
              aria-label="Change status for ${escapeHtml(
                booking.name
              )}"
            >
              ${createStatusOptions(status)}
            </select>

            <p
              class="status-message"
              data-message-id="${escapeHtml(booking.id)}"
              aria-live="polite"
            ></p>
          </div>
        </article>
      `;
    })
    .join("");

  document
    .querySelectorAll("select[data-id]")
    .forEach((select) => {
      select.addEventListener("change", () => {
        updateBookingStatus(
          select.dataset.id,
          select.value,
          select
        );
      });
    });
}

/*
  Update a booking status in PostgreSQL.
  The backend can also send the customer notification email.
*/
async function updateBookingStatus(
  bookingId,
  status,
  selectElement
) {
  const originalStatus =
    selectElement.dataset.originalStatus;

  const statusMessage = document.querySelector(
    `[data-message-id="${CSS.escape(bookingId)}"]`
  );

  selectElement.disabled = true;

  if (statusMessage) {
    statusMessage.textContent = "Saving...";
  }

  try {
    const response = await fetch(
      `/api/admin/bookings/${encodeURIComponent(bookingId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status }),
      }
    );

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      loginPanel.hidden = false;
      bookingPanel.hidden = true;

      showLoginMessage(
        "Your session expired. Enter your PIN again."
      );

      return;
    }

    if (!response.ok) {
      throw new Error(
        data.error || "Could not update booking."
      );
    }

    selectElement.dataset.originalStatus = status;

    if (statusMessage) {
      statusMessage.textContent = "Status updated";
    }

    const booking = bookings.find(
      (item) => item.id === bookingId
    );

    if (booking) {
      booking.status = status;
    }

    updateFilterCounts();

    setTimeout(() => {
      renderBookings();
    }, 600);
  } catch (error) {
    console.error("Booking update failed:", error);

    selectElement.value = originalStatus;

    if (statusMessage) {
      statusMessage.textContent =
        "Update failed. Please try again.";
    }
  } finally {
    selectElement.disabled = false;
  }
}

/*
  Booking filter buttons.
*/
filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter || "All";

    filterButtons.forEach((item) => {
      item.classList.toggle(
        "active",
        item === button
      );
    });

    renderBookings();
  });
});

/*
  Log the owner out.
*/
logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  logoutButton.textContent = "Logging out...";

  try {
    await fetch("/api/admin/logout", {
      method: "POST",
    });
  } catch (error) {
    console.error("Logout failed:", error);
  } finally {
    bookings = [];
    currentFilter = "All";

    bookingList.innerHTML = "";
    bookingPanel.hidden = true;
    loginPanel.hidden = false;

    filterButtons.forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.filter === "All"
      );
    });

    logoutButton.disabled = false;
    logoutButton.textContent = "Log out";

    showLoginMessage("");
  }
});

/*
  If the owner still has a valid secure cookie,
  open the dashboard without requesting the PIN again.
*/
loadBookings();
