const loginForm = document.querySelector("#login-form");
const loginButton = document.querySelector("#login-button");
const loginError = document.querySelector("#login-error");
const activePanel = document.querySelector("#active-panel");
const activeDomain = document.querySelector("#active-domain");
const studyTimer = document.querySelector("#study-timer");
const pauseToggle = document.querySelector("#pause-toggle");
const pausedTimePanel = document.querySelector("#paused-time-panel");
const pausedTimer = document.querySelector("#paused-timer");
const sessionError = document.querySelector("#session-error");
const logoffButton = document.querySelector("#logoff-button");
const summaryDialog = document.querySelector("#summary-dialog");
const longSessionWarning = document.querySelector("#long-session-warning");
const statusBadge = document.querySelector("#status-badge");
const sessionStatusText = document.querySelector("#session-status-text");
const todayDate = document.querySelector("#today-date");
const goalList = document.querySelector(".goal-list");
const goalMessage = document.querySelector("#goal-message");
const goalsDate = document.querySelector("#goals-date");
const domainSelector = document.querySelector("#domain-selector");
const domainSelect = document.querySelector("#domain-select");
const technologyChips = document.querySelector("#technology-chips");
const technologyCategoryFilter = document.querySelector("#technology-category-filter");
const technologyIdInput = document.querySelector("#technology-id");
const technologyHint = document.querySelector("#technology-hint");
const collegeDayCheckbox = document.querySelector("#college-day");
const domainOptions = [...domainSelector.querySelectorAll(".domain-option")];

const longSessionThresholdMilliseconds = 6 * 60 * 60 * 1000;
let timerInterval;
let sessionStatus = "idle";
let accumulatedStudyMilliseconds = 0;
let studySegmentStartedAt = 0;
let pausedAt = null;
let goalRefreshInterval;
let domainSelectorsLocked = false;
let domainTechnologies = [];
let activeSdeCategory = "All";

todayDate.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
}).format(new Date());
goalsDate.textContent = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
}).format(new Date());

function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
}

function selectDomain(domainId, remember = true, preferredTechnologyId = undefined) {
    const value = String(domainId);
    const exists = [...domainSelect.options].some((option) => option.value === value);
    if (!exists) {
        return false;
    }

    const domainChanged = domainSelect.value !== value;
    domainSelect.value = value;
    for (const option of domainOptions) {
        const selected = option.dataset.domainId === value;
        option.setAttribute("aria-checked", String(selected));
        option.tabIndex = selected ? 0 : -1;
    }

    if (remember) {
        try {
            localStorage.setItem("study-tracker-domain-id", value);
        } catch {
            // Keep the selection usable when browser storage is unavailable.
        }
    }
    if (domainChanged || preferredTechnologyId !== undefined) {
        loadDomainTechnologies(value, preferredTechnologyId);
    }
    return true;
}

let technologyRequestId = 0;

async function loadDomainTechnologies(domainId, preferredTechnologyId = undefined) {
    const requestId = ++technologyRequestId;
    technologyChips.setAttribute("aria-busy", "true");
    technologyChips.replaceChildren();
    technologyIdInput.value = "";
    technologyHint.hidden = false;
    updateLoginAvailability();

    try {
        const response = await fetch(`/api/technologies?domain_id=${encodeURIComponent(domainId)}`);
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Unable to load technologies.");
        }
        if (requestId !== technologyRequestId || domainSelect.value !== String(domainId)) {
            return;
        }

        domainTechnologies = result.technologies;
        const selectedDomainName = domainSelect.options[domainSelect.selectedIndex].textContent;
        const isSdeDomain = selectedDomainName === "SDE";
        technologyCategoryFilter.hidden = !isSdeDomain;
        activeSdeCategory = isSdeDomain ? rememberedSdeCategory() : "All";
        renderTechnologyCategoryTabs(isSdeDomain);

        const storedTechnologyId = preferredTechnologyId === undefined
            ? localStorageTechnology(domainId)
            : String(preferredTechnologyId);
        const storedTechnology = result.technologies.find(
            (technology) => String(technology.id) === storedTechnologyId,
        );
        const hasStoredTechnology = preferredTechnologyId !== null
            && storedTechnology
            && (activeSdeCategory === "All" || categoryForTechnology(storedTechnology) === activeSdeCategory);

        if (!hasStoredTechnology) {
            technologyIdInput.value = "";
        }
        renderTechnologyChips();

        if (hasStoredTechnology) {
            technologyIdInput.value = storedTechnologyId;
            const selectedChip = technologyChips.querySelector(`[data-technology-id="${CSS.escape(storedTechnologyId)}"]`);
            if (selectedChip) {
                selectedChip.setAttribute("aria-checked", "true");
                selectedChip.tabIndex = 0;
            }
        }
        technologyChips.setAttribute("aria-busy", "false");
        technologyHint.hidden = Boolean(technologyIdInput.value);
        updateLoginAvailability();
    } catch (error) {
        if (requestId === technologyRequestId) {
            domainTechnologies = [];
            technologyChips.replaceChildren();
            technologyChips.setAttribute("aria-busy", "false");
            technologyCategoryFilter.hidden = true;
            technologyHint.hidden = false;
            updateLoginAvailability();
            loginError.textContent = error.message || "Unable to load technologies.";
            loginError.hidden = false;
        }
    }
}

function categoryForTechnology(technology) {
    return technology.category || "General";
}

function rememberedSdeCategory() {
    try {
        const category = localStorage.getItem("study-tracker-sde-category");
        return ["All", "Frontend", "Backend", "General"].includes(category) ? category : "All";
    } catch {
        return "All";
    }
}

function renderTechnologyCategoryTabs(isSdeDomain) {
    technologyCategoryFilter.replaceChildren();
    if (!isSdeDomain) {
        return;
    }
    for (const category of ["All", "Frontend", "Backend", "General"]) {
        const tab = document.createElement("button");
        const isSelected = category === activeSdeCategory;
        tab.className = "technology-category-tab";
        tab.type = "button";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(isSelected));
        tab.tabIndex = isSelected ? 0 : -1;
        tab.disabled = domainSelectorsLocked;
        tab.dataset.category = category;
        tab.textContent = category;
        technologyCategoryFilter.append(tab);
    }
}

function renderTechnologyChips() {
    const isSdeDomain = domainSelect.options[domainSelect.selectedIndex].textContent === "SDE";
    const visibleTechnologies = domainTechnologies.filter((technology) =>
        !isSdeDomain || activeSdeCategory === "All" || categoryForTechnology(technology) === activeSdeCategory,
    );
    const selectedTechnologyId = technologyIdInput.value;
    technologyChips.replaceChildren();
    for (const [index, technology] of visibleTechnologies.entries()) {
            const chip = document.createElement("button");
            chip.className = "technology-chip";
            chip.type = "button";
            chip.setAttribute("role", "radio");
            chip.dataset.technologyId = String(technology.id);
            const selected = String(technology.id) === selectedTechnologyId;
            chip.setAttribute("aria-checked", String(selected));
            chip.tabIndex = selected || (!selectedTechnologyId && index === 0) ? 0 : -1;
            chip.disabled = domainSelectorsLocked;
            chip.textContent = technology.name;
            technologyChips.append(chip);
    }
    updateLoginAvailability();
}

function localStorageTechnology(domainId) {
    try {
        return localStorage.getItem(`study-tracker-technology-${domainId}`);
    } catch {
        return null;
    }
}

function updateLoginAvailability() {
    const hasTechnology = technologyIdInput.value !== "";
    const isLoading = technologyChips.getAttribute("aria-busy") === "true";
    loginButton.disabled = domainSelectorsLocked || !hasTechnology || isLoading;
    technologyHint.hidden = domainSelectorsLocked || hasTechnology;
}

function setDomainSelectorLocked(locked) {
    domainSelectorsLocked = locked;
    domainSelector.classList.toggle("is-disabled", locked);
    domainSelector.setAttribute("aria-disabled", String(locked));
    domainSelect.disabled = locked;
    technologyChips.setAttribute("aria-disabled", String(locked));
    for (const tab of technologyCategoryFilter.querySelectorAll(".technology-category-tab")) {
        tab.disabled = locked;
    }
    for (const chip of technologyChips.querySelectorAll(".technology-chip")) {
        chip.disabled = locked;
    }
    technologyIdInput.disabled = locked;
    collegeDayCheckbox.disabled = locked;
    for (const option of domainOptions) {
        option.disabled = locked;
    }
    loginButton.hidden = locked;
    updateLoginAvailability();
}

domainSelector.addEventListener("click", (event) => {
    const option = event.target.closest(".domain-option");
    if (option && !option.disabled) {
        selectDomain(option.dataset.domainId);
    }
});

domainSelector.addEventListener("keydown", (event) => {
    const currentIndex = domainOptions.indexOf(event.target.closest(".domain-option"));
    if (currentIndex < 0 || domainOptions.length === 0) {
        return;
    }

    let nextIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (currentIndex + 1) % domainOptions.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex = (currentIndex - 1 + domainOptions.length) % domainOptions.length;
    } else if (event.key === "Home") {
        nextIndex = 0;
    } else if (event.key === "End") {
        nextIndex = domainOptions.length - 1;
    } else {
        return;
    }

    event.preventDefault();
    const nextOption = domainOptions[nextIndex];
    selectDomain(nextOption.dataset.domainId);
    nextOption.focus();
});

technologyCategoryFilter.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-category]");
    if (!tab || tab.disabled) {
        return;
    }
    activeSdeCategory = tab.dataset.category;
    try {
        localStorage.setItem("study-tracker-sde-category", activeSdeCategory);
    } catch {
        // Keep filtering available when browser storage is unavailable.
    }
    renderTechnologyCategoryTabs(true);
    const selectedTechnology = domainTechnologies.find(
        (technology) => String(technology.id) === technologyIdInput.value,
    );
    if (
        selectedTechnology
        && activeSdeCategory !== "All"
        && categoryForTechnology(selectedTechnology) !== activeSdeCategory
    ) {
        technologyIdInput.value = "";
    }
    renderTechnologyChips();
    technologyHint.hidden = Boolean(technologyIdInput.value);
});

technologyCategoryFilter.addEventListener("keydown", (event) => {
    const tabs = [...technologyCategoryFilter.querySelectorAll(".technology-category-tab")];
    const currentIndex = tabs.indexOf(event.target.closest(".technology-category-tab"));
    if (currentIndex < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
    }
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
            : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    nextTab.click();
    technologyCategoryFilter.querySelector(`[data-category="${nextTab.dataset.category}"]`).focus();
});

function selectTechnology(technologyId, remember = true) {
    const value = String(technologyId);
    const chips = [...technologyChips.querySelectorAll(".technology-chip")];
    const selectedChip = chips.find((chip) => chip.dataset.technologyId === value);
    if (!selectedChip || selectedChip.disabled) {
        return false;
    }

    if (technologyIdInput.value === value) {
        technologyIdInput.value = "";
        for (const chip of chips) {
            chip.setAttribute("aria-checked", "false");
            chip.tabIndex = chip === selectedChip ? 0 : -1;
        }
        technologyHint.hidden = false;
        if (remember) {
            try {
                localStorage.removeItem(`study-tracker-technology-${domainSelect.value}`);
            } catch {
                // Keep the selection usable when browser storage is unavailable.
            }
        }
        updateLoginAvailability();
        return true;
    }

    technologyIdInput.value = value;
    for (const chip of chips) {
        const selected = chip === selectedChip;
        chip.setAttribute("aria-checked", String(selected));
        chip.tabIndex = selected ? 0 : -1;
    }
    technologyHint.hidden = true;
    if (remember) {
        try {
            localStorage.setItem(`study-tracker-technology-${domainSelect.value}`, value);
        } catch {
            // Preserve the selected technology if browser storage is unavailable.
        }
    }
    updateLoginAvailability();
    return true;
}

technologyChips.addEventListener("click", (event) => {
    const chip = event.target.closest(".technology-chip");
    if (chip) {
        selectTechnology(chip.dataset.technologyId);
    }
});

technologyChips.addEventListener("keydown", (event) => {
    const chips = [...technologyChips.querySelectorAll(".technology-chip")];
    const currentIndex = chips.indexOf(event.target.closest(".technology-chip"));
    if (currentIndex < 0 || chips.length === 0) {
        return;
    }

    let nextIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (currentIndex + 1) % chips.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex = (currentIndex - 1 + chips.length) % chips.length;
    } else if (event.key === "Home") {
        nextIndex = 0;
    } else if (event.key === "End") {
        nextIndex = chips.length - 1;
    } else {
        return;
    }

    event.preventDefault();
    selectTechnology(chips[nextIndex].dataset.technologyId);
    chips[nextIndex].focus();
});

try {
    const rememberedDomain = localStorage.getItem("study-tracker-domain-id");
    if (rememberedDomain) {
        selectDomain(rememberedDomain, false);
    }
} catch {
    // The first domain remains selected when browser storage is unavailable.
}
loadDomainTechnologies(domainSelect.value);

async function loadDailyGoals() {
    try {
        const response = await fetch("/api/goals/today");
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Unable to load daily goals.");
        }

        for (const goal of result.goals) {
            const form = goalList.querySelector(`[data-domain-id="${goal.domain_id}"]`);
            if (!form) {
                continue;
            }
            const input = form.querySelector("[name='target_hours']");
            const progress = form.querySelector("progress");
            const label = form.querySelector(".goal-progress-label");
            if (goal.target_seconds && document.activeElement !== input) {
                input.value = (goal.target_seconds / 3600).toString();
            }
            progress.value = goal.progress_percent;
            label.textContent = goal.target_seconds
                ? `${formatDuration(goal.study_seconds)} / ${formatDuration(goal.target_seconds)} · ${goal.progress_percent}%`
                : `${formatDuration(goal.study_seconds)} studied · no target`;
        }
    } catch (error) {
        goalMessage.textContent = error.message || "Unable to load daily goals.";
        goalMessage.hidden = false;
    }
}

async function saveDailyGoal(form) {
    const input = form.querySelector("[name='target_hours']");
    const saveButton = form.querySelector("button");
    goalMessage.hidden = true;
    saveButton.disabled = true;

    try {
        const response = await fetch("/api/goals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                domain_id: Number(form.dataset.domainId),
                target_hours: Number(input.value),
            }),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Unable to save this daily goal.");
        }
        goalMessage.textContent = "Daily target saved.";
        goalMessage.hidden = false;
        await loadDailyGoals();
    } catch (error) {
        goalMessage.textContent = error.message || "Unable to reach the server. Try again.";
        goalMessage.hidden = false;
    } finally {
        saveButton.disabled = false;
    }
}

function renderSessionStatus(status) {
    const labels = { idle: "Idle", active: "Studying", paused: "Paused" };
    sessionStatus = status;
    statusBadge.dataset.status = status;
    sessionStatusText.textContent = labels[status];
}

function updateTimers() {
    const now = Date.now();
    const activeMilliseconds = sessionStatus === "active"
        ? Math.max(0, now - studySegmentStartedAt)
        : 0;
    const studyMilliseconds = accumulatedStudyMilliseconds + activeMilliseconds;
    studyTimer.textContent = formatDuration(Math.floor(studyMilliseconds / 1000));
    longSessionWarning.hidden = sessionStatus !== "active"
        || studyMilliseconds < longSessionThresholdMilliseconds;

    if (sessionStatus === "paused" && pausedAt !== null) {
        const pausedSeconds = Math.max(0, Math.floor((now - pausedAt) / 1000));
        pausedTimer.textContent = formatDuration(pausedSeconds);
    }
}

function startTimers() {
    window.clearInterval(timerInterval);
    updateTimers();
    timerInterval = window.setInterval(updateTimers, 1000);
}

function restoreSession(session) {
    let activeSince = null;
    let currentPauseSince = null;
    accumulatedStudyMilliseconds = 0;

    for (const event of session.events) {
        const eventMilliseconds = Date.parse(event.event_time);
        if (event.event_type === "LOGIN") {
            activeSince = eventMilliseconds;
            currentPauseSince = null;
        } else if (event.event_type === "PAUSE" && activeSince !== null) {
            accumulatedStudyMilliseconds += Math.max(0, eventMilliseconds - activeSince);
            activeSince = null;
            currentPauseSince = eventMilliseconds;
        } else if (event.event_type === "RESUME" && currentPauseSince !== null) {
            activeSince = eventMilliseconds;
            currentPauseSince = null;
        }
    }

    renderSessionStatus(session.status);
    studySegmentStartedAt = sessionStatus === "active"
        ? (activeSince ?? Date.parse(session.started_at))
        : 0;
    pausedAt = sessionStatus === "paused" ? currentPauseSince : null;
    activeDomain.textContent = session.domain_name;
    selectDomain(session.domain_id, false, session.technology_id);
    setDomainSelectorLocked(true);
    activePanel.hidden = false;
    pauseToggle.textContent = sessionStatus === "paused" ? "Resume" : "Pause";
    pausedTimePanel.hidden = sessionStatus !== "paused";
    sessionError.hidden = true;
    startTimers();
    document.dispatchEvent(new Event("study-session-updated"));
}

function startNewSession(startedAt, domainName, domainId) {
    renderSessionStatus("active");
    accumulatedStudyMilliseconds = 0;
    studySegmentStartedAt = Date.parse(startedAt);
    pausedAt = null;
    activeDomain.textContent = domainName;
    selectDomain(domainId);
    setDomainSelectorLocked(true);
    pauseToggle.textContent = "Pause";
    pausedTimePanel.hidden = true;
    activePanel.hidden = false;
    startTimers();
    document.dispatchEvent(new Event("study-session-updated"));
}

function applyStatusChange(result) {
    const eventMilliseconds = Date.parse(result.event_time);

    if (result.status === "paused") {
        accumulatedStudyMilliseconds += Math.max(0, eventMilliseconds - studySegmentStartedAt);
        pausedAt = eventMilliseconds;
        renderSessionStatus("paused");
        pauseToggle.textContent = "Resume";
        pausedTimePanel.hidden = false;
    } else {
        renderSessionStatus("active");
        studySegmentStartedAt = eventMilliseconds;
        pausedAt = null;
        pauseToggle.textContent = "Pause";
        pausedTimePanel.hidden = true;
    }

    updateTimers();
    document.dispatchEvent(new Event("study-session-updated"));
}

function formatTimestamp(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(timestamp));
}

function showSummary(result) {
    document.querySelector("#summary-domain").textContent = result.domain_name;
    document.querySelector("#summary-started").textContent = formatTimestamp(result.started_at);
    document.querySelector("#summary-ended").textContent = formatTimestamp(result.ended_at);
    document.querySelector("#summary-study").textContent = formatDuration(result.study_seconds);
    document.querySelector("#summary-paused").textContent = formatDuration(result.pause_seconds);
    document.querySelector("#summary-pause-count").textContent = String(result.pause_count);
    summaryDialog.showModal();
}

function resetToLogin() {
    window.clearInterval(timerInterval);
    timerInterval = undefined;
    renderSessionStatus("idle");
    accumulatedStudyMilliseconds = 0;
    studySegmentStartedAt = 0;
    pausedAt = null;
    setDomainSelectorLocked(false);
    studyTimer.textContent = "00:00:00";
    pausedTimer.textContent = "00:00:00";
    longSessionWarning.hidden = true;
    pausedTimePanel.hidden = true;
    pauseToggle.textContent = "Pause";
    pauseToggle.disabled = false;
    logoffButton.disabled = false;
    sessionError.hidden = true;
    activePanel.hidden = true;
    loginButton.disabled = false;
    document.dispatchEvent(new Event("study-session-updated"));
}

async function togglePause() {
    const action = sessionStatus === "active" ? "pause" : "resume";
    pauseToggle.disabled = true;
    logoffButton.disabled = true;
    sessionError.hidden = true;

    try {
        const response = await fetch(`/api/${action}`, { method: "POST" });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || `Unable to ${action} the session.`);
        }

        applyStatusChange(result);
    } catch (error) {
        sessionError.textContent = error.message || "Unable to reach the server. Try again.";
        sessionError.hidden = false;
    } finally {
        pauseToggle.disabled = false;
        logoffButton.disabled = false;
    }
}

async function logoff() {
    pauseToggle.disabled = true;
    logoffButton.disabled = true;
    sessionError.hidden = true;

    try {
        const response = await fetch("/api/logoff", { method: "POST" });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Unable to end the session.");
        }

        resetToLogin();
        showSummary(result);
    } catch (error) {
        sessionError.textContent = error.message || "Unable to reach the server. Try again.";
        sessionError.hidden = false;
        pauseToggle.disabled = false;
        logoffButton.disabled = false;
    }
}

async function loadCurrentSession() {
    loginButton.disabled = true;

    try {
        const response = await fetch("/api/current-session");
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Unable to check the current session.");
        }

        if (result.session) {
            restoreSession(result.session);
        } else {
            setDomainSelectorLocked(false);
        }
    } catch (error) {
        loginError.textContent = error.message || "Unable to reach the server. Try again.";
        loginError.hidden = false;
        setDomainSelectorLocked(false);
    }
}

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError.hidden = true;
    loginButton.disabled = true;

    const formData = new FormData(loginForm);
    try {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                domain_id: Number(formData.get("domain_id")),
                technology_id: formData.get("technology_id")
                    ? Number(formData.get("technology_id"))
                    : null,
                is_college_day: formData.has("is_college_day"),
            }),
        });
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Unable to start the session.");
        }

        startNewSession(result.started_at, result.domain_name, result.domain_id);
        loadDailyGoals();
    } catch (error) {
        loginError.textContent = error.message || "Unable to reach the server. Try again.";
        loginError.hidden = false;
        loginButton.disabled = false;
    }
});

pauseToggle.addEventListener("click", togglePause);
logoffButton.addEventListener("click", logoff);
goalList.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-domain-id]");
    if (!form) {
        return;
    }
    event.preventDefault();
    saveDailyGoal(form);
});
document.querySelector("#summary-done").addEventListener("click", () => summaryDialog.close());
summaryDialog.addEventListener("close", () => loginButton.focus());
loadCurrentSession();
loadDailyGoals();
goalRefreshInterval = window.setInterval(loadDailyGoals, 30000);