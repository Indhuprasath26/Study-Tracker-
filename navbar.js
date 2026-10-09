const navbarStatus = document.querySelector("#navbar-session-status");
const navbarTimer = document.querySelector("#navbar-session-timer");
const navbarStatusDot = document.querySelector("#navbar-session-dot");
const navbarToggle = document.querySelector("#navbar-menu-toggle");
const navbarLinks = document.querySelector("#primary-navigation");

let navbarSessionStatus = "idle";
let completedStudyMilliseconds = 0;
let activeSegmentStartedAt = null;
let pausedSegmentStartedAt = null;

function formatNavbarDuration(totalMilliseconds) {
    const totalSeconds = Math.max(0, Math.floor(totalMilliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
}

function renderNavbarSession() {
    const now = Date.now();
    let elapsed = completedStudyMilliseconds;

    if (navbarSessionStatus === "active" && activeSegmentStartedAt !== null) {
        elapsed += Math.max(0, now - activeSegmentStartedAt);
    } else if (navbarSessionStatus === "paused" && pausedSegmentStartedAt !== null) {
        elapsed = Math.max(0, now - pausedSegmentStartedAt);
    }

    const labels = { idle: "Idle", active: "Studying", paused: "Paused" };
    navbarStatus.textContent = labels[navbarSessionStatus];
    navbarTimer.textContent = formatNavbarDuration(elapsed);
    navbarStatusDot.dataset.status = navbarSessionStatus;
}

async function refreshNavbarSession() {
    try {
        const response = await fetch("/api/current-session", { cache: "no-store" });
        if (!response.ok) {
            return;
        }
        const result = await response.json();
        const session = result.session;
        completedStudyMilliseconds = 0;
        activeSegmentStartedAt = null;
        pausedSegmentStartedAt = null;

        if (!session) {
            navbarSessionStatus = "idle";
            renderNavbarSession();
            return;
        }

        for (const event of session.events) {
            const eventTime = Date.parse(event.event_time);
            if (event.event_type === "LOGIN") {
                activeSegmentStartedAt = eventTime;
                pausedSegmentStartedAt = null;
            } else if (event.event_type === "PAUSE" && activeSegmentStartedAt !== null) {
                completedStudyMilliseconds += Math.max(0, eventTime - activeSegmentStartedAt);
                activeSegmentStartedAt = null;
                pausedSegmentStartedAt = eventTime;
            } else if (event.event_type === "RESUME" && pausedSegmentStartedAt !== null) {
                activeSegmentStartedAt = eventTime;
                pausedSegmentStartedAt = null;
            }
        }

        navbarSessionStatus = session.status;
        renderNavbarSession();
    } catch {
        // Keep the last known badge and retry on the next refresh.
    }
}

navbarToggle.addEventListener("click", () => {
    const isOpen = navbarToggle.getAttribute("aria-expanded") === "true";
    navbarToggle.setAttribute("aria-expanded", String(!isOpen));
    navbarToggle.setAttribute("aria-label", isOpen ? "Open navigation menu" : "Close navigation menu");
    navbarLinks.classList.toggle("is-open", !isOpen);
});

navbarLinks.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
        navbarLinks.classList.remove("is-open");
        navbarToggle.setAttribute("aria-expanded", "false");
        navbarToggle.setAttribute("aria-label", "Open navigation menu");
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && navbarLinks.classList.contains("is-open")) {
        navbarLinks.classList.remove("is-open");
        navbarToggle.setAttribute("aria-expanded", "false");
        navbarToggle.setAttribute("aria-label", "Open navigation menu");
        navbarToggle.focus();
    }
});

document.addEventListener("study-session-updated", refreshNavbarSession);
window.setInterval(renderNavbarSession, 1000);
window.setInterval(refreshNavbarSession, 15000);
refreshNavbarSession();